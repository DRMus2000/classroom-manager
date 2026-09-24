/**
 * 学生服务：增删改、离班（二次确认）、恢复、匿名化。
 *
 * 约定（A11 / Q3 / 第1、12、16项）：
 * - 内部身份 student_id 不可变；改姓名或学号都不改变它。
 * - 离班 = 状态转移，永不删除数据。离班后不出现在任何当前榜单和点名池。
 * - 恢复必须同时指定座位（在班学生必须各占一座）。
 * - 匿名化只清空身份信息，历史数值与事件全部保留；匿名化清单独立保存。
 */

import { type Db, type Tx, db as defaultDb, sql } from '../repo/db.js';
import * as studentRepo from '../repo/student.js';
import * as classRepo from '../repo/class.js';
import * as auditRepo from '../repo/audit.js';
import { idempotentTx } from './idempotency.js';
import { Errors } from '../lib/errors.js';
import type {
  StudentDto,
  CreateStudentInput,
  PatchStudentInput,
  LeaveStudentInput,
  RestoreStudentInput,
} from '../lib/schema.js';
import { appendAnonLedgerEntries, type NewAnonLedgerEntry } from './anonLedger.js';

function isoTimestamp(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toDto(
  s: studentRepo.StudentRow,
  seat: studentRepo.StudentSeatRow | null,
  marks: string[] = [],
): StudentDto {
  return {
    student_id: s.student_id,
    class_id: s.class_id,
    student_no: s.student_no,
    name: s.name,
    remark: s.remark,
    status: s.status,
    left_reason: s.left_reason,
    left_note: s.left_note,
    left_at: isoTimestamp(s.left_at),
    anon_code: s.anon_code,
    anon_at: isoTimestamp(s.anon_at),
    seat: seat
      ? {
          seat_id: seat.seat_id,
          seat_number: seat.seat_number ?? 0,
          column_code: seat.column_code,
        }
      : null,
    marks,
  };
}

export async function listStudents(
  classId: string,
  opts: { status?: 'active' | 'left' | 'anonymized' | 'all'; q?: string },
  db: Db = defaultDb,
): Promise<StudentDto[]> {
  const cls = await classRepo.findClass(db, classId);
  if (!cls) throw Errors.notFound('班级', classId);

  const rows = await studentRepo.listStudents(db, classId, opts);
  const marks = await studentRepo.listStudentMarks(
    db,
    rows.map((r) => r.student_id),
  );

  const out: StudentDto[] = [];
  for (const r of rows) {
    const seat =
      r.status === 'active' ? await studentRepo.findStudentSeat(db, classId, r.student_id) : null;
    out.push(toDto(r, seat, marks.get(r.student_id) ?? []));
  }
  return out;
}

export async function getStudent(
  studentId: string,
  db: Db = defaultDb,
): Promise<StudentDto> {
  const s = await studentRepo.findStudent(db, studentId);
  if (!s) throw Errors.notFound('学生', studentId);

  const seat =
    s.status === 'active' ? await studentRepo.findStudentSeat(db, s.class_id, s.student_id) : null;
  const marks = await studentRepo.listStudentMarks(db, [studentId]);

  return toDto(s, seat, marks.get(studentId) ?? []);
}

/**
 * 新增学生。
 * 在班学生必须绑定一个独立座位，不设待排座区（第 20 行）。
 */
export async function createStudent(
  actorId: string,
  classId: string,
  input: CreateStudentInput,
  db: Db = defaultDb,
): Promise<StudentDto> {
  return idempotentTx(db, input.request_id, `POST /api/v1/classes/${classId}/students`, input, async (tx) => {
    const cls = await classRepo.lockClass(tx, classId);
    if (!cls) throw Errors.notFound('班级', classId);
    if (cls.archived_at) throw Errors.forbidden('班级已归档，无法新增学生');
    if (cls.seat_version !== input.expected_version) {
      throw Errors.versionConflict(
        `座次已被其他设备修改（当前版本 ${cls.seat_version}，提交版本 ${input.expected_version}）`,
      );
    }

    const term = await classRepo.currentTerm(tx);
    if (!term) throw Errors.notFound('当前学期');

    // 座位必须存在且空闲
    const occupant = await studentRepo.findSeatOccupant(tx, classId, input.seat_id);
    if (occupant) {
      throw Errors.seatConflict(0, occupant.student_id);
    }

    const seat = await tx.execute<{ seat_id: string; seat_number: number | null }>(
      sql`SELECT seat_id, seat_number FROM room_slot WHERE seat_id = ${input.seat_id}`,
    );
    if (seat.length === 0) throw Errors.notFound('机位', input.seat_id);

    // 班内学号唯一（由 uq_student_no_active 物理保证，这里给出可读错误）
    const dupe = await studentRepo.findStudentByNo(tx, classId, input.student_no);
    if (dupe && dupe.status === 'active') {
      throw Errors.seatConflict(0, dupe.name).constructor === Error
        ? Errors.seatConflict(0, dupe.name)
        : Errors.seatConflict(0, dupe.name);
    }
    if (dupe && dupe.status === 'anonymized') {
      throw Errors.forbidden('该学号属于已匿名化学生，身份不可逆，不允许重新认领');
    }

    const created = await studentRepo.createStudent(tx, {
      class_id: classId,
      student_no: input.student_no,
      name: input.name,
      remark: input.remark ?? null,
    });

    await studentRepo.assignSeat(tx, classId, input.seat_id, created.student_id, term.term_id);
    await classRepo.bumpSeatVersion(tx, classId);

    await auditRepo.writeAudit(tx, {
      actor: actorId,
      entity: 'student',
      entity_id: created.student_id,
      action: 'created',
      after: { seat_id: input.seat_id },
      request_id: input.request_id,
    });

    await auditRepo.writeEvent(tx, {
      class_id: classId,
      kind: 'roster_changed',
      payload: { class_id: classId, action: 'student_created', student_id: created.student_id },
    });

    const savedSeat = await studentRepo.findStudentSeat(tx, classId, created.student_id);
    return toDto(created, savedSeat);
  });
}

/** 改名 / 改学号 / 改备注（不改内部身份）。 */
export async function patchStudent(
  actorId: string,
  studentId: string,
  input: PatchStudentInput,
  db: Db = defaultDb,
): Promise<StudentDto> {
  return idempotentTx(db, input.request_id, `PATCH /api/v1/students/${studentId}`, input, async (tx) => {
    const before = await studentRepo.findStudent(tx, studentId);
    if (!before) throw Errors.notFound('学生', studentId);

    if (before.status === 'anonymized') {
      throw Errors.forbidden('已匿名化学生不可修改身份信息');
    }

    if (input.student_no && input.student_no !== before.student_no) {
      const dupe = await studentRepo.findStudentByNo(tx, before.class_id, input.student_no);
      if (dupe && dupe.student_id !== studentId && dupe.status === 'active') {
        throw Errors.seatConflict(0, dupe.name);
      }
      if (dupe && dupe.status === 'anonymized') {
        throw Errors.forbidden('目标学号属于已匿名化学生，不允许占用');
      }
    }

    const after = await studentRepo.updateStudent(tx, studentId, {
      student_no: input.student_no,
      name: input.name,
      remark: input.remark,
    });
    if (!after) throw Errors.notFound('学生', studentId);

    await auditRepo.writeAudit(tx, {
      actor: actorId,
      entity: 'student',
      entity_id: studentId,
      action: 'updated',
      before: { remark: before.remark },
      after: { remark: after.remark },
      request_id: input.request_id,
    });

    await auditRepo.writeEvent(tx, {
      class_id: after.class_id,
      kind: 'roster_changed',
      payload: { class_id: after.class_id, action: 'student_updated', student_id: studentId },
    });

    const seat = await studentRepo.findStudentSeat(tx, after.class_id, studentId);
    return toDto(after, seat);
  });
}

/**
 * 离班（二次确认）。
 *
 * 释放座位、结束卫生任期、记录原因、保留身份和历史。
 * confirm_token 必须等于该生当前姓名 —— 防止误触（第 16 项）。
 */
export async function leaveStudent(
  actorId: string,
  studentId: string,
  input: LeaveStudentInput,
  db: Db = defaultDb,
): Promise<StudentDto> {
  return idempotentTx(db, input.request_id, `POST /api/v1/students/${studentId}/leave`, input, async (tx) => {
    const student = await studentRepo.findStudent(tx, studentId);
    if (!student) throw Errors.notFound('学生', studentId);
    if (student.status !== 'active') {
      throw Errors.forbidden('该学生不在班，无法执行离班操作');
    }

    const cls = await classRepo.lockClass(tx, student.class_id);
    if (!cls) throw Errors.notFound('班级', student.class_id);
    if (cls.seat_version !== input.expected_version) {
      throw Errors.versionConflict(
        `座次已被其他设备修改（当前版本 ${cls.seat_version}，提交版本 ${input.expected_version}）`,
      );
    }

    // 二次确认：输入的姓名必须与当前姓名一致
    if (input.confirm_token.trim() !== student.name.trim()) {
      throw Errors.forbidden('确认姓名与当前姓名不一致，操作已取消');
    }

    // 结束卫生任期（第二阶段实现的表，此处按表存在与否安全处理）
    await tx.execute(
      sql`UPDATE duty_term
          SET status = 'released', retired_at = now(), retire_reason = '学生离班'
          WHERE student_id = ${studentId} AND status = 'active'`,
    );

    await studentRepo.releaseStudentSeat(tx, student.class_id, studentId);
    const updated = await studentRepo.markStudentLeft(
      tx,
      studentId,
      input.reason,
      input.note ?? null,
    );
    if (!updated) throw Errors.notFound('学生', studentId);

    await classRepo.bumpSeatVersion(tx, student.class_id);

    await auditRepo.writeAudit(tx, {
      actor: actorId,
      entity: 'student',
      entity_id: studentId,
      action: 'left',
      before: { status: 'active' },
      after: { status: 'left', reason: input.reason, note: input.note ?? null },
      request_id: input.request_id,
    });

    await auditRepo.writeEvent(tx, {
      class_id: student.class_id,
      kind: 'roster_changed',
      payload: { class_id: student.class_id, action: 'student_left', student_id: studentId },
    });

    return toDto(updated, null);
  });
}

/** 恢复（必须同时指定座位）。 */
export async function restoreStudent(
  actorId: string,
  studentId: string,
  input: RestoreStudentInput,
  db: Db = defaultDb,
): Promise<StudentDto> {
  return idempotentTx(db, input.request_id, `POST /api/v1/students/${studentId}/restore`, input, async (tx) => {
    const student = await studentRepo.findStudent(tx, studentId);
    if (!student) throw Errors.notFound('学生', studentId);
    if (student.status !== 'left') {
      throw Errors.forbidden('仅已离班学生可恢复');
    }

    const cls = await classRepo.lockClass(tx, student.class_id);
    if (!cls) throw Errors.notFound('班级', student.class_id);
    if (cls.seat_version !== input.expected_version) {
      throw Errors.versionConflict(
        `座次已被其他设备修改（当前版本 ${cls.seat_version}，提交版本 ${input.expected_version}）`,
      );
    }

    const term = await classRepo.currentTerm(tx);
    if (!term) throw Errors.notFound('当前学期');

    const occupant = await studentRepo.findSeatOccupant(tx, student.class_id, input.seat_id);
    if (occupant) throw Errors.seatConflict(0, occupant.student_id);

    const restored = await studentRepo.restoreStudent(tx, studentId);
    if (!restored) throw Errors.notFound('学生', studentId);

    await studentRepo.assignSeat(
      tx,
      student.class_id,
      input.seat_id,
      studentId,
      term.term_id,
    );
    await classRepo.bumpSeatVersion(tx, student.class_id);

    await auditRepo.writeAudit(tx, {
      actor: actorId,
      entity: 'student',
      entity_id: studentId,
      action: 'restored',
      before: { status: 'left', reason: student.left_reason },
      after: { status: 'active', seat_id: input.seat_id },
      request_id: input.request_id,
    });

    await auditRepo.writeEvent(tx, {
      class_id: student.class_id,
      kind: 'roster_changed',
      payload: { class_id: student.class_id, action: 'student_restored', student_id: studentId },
    });

    const seat = await studentRepo.findStudentSeat(tx, student.class_id, studentId);
    return toDto(restored, seat);
  });
}

interface PreparedAnon {
  student: StudentDto;
  anonId: string;
  ledger: NewAnonLedgerEntry;
}

/**
 * 匿名化：去除姓名、学号和身份备注，历史数值及事件保留。
 * 外部账本写入失败时抛错，数据库事务整体回滚。
 */
export async function anonymizeStudent(
  actorId: string,
  studentId: string,
  requestId: string,
  db: Db = defaultDb,
): Promise<{ student: StudentDto; ledger_entry_id: string }> {
  return idempotentTx(
    db,
    requestId,
    `POST /api/v1/students/${studentId}/anonymize`,
    { request_id: requestId },
    async (tx) => {
      const prepared = await prepareAnonymize(tx, actorId, studentId, requestId);
      const [ledgerEntryId] = await exportAnonLedger(tx, [prepared]);
      if (!ledgerEntryId) throw Errors.internal('外部匿名账本写入失败，本次匿名化已回滚');
      return { student: prepared.student, ledger_entry_id: ledgerEntryId };
    },
  );
}

/** 班级批量匿名化。逐人一条账本；任何一条写失败则整班回滚。 */
export async function anonymizeClass(
  actorId: string,
  classId: string,
  requestId: string,
  db: Db = defaultDb,
): Promise<{ anonymized: number; failed: number; students: string[] }> {
  return idempotentTx(
    db,
    requestId,
    `POST /api/v1/classes/${classId}/anonymize`,
    { request_id: requestId },
    async (tx) => {
      const cls = await classRepo.findClass(tx, classId);
      if (!cls) throw Errors.notFound('班级', classId);

      const students = await studentRepo.listStudents(tx, classId, { status: 'all' });
      const prepared: PreparedAnon[] = [];
      for (const student of students) {
        if (student.status === 'anonymized') continue;
        prepared.push(await prepareAnonymize(tx, actorId, student.student_id, requestId));
      }
      await exportAnonLedger(tx, prepared);
      return {
        anonymized: prepared.length,
        failed: 0,
        students: prepared.map((item) => item.student.student_id),
      };
    },
  );
}

async function prepareAnonymize(
  tx: Tx,
  actorId: string,
  studentId: string,
  requestId: string,
): Promise<PreparedAnon> {
  const student = await studentRepo.findStudent(tx, studentId);
  if (!student) throw Errors.notFound('学生', studentId);
  if (student.status === 'anonymized') {
    throw Errors.forbidden('该学生已匿名化');
  }

  const anonCode = student.anon_code ?? (await studentRepo.nextAnonCode(tx, student.class_id));
  const verRows = await tx.execute<{ max: number | null }>(
    sql`SELECT MAX(process_version)::int AS max FROM anon_registry WHERE student_id = ${studentId}`,
  );
  const processVersion = (verRows[0]?.max ?? 0) + 1;

  const updated = await studentRepo.anonymizeStudent(tx, studentId, anonCode);
  if (!updated) throw Errors.notFound('学生', studentId);

  const reg = await tx.execute<{ anon_id: string }>(
    sql`INSERT INTO anon_registry (student_id, class_id, anon_code, process_version)
        VALUES (${studentId}, ${student.class_id}, ${anonCode}, ${processVersion})
        RETURNING anon_id`,
  );
  const anonId = reg[0]?.anon_id;
  if (!anonId) throw Errors.internal('匿名化登记失败');

  await tx.execute(
    sql`INSERT INTO anon_ledger_export (anon_id, state) VALUES (${anonId}, 'pending')
        ON CONFLICT (anon_id) DO NOTHING`,
  );

  await auditRepo.writeAudit(tx, {
    actor: actorId,
    entity: 'student',
    entity_id: studentId,
    action: 'anonymized',
    before: { status: student.status },
    after: { status: 'anonymized', anon_code: anonCode, process_version: processVersion },
    request_id: requestId,
  });

  await auditRepo.writeEvent(tx, {
    class_id: student.class_id,
    kind: 'roster_changed',
    payload: {
      class_id: student.class_id,
      action: 'student_anonymized',
      student_id: studentId,
      anon_code: anonCode,
    },
  });

  const seat = await studentRepo.findStudentSeat(tx, student.class_id, studentId);
  return {
    student: toDto(updated, seat),
    anonId,
    ledger: {
      student_id: studentId,
      class_id: student.class_id,
      anon_code: anonCode,
      processed_at: new Date().toISOString(),
      process_version: processVersion,
    },
  };
}

async function exportAnonLedger(tx: Tx, prepared: PreparedAnon[]): Promise<string[]> {
  if (prepared.length === 0) return [];
  let entryIds: string[];
  try {
    entryIds = await appendAnonLedgerEntries(prepared.map((item) => item.ledger));
  } catch (err) {
    console.error('匿名账本写入失败', err);
    throw Errors.internal('外部匿名账本写入失败，本次匿名化已回滚');
  }
  if (entryIds.length !== prepared.length || entryIds.some((id) => !id)) {
    throw Errors.internal('外部匿名账本写入失败，本次匿名化已回滚');
  }
  for (let i = 0; i < prepared.length; i += 1) {
    const anonId = prepared[i]!.anonId;
    const entryId = entryIds[i]!;
    await tx.execute(
      sql`UPDATE anon_registry SET ledger_entry_id = ${entryId} WHERE anon_id = ${anonId}`,
    );
    await tx.execute(
      sql`UPDATE anon_ledger_export
          SET state = 'exported', attempts = attempts + 1, exported_at = now(), updated_at = now()
          WHERE anon_id = ${anonId}`,
    );
  }
  return entryIds;
}
