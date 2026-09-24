/**
 * 积分服务：记账（单人/批量统一）、撤销（单条/整批）、时间线查询。
 *
 * 约定（A5/A6/A7）：
 * - 一次批量 → 一个批次，整体成功或整体失败，共享同一 occurred_at。
 * - 撤销生成反向记录，原记录永不改写；部分撤销后仍可整批撤销剩余（Q2 方案 a）。
 * - 幂等：同 request_id 同请求体重放原结果；请求体不同则 409，不重复记账。
 * - 旧学期只读：非当前学期一律拒绝写入（DB 触发器兜底）。
 */

import { type Db, db as defaultDb, sql } from '../repo/db.js';
import * as pointsRepo from '../repo/points.js';
import * as studentRepo from '../repo/student.js';
import * as classRepo from '../repo/class.js';
import * as auditRepo from '../repo/audit.js';
import { writeEvent } from './publishEvent.js';
import { idempotentTx } from './idempotency.js';
import { assignRanks, canReverseBatch, canReverseEntry, validateDeltaPolarity } from '../domain/points.js';
import { AppError, Errors } from '../lib/errors.js';
import { toIsoTimestamp } from '../lib/time.js';
import type {
  CreateBatchInput,
  BatchResultDto,
  PointEntryDto,
  ListEntriesQuery,
  TimelineEventDto,
  Polarity,
} from '../lib/schema.js';

/* ------------------------------------------------------------------ */
/* 记账                                                                */
/* ------------------------------------------------------------------ */

export async function createBatch(
  actorId: string,
  input: CreateBatchInput,
  db: Db = defaultDb,
): Promise<BatchResultDto> {
  return idempotentTx(
    db,
    input.request_id,
    'POST /api/v1/points/batches',
    input,
    async (tx) => {
        // 1. 校验学期为当前且 open
        const term = await classRepo.findTerm(tx, input.term_id);
        if (!term) throw Errors.notFound('学期', input.term_id);
        if (term.status !== 'open') throw Errors.termReadonly();

        const current = await classRepo.currentTerm(tx);
        if (!current || current.term_id !== input.term_id) {
          throw Errors.termReadonly('只能向当前学期记账');
        }

        // 2. 校验班级
        const cls = await classRepo.findClass(tx, input.class_id);
        if (!cls) throw Errors.notFound('班级', input.class_id);
        if (cls.archived_at) throw Errors.forbidden('班级已归档');

        // 3. 校验模板（若指定）并解析原因快照
        let reasonSnapshot: { name: string; polarity: Polarity; source: 'global' | 'class' | 'none' } | null =
          null;
        let polarity: Polarity | null = null;

        if (input.template_id) {
          const tpl = await pointsRepo.findTemplate(tx, input.template_id);
          if (!tpl) throw Errors.notFound('原因模板', input.template_id);
          const visible = (await listEffectiveTemplates(input.class_id, tx)).find(
            (item) => item.template_id === input.template_id && !item.hidden,
          );
          if (!visible) throw Errors.forbidden('该原因模板在本班不可用或已隐藏');

          const overrides = await pointsRepo.listClassOverrides(tx, input.class_id);
          const ov = overrides.find((o) => o.template_id === input.template_id);

          const effectiveName = ov?.name ?? tpl.name;
          polarity = tpl.polarity;

          reasonSnapshot = {
            name: effectiveName,
            polarity: tpl.polarity,
            source: ov ? 'class' : 'global',
          };

          // 方向校验：当次可改大小，不能反转模板方向
          if (!validateDeltaPolarity(input.delta, tpl.polarity)) {
            throw Errors.polarityMismatch(
              `分值方向与模板「${effectiveName}」不一致（模板为${tpl.polarity > 0 ? '加分' : '扣分'}）`,
            );
          }
        }

        const studentIds = [...new Set(input.student_ids)];
        if (studentIds.length !== input.student_ids.length) {
          throw new AppError('VALIDATION_FAILED', '同一学生不能在一批里出现两次', {
            issues: [{ path: ['student_ids'], message: '存在重复的 student_id' }],
          });
        }

        const students = await studentRepo.listStudents(tx, input.class_id, { status: 'active' });
        const byId = new Map(students.map((s) => [s.student_id, s]));
        for (const sid of studentIds) {
          if (!byId.get(sid)) throw Errors.notFound('在班学生', sid);
        }
        const seats = await studentRepo.listClassSeats(tx, input.class_id);
        const seatByStudent = new Map(
          seats.filter((seat) => seat.student_id).map((seat) => [seat.student_id as string, seat]),
        );

        // 5. 写入批次
        const occurredAt = new Date();

        const batch = await pointsRepo.insertBatch(tx, {
          term_id: input.term_id,
          class_id: input.class_id,
          template_id: input.template_id,
          reason_snapshot: reasonSnapshot,
          delta_value: input.delta,
          member_count: studentIds.length,
          kind: 'score',
          teacher_id: actorId,
          request_id: input.request_id,
          note: input.note?.trim() ? input.note.trim() : null,
        });

        // 6. 逐条写入明细（含座位快照）+ 更新余额
        const entries: PointEntryDto[] = [];
        for (const sid of studentIds) {
          const seat = seatByStudent.get(sid);
          const student = byId.get(sid)!;

          const entry = await pointsRepo.insertEntry(tx, {
            batch_id: batch.batch_id,
            student_id: sid,
            term_id: input.term_id,
            class_id_snapshot: input.class_id,
            delta: input.delta,
            seat_id: seat?.seat_id ?? null,
            seat_number_snapshot: seat?.seat_number ?? null,
            reason_snapshot: reasonSnapshot,
            occurred_at: occurredAt,
          });

          entries.push({
            entry_id: entry.entry_id,
            batch_id: entry.batch_id,
            student_id: entry.student_id,
            student_name: student.name,
            delta: entry.delta,
            balance_before: entry.balance_after - entry.delta,
            balance_after: entry.balance_after,
            seat_id: entry.seat_id,
            seat_number_snapshot: entry.seat_number_snapshot,
            reason_snapshot: reasonSnapshot,
            status: 'effective',
            reverses_entry_id: null,
            reversed_by_entry_id: null,
            occurred_at: occurredAt.toISOString(),
            seq: Number(entry.seq),
          });
        }

        // 7. 审计 + 事件
        await auditRepo.writeAudit(tx, {
          actor: actorId,
          entity: 'point_batch',
          entity_id: batch.batch_id,
          action: 'scored',
          after: {
            delta: input.delta,
            member_count: studentIds.length,
            template_id: input.template_id,
            note: batch.note,
          },
          request_id: input.request_id,
        });

        const scoredEvent = await writeEvent(tx, {
          class_id: input.class_id,
          kind: 'points_appended',
          payload: {
            class_id: input.class_id,
            term_id: input.term_id,
            batch_id: batch.batch_id,
            note: batch.note,
            entries: entries.map((e) => ({
              entry_id: e.entry_id,
              student_id: e.student_id,
              delta: e.delta,
              balance_after: e.balance_after,
            })),
          },
        });
        await pointsRepo.setTieBreakSeq(
          tx,
          input.term_id,
          studentIds,
          Number(scoredEvent.event_seq),
        );

        const dto: BatchResultDto = {
          batch_id: batch.batch_id,
          term_id: batch.term_id,
          class_id: batch.class_id,
          kind: 'score',
          reverses_batch_id: null,
          delta_value: batch.delta_value,
          member_count: batch.member_count,
          partial_reversed: false,
          occurred_at: occurredAt.toISOString(),
          entries,
          undo: { batch_reverse_available: true, already_reversed_count: 0 },
        };

        return dto;
  },
  );
}

/* ------------------------------------------------------------------ */
/* 撤销                                                                */
/* ------------------------------------------------------------------ */

/**
 * 整批撤销（Q2 方案 a）：只冲销 status='effective' 的明细。
 * 已部分撤销的批次，剩余明细照常冲销；全部已冲销 → 409。
 */
export async function reverseBatch(
  actorId: string,
  batchId: string,
  requestId: string,
  db: Db = defaultDb,
): Promise<BatchResultDto> {
  return idempotentTx(
    db,
    requestId,
    `POST /api/v1/points/batches/${batchId}/reverse`,
    { request_id: requestId },
    async (tx) => {
        const found = await pointsRepo.findBatchWithEntries(tx, batchId);
        if (!found) throw Errors.notFound('积分批次', batchId);

        const { batch, entries } = found;

        const eligibility = canReverseBatch({
          batch_id: batch.batch_id,
          delta_value: batch.delta_value,
          member_count: batch.member_count,
          kind: batch.kind,
          reverses_batch_id: batch.reverses_batch_id,
          partial_reversed: batch.partial_reversed,
          entries: entries.map((e) => ({
            entry_id: e.entry_id,
            student_id: e.student_id,
            delta: e.delta,
            balance_after: e.balance_after,
            status: e.status,
            reverses_entry_id: e.reverses_entry_id,
            reversed_by_entry_id: e.reversed_by_entry_id,
            seq: Number(e.seq),
          })),
        });

        if (!eligibility.reversible) {
          throw Errors.alreadyReversed('该批次全部明细已被冲销');
        }

        const effective = entries.filter((e) => e.status === 'effective');
        const occurredAt = new Date();

        // 反向批次
        const revBatch = await pointsRepo.insertBatch(tx, {
          term_id: batch.term_id,
          class_id: batch.class_id,
          template_id: batch.template_id,
          reason_snapshot: batch.reason_snapshot,
          delta_value: -batch.delta_value,
          member_count: effective.length,
          kind: 'reversal',
          reverses_batch_id: batch.batch_id,
          teacher_id: actorId,
          request_id: requestId,
        });

        const newEntries: PointEntryDto[] = [];

        for (const e of effective) {
          // 反向明细（delta 取反）
          const rev = await pointsRepo.insertEntry(tx, {
            batch_id: revBatch.batch_id,
            student_id: e.student_id,
            term_id: batch.term_id,
            class_id_snapshot: e.class_id_snapshot,
            delta: -e.delta,
            seat_id: e.seat_id,
            seat_number_snapshot: e.seat_number_snapshot,
            reason_snapshot: batch.reason_snapshot,
            occurred_at: occurredAt,
            reverses_entry_id: e.entry_id,
          });

          // 标记原明细为已冲销
          await pointsRepo.markEntryReversed(tx, e.entry_id, rev.entry_id);

          const student = await studentRepo.findStudent(tx, e.student_id);

          newEntries.push({
            entry_id: rev.entry_id,
            batch_id: rev.batch_id,
            student_id: rev.student_id,
            student_name: student?.name ?? '',
            delta: rev.delta,
            balance_before: rev.balance_after - rev.delta,
            balance_after: rev.balance_after,
            seat_id: rev.seat_id,
            seat_number_snapshot: rev.seat_number_snapshot,
            reason_snapshot: batch.reason_snapshot,
            status: 'effective',
            reverses_entry_id: e.entry_id,
            reversed_by_entry_id: null,
            occurred_at: occurredAt.toISOString(),
            seq: Number(rev.seq),
          });
        }

        // 标记原批次为部分/整体已撤销
        const remaining = entries.filter(
          (e) => e.status === 'effective' && !effective.includes(e),
        );
        await pointsRepo.setBatchPartialReversed(
          tx,
          batch.batch_id,
          remaining.length > 0 || eligibility.already_reversed_count > 0,
        );

        await auditRepo.writeAudit(tx, {
          actor: actorId,
          entity: 'point_batch',
          entity_id: batchId,
          action: 'batch_reversed',
          before: { effective: eligibility.effective_count, reversed: eligibility.already_reversed_count },
          after: { reversal_batch_id: revBatch.batch_id },
          request_id: requestId,
        });

        const reversedEvent = await writeEvent(tx, {
          class_id: batch.class_id,
          kind: 'points_appended',
          payload: {
            class_id: batch.class_id,
            term_id: batch.term_id,
            batch_id: revBatch.batch_id,
            kind: 'reversal',
            reverses_batch_id: batch.batch_id,
            entries: newEntries.map((e) => ({
              entry_id: e.entry_id,
              student_id: e.student_id,
              delta: e.delta,
              balance_after: e.balance_after,
            })),
          },
        });
        await pointsRepo.setTieBreakSeq(
          tx,
          batch.term_id,
          newEntries.map((e) => e.student_id),
          Number(reversedEvent.event_seq),
        );

        const dto: BatchResultDto = {
          batch_id: revBatch.batch_id,
          term_id: revBatch.term_id,
          class_id: revBatch.class_id,
          kind: 'reversal',
          reverses_batch_id: batch.batch_id,
          delta_value: revBatch.delta_value,
          member_count: revBatch.member_count,
          partial_reversed: false,
          occurred_at: occurredAt.toISOString(),
          entries: newEntries,
          undo: { batch_reverse_available: false, already_reversed_count: 0 },
        };

        return dto;
  },
  );
}

/** 单条撤销。已撤销明细 → 409。 */
export async function reverseEntry(
  actorId: string,
  entryId: string,
  requestId: string,
  db: Db = defaultDb,
): Promise<BatchResultDto> {
  return idempotentTx(
    db,
    requestId,
    `POST /api/v1/points/entries/${entryId}/reverse`,
    { request_id: requestId },
    async (tx) => {
        const entry = await pointsRepo.findEntry(tx, entryId);
        if (!entry) throw Errors.notFound('积分明细', entryId);

        const check = canReverseEntry({
          entry_id: entry.entry_id,
          student_id: entry.student_id,
          delta: entry.delta,
          balance_after: entry.balance_after,
          status: entry.status,
          reverses_entry_id: entry.reverses_entry_id,
          reversed_by_entry_id: entry.reversed_by_entry_id,
          seq: Number(entry.seq),
        });
        if (!check.reversible) throw Errors.alreadyReversed(check.reason ?? '无法撤销');

        // 不能冲销"反向明细"本身（会形成冲销链）
        if (entry.reverses_entry_id) {
          throw Errors.alreadyReversed('反向记录本身不可再次冲销');
        }

        const originalBatch = await pointsRepo.findBatchWithEntries(tx, entry.batch_id);
        if (!originalBatch) throw Errors.notFound('批次', entry.batch_id);

        const occurredAt = new Date();

        const revBatch = await pointsRepo.insertBatch(tx, {
          term_id: entry.term_id,
          class_id: originalBatch.batch.class_id,
          template_id: originalBatch.batch.template_id,
          reason_snapshot: originalBatch.batch.reason_snapshot,
          delta_value: -entry.delta,
          member_count: 1,
          kind: 'reversal',
          reverses_batch_id: entry.batch_id,
          teacher_id: actorId,
          request_id: requestId,
        });

        const rev = await pointsRepo.insertEntry(tx, {
          batch_id: revBatch.batch_id,
          student_id: entry.student_id,
          term_id: entry.term_id,
          class_id_snapshot: entry.class_id_snapshot,
          delta: -entry.delta,
          seat_id: entry.seat_id,
          seat_number_snapshot: entry.seat_number_snapshot,
          reason_snapshot: entry.reason_snapshot,
          occurred_at: occurredAt,
          reverses_entry_id: entry.entry_id,
        });

        await pointsRepo.markEntryReversed(tx, entry.entry_id, rev.entry_id);

        // 原批次标记为部分撤销
        await pointsRepo.setBatchPartialReversed(tx, entry.batch_id, true);

        const student = await studentRepo.findStudent(tx, entry.student_id);

        await auditRepo.writeAudit(tx, {
          actor: actorId,
          entity: 'point_entry',
          entity_id: entryId,
          action: 'entry_reversed',
          after: { reversal_entry_id: rev.entry_id },
          request_id: requestId,
        });

        const entryEvent = await writeEvent(tx, {
          class_id: entry.class_id_snapshot,
          kind: 'points_appended',
          payload: {
            class_id: entry.class_id_snapshot,
            term_id: entry.term_id,
            batch_id: revBatch.batch_id,
            kind: 'reversal',
            entries: [
              {
                entry_id: rev.entry_id,
                student_id: rev.student_id,
                delta: rev.delta,
                balance_after: rev.balance_after,
              },
            ],
          },
        });
        await pointsRepo.setTieBreakSeq(
          tx,
          entry.term_id,
          [entry.student_id],
          Number(entryEvent.event_seq),
        );

        const dto: BatchResultDto = {
          batch_id: revBatch.batch_id,
          term_id: revBatch.term_id,
          class_id: revBatch.class_id,
          kind: 'reversal',
          reverses_batch_id: entry.batch_id,
          delta_value: revBatch.delta_value,
          member_count: 1,
          partial_reversed: false,
          occurred_at: occurredAt.toISOString(),
          entries: [
            {
              entry_id: rev.entry_id,
              batch_id: rev.batch_id,
              student_id: rev.student_id,
              student_name: student?.name ?? '',
              delta: rev.delta,
              balance_before: rev.balance_after - rev.delta,
              balance_after: rev.balance_after,
              seat_id: rev.seat_id,
              seat_number_snapshot: rev.seat_number_snapshot,
              reason_snapshot: entry.reason_snapshot as any,
              status: 'effective',
              reverses_entry_id: entry.entry_id,
              reversed_by_entry_id: null,
              occurred_at: occurredAt.toISOString(),
              seq: Number(rev.seq),
            },
          ],
          undo: { batch_reverse_available: false, already_reversed_count: 0 },
        };

        return dto;
  },
  );
}

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

export function entryFilterFromQuery(q: ListEntriesQuery): {
  term_id?: string;
  class_id?: string;
  student_id?: string;
  date_from?: Date;
  date_to?: Date;
  direction?: 'add' | 'sub';
  reason_template_id?: string;
  include_reversals: boolean;
  cursor_seq?: number;
  limit: number;
} {
  return {
    term_id: q.term_id,
    class_id: q.class_id,
    student_id: q.student_id,
    date_from: q.date_from ? new Date(q.date_from) : undefined,
    date_to: q.date_to ? new Date(q.date_to) : undefined,
    direction: q.direction,
    reason_template_id: q.reason_template_id,
    include_reversals: q.include_reversals,
    cursor_seq: q.cursor ? Number(q.cursor) : undefined,
    limit: q.limit ?? 50,
  };
}

export async function listTimeline(
  q: ListEntriesQuery,
  db: Db = defaultDb,
): Promise<{ items: TimelineEventDto[]; next_cursor: string | null }> {
  const limit = q.limit ?? 50;
  const filter = entryFilterFromQuery(q);
  const grouped = await pointsRepo.listTimeline(db, { ...filter, limit: limit + 1 });
  const hasMore = grouped.length > limit;
  const page = hasMore ? grouped.slice(0, limit) : grouped;
  const last = page[page.length - 1];
  return {
    items: page.map((row) => ({
      batch_id: row.batch_id,
      occurred_at: toIsoTimestamp(row.occurred_at),
      delta_value: row.delta_value,
      member_count: row.member_count,
      kind: row.kind,
      note: row.note,
      reason_snapshot: row.reason_snapshot as TimelineEventDto['reason_snapshot'],
      entries: row.entries,
    })),
    next_cursor: hasMore && last ? String(last.max_seq) : null,
  };
}

/** 学生详情时间线。 */
export async function getStudentTimeline(
  studentId: string,
  termId: string | undefined,
  db: Db = defaultDb,
): Promise<{
  student: { student_id: string; name: string; student_no: string };
  balance: number;
  events: TimelineEventDto[];
}> {
  const student = await studentRepo.findStudent(db, studentId);
  if (!student) throw Errors.notFound('学生', studentId);

  const term = termId
    ? await classRepo.findTerm(db, termId)
    : await classRepo.currentTerm(db);
  if (!term) throw Errors.notFound('学期');

  const balance = await pointsRepo.findBalance(db, term.term_id, studentId);

  const events = (
    await listTimeline(
      { student_id: studentId, term_id: term.term_id, limit: 200, include_reversals: true },
      db,
    )
  ).items;

  return {
    student: {
      student_id: student.student_id,
      name: student.name || student.anon_code || '',
      student_no: student.student_no,
    },
    balance: balance?.balance ?? 0,
    events,
  };
}

export async function getStudentBalance(studentId: string, termId?: string, db: Db = defaultDb) {
  const student = await studentRepo.findStudent(db, studentId);
  if (!student) throw Errors.notFound('学生', studentId);
  const term = termId ? await classRepo.findTerm(db, termId) : await classRepo.currentTerm(db);
  if (!term) throw Errors.notFound('学期');
  const balance = await pointsRepo.findBalance(db, term.term_id, studentId);
  return {
    student_id: studentId,
    term_id: term.term_id,
    balance: balance?.balance ?? 0,
    last_change_seq: balance?.last_change_seq ?? 0,
  };
}

export async function listLeaderboard(
  termId: string,
  classId: string | undefined,
  db: Db = defaultDb,
) {
  const rows = await pointsRepo.listRanked(db, termId, classId);
  return assignRanks(
    rows.map((row) => ({
      student_id: row.student_id,
      name: row.student_name,
      student_no: row.student_no,
      anon_code: null,
      class_id: row.class_id,
      class_name: row.class_name,
      balance: Number(row.balance),
      last_change_seq: Number(row.last_change_seq),
    })),
  );
}

/* ------------------------------------------------------------------ */
/* 模板（有效值 = 全局基线 + 班级覆盖）                                 */
/* ------------------------------------------------------------------ */

export async function createGlobalTemplate(
  actorId: string,
  input: { name: string; polarity: Polarity; default_delta: number; sort_order?: number; request_id: string },
  db: Db = defaultDb,
) {
  assertDeltaSign(input.default_delta, input.polarity);
  return idempotentTx(db, input.request_id, 'POST /api/v1/templates', input, async (tx) => {
    const created = await pointsRepo.createTemplate(tx, {
      name: input.name,
      polarity: input.polarity,
      default_delta: input.default_delta,
      sort_order: input.sort_order,
    });
    await auditRepo.writeAudit(tx, {
      actor: actorId,
      entity: 'reason_template',
      entity_id: created.template_id,
      action: 'created',
      after: { polarity: created.polarity, default_delta: created.default_delta },
      request_id: input.request_id,
    });
    return created;
  });
}

export async function patchGlobalTemplate(
  actorId: string,
  templateId: string,
  input: { name?: string; default_delta?: number; request_id: string },
  db: Db = defaultDb,
) {
  return idempotentTx(db, input.request_id, `PATCH /api/v1/templates/${templateId}`, input, async (tx) => {
    const current = await pointsRepo.findTemplate(tx, templateId);
    if (!current) throw Errors.notFound('原因模板', templateId);
    if (input.default_delta != null) assertDeltaSign(input.default_delta, current.polarity);
    const updated = await pointsRepo.updateTemplate(tx, templateId, {
      name: input.name,
      default_delta: input.default_delta,
    });
    if (!updated) throw Errors.notFound('原因模板', templateId);
    await auditRepo.writeAudit(tx, {
      actor: actorId,
      entity: 'reason_template',
      entity_id: templateId,
      action: 'updated',
      before: { default_delta: current.default_delta },
      after: { default_delta: updated.default_delta },
      request_id: input.request_id,
    });
    return updated;
  });
}

export async function createClassTemplate(
  actorId: string,
  classId: string,
  input: { name: string; polarity: Polarity; default_delta: number; request_id: string },
  db: Db = defaultDb,
) {
  assertDeltaSign(input.default_delta, input.polarity);
  return idempotentTx(
    db,
    input.request_id,
    `POST /api/v1/classes/${classId}/templates`,
    input,
    async (tx) => {
      const cls = await classRepo.findClass(tx, classId);
      if (!cls) throw Errors.notFound('班级', classId);
      const created = await pointsRepo.createTemplate(tx, {
        name: input.name,
        polarity: input.polarity,
        default_delta: input.default_delta,
      });
      await tx.execute(
        sql`UPDATE reason_template SET hidden_by_default = true WHERE template_id = ${created.template_id}`,
      );
      await pointsRepo.upsertClassOverride(tx, classId, created.template_id, {
        hidden: false,
        added_in_class: true,
      });
      await auditRepo.writeAudit(tx, {
        actor: actorId,
        entity: 'reason_template',
        entity_id: created.template_id,
        action: 'created_in_class',
        after: { class_id: classId, polarity: input.polarity, default_delta: input.default_delta },
        request_id: input.request_id,
      });
      return { ...created, hidden_by_default: true, added_in_class: true };
    },
  );
}

export async function overrideTemplate(
  actorId: string,
  classId: string,
  templateId: string,
  input: { name?: string | null; default_delta?: number | null; hidden?: boolean | null; request_id: string },
  db: Db = defaultDb,
) {
  return idempotentTx(
    db,
    input.request_id,
    `POST /api/v1/classes/${classId}/templates/${templateId}/override`,
    input,
    async (tx) => {
      const tpl = await pointsRepo.findTemplate(tx, templateId);
      if (!tpl) throw Errors.notFound('原因模板', templateId);
      if (input.default_delta != null) assertDeltaSign(input.default_delta, tpl.polarity);
      await pointsRepo.upsertClassOverride(tx, classId, templateId, {
        name: input.name,
        default_delta: input.default_delta,
        hidden: input.hidden,
      });
      await auditRepo.writeAudit(tx, {
        actor: actorId,
        entity: 'class_template_override',
        entity_id: `${classId}:${templateId}`,
        action: 'overridden',
        after: { default_delta: input.default_delta ?? null, hidden: input.hidden ?? null },
        request_id: input.request_id,
      });
      return listEffectiveTemplates(classId, tx);
    },
  );
}

export async function clearTemplateOverride(
  actorId: string,
  classId: string,
  templateId: string,
  requestId: string,
  db: Db = defaultDb,
) {
  return idempotentTx(
    db,
    requestId,
    `DELETE /api/v1/classes/${classId}/templates/${templateId}/override`,
    { request_id: requestId },
    async (tx) => {
      await pointsRepo.deleteClassOverride(tx, classId, templateId);
      await auditRepo.writeAudit(tx, {
        actor: actorId,
        entity: 'class_template_override',
        entity_id: `${classId}:${templateId}`,
        action: 'cleared',
        request_id: requestId,
      });
      return { ok: true };
    },
  );
}

function assertDeltaSign(delta: number, polarity: Polarity) {
  if (delta === 0 || Math.sign(delta) !== polarity) {
    throw Errors.polarityMismatch('默认分值的符号必须与模板方向一致');
  }
}

export async function listEffectiveTemplates(
  classId: string,
  db: Db = defaultDb,
): Promise<
  {
    template_id: string;
    effective_name: string;
    effective_delta: number;
    hidden: boolean;
    polarity: Polarity;
    added_in_class: boolean;
    has_override: boolean;
    sort_order: number;
  }[]
> {
  const [templates, overrides] = await Promise.all([
    pointsRepo.listTemplates(db),
    pointsRepo.listClassOverrides(db, classId),
  ]);

  const ovByTpl = new Map(overrides.map((o) => [o.template_id, o]));

  return templates
    .map((t) => {
      const ov = ovByTpl.get(t.template_id);
      return {
        template_id: t.template_id,
        effective_name: ov?.name ?? t.name,
        effective_delta: ov?.default_delta ?? t.default_delta,
        hidden: ov?.hidden ?? t.hidden_by_default,
        polarity: t.polarity,
        added_in_class: ov?.added_in_class ?? false,
        has_override: ov != null,
        sort_order: t.sort_order,
      };
    })
    .filter((t) => !t.hidden || t.has_override)
    .sort((a, b) => a.sort_order - b.sort_order || a.effective_name.localeCompare(b.effective_name));
}
