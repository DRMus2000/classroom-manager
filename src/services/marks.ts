/**
 * 普通标记服务。
 *
 * 约定（第 17、82 项）：
 * - 标记可自定义名称、图标、颜色；一人可有多个标记。
 * - 卫生管理员【不是】标记：它是独立业务角色，通过卫生流程管理。
 *   不能仅靠添加普通图标改变任职状态，因此本模块完全不触碰 duty_* 表。
 */

import { type Db, db as defaultDb, sql } from '../repo/db.js';
import { idempotentTx } from './idempotency.js';
import * as studentRepo from '../repo/student.js';
import * as auditRepo from '../repo/audit.js';
import { writeEvent } from './publishEvent.js';
import { Errors } from '../lib/errors.js';
import type { CreateMarkInput, PatchMarkInput } from '../lib/schema.js';

export interface MarkDefDto {
  mark_id: string;
  name: string;
  icon: string;
  color: string;
  sort_order: number;
}

export async function listMarks(db: Db = defaultDb): Promise<MarkDefDto[]> {
  const rows = await studentRepo.listMarkDefs(db);
  return rows.map((m) => ({
    mark_id: m.mark_id,
    name: m.name,
    icon: m.icon,
    color: m.color,
    sort_order: m.sort_order,
  }));
}

export async function createMark(
  actorId: string,
  input: CreateMarkInput,
  db: Db = defaultDb,
): Promise<MarkDefDto> {
  return idempotentTx(db, input.request_id, 'POST /api/v1/marks', input, async (tx) => {
    let created: studentRepo.MarkDefRow;
    try {
      created = await studentRepo.createMarkDef(tx, {
        name: input.name,
        icon: input.icon,
        color: input.color,
        sort_order: input.sort_order,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw Errors.forbidden('已有同名的未归档标记');
      }
      throw err;
    }

    await auditRepo.writeAudit(tx, {
      actor: actorId,
      entity: 'mark_def',
      entity_id: created.mark_id,
      action: 'created',
      after: { name: created.name, icon: created.icon, color: created.color },
      request_id: input.request_id,
    });

    return {
      mark_id: created.mark_id,
      name: created.name,
      icon: created.icon,
      color: created.color,
      sort_order: created.sort_order,
    };
  });
}

/** 改名 / 改图标 / 改颜色 / 归档（归档不删历史关联）。 */
export async function patchMark(
  actorId: string,
  markId: string,
  patch: Omit<PatchMarkInput, 'request_id'>,
  requestId: string,
  db: Db = defaultDb,
): Promise<MarkDefDto> {
  return idempotentTx(db, requestId, `PATCH /api/v1/marks/${markId}`, { ...patch, request_id: requestId }, async (tx) => {
    const before = await tx.execute<studentRepo.MarkDefRow>(
      sql`SELECT mark_id, name, icon, color, sort_order, archived_at FROM mark_def WHERE mark_id = ${markId}`,
    );
    if (before.length === 0) throw Errors.notFound('标记', markId);

    const sets = [];
    if (patch.name !== undefined) sets.push(sql`name = ${patch.name}`);
    if (patch.icon !== undefined) sets.push(sql`icon = ${patch.icon}`);
    if (patch.color !== undefined) sets.push(sql`color = ${patch.color}`);
    if (patch.sort_order !== undefined) sets.push(sql`sort_order = ${patch.sort_order}`);
    if (patch.archived === true) sets.push(sql`archived_at = now()`);
    if (patch.archived === false) sets.push(sql`archived_at = NULL`);
    if (sets.length === 0) {
      return {
        mark_id: before[0]!.mark_id,
        name: before[0]!.name,
        icon: before[0]!.icon,
        color: before[0]!.color,
        sort_order: before[0]!.sort_order,
      };
    }
    const rows = await tx.execute<studentRepo.MarkDefRow>(
      sql`UPDATE mark_def SET ${sql.join(sets, sql`, `)}
          WHERE mark_id = ${markId}
          RETURNING mark_id, name, icon, color, sort_order, archived_at`,
    );
    const after = rows[0]!;

    await auditRepo.writeAudit(tx, {
      actor: actorId,
      entity: 'mark_def',
      entity_id: markId,
      action: patch.archived === true ? 'archived' : 'updated',
      before: before[0],
      after: after,
      request_id: requestId,
    });

    return {
      mark_id: after.mark_id,
      name: after.name,
      icon: after.icon,
      color: after.color,
      sort_order: after.sort_order,
    };
  });
}

/** 打标（幂等：重复打标返回成功，不报错）。 */
export async function addMark(
  actorId: string,
  studentId: string,
  markId: string,
  requestId: string,
  db: Db = defaultDb,
): Promise<void> {
  await idempotentTx(
    db,
    requestId,
    `POST /api/v1/students/${studentId}/marks/${markId}`,
    { request_id: requestId },
    async (tx) => {
    const student = await studentRepo.findStudent(tx, studentId);
    if (!student) throw Errors.notFound('学生', studentId);

    const mark = await tx.execute<{ mark_id: string }>(
      sql`SELECT mark_id FROM mark_def WHERE mark_id = ${markId} AND archived_at IS NULL`,
    );
    if (mark.length === 0) throw Errors.notFound('标记', markId);

    await studentRepo.addStudentMark(tx, studentId, markId);

    await auditRepo.writeAudit(tx, {
      actor: actorId,
      entity: 'student_mark',
      entity_id: `${studentId}:${markId}`,
      action: 'added',
      request_id: requestId,
    });

    await writeEvent(tx, {
      class_id: student.class_id,
      kind: 'marks_changed',
      payload: { class_id: student.class_id, student_id: studentId, mark_id: markId, action: 'added' },
    });
  });
}

/** 取消打标。 */
export async function removeMark(
  actorId: string,
  studentId: string,
  markId: string,
  requestId: string,
  db: Db = defaultDb,
): Promise<void> {
  await idempotentTx(
    db,
    requestId,
    `DELETE /api/v1/students/${studentId}/marks/${markId}`,
    { request_id: requestId },
    async (tx) => {
    const student = await studentRepo.findStudent(tx, studentId);
    if (!student) throw Errors.notFound('学生', studentId);

    await studentRepo.removeStudentMark(tx, studentId, markId);

    await auditRepo.writeAudit(tx, {
      actor: actorId,
      entity: 'student_mark',
      entity_id: `${studentId}:${markId}`,
      action: 'removed',
      request_id: requestId,
    });

    await writeEvent(tx, {
      class_id: student.class_id,
      kind: 'marks_changed',
      payload: {
        class_id: student.class_id,
        student_id: studentId,
        mark_id: markId,
        action: 'removed',
      },
    });
  });
}

function isUniqueViolation(err: unknown): boolean {
  const queue = [err];
  for (let i = 0; i < queue.length && i < 4; i += 1) {
    const current = queue[i];
    if (!current || typeof current !== 'object') continue;
    if ('code' in current && (current as { code: unknown }).code === '23505') return true;
    if ('cause' in current) queue.push((current as { cause: unknown }).cause);
  }
  return false;
}
