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
import { Errors } from '../lib/errors.js';

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
  input: { name: string; icon: string; color: string; sort_order?: number; request_id: string },
  db: Db = defaultDb,
): Promise<MarkDefDto> {
  return idempotentTx(db, input.request_id, 'POST /api/v1/marks', input, async (tx) => {
    const created = await studentRepo.createMarkDef(tx, {
      name: input.name,
      icon: input.icon,
      color: input.color,
      sort_order: input.sort_order,
    });

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
  patch: {
    name?: string;
    icon?: string;
    color?: string;
    sort_order?: number;
    archived?: boolean;
  },
  requestId: string,
  db: Db = defaultDb,
): Promise<MarkDefDto> {
  return idempotentTx(db, requestId, `PATCH /api/v1/marks/${markId}`, { ...patch, request_id: requestId }, async (tx) => {
    const before = await tx.execute<studentRepo.MarkDefRow>(
      sql`SELECT mark_id, name, icon, color, sort_order, archived_at FROM mark_def WHERE mark_id = ${markId}`,
    );
    if (before.length === 0) throw Errors.notFound('标记', markId);

    const rows = await tx.execute<studentRepo.MarkDefRow>(
      sql`UPDATE mark_def
          SET name = COALESCE(${patch.name ?? null}, name),
              icon = COALESCE(${patch.icon ?? null}, icon),
              color = COALESCE(${patch.color ?? null}, color),
              sort_order = COALESCE(${patch.sort_order ?? null}, sort_order),
              archived_at = CASE
                WHEN ${patch.archived ?? null} IS NULL THEN archived_at
                WHEN ${patch.archived ?? null} = true THEN now()
                ELSE NULL
              END
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

    await auditRepo.writeEvent(tx, {
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

    await auditRepo.writeEvent(tx, {
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
