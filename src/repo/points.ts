/**
 * 积分账本数据访问：point_batch / point_entry / point_balance / reason_template。
 *
 * 约定（A5/A6/A7）：
 * - 账本只追加。撤销 = 插入反向明细 + 更新原明细 status/reversed_by_entry_id。
 * - 余额与账本同事务维护；last_change_seq 用于并列破序。
 * - 一次批量 → 一个批次，共享同一 occurred_at。
 */

import { sql, type Db, type Tx, now } from './db.js';
import type { EntryStatus, Polarity } from '../lib/schema.js';

export interface ReasonTemplateRow {
  template_id: string;
  name: string;
  polarity: Polarity;
  default_delta: number;
  hidden_by_default: boolean;
  sort_order: number;
}

export interface ClassTemplateOverrideRow {
  class_id: string;
  template_id: string;
  name: string | null;
  default_delta: number | null;
  hidden: boolean | null;
  added_in_class: boolean;
}

export interface BatchRow {
  batch_id: string;
  term_id: string;
  class_id: string;
  template_id: string | null;
  reason_snapshot: { name: string; polarity: Polarity; source: 'global' | 'class' | 'none' } | null;
  delta_value: number;
  member_count: number;
  kind: 'score' | 'reversal';
  reverses_batch_id: string | null;
  partial_reversed: boolean;
  occurred_at: Date;
  teacher_id: string | null;
  request_id: string;
  note: string | null;
}

export interface EntryRow {
  entry_id: string;
  batch_id: string;
  student_id: string;
  term_id: string;
  class_id_snapshot: string;
  delta: number;
  balance_after: number;
  seat_id: string | null;
  seat_number_snapshot: number | null;
  reason_snapshot: unknown;
  status: EntryStatus;
  reverses_entry_id: string | null;
  reversed_by_entry_id: string | null;
  occurred_at: Date;
  seq: number;
  student_name?: string | null;
  note?: string | null;
}

/* ------------------------------------------------------------------ */
/* 模板                                                                */
/* ------------------------------------------------------------------ */

export async function listTemplates(db: Db | Tx): Promise<ReasonTemplateRow[]> {
  const rows = await db.execute<ReasonTemplateRow>(
    sql`SELECT template_id, name, polarity, default_delta, hidden_by_default, sort_order
        FROM reason_template ORDER BY sort_order, name`,
  );
  return rows;
}

export async function findTemplate(db: Db | Tx, templateId: string): Promise<ReasonTemplateRow | null> {
  const rows = await db.execute<ReasonTemplateRow>(
    sql`SELECT template_id, name, polarity, default_delta, hidden_by_default, sort_order
        FROM reason_template WHERE template_id = ${templateId}`,
  );
  return rows[0] ?? null;
}

export async function createTemplate(
  db: Db | Tx,
  input: { name: string; polarity: Polarity; default_delta: number; sort_order?: number },
): Promise<ReasonTemplateRow> {
  const rows = await db.execute<ReasonTemplateRow>(
    sql`INSERT INTO reason_template (name, polarity, default_delta, sort_order)
        VALUES (${input.name}, ${input.polarity}, ${input.default_delta}, ${input.sort_order ?? 0})
        RETURNING template_id, name, polarity, default_delta, hidden_by_default, sort_order`,
  );
  return rows[0]!;
}

export async function updateTemplate(
  db: Tx,
  templateId: string,
  patch: { name?: string; default_delta?: number },
): Promise<ReasonTemplateRow | null> {
  const rows = await db.execute<ReasonTemplateRow>(
    sql`UPDATE reason_template
        SET name = COALESCE(${patch.name ?? null}, name),
            default_delta = COALESCE(${patch.default_delta ?? null}, default_delta)
        WHERE template_id = ${templateId}
        RETURNING template_id, name, polarity, default_delta, hidden_by_default, sort_order`,
  );
  return rows[0] ?? null;
}

/** 班级覆盖清单。 */
export async function listClassOverrides(
  db: Db | Tx,
  classId: string,
): Promise<ClassTemplateOverrideRow[]> {
  const rows = await db.execute<ClassTemplateOverrideRow>(
    sql`SELECT class_id, template_id, name, default_delta, hidden, added_in_class
        FROM class_template_override WHERE class_id = ${classId}`,
  );
  return rows;
}

/** 写入/更新班级覆盖（字段级）。 */
export async function upsertClassOverride(
  db: Tx,
  classId: string,
  templateId: string,
  patch: { name?: string | null; default_delta?: number | null; hidden?: boolean | null; added_in_class?: boolean },
): Promise<void> {
  await db.execute(
    sql`INSERT INTO class_template_override (class_id, template_id, name, default_delta, hidden, added_in_class)
        VALUES (${classId}, ${templateId}, ${patch.name ?? null}, ${patch.default_delta ?? null},
                ${patch.hidden ?? null}, ${patch.added_in_class ?? false})
        ON CONFLICT (class_id, template_id) DO UPDATE
          SET name = COALESCE(EXCLUDED.name, class_template_override.name),
              default_delta = COALESCE(EXCLUDED.default_delta, class_template_override.default_delta),
              hidden = COALESCE(EXCLUDED.hidden, class_template_override.hidden),
              added_in_class = class_template_override.added_in_class OR EXCLUDED.added_in_class`,
  );
}

/** 清除班级覆盖（回落全局）。 */
export async function deleteClassOverride(db: Tx, classId: string, templateId: string): Promise<void> {
  await db.execute(
    sql`DELETE FROM class_template_override WHERE class_id = ${classId} AND template_id = ${templateId}`,
  );
}

/* ------------------------------------------------------------------ */
/* 批次与明细                                                          */
/* ------------------------------------------------------------------ */

/** 查询批次（含明细）。 */
export async function findBatchWithEntries(
  db: Db | Tx,
  batchId: string,
): Promise<{ batch: BatchRow; entries: EntryRow[] } | null> {
  const batchRows = await db.execute<BatchRow>(
    sql`SELECT batch_id, term_id, class_id, template_id, reason_snapshot, delta_value,
               member_count, kind, reverses_batch_id, partial_reversed, occurred_at, teacher_id, request_id, note
        FROM point_batch WHERE batch_id = ${batchId}`,
  );
  const batch = batchRows[0];
  if (!batch) return null;

  const entries = await db.execute<EntryRow>(
    sql`SELECT entry_id, batch_id, student_id, term_id, class_id_snapshot, delta, balance_after,
               seat_id, seat_number_snapshot, reason_snapshot, status,
               reverses_entry_id, reversed_by_entry_id, occurred_at, seq
        FROM point_entry WHERE batch_id = ${batchId} ORDER BY seq`,
  );

  return { batch, entries };
}

/** 查询单条明细。 */
export async function findEntry(db: Db | Tx, entryId: string): Promise<EntryRow | null> {
  const rows = await db.execute<EntryRow>(
    sql`SELECT entry_id, batch_id, student_id, term_id, class_id_snapshot, delta, balance_after,
               seat_id, seat_number_snapshot, reason_snapshot, status,
               reverses_entry_id, reversed_by_entry_id, occurred_at, seq
        FROM point_entry WHERE entry_id = ${entryId}`,
  );
  return rows[0] ?? null;
}

/** 插入批次。 */
export async function insertBatch(
  db: Tx,
  input: {
    term_id: string;
    class_id: string;
    template_id: string | null;
    reason_snapshot: unknown;
    delta_value: number;
    member_count: number;
    kind: 'score' | 'reversal';
    reverses_batch_id?: string | null;
    teacher_id: string | null;
    request_id: string;
    note?: string | null;
  },
): Promise<BatchRow> {
  const rows = await db.execute<BatchRow>(
    sql`INSERT INTO point_batch
          (term_id, class_id, template_id, reason_snapshot, delta_value, member_count,
           kind, reverses_batch_id, teacher_id, request_id, note)
        VALUES (${input.term_id}, ${input.class_id}, ${input.template_id},
                ${input.reason_snapshot ? JSON.stringify(input.reason_snapshot) : null},
                ${input.delta_value}, ${input.member_count}, ${input.kind},
                ${input.reverses_batch_id ?? null}, ${input.teacher_id}, ${input.request_id},
                ${input.note ?? null})
        RETURNING batch_id, term_id, class_id, template_id, reason_snapshot, delta_value,
                  member_count, kind, reverses_batch_id, partial_reversed, occurred_at, teacher_id, request_id, note`,
  );
  return rows[0]!;
}

/**
 * 插入明细 + 同事务更新余额。
 * 返回写入后的明细（含 balance_after 与 seq）。
 */
export async function insertEntry(
  db: Tx,
  input: {
    batch_id: string;
    student_id: string;
    term_id: string;
    class_id_snapshot: string;
    delta: number;
    seat_id: string | null;
    seat_number_snapshot: number | null;
    reason_snapshot: unknown;
    occurred_at: Date;
    reverses_entry_id?: string | null;
  },
): Promise<EntryRow> {
  // 锁定余额行，计算新余额
  const balRows = await db.execute<{ balance: number; last_change_seq: number }>(
    sql`SELECT balance, last_change_seq FROM point_balance
        WHERE term_id = ${input.term_id} AND student_id = ${input.student_id}
        FOR UPDATE`,
  );

  const prevBalance = balRows[0]?.balance ?? 0;
  const newBalance = prevBalance + input.delta;

  // 先插入明细拿到 seq
  const entryRows = await db.execute<EntryRow>(
    sql`INSERT INTO point_entry
          (batch_id, student_id, term_id, class_id_snapshot, delta, balance_after,
           seat_id, seat_number_snapshot, reason_snapshot, occurred_at, reverses_entry_id)
        VALUES (${input.batch_id}, ${input.student_id}, ${input.term_id}, ${input.class_id_snapshot},
                ${input.delta}, ${newBalance}, ${input.seat_id}, ${input.seat_number_snapshot},
                ${input.reason_snapshot ? JSON.stringify(input.reason_snapshot) : null},
                ${input.occurred_at}, ${input.reverses_entry_id ?? null})
        RETURNING entry_id, batch_id, student_id, term_id, class_id_snapshot, delta, balance_after,
                  seat_id, seat_number_snapshot, reason_snapshot, status,
                  reverses_entry_id, reversed_by_entry_id, occurred_at, seq`,
  );
  const entry = entryRows[0]!;

  // 更新余额 + last_change_seq（口径：最近一次积分变化）
  await db.execute(
    sql`INSERT INTO point_balance (term_id, student_id, balance, last_change_seq, updated_at)
        VALUES (${input.term_id}, ${input.student_id}, ${newBalance}, ${entry.seq}, ${now()})
        ON CONFLICT (term_id, student_id) DO UPDATE
          SET balance = ${newBalance},
              last_change_seq = ${entry.seq},
              updated_at = ${now()}`,
  );

  return entry;
}

/** 同一批次共用回放事件序号作为并列破序键。 */
export async function setTieBreakSeq(
  db: Tx,
  termId: string,
  studentIds: string[],
  eventSeq: number,
): Promise<void> {
  if (studentIds.length === 0) return;
  await db.execute(
    sql`UPDATE point_balance
        SET last_change_seq = ${eventSeq}
        WHERE term_id = ${termId} AND student_id = ANY(${sql.param(studentIds)}::uuid[])`,
  );
}

/** 标记明细为已冲销（撤销时调用）。 */
export async function markEntryReversed(
  db: Tx,
  entryId: string,
  reversedByEntryId: string,
): Promise<void> {
  await db.execute(
    sql`UPDATE point_entry
        SET status = 'reversed', reversed_by_entry_id = ${reversedByEntryId}
        WHERE entry_id = ${entryId} AND status = 'effective'`,
  );
}

/** 更新批次的 partial_reversed 标记。 */
export async function setBatchPartialReversed(db: Tx, batchId: string, value: boolean): Promise<void> {
  await db.execute(
    sql`UPDATE point_batch SET partial_reversed = ${value} WHERE batch_id = ${batchId}`,
  );
}

/* ------------------------------------------------------------------ */
/* 查询：时间线与余额                                                  */
/* ------------------------------------------------------------------ */

export interface EntryFilter {
  term_id?: string;
  class_id?: string;
  student_id?: string;
  date_from?: Date;
  date_to?: Date;
  direction?: 'add' | 'sub';
  reason_template_id?: string;
  include_reversals?: boolean;
  limit?: number;
  cursor_seq?: number;
}

/** 按筛选条件查询明细（时间线）。 */
export async function listEntries(db: Db | Tx, f: EntryFilter): Promise<EntryRow[]> {
  const conds = [sql`true`];
  if (f.term_id) conds.push(sql`e.term_id = ${f.term_id}`);
  if (f.class_id) conds.push(sql`e.class_id_snapshot = ${f.class_id}`);
  if (f.student_id) conds.push(sql`e.student_id = ${f.student_id}`);
  if (f.date_from) conds.push(sql`e.occurred_at >= ${f.date_from}`);
  if (f.date_to) conds.push(sql`e.occurred_at <= ${f.date_to}`);
  if (f.direction === 'add') conds.push(sql`e.delta > 0`);
  if (f.direction === 'sub') conds.push(sql`e.delta < 0`);
  if (f.include_reversals === false) conds.push(sql`e.reverses_entry_id IS NULL`);
  if (f.reason_template_id) conds.push(sql`b.template_id = ${f.reason_template_id}`);
  if (f.cursor_seq != null) conds.push(sql`e.seq < ${f.cursor_seq}`);

  const limit = f.limit ?? 50;

  const rows = await db.execute<EntryRow>(
    sql`SELECT e.entry_id, e.batch_id, e.student_id, e.term_id, e.class_id_snapshot, e.delta,
               e.balance_after, e.seat_id, e.seat_number_snapshot, e.reason_snapshot, e.status,
               e.reverses_entry_id, e.reversed_by_entry_id, e.occurred_at, e.seq,
               COALESCE(st.name, st.anon_code, '') AS student_name,
               b.note AS note
        FROM point_entry e
        JOIN point_batch b ON b.batch_id = e.batch_id
        LEFT JOIN student st ON st.student_id = e.student_id
        WHERE ${sql.join(conds, sql` AND `)}
        ORDER BY e.seq DESC
        LIMIT ${limit}`,
  );
  return rows;
}

export interface TimelineBatch {
  batch_id: string;
  occurred_at: Date;
  delta_value: number;
  member_count: number;
  kind: 'score' | 'reversal';
  note: string | null;
  reason_snapshot: unknown;
  max_seq: number;
  entries: {
    entry_id: string;
    student_id: string;
    student_name: string;
    delta: number;
    balance_after: number;
    status: EntryStatus;
    seat_number_snapshot: number | null;
  }[];
}

/**
 * 按批次分页，并取回该页每个批次的全部匹配明细。
 * 游标是上一页最后一批的最大明细序号，下一批必须更小。
 */
export async function listTimeline(db: Db | Tx, f: EntryFilter): Promise<TimelineBatch[]> {
  const conds = [sql`true`];
  if (f.term_id) conds.push(sql`e.term_id = ${f.term_id}`);
  if (f.class_id) conds.push(sql`e.class_id_snapshot = ${f.class_id}`);
  if (f.student_id) conds.push(sql`e.student_id = ${f.student_id}`);
  if (f.date_from) conds.push(sql`e.occurred_at >= ${f.date_from}`);
  if (f.date_to) conds.push(sql`e.occurred_at <= ${f.date_to}`);
  if (f.direction === 'add') conds.push(sql`e.delta > 0`);
  if (f.direction === 'sub') conds.push(sql`e.delta < 0`);
  if (f.include_reversals === false) conds.push(sql`e.reverses_entry_id IS NULL`);
  if (f.reason_template_id) conds.push(sql`b.template_id = ${f.reason_template_id}`);

  const limit = f.limit ?? 50;
  const cursorSql = f.cursor_seq != null ? sql`WHERE max_seq < ${f.cursor_seq}` : sql``;
  const page = await db.execute<{ batch_id: string; max_seq: number }>(
    sql`SELECT batch_id, max_seq FROM (
          SELECT b.batch_id, MAX(e.seq) AS max_seq
          FROM point_entry e
          JOIN point_batch b ON b.batch_id = e.batch_id
          WHERE ${sql.join(conds, sql` AND `)}
          GROUP BY b.batch_id
        ) batch_page
        ${cursorSql}
        ORDER BY max_seq DESC
        LIMIT ${limit}`,
  );
  if (page.length === 0) return [];

  const batchIds = page.map((row) => row.batch_id);
  const maxSeq = new Map(page.map((row) => [row.batch_id, Number(row.max_seq)]));
  const entries = await db.execute<EntryRow>(
    sql`SELECT e.entry_id, e.batch_id, e.student_id, e.delta, e.balance_after, e.status,
               e.seat_number_snapshot, e.seq,
               COALESCE(st.name, st.anon_code, '') AS student_name
        FROM point_entry e
        JOIN point_batch b ON b.batch_id = e.batch_id
        LEFT JOIN student st ON st.student_id = e.student_id
        WHERE e.batch_id = ANY(${sql.param(batchIds)}::uuid[])
          AND ${sql.join(conds, sql` AND `)}
        ORDER BY e.seq DESC`,
  );
  const batches = await db.execute<BatchRow>(
    sql`SELECT batch_id, term_id, class_id, template_id, reason_snapshot, delta_value,
               member_count, kind, reverses_batch_id, partial_reversed, occurred_at, teacher_id, request_id, note
        FROM point_batch WHERE batch_id = ANY(${sql.param(batchIds)}::uuid[])`,
  );
  const batchMap = new Map(batches.map((row) => [row.batch_id, row]));
  const byBatch = new Map<string, EntryRow[]>();
  for (const entry of entries) {
    const list = byBatch.get(entry.batch_id) ?? [];
    list.push(entry);
    byBatch.set(entry.batch_id, list);
  }

  return page.map((row) => {
    const batch = batchMap.get(row.batch_id)!;
    return {
      batch_id: row.batch_id,
      occurred_at: batch.occurred_at,
      delta_value: batch.delta_value,
      member_count: batch.member_count,
      kind: batch.kind,
      note: batch.note,
      reason_snapshot: batch.reason_snapshot,
      max_seq: maxSeq.get(row.batch_id) ?? 0,
      entries: (byBatch.get(row.batch_id) ?? []).map((entry) => ({
        entry_id: entry.entry_id,
        student_id: entry.student_id,
        student_name: entry.student_name ?? '',
        delta: entry.delta,
        balance_after: entry.balance_after,
        status: entry.status,
        seat_number_snapshot: entry.seat_number_snapshot,
      })),
    };
  });
}

/**
 * 批量查询多名学生在某学期的余额（座位图渲染用，避免 N+1）。
 * 返回 Map<student_id, balance>；无余额行的学生按 0 处理。
 */
export async function listBalancesForStudents(
  db: Db | Tx,
  termId: string,
  studentIds: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (studentIds.length === 0) return map;

  const rows = await db.execute<{ student_id: string; balance: number }>(
    sql`SELECT student_id, balance FROM point_balance
        WHERE term_id = ${termId} AND student_id = ANY(${sql.param(studentIds)}::uuid[])`,
  );
  for (const r of rows) map.set(r.student_id, r.balance);

  // 补齐缺失的学生为 0（新入班尚未记分）
  for (const id of studentIds) if (!map.has(id)) map.set(id, 0);

  return map;
}

/** 查询学生在某学期的余额行。 */
export async function findBalance(
  db: Db | Tx,
  termId: string,
  studentId: string,
): Promise<{ balance: number; last_change_seq: number } | null> {
  const rows = await db.execute<{ balance: number; last_change_seq: number }>(
    sql`SELECT balance, last_change_seq FROM point_balance
        WHERE term_id = ${termId} AND student_id = ${studentId}`,
  );
  return rows[0] ?? null;
}

/**
 * 排行榜（并列 + 破并列：最近一次积分变化）。
 * 排序：balance DESC, last_change_seq ASC, 班级名, 学号。只含在班学生。
 */
export async function listRanked(
  db: Db | Tx,
  termId: string,
  classId?: string,
): Promise<
  {
    student_id: string;
    student_name: string;
    student_no: string;
    class_id: string;
    class_name: string;
    balance: number;
    last_change_seq: number;
  }[]
> {
  const filter = classId ? sql`AND st.class_id = ${classId}` : sql``;
  const rows = await db.execute<{
    student_id: string;
    student_name: string;
    student_no: string;
    class_id: string;
    class_name: string;
    balance: number;
    last_change_seq: number;
  }>(
        sql`SELECT st.student_id,
               COALESCE(NULLIF(st.name, ''), st.anon_code, '') AS student_name,
               st.student_no, st.class_id, c.name AS class_name,
               COALESCE(pb.balance, 0)::int AS balance,
               COALESCE(pb.last_change_seq, 0)::bigint AS last_change_seq
        FROM student st
        JOIN class c ON c.class_id = st.class_id
        LEFT JOIN point_balance pb
          ON pb.student_id = st.student_id AND pb.term_id = ${termId}
        WHERE st.status = 'active'
          ${filter}
        ORDER BY COALESCE(pb.balance, 0) DESC,
                 COALESCE(pb.last_change_seq, 0) ASC,
                 c.name, st.student_no`,
  );
  return rows;
}

/**
 * 全量重算余额（维护命令用）：从账本重放并与缓存比对。
 * 返回不一致的明细清单。
 */
export async function recomputeBalances(
  db: Db | Tx,
  termId: string,
): Promise<{ student_id: string; cached: number; computed: number; last_change_seq: number }[]> {
  const rows = await db.execute<{
    student_id: string;
    cached: number;
    computed: number;
    last_change_seq: number;
  }>(
        sql`WITH ledger AS (
          SELECT pe.student_id,
                 SUM(pe.delta)::int AS computed,
                 COALESCE(MAX(ev.event_seq), 0) AS last_change_seq
          FROM point_entry pe
          LEFT JOIN event_log ev
            ON ev.kind = 'points_appended'
           AND ev.payload->>'batch_id' = pe.batch_id::text
          WHERE pe.term_id = ${termId} AND pe.status = 'effective'
          GROUP BY pe.student_id
        )
        SELECT COALESCE(pb.student_id, l.student_id) AS student_id,
               COALESCE(pb.balance, 0) AS cached,
               COALESCE(l.computed, 0) AS computed,
               COALESCE(l.last_change_seq, 0) AS last_change_seq
        FROM point_balance pb
        FULL OUTER JOIN ledger l ON l.student_id = pb.student_id
        WHERE pb.term_id = ${termId} OR pb.term_id IS NULL
        HAVING COALESCE(pb.balance, 0) <> COALESCE(l.computed, 0)
            OR pb.last_change_seq IS DISTINCT FROM COALESCE(l.last_change_seq, 0)`,
  );
  return rows;
}
