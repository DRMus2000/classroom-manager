/**
 * 点名轮次。判定在 domain/rollcall.ts。
 */

import { sql, type Db, type Tx } from './db.js';

export interface RollcallRow {
  rollcall_id: string;
  class_id: string;
  scope_desc: unknown;
  exclude_list: unknown;
  picked_ids: unknown;
  status: 'open' | 'closed';
  created_at: Date | string;
  closed_at: Date | string | null;
}

export interface ClassStudentRow {
  student_id: string;
  name: string;
  status: 'active' | 'left' | 'anonymized';
  seat_number: number | null;
}

export async function lockClass(tx: Tx, classId: string): Promise<boolean> {
  const rows = await tx.execute<{ class_id: string }>(
    sql`SELECT class_id FROM class WHERE class_id = ${classId} FOR UPDATE`,
  );
  return rows.length > 0;
}

export async function listClassStudents(db: Db | Tx, classId: string): Promise<ClassStudentRow[]> {
  return db.execute<ClassStudentRow>(
    sql`SELECT s.student_id, s.name, s.status, rs.seat_number
        FROM student s
        LEFT JOIN seat_assignment sa ON sa.class_id = s.class_id AND sa.student_id = s.student_id
        LEFT JOIN room_slot rs ON rs.seat_id = sa.seat_id
        WHERE s.class_id = ${classId}`,
  );
}

export async function findOpenRound(db: Db | Tx, classId: string): Promise<RollcallRow | null> {
  const rows = await db.execute<RollcallRow>(
    sql`SELECT rollcall_id, class_id, scope_desc, exclude_list, picked_ids, status, created_at, closed_at
        FROM rollcall_round
        WHERE class_id = ${classId} AND status = 'open'`,
  );
  return rows[0] ?? null;
}

export async function findRound(db: Db | Tx, rollcallId: string): Promise<RollcallRow | null> {
  const rows = await db.execute<RollcallRow>(
    sql`SELECT rollcall_id, class_id, scope_desc, exclude_list, picked_ids, status, created_at, closed_at
        FROM rollcall_round
        WHERE rollcall_id = ${rollcallId}`,
  );
  return rows[0] ?? null;
}

export async function lockRound(tx: Tx, rollcallId: string): Promise<RollcallRow | null> {
  const rows = await tx.execute<RollcallRow>(
    sql`SELECT rollcall_id, class_id, scope_desc, exclude_list, picked_ids, status, created_at, closed_at
        FROM rollcall_round
        WHERE rollcall_id = ${rollcallId}
        FOR UPDATE`,
  );
  return rows[0] ?? null;
}

export async function insertRound(
  tx: Tx,
  input: { class_id: string; scope: unknown; exclude_ids: string[] },
): Promise<RollcallRow> {
  const rows = await tx.execute<RollcallRow>(
    sql`INSERT INTO rollcall_round (class_id, scope_desc, exclude_list, picked_ids)
        VALUES (${input.class_id}, ${JSON.stringify(input.scope)}, ${JSON.stringify(input.exclude_ids)}, '[]')
        RETURNING rollcall_id, class_id, scope_desc, exclude_list, picked_ids, status, created_at, closed_at`,
  );
  return rows[0]!;
}

export async function saveRoundLists(
  tx: Tx,
  rollcallId: string,
  excludeIds: string[],
  pickedIds: string[],
): Promise<void> {
  await tx.execute(
    sql`UPDATE rollcall_round
        SET exclude_list = ${JSON.stringify(excludeIds)},
            picked_ids = ${JSON.stringify(pickedIds)}
        WHERE rollcall_id = ${rollcallId}`,
  );
}

export async function closeRound(tx: Tx, rollcallId: string): Promise<void> {
  await tx.execute(
    sql`UPDATE rollcall_round
        SET status = 'closed', closed_at = now()
        WHERE rollcall_id = ${rollcallId} AND status = 'open'`,
  );
}
