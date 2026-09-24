/**
 * 每班一条倒计时。状态机在 domain/countdown.ts。
 */

import { sql, type Db, type Tx } from './db.js';

export interface CountdownRow {
  countdown_id: string;
  class_id: string;
  duration_sec: number;
  status: 'running' | 'paused' | 'reset' | 'finished';
  deadline_at: Date | string | null;
  remaining_sec: number | null;
  updated_at: Date | string;
  updated_by: string | null;
}

export async function findCountdown(db: Db | Tx, classId: string): Promise<CountdownRow | null> {
  const rows = await db.execute<CountdownRow>(
    sql`SELECT countdown_id, class_id, duration_sec, status, deadline_at, remaining_sec, updated_at, updated_by
        FROM countdown_state WHERE class_id = ${classId}`,
  );
  return rows[0] ?? null;
}

export async function lockCountdown(tx: Tx, classId: string): Promise<CountdownRow | null> {
  const rows = await tx.execute<CountdownRow>(
    sql`SELECT countdown_id, class_id, duration_sec, status, deadline_at, remaining_sec, updated_at, updated_by
        FROM countdown_state WHERE class_id = ${classId} FOR UPDATE`,
  );
  return rows[0] ?? null;
}

export async function upsertCountdown(
  tx: Tx,
  input: {
    class_id: string;
    duration_sec: number;
    status: CountdownRow['status'];
    deadline_at: Date | null;
    remaining_sec: number | null;
    updated_by: string | null;
  },
): Promise<CountdownRow> {
  const rows = await tx.execute<CountdownRow>(
    sql`INSERT INTO countdown_state (class_id, duration_sec, status, deadline_at, remaining_sec, updated_at, updated_by)
        VALUES (${input.class_id}, ${input.duration_sec}, ${input.status}, ${input.deadline_at},
                ${input.remaining_sec}, now(), ${input.updated_by})
        ON CONFLICT (class_id) DO UPDATE SET
          duration_sec = EXCLUDED.duration_sec,
          status = EXCLUDED.status,
          deadline_at = EXCLUDED.deadline_at,
          remaining_sec = EXCLUDED.remaining_sec,
          updated_at = now(),
          updated_by = EXCLUDED.updated_by
        RETURNING countdown_id, class_id, duration_sec, status, deadline_at, remaining_sec, updated_at, updated_by`,
  );
  return rows[0]!;
}
