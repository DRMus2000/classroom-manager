/**
 * 座次与换座服务。
 *
 * 约定（A12 / §3.2）：
 * - 换座走 planSwap()：重叠按轮换链处理，受影响的未选中学生一并写入。
 * - 提交必须携带 expected_version；版本不符 → 409，要求载入最新状态。
 * - 积分快照记录操作当时的座位号（永不回溯），故换座不修改任何历史明细。
 */

import { type Db, db as defaultDb } from '../repo/db.js';
import { idempotentTx } from './idempotency.js';
import * as studentRepo from '../repo/student.js';
import * as classRepo from '../repo/class.js';
import * as pointsRepo from '../repo/points.js';
import * as layoutRepo from '../repo/layout.js';
import * as auditRepo from '../repo/audit.js';
import { planSwap, type SeatOccupancy } from '../domain/seatMove.js';
import { Errors } from '../lib/errors.js';
import type {
  ClassSeatsDto,
  SeatCardDto,
  SeatPlanIssue,
  SeatAssignmentsInput,
  PlanSeatsInput,
  RoomColumnDto,
} from '../lib/schema.js';

/* ------------------------------------------------------------------ */
/* 座次图查询                                                          */
/* ------------------------------------------------------------------ */

export async function getClassSeats(
  classId: string,
  termId: string,
  db: Db = defaultDb,
): Promise<ClassSeatsDto> {
  const cls = await classRepo.findClass(db, classId);
  if (!cls) throw Errors.notFound('班级', classId);

  const activeStudents = await studentRepo.listActiveStudentsWithSeats(db, classId);

  const [seats, marks, rawColumns, balances] = await Promise.all([
    studentRepo.listClassSeats(db, classId),
    studentRepo.listStudentMarks(
      db,
      activeStudents.map((s) => s.student_id),
    ),
    layoutRepo.listColumns(db),
    pointsRepo.listBalancesForStudents(
      db,
      termId,
      activeStudents.map((s) => s.student_id),
    ),
  ]);

  const activeSeatByStudent = new Map(
    activeStudents.filter((s) => s.seat).map((s) => [s.student_id, s]),
  );

  const cards: SeatCardDto[] = seats.map((seat) => {
    const student = seat.student_id ? activeSeatByStudent.get(seat.student_id) : undefined;
    return {
      seat_id: seat.seat_id,
      seat_number: seat.seat_number,
      column_code: seat.column_code,
      sort_in_column: seat.sort_in_column,
      facing: 'right', // 由列配置填充（见下方 columns 组装）
      student: student
        ? {
            student_id: student.student_id,
            name: student.name,
            student_no: student.student_no,
            balance: balances.get(student.student_id) ?? 0,
            marks: marks.get(student.student_id) ?? [],
            duty: null, // 第二阶段填充
          }
        : null,
    };
  });

  // 组装列（含 facing）
  const columnDtos: RoomColumnDto[] = rawColumns.map((c) => ({
    column_id: c.column_id,
    code: c.code,
    display_order: c.display_order,
    direction: c.direction,
    facing: c.facing,
    label: c.label,
    slot_count: seats.filter((s) => s.column_code === c.code).length,
  }));

  // 回填每张卡的 facing
  const facingByColumn = new Map(columnDtos.map((c) => [c.code, c.facing]));
  for (const card of cards) {
    card.facing = facingByColumn.get(card.column_code) ?? 'right';
  }

  return {
    class_id: classId,
    seat_version: cls.seat_version,
    term_id: termId,
    columns: columnDtos,
    cards,
  };
}

/* ------------------------------------------------------------------ */
/* 换座求值（不落库）                                                  */
/* ------------------------------------------------------------------ */

export interface PlanResult {
  ok: boolean;
  assignments: {
    student_id: string;
    from_seat_id: string;
    to_seat_id: string;
    role: 'selected' | 'affected';
  }[];
  issues: SeatPlanIssue[];
}

export async function planSeats(
  classId: string,
  input: PlanSeatsInput,
  db: Db = defaultDb,
): Promise<PlanResult> {
  const seats = await studentRepo.listClassSeats(db, classId);

  const occupancies: SeatOccupancy[] = seats.map((s) => ({
    seat_id: s.seat_id,
    seat_number: s.seat_number,
    student_id: s.student_id,
  }));

  const plan = planSwap(occupancies, input.source_student_ids, input.target_seat_ids);

  return {
    ok: plan.ok,
    assignments: plan.assignments,
    issues: plan.issues.map((i) => ({
      code: i.code,
      message: i.message,
      offending_seat_ids: i.offending_seat_ids ?? [],
    })),
  };
}

/* ------------------------------------------------------------------ */
/* 换座提交                                                            */
/* ------------------------------------------------------------------ */

export async function applySeatAssignments(
  classId: string,
  termId: string,
  actorId: string,
  input: SeatAssignmentsInput,
  db: Db = defaultDb,
): Promise<{ seat_version: number }> {
  return idempotentTx(
    db,
    input.request_id,
    `POST /api/v1/classes/${classId}/seats/apply`,
    input,
    async (tx) => {
    // 锁班级行（并发保护）
    const cls = await classRepo.lockClass(tx, classId);
    if (!cls) throw Errors.notFound('班级', classId);
    if (cls.archived_at) throw Errors.forbidden('班级已归档，无法修改座次');

    // 乐观锁：版本必须匹配
    if (cls.seat_version !== input.expected_version) {
      throw Errors.versionConflict(
        `座次已被其他设备修改（当前版本 ${cls.seat_version}，提交版本 ${input.expected_version}）`,
      );
    }

    // 服务端权威校验：重新跑一遍 planSwap（防止前端伪造）
    const seats = await studentRepo.listClassSeats(tx, classId);
    const occupancies: SeatOccupancy[] = seats.map((s) => ({
      seat_id: s.seat_id,
      seat_number: s.seat_number,
      student_id: s.student_id,
    }));

    const sourceIds = [...new Set(input.assignments.map((a) => a.student_id))];
    const targetIds = [...new Set(input.assignments.map((a) => a.seat_id))];

    const plan = planSwap(occupancies, sourceIds, targetIds);
    if (!plan.ok) {
      throw Errors.seatMoveUnbalanced(plan.issues.map((i) => i.message).join('；'));
    }

    const selected = plan.assignments.filter((a) => a.role === 'selected');
    const submitted = new Map(input.assignments.map((a) => [a.student_id, a.seat_id]));
    const matches =
      selected.length === submitted.size &&
      selected.every((a) => submitted.get(a.student_id) === a.to_seat_id);
    if (!matches) {
      throw Errors.seatMoveUnbalanced('提交的分配与服务端重算结果不一致');
    }

    await studentRepo.applySeatAssignments(
      tx,
      classId,
      termId,
      plan.assignments.map((a) => ({ student_id: a.student_id, seat_id: a.to_seat_id })),
    );

    // 变更后仍必须无无座学生
    const after = await studentRepo.studentsWithoutSeat(tx, classId);
    if (after.length > 0) {
      throw Errors.studentNoSeat(after.map((s) => s.student_no));
    }

    const newVersion = await classRepo.bumpSeatVersion(tx, classId);

    await auditRepo.writeAudit(tx, {
      actor: actorId,
      entity: 'seat_assignment',
      entity_id: classId,
      action: 'swap_applied',
      before: { version: cls.seat_version, assignments: input.assignments.length },
      after: { version: newVersion, assignments: input.assignments },
      request_id: input.request_id,
    });

    await auditRepo.writeEvent(tx, {
      class_id: classId,
      kind: 'seat_changed',
      payload: { class_id: classId, version: newVersion, assignments: input.assignments },
    });

    return { seat_version: newVersion };
  });
}
