/**
 * 回放读取。检查点由独立任务写入，不在记分事务里调用。
 */

import { sql, type Db, db as defaultDb } from '../repo/db.js';
import { assignRanks } from '../domain/points.js';
import type { ReplayMode } from '../lib/schema.js';

export const CHECKPOINT_EVENT_THRESHOLD = 200;

export function shouldWriteCheckpoint(eventsSinceLast: number, dailyDue: boolean): boolean {
  if (!Number.isFinite(eventsSinceLast) || eventsSinceLast < 0) return false;
  return dailyDue || eventsSinceLast >= CHECKPOINT_EVENT_THRESHOLD;
}

export async function replayTimeline(
  input: { termId: string; classId: string; from: string; to: string; mode: ReplayMode },
  db: Db = defaultDb,
) {
  const frames = await db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM event_log
    WHERE replay_relevant
      AND occurred_at >= ${input.from} AND occurred_at <= ${input.to}
      AND (${input.classId}::uuid IS NULL OR class_id = ${input.classId} OR class_id IS NULL)
  `);
  const checkpoints = await db.execute<{ upto_event_seq: number; created_at: Date | string }>(sql`
    SELECT upto_event_seq, created_at FROM replay_checkpoint
    WHERE term_id = ${input.termId} AND class_id = ${input.classId}
    ORDER BY upto_event_seq
  `);
  const density = await db.execute<{ at: Date | string; frames: number }>(sql`
    SELECT date_trunc('day', occurred_at) AS at, COUNT(*)::int AS frames
    FROM event_log
    WHERE replay_relevant
      AND occurred_at >= ${input.from} AND occurred_at <= ${input.to}
      AND (class_id = ${input.classId} OR class_id IS NULL)
    GROUP BY 1 ORDER BY 1
  `);
  return {
    mode: input.mode,
    from: input.from,
    to: input.to,
    base_state: [],
    frame_count: Number(frames[0]?.n ?? 0),
    checkpoints: checkpoints.map((row) => ({
      upto_event_seq: Number(row.upto_event_seq),
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    })),
    density: density.map((row) => ({
      at: row.at instanceof Date ? row.at.toISOString() : String(row.at),
      frames: Number(row.frames),
    })),
  };
}

export async function replayFrames(
  input: { termId: string; classId: string; from: string; to: string; mode: ReplayMode; cursor?: string; limit: number },
  db: Db = defaultDb,
) {
  const cursor = input.cursor ? Number(input.cursor) : 0;
  const rows = await db.execute<{
    event_seq: number;
    kind: string;
    occurred_at: Date | string;
    payload: unknown;
  }>(sql`
    SELECT event_seq, kind, occurred_at, payload FROM event_log
    WHERE replay_relevant
      AND event_seq > ${cursor}
      AND occurred_at >= ${input.from} AND occurred_at <= ${input.to}
      AND (class_id = ${input.classId} OR class_id IS NULL)
    ORDER BY event_seq
    LIMIT ${input.limit + 1}
  `);
  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const items = [];
  for (const row of page) {
    items.push({
      event_seq: Number(row.event_seq),
      kind: row.kind,
      occurred_at: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at),
      mode: input.mode,
      top10: await rankingAt(input.termId, input.classId, Number(row.event_seq), db),
    });
  }
  const last = page[page.length - 1];
  return {
    items,
    next_cursor: hasMore && last ? String(Number(last.event_seq)) : null,
  };
}

export async function replayStateAt(
  input: { termId: string; classId: string; at: string; mode: ReplayMode },
  db: Db = defaultDb,
) {
  const seq = await db.execute<{ event_seq: number }>(sql`
    SELECT COALESCE(MAX(event_seq), 0)::bigint AS event_seq FROM event_log
    WHERE replay_relevant AND occurred_at <= ${input.at}
      AND (class_id = ${input.classId} OR class_id IS NULL)
  `);
  return {
    at: input.at,
    mode: input.mode,
    ranking: await rankingAt(input.termId, input.classId, Number(seq[0]?.event_seq ?? 0), db),
  };
}

async function rankingAt(termId: string, classId: string, uptoSeq: number, db: Db) {
  const rows = await db.execute<{
    student_id: string;
    name: string;
    student_no: string;
    class_id: string;
    class_name: string;
    balance: number;
    last_change_seq: number;
  }>(sql`
    SELECT st.student_id, st.name, st.student_no, st.class_id, c.name AS class_name,
           COALESCE(SUM(pe.delta), 0)::int AS balance,
           COALESCE(MAX(pe.seq), 0)::bigint AS last_change_seq
    FROM point_entry pe
    JOIN student st ON st.student_id = pe.student_id
    JOIN class c ON c.class_id = st.class_id
    WHERE pe.term_id = ${termId}
      AND pe.class_id_snapshot = ${classId}
      AND pe.seq <= ${uptoSeq}
      AND st.status = 'active'
    GROUP BY st.student_id, st.name, st.student_no, st.class_id, c.name
    ORDER BY balance DESC, last_change_seq ASC, c.name, st.student_no
    LIMIT 10
  `);
  return assignRanks(
    rows.map((row) => ({
      ...row,
      balance: Number(row.balance),
      last_change_seq: Number(row.last_change_seq),
    })),
  );
}
