/**
 * 学生与座次数据访问：student / seat_assignment / mark_def / student_mark。
 *
 * 约定（A1/A11）：
 * - 任何引用学生用 student_id（UUID），学号只是班内唯一属性。
 * - 离班 = 状态转移，永不删除；恢复必须指定座位。
 * - 座次唯一性由 uq_seat_assign_student 物理保证。
 */

import { sql, type Db, type Tx, now, uuid as genUuid } from './db.js';
import type { LeftReason, StudentStatus } from '../lib/schema.js';

export interface StudentRow {
  student_id: string;
  class_id: string;
  student_no: string;
  name: string;
  remark: string | null;
  status: StudentStatus;
  left_reason: LeftReason | null;
  left_note: string | null;
  left_at: Date | null;
  anon_code: string | null;
  anon_at: Date | null;
  created_at: Date;
}

export interface StudentSeatRow {
  student_id: string;
  seat_id: string;
  seat_number: number | null;
  column_code: string;
  sort_in_column: number;
}

export interface SeatOccupancyRow {
  seat_id: string;
  seat_number: number;
  column_code: string;
  sort_in_column: number;
  student_id: string | null;
  student_no: string | null;
  student_name: string | null;
}

/** 班级学生列表。 */
export async function listStudents(
  db: Db | Tx,
  classId: string,
  opts: { status?: StudentStatus | 'all'; q?: string } = {},
): Promise<StudentRow[]> {
  const statusFilter =
    !opts.status || opts.status === 'all'
      ? sql`true`
      : sql`status = ${opts.status}`;

  const qFilter = opts.q
    ? sql`AND (name ILIKE ${'%' + opts.q + '%'} OR student_no ILIKE ${'%' + opts.q + '%'})`
    : sql``;

  const rows = await db.execute<StudentRow>(
    sql`SELECT student_id, class_id, student_no, name, remark, status,
               left_reason, left_note, left_at, anon_code, anon_at, created_at
        FROM student
        WHERE class_id = ${classId} AND ${statusFilter} ${qFilter}
        ORDER BY student_no`,
  );
  return rows;
}

/** 在班学生（含座位）。 */
export async function listActiveStudentsWithSeats(
  db: Db | Tx,
  classId: string,
): Promise<(StudentRow & { seat: StudentSeatRow | null })[]> {
  const students = await listStudents(db, classId, { status: 'active' });
  const seats = await listClassSeats(db, classId);
  const seatByStudent = new Map(
    seats
      .filter((s): s is SeatOccupancyRow & { student_id: string } => s.student_id != null)
      .map((s) => [
        s.student_id,
        {
          student_id: s.student_id,
          seat_id: s.seat_id,
          seat_number: s.seat_number,
          column_code: s.column_code,
          sort_in_column: s.sort_in_column,
        },
      ]),
  );

  return students.map((s) => ({
    ...s,
    seat: seatByStudent.get(s.student_id) ?? null,
  }));
}

/** 查询学生。 */
export async function findStudent(db: Db | Tx, studentId: string): Promise<StudentRow | null> {
  const rows = await db.execute<StudentRow>(
    sql`SELECT student_id, class_id, student_no, name, remark, status,
               left_reason, left_note, left_at, anon_code, anon_at, created_at
        FROM student WHERE student_id = ${studentId}`,
  );
  return rows[0] ?? null;
}

/** 按学号查学生（班内）。 */
export async function findStudentByNo(
  db: Db | Tx,
  classId: string,
  studentNo: string,
): Promise<StudentRow | null> {
  const rows = await db.execute<StudentRow>(
    sql`SELECT student_id, class_id, student_no, name, remark, status,
               left_reason, left_note, left_at, anon_code, anon_at, created_at
        FROM student WHERE class_id = ${classId} AND student_no = ${studentNo}
        ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'left' THEN 1 ELSE 2 END
        LIMIT 1`,
  );
  return rows[0] ?? null;
}

/** 创建学生。 */
export async function createStudent(
  db: Db | Tx,
  input: {
    class_id: string;
    student_no: string;
    name: string;
    remark?: string | null;
  },
): Promise<StudentRow> {
  const rows = await db.execute<StudentRow>(
    sql`INSERT INTO student (class_id, student_no, name, remark)
        VALUES (${input.class_id}, ${input.student_no}, ${input.name}, ${input.remark ?? null})
        RETURNING student_id, class_id, student_no, name, remark, status,
                  left_reason, left_note, left_at, anon_code, anon_at, created_at`,
  );
  return rows[0]!;
}

/** 更新学生（改名/改学号不改内部身份）。 */
export async function updateStudent(
  db: Db | Tx,
  studentId: string,
  patch: { student_no?: string; name?: string; remark?: string | null },
): Promise<StudentRow | null> {
  const rows = await db.execute<StudentRow>(
    sql`UPDATE student
        SET student_no = COALESCE(${patch.student_no ?? null}, student_no),
            name = COALESCE(${patch.name ?? null}, name),
            remark = CASE WHEN ${patch.remark === undefined} THEN remark ELSE ${patch.remark ?? null} END
        WHERE student_id = ${studentId}
        RETURNING student_id, class_id, student_no, name, remark, status,
                  left_reason, left_note, left_at, anon_code, anon_at, created_at`,
  );
  return rows[0] ?? null;
}

/**
 * 离班：释放座位 + 标记状态。
 * 座位释放由调用方在同一事务内删除 seat_assignment。
 */
export async function markStudentLeft(
  db: Tx,
  studentId: string,
  reason: LeftReason,
  note: string | null,
): Promise<StudentRow | null> {
  const rows = await db.execute<StudentRow>(
    sql`UPDATE student
        SET status = 'left', left_reason = ${reason}, left_note = ${note}, left_at = ${now()}
        WHERE student_id = ${studentId} AND status = 'active'
        RETURNING student_id, class_id, student_no, name, remark, status,
                  left_reason, left_note, left_at, anon_code, anon_at, created_at`,
  );
  return rows[0] ?? null;
}

/** 恢复学生（必须同时指定座位）。 */
export async function restoreStudent(db: Tx, studentId: string): Promise<StudentRow | null> {
  const rows = await db.execute<StudentRow>(
    sql`UPDATE student
        SET status = 'active', left_reason = NULL, left_note = NULL, left_at = NULL
        WHERE student_id = ${studentId} AND status = 'left'
        RETURNING student_id, class_id, student_no, name, remark, status,
                  left_reason, left_note, left_at, anon_code, anon_at, created_at`,
  );
  return rows[0] ?? null;
}

/**
 * 匿名化：清空姓名/学号/备注，保留 anon_code。
 * 历史数值及事件保留。
 */
export async function anonymizeStudent(
  db: Tx,
  studentId: string,
  anonCode: string,
): Promise<StudentRow | null> {
  const rows = await db.execute<StudentRow>(
    sql`UPDATE student
        SET status = 'anonymized',
            name = '',
            student_no = '',
            remark = NULL,
            anon_code = ${anonCode},
            anon_at = ${now()}
        WHERE student_id = ${studentId}
        RETURNING student_id, class_id, student_no, name, remark, status,
                  left_reason, left_note, left_at, anon_code, anon_at, created_at`,
  );
  return rows[0] ?? null;
}

/** 生成下一个匿名代号（班内递增）。 */
export async function nextAnonCode(db: Db | Tx, classId: string): Promise<string> {
  const rows = await db.execute<{ cnt: number }>(
    sql`SELECT COUNT(*)::int AS cnt FROM student
        WHERE class_id = ${classId} AND status = 'anonymized'`,
  );
  const n = (rows[0]?.cnt ?? 0) + 1;
  return `匿名-${n}`;
}

/* ------------------------------------------------------------------ */
/* 座次                                                                */
/* ------------------------------------------------------------------ */

/** 班级座次（含占用学生）。 */
export async function listClassSeats(db: Db | Tx, classId: string): Promise<SeatOccupancyRow[]> {
  const rows = await db.execute<SeatOccupancyRow>(
    sql`SELECT s.seat_id, COALESCE(s.seat_number, 0) AS seat_number, c.code AS column_code,
               s.sort_in_column, sa.student_id, st.student_no, st.name AS student_name
        FROM room_slot s
        JOIN room_column c ON c.column_id = s.column_id
        LEFT JOIN seat_assignment sa ON sa.seat_id = s.seat_id AND sa.class_id = ${classId}
        LEFT JOIN student st ON st.student_id = sa.student_id
        ORDER BY c.display_order, s.sort_in_column`,
  );
  return rows;
}

/** 查询某座位在某班的占用者。 */
export async function findSeatOccupant(
  db: Db | Tx,
  classId: string,
  seatId: string,
): Promise<{ student_id: string } | null> {
  const rows = await db.execute<{ student_id: string }>(
    sql`SELECT student_id FROM seat_assignment WHERE class_id = ${classId} AND seat_id = ${seatId}`,
  );
  return rows[0] ?? null;
}

/** 查询某学生的座位。 */
export async function findStudentSeat(
  db: Db | Tx,
  classId: string,
  studentId: string,
): Promise<StudentSeatRow | null> {
  const rows = await db.execute<StudentSeatRow>(
    sql`SELECT sa.student_id, sa.seat_id, s.seat_number, c.code AS column_code, s.sort_in_column
        FROM seat_assignment sa
        JOIN room_slot s ON s.seat_id = sa.seat_id
        JOIN room_column c ON c.column_id = s.column_id
        WHERE sa.class_id = ${classId} AND sa.student_id = ${studentId}`,
  );
  return rows[0] ?? null;
}

/** 占用座位（幂等：已占用同一学生则无操作）。 */
export async function assignSeat(
  db: Tx,
  classId: string,
  seatId: string,
  studentId: string,
  termId: string,
): Promise<void> {
  await db.execute(
    sql`INSERT INTO seat_assignment (class_id, seat_id, student_id, term_id, updated_at)
        VALUES (${classId}, ${seatId}, ${studentId}, ${termId}, ${now()})
        ON CONFLICT (class_id, seat_id) DO UPDATE
          SET student_id = EXCLUDED.student_id, term_id = EXCLUDED.term_id, updated_at = ${now()}`,
  );
}

/** 释放座位。 */
export async function releaseSeat(db: Tx, classId: string, seatId: string): Promise<void> {
  await db.execute(
    sql`DELETE FROM seat_assignment WHERE class_id = ${classId} AND seat_id = ${seatId}`,
  );
}

/** 释放某学生的座位。 */
export async function releaseStudentSeat(db: Tx, classId: string, studentId: string): Promise<void> {
  await db.execute(
    sql`DELETE FROM seat_assignment WHERE class_id = ${classId} AND student_id = ${studentId}`,
  );
}

/**
 * 批量提交换座（整份映射替换）。
 * 调用方在同一事务内：先释放来源座位，再写目标座位。
 */
export async function applySeatAssignments(
  db: Tx,
  classId: string,
  termId: string,
  assignments: { student_id: string; seat_id: string }[],
): Promise<void> {
  // 先清空这些学生的现有座次（避免 uq_seat_assign_student 冲突）
  const studentIds = assignments.map((a) => a.student_id);
  if (studentIds.length > 0) {
    await db.execute(
      sql`DELETE FROM seat_assignment
          WHERE class_id = ${classId} AND student_id = ANY(${sql.param(studentIds)}::uuid[])`,
    );
  }

  // 目标座位可能被这批学生之外的人占用 → 由调用方的 P3 校验保证不会发生
  for (const a of assignments) {
    await db.execute(
      sql`INSERT INTO seat_assignment (class_id, seat_id, student_id, term_id, updated_at)
          VALUES (${classId}, ${a.seat_id}, ${a.student_id}, ${termId}, ${now()})`,
    );
  }
}

/** 无座在班学生清单（导入阻塞检查）。 */
export async function studentsWithoutSeat(
  db: Db | Tx,
  classId: string,
): Promise<StudentRow[]> {
  const rows = await db.execute<StudentRow>(
    sql`SELECT s.student_id, s.class_id, s.student_no, s.name, s.remark, s.status,
               s.left_reason, s.left_note, s.left_at, s.anon_code, s.anon_at, s.created_at
        FROM student s
        LEFT JOIN seat_assignment sa ON sa.student_id = s.student_id AND sa.class_id = s.class_id
        WHERE s.class_id = ${classId} AND s.status = 'active' AND sa.seat_id IS NULL
        ORDER BY s.student_no`,
  );
  return rows;
}

/** 在班人数。 */
export async function countActiveStudents(db: Db | Tx, classId: string): Promise<number> {
  const rows = await db.execute<{ cnt: number }>(
    sql`SELECT COUNT(*)::int AS cnt FROM student WHERE class_id = ${classId} AND status = 'active'`,
  );
  return rows[0]?.cnt ?? 0;
}

/** 机位总数（超员检查）。 */
export async function countSlots(db: Db | Tx): Promise<number> {
  const rows = await db.execute<{ cnt: number }>(
    sql`SELECT COUNT(*)::int AS cnt FROM room_slot`,
  );
  return rows[0]?.cnt ?? 0;
}

/* ------------------------------------------------------------------ */
/* 普通标记                                                            */
/* ------------------------------------------------------------------ */

export interface MarkDefRow {
  mark_id: string;
  name: string;
  icon: string;
  color: string;
  sort_order: number;
  archived_at: Date | null;
}

export async function listMarkDefs(db: Db | Tx): Promise<MarkDefRow[]> {
  const rows = await db.execute<MarkDefRow>(
    sql`SELECT mark_id, name, icon, color, sort_order, archived_at
        FROM mark_def WHERE archived_at IS NULL ORDER BY sort_order, name`,
  );
  return rows;
}

export async function createMarkDef(
  db: Db | Tx,
  input: { name: string; icon: string; color: string; sort_order?: number },
): Promise<MarkDefRow> {
  const rows = await db.execute<MarkDefRow>(
    sql`INSERT INTO mark_def (name, icon, color, sort_order)
        VALUES (${input.name}, ${input.icon}, ${input.color}, ${input.sort_order ?? 0})
        RETURNING mark_id, name, icon, color, sort_order, archived_at`,
  );
  return rows[0]!;
}

/** 学生的标记 ID 清单。 */
export async function listStudentMarks(
  db: Db | Tx,
  studentIds: string[],
): Promise<Map<string, string[]>> {
  if (studentIds.length === 0) return new Map();
  const rows = await db.execute<{ student_id: string; mark_id: string }>(
    sql`SELECT student_id, mark_id FROM student_mark WHERE student_id = ANY(${sql.param(studentIds)}::uuid[])`,
  );
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const arr = map.get(r.student_id) ?? [];
    arr.push(r.mark_id);
    map.set(r.student_id, arr);
  }
  return map;
}

/** 打标（幂等）。 */
export async function addStudentMark(db: Tx, studentId: string, markId: string): Promise<void> {
  await db.execute(
    sql`INSERT INTO student_mark (student_id, mark_id) VALUES (${studentId}, ${markId})
        ON CONFLICT (student_id, mark_id) DO NOTHING`,
  );
}

/** 取消打标。 */
export async function removeStudentMark(db: Tx, studentId: string, markId: string): Promise<void> {
  await db.execute(
    sql`DELETE FROM student_mark WHERE student_id = ${studentId} AND mark_id = ${markId}`,
  );
}
