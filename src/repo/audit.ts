/**
 * 审计与事件流数据访问：audit_log / event_log。
 *
 * 约定（第11项）：
 * - 审计记录与业务变更同事务写入，不依赖前端收到通知后才记录。
 * - 事件流的 replay_relevant 标记决定是否计入检查点触发计数。
 */

import { sql, type Db, type Tx, now } from './db.js';
import { afterCommit } from './afterCommit.js';
import { publishEvent } from '../events/broadcaster.js';
import { REPLAY_RELEVANT_KINDS, type EventKind } from '../lib/schema.js';

export interface AuditRow {
  audit_id: number;
  actor: string | null;
  entity: string;
  entity_id: string | null;
  action: string;
  before: unknown;
  after: unknown;
  request_id: string | null;
  created_at: Date;
}

export interface EventRow {
  event_seq: number;
  class_id: string | null;
  kind: EventKind;
  payload: unknown;
  replay_relevant: boolean;
  occurred_at: Date;
}

/** 写审计记录（必须在业务事务内调用）。 */
export async function writeAudit(
  db: Tx,
  input: {
    actor: string | null;
    entity: string;
    entity_id: string | null;
    action: string;
    before?: unknown;
    after?: unknown;
    request_id?: string | null;
    ip?: string | null;
  },
): Promise<void> {
  await db.execute(
    sql`INSERT INTO audit_log (actor, entity, entity_id, action, before, after, request_id, ip)
        VALUES (${input.actor}, ${input.entity}, ${input.entity_id}, ${input.action},
                ${input.before !== undefined ? JSON.stringify(input.before) : null},
                ${input.after !== undefined ? JSON.stringify(input.after) : null},
                ${input.request_id ?? null}, ${input.ip ?? null})`,
  );
}

/**
 * 写事件（SSE 推送源）。
 * replay_relevant 由 kind 自动判定：积分追加、名单变更会影响回放。
 */
export async function writeEvent(
  db: Tx,
  input: {
    class_id: string | null;
    kind: EventKind;
    payload: unknown;
  },
): Promise<EventRow> {
  const replayRelevant = REPLAY_RELEVANT_KINDS.includes(input.kind);
  const rows = await db.execute<EventRow>(
    sql`INSERT INTO event_log (class_id, kind, payload, replay_relevant)
        VALUES (${input.class_id}, ${input.kind}, ${JSON.stringify(input.payload)}, ${replayRelevant})
        RETURNING event_seq, class_id, kind, payload, replay_relevant, occurred_at`,
  );
  const row = rows[0]!;
  afterCommit(() => publishEvent(row));
  return row;
}

/** 查询审计（分页）。 */
export async function listAudit(
  db: Db | Tx,
  f: {
    entity?: string;
    entity_id?: string;
    action?: string;
    date_from?: Date;
    date_to?: Date;
    limit?: number;
    cursor_id?: number;
  },
): Promise<AuditRow[]> {
  const conds = [sql`true`];
  if (f.entity) conds.push(sql`entity = ${f.entity}`);
  if (f.entity_id) conds.push(sql`entity_id = ${f.entity_id}`);
  if (f.action) conds.push(sql`action = ${f.action}`);
  if (f.date_from) conds.push(sql`created_at >= ${f.date_from}`);
  if (f.date_to) conds.push(sql`created_at <= ${f.date_to}`);
  if (f.cursor_id != null) conds.push(sql`audit_id < ${f.cursor_id}`);

  const rows = await db.execute<AuditRow>(
    sql`SELECT audit_id, actor, entity, entity_id, action, before, after, request_id, created_at
        FROM audit_log
        WHERE ${sql.join(conds, sql` AND `)}
        ORDER BY audit_id DESC
        LIMIT ${f.limit ?? 50}`,
  );
  return rows;
}

/** 查询事件（SSE 补发用：since 之后的全部事件）。 */
export async function listEventsSince(
  db: Db | Tx,
  sinceSeq: number,
  classId?: string,
  limit = 1000,
): Promise<EventRow[]> {
  const classFilter = classId ? sql`AND (class_id = ${classId} OR class_id IS NULL)` : sql``;
  const rows = await db.execute<EventRow>(
    sql`SELECT event_seq, class_id, kind, payload, replay_relevant, occurred_at
        FROM event_log
        WHERE event_seq > ${sinceSeq} ${classFilter}
        ORDER BY event_seq
        LIMIT ${limit}`,
  );
  return rows;
}

/** 当前最大事件序号。 */
export async function maxEventSeq(db: Db | Tx): Promise<number> {
  const rows = await db.execute<{ max: number | null }>(
    sql`SELECT MAX(event_seq)::bigint AS max FROM event_log`,
  );
  return Number(rows[0]?.max ?? 0);
}

/**
 * 自上次检查点以来新增的 replay_relevant 事件数。
 * 用于判断是否触发"每 N 个事件生成检查点"。
 */
export async function countReplayEventsSince(
  db: Db | Tx,
  classId: string,
  sinceSeq: number,
): Promise<number> {
  const rows = await db.execute<{ cnt: number }>(
    sql`SELECT COUNT(*)::int AS cnt FROM event_log
        WHERE class_id = ${classId} AND event_seq > ${sinceSeq} AND replay_relevant`,
  );
  return rows[0]?.cnt ?? 0;
}

/* ------------------------------------------------------------------ */
/* 回放检查点                                                          */
/* ------------------------------------------------------------------ */

export interface CheckpointRow {
  checkpoint_id: string;
  class_id: string;
  term_id: string;
  upto_event_seq: number;
  state: Record<string, { balance: number; class_id: string }>;
  trigger_reason: 'event_threshold' | 'daily' | 'manual';
  created_at: Date;
}

/** 查询某班级某学期 ≤ 指定序号的最近检查点。 */
export async function findNearestCheckpoint(
  db: Db | Tx,
  classId: string,
  termId: string,
  atOrBeforeSeq: number,
): Promise<CheckpointRow | null> {
  const rows = await db.execute<CheckpointRow>(
    sql`SELECT checkpoint_id, class_id, term_id, upto_event_seq, state, trigger_reason, created_at
        FROM replay_checkpoint
        WHERE class_id = ${classId} AND term_id = ${termId} AND upto_event_seq <= ${atOrBeforeSeq}
        ORDER BY upto_event_seq DESC LIMIT 1`,
  );
  return rows[0] ?? null;
}

/** 最新检查点。 */
export async function latestCheckpoint(
  db: Db | Tx,
  classId: string,
  termId: string,
): Promise<CheckpointRow | null> {
  const rows = await db.execute<CheckpointRow>(
    sql`SELECT checkpoint_id, class_id, term_id, upto_event_seq, state, trigger_reason, created_at
        FROM replay_checkpoint
        WHERE class_id = ${classId} AND term_id = ${termId}
        ORDER BY upto_event_seq DESC LIMIT 1`,
  );
  return rows[0] ?? null;
}

/** 写入检查点。 */
export async function insertCheckpoint(
  db: Db | Tx,
  input: {
    class_id: string;
    term_id: string;
    upto_event_seq: number;
    state: unknown;
    trigger_reason: 'event_threshold' | 'daily' | 'manual';
  },
): Promise<void> {
  await db.execute(
    sql`INSERT INTO replay_checkpoint (class_id, term_id, upto_event_seq, state, trigger_reason)
        VALUES (${input.class_id}, ${input.term_id}, ${input.upto_event_seq},
                ${JSON.stringify(input.state)}, ${input.trigger_reason})
        ON CONFLICT (class_id, term_id, upto_event_seq) DO NOTHING`,
  );
}

/** 读取可调参数。 */
export async function getJobConfig<T>(db: Db | Tx, key: string, fallback: T): Promise<T> {
  const rows = await db.execute<{ value: T }>(
    sql`SELECT value FROM job_config WHERE key = ${key}`,
  );
  return rows[0]?.value ?? fallback;
}

/** 写入可调参数。 */
export async function setJobConfig(db: Db | Tx, key: string, value: unknown): Promise<void> {
  await db.execute(
    sql`INSERT INTO job_config (key, value, updated_at) VALUES (${key}, ${JSON.stringify(value)}, ${now()})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = ${now()}`,
  );
}

/* ------------------------------------------------------------------ */
/* 备份记录                                                            */
/* ------------------------------------------------------------------ */

export interface BackupRow {
  backup_id: string;
  file_name: string;
  size_bytes: number | null;
  disk_free_bytes: number | null;
  status: 'running' | 'success' | 'failed';
  error: string | null;
  started_at: Date;
  finished_at: Date | null;
}

export async function listBackups(db: Db | Tx, limit = 50): Promise<BackupRow[]> {
  const rows = await db.execute<BackupRow>(
    sql`SELECT backup_id, file_name, size_bytes, disk_free_bytes, status, error, started_at, finished_at
        FROM backup_record ORDER BY started_at DESC LIMIT ${limit}`,
  );
  return rows;
}

export async function startBackup(db: Db | Tx, fileName: string): Promise<string> {
  const rows = await db.execute<{ backup_id: string }>(
    sql`INSERT INTO backup_record (file_name, status) VALUES (${fileName}, 'running')
        RETURNING backup_id`,
  );
  return rows[0]!.backup_id;
}

export async function finishBackup(
  db: Db | Tx,
  backupId: string,
  patch: { size_bytes?: number; disk_free_bytes?: number; status: 'success' | 'failed'; error?: string },
): Promise<void> {
  await db.execute(
    sql`UPDATE backup_record
        SET size_bytes = ${patch.size_bytes ?? null},
            disk_free_bytes = ${patch.disk_free_bytes ?? null},
            status = ${patch.status},
            error = ${patch.error ?? null},
            finished_at = ${now()}
        WHERE backup_id = ${backupId}`,
  );
}
