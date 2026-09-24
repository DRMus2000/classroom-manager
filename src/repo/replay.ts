/**
 * 回放读取用的事件与名单查询。检查点写入仍走 audit.insertCheckpoint。
 */

import { sql, type Db, type Tx } from './db.js';
import type { EventKind } from '../lib/schema.js';
import type { ReplayIdentity } from '../domain/replay.js';

export interface ReplayEventRow {
  event_seq: number;
  class_id: string | null;
  kind: EventKind;
  payload: unknown;
  occurred_at: Date;
}

function replayKinds(termId: string) {
  return sql`(kind = 'roster_changed' OR (kind = 'points_appended' AND payload->>'term_id' = ${termId}))`;
}

function classScope(classId: string) {
  return sql`(class_id = ${classId} OR class_id IS NULL)`;
}

export async function countReplayFrames(
  db: Db | Tx,
  input: { termId: string; classId: string; from: string; to: string },
): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM event_log
    WHERE replay_relevant
      AND occurred_at >= ${input.from} AND occurred_at <= ${input.to}
      AND ${classScope(input.classId)}
      AND ${replayKinds(input.termId)}
  `);
  return Number(rows[0]?.n ?? 0);
}

export async function listReplayDensity(
  db: Db | Tx,
  input: { termId: string; classId: string; from: string; to: string },
): Promise<{ at: Date | string; frames: number }[]> {
  return db.execute<{ at: Date | string; frames: number }>(sql`
    SELECT date_trunc('day', occurred_at) AS at, COUNT(*)::int AS frames
    FROM event_log
    WHERE replay_relevant
      AND occurred_at >= ${input.from} AND occurred_at <= ${input.to}
      AND ${classScope(input.classId)}
      AND ${replayKinds(input.termId)}
    GROUP BY 1 ORDER BY 1
  `);
}

export async function listReplayCheckpoints(
  db: Db | Tx,
  classId: string,
  termId: string,
): Promise<{ upto_event_seq: number; created_at: Date | string }[]> {
  return db.execute<{ upto_event_seq: number; created_at: Date | string }>(sql`
    SELECT upto_event_seq, created_at FROM replay_checkpoint
    WHERE term_id = ${termId} AND class_id = ${classId}
    ORDER BY upto_event_seq
  `);
}

export async function listReplayFrameEvents(
  db: Db | Tx,
  input: {
    termId: string;
    classId: string;
    from: string;
    to: string;
    afterSeq: number;
    limit: number;
  },
): Promise<ReplayEventRow[]> {
  return db.execute<ReplayEventRow>(sql`
    SELECT event_seq, class_id, kind, payload, occurred_at FROM event_log
    WHERE replay_relevant
      AND event_seq > ${input.afterSeq}
      AND occurred_at >= ${input.from} AND occurred_at <= ${input.to}
      AND ${classScope(input.classId)}
      AND ${replayKinds(input.termId)}
    ORDER BY event_seq
    LIMIT ${input.limit}
  `);
}

export async function listReplayEventsBetween(
  db: Db | Tx,
  input: { termId: string; classId: string; afterSeq: number; uptoSeq: number },
): Promise<ReplayEventRow[]> {
  if (input.uptoSeq <= input.afterSeq) return [];
  return db.execute<ReplayEventRow>(sql`
    SELECT event_seq, class_id, kind, payload, occurred_at FROM event_log
    WHERE replay_relevant
      AND event_seq > ${input.afterSeq}
      AND event_seq <= ${input.uptoSeq}
      AND ${classScope(input.classId)}
      AND ${replayKinds(input.termId)}
    ORDER BY event_seq
  `);
}

export async function maxReplaySeqAt(
  db: Db | Tx,
  input: { termId: string; classId: string; at: string; inclusive: boolean },
): Promise<number> {
  const timeFilter = input.inclusive
    ? sql`occurred_at <= ${input.at}`
    : sql`occurred_at < ${input.at}`;
  const rows = await db.execute<{ event_seq: number }>(sql`
    SELECT COALESCE(MAX(event_seq), 0)::bigint AS event_seq FROM event_log
    WHERE replay_relevant
      AND ${timeFilter}
      AND ${classScope(input.classId)}
      AND ${replayKinds(input.termId)}
  `);
  return Number(rows[0]?.event_seq ?? 0);
}

export async function maxReplaySeqForClass(
  db: Db | Tx,
  classId: string,
  termId: string,
): Promise<number> {
  const rows = await db.execute<{ event_seq: number }>(sql`
    SELECT COALESCE(MAX(event_seq), 0)::bigint AS event_seq FROM event_log
    WHERE replay_relevant
      AND ${classScope(classId)}
      AND ${replayKinds(termId)}
  `);
  return Number(rows[0]?.event_seq ?? 0);
}

export async function listReplayIdentities(
  db: Db | Tx,
  classId: string,
): Promise<ReplayIdentity[]> {
  return db.execute<ReplayIdentity>(sql`
    SELECT st.student_id, st.class_id, c.name AS class_name,
           st.name, st.student_no, st.anon_code
    FROM student st
    JOIN class c ON c.class_id = st.class_id
    WHERE st.class_id = ${classId}
  `);
}
