/**
 * 点名轮次：开轮、抽取、排除、关闭。同一班级同时只有一个 open 轮次。
 * 抽取不放回。排除名单不写卫生。事件在事务内写入，提交后再广播。
 */

import { randomInt } from 'node:crypto';
import { type Db, db as defaultDb } from '../repo/db.js';
import * as classRepo from '../repo/class.js';
import * as rollcallRepo from '../repo/rollcall.js';
import * as auditRepo from '../repo/audit.js';
import { writeEvent } from './publishEvent.js';
import { idempotentTx } from './idempotency.js';
import { Errors } from '../lib/errors.js';
import {
  drawStudents,
  parseStoredIdList,
  rollcallPool,
  uniqueIds,
  unknownStudentIds,
  type DrawnStudent,
  type PoolStudent,
  type RollcallScope,
} from '../domain/rollcall.js';

export interface RollcallView {
  rollcall_id: string;
  class_id: string;
  status: 'open' | 'closed';
  scope: RollcallScope;
  exclude_student_ids: string[];
  picked: DrawnStudent[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

export function readStoredIdList(value: unknown): string[] {
  const list = parseStoredIdList(value);
  if (list == null) {
    console.error('点名名单不是合法 JSON');
    throw Errors.internal('点名名单无法解析');
  }
  return list;
}

function readScope(value: unknown): RollcallScope {
  const record = asRecord(value);
  const type = record?.type === 'selected' ? 'selected' : 'all';
  return { type, student_ids: readStoredIdList(record?.student_ids) };
}

function toPool(rows: rollcallRepo.ClassStudentRow[]): PoolStudent[] {
  return rows.map((row) => ({
    student_id: row.student_id,
    name: row.name,
    seat_number: row.seat_number == null ? null : Number(row.seat_number),
    status: row.status,
  }));
}

function present(students: readonly PoolStudent[], ids: readonly string[]): DrawnStudent[] {
  const byId = new Map(students.map((student) => [student.student_id, student]));
  return ids.map((id) => {
    const student = byId.get(id);
    return {
      student_id: id,
      name: student?.name ?? '',
      seat_number: student?.seat_number ?? null,
    };
  });
}

async function viewOf(db: Db, row: rollcallRepo.RollcallRow): Promise<RollcallView> {
  const students = toPool(await rollcallRepo.listClassStudents(db, row.class_id));
  return {
    rollcall_id: row.rollcall_id,
    class_id: row.class_id,
    status: row.status,
    scope: readScope(row.scope_desc),
    exclude_student_ids: readStoredIdList(row.exclude_list),
    picked: present(students, readStoredIdList(row.picked_ids)),
  };
}

async function publish(tx: Parameters<typeof writeEvent>[0], view: RollcallView, action: string, actorId: string, requestId: string) {
  await writeEvent(tx, {
    class_id: view.class_id,
    kind: 'rollcall_changed',
    payload: {
      rollcall_id: view.rollcall_id,
      class_id: view.class_id,
      action,
      status: view.status,
    },
  });
  await auditRepo.writeAudit(tx, {
    actor: actorId,
    entity: 'rollcall_round',
    entity_id: view.rollcall_id,
    action,
    after: {
      status: view.status,
      scope: view.scope,
      exclude_student_ids: view.exclude_student_ids,
      picked_ids: view.picked.map((student) => student.student_id),
    },
    request_id: requestId,
  });
}

function assertKnown(students: readonly PoolStudent[], ids: readonly string[]) {
  const unknown = unknownStudentIds(
    students.map((student) => student.student_id),
    ids,
  );
  if (unknown.length > 0) {
    throw Errors.notFound('学生', unknown.join(','));
  }
}

export async function getRound(rollcallId: string, db: Db = defaultDb): Promise<RollcallView> {
  const row = await rollcallRepo.findRound(db, rollcallId);
  if (!row) throw Errors.notFound('点名轮次', rollcallId);
  return viewOf(db, row);
}

export async function getOpenRound(classId: string, db: Db = defaultDb): Promise<RollcallView | null> {
  const cls = await classRepo.findClass(db, classId);
  if (!cls) throw Errors.notFound('班级', classId);
  const row = await rollcallRepo.findOpenRound(db, classId);
  if (!row) return null;
  return viewOf(db, row);
}

export async function openRound(
  actorId: string,
  input: { class_id: string; scope: RollcallScope; exclude_student_ids: string[]; request_id: string },
  db: Db = defaultDb,
): Promise<RollcallView> {
  const scope: RollcallScope = {
    type: input.scope.type,
    student_ids: uniqueIds(input.scope.student_ids),
  };
  const excludeIds = uniqueIds(input.exclude_student_ids);
  return idempotentTx(
    db,
    input.request_id,
    'POST /api/v1/rollcall/rounds',
    { class_id: input.class_id, scope, exclude_student_ids: excludeIds, request_id: input.request_id },
    async (tx) => {
      const locked = await rollcallRepo.lockClass(tx, input.class_id);
      if (!locked) throw Errors.notFound('班级', input.class_id);
      const students = toPool(await rollcallRepo.listClassStudents(tx, input.class_id));
      assertKnown(students, [...scope.student_ids, ...excludeIds]);
      if (scope.type === 'selected' && scope.student_ids.length === 0) {
        throw Errors.forbidden('选中范围至少包含一名学生');
      }
      const open = await rollcallRepo.findOpenRound(tx, input.class_id);
      if (open) throw Errors.versionConflict('本班已有进行中的点名，请先结束后再开新的一轮');
      const row = await rollcallRepo.insertRound(tx, {
        class_id: input.class_id,
        scope,
        exclude_ids: excludeIds,
      });
      const view = await viewOf(tx, row);
      await publish(tx, view, 'open', actorId, input.request_id);
      return view;
    },
  );
}

export async function draw(
  actorId: string,
  rollcallId: string,
  count: number,
  requestId: string,
  db: Db = defaultDb,
  random: (max: number) => number = (max) => randomInt(max),
): Promise<RollcallView> {
  return idempotentTx(
    db,
    requestId,
    `POST /api/v1/rollcall/rounds/${rollcallId}/draw`,
    { count, request_id: requestId },
    async (tx) => {
      const row = await rollcallRepo.lockRound(tx, rollcallId);
      if (!row) throw Errors.notFound('点名轮次', rollcallId);
      if (row.status !== 'open') throw Errors.forbidden('点名已结束，请开启新一轮');
      const students = toPool(await rollcallRepo.listClassStudents(tx, row.class_id));
      const scope = readScope(row.scope_desc);
      const excludeIds = readStoredIdList(row.exclude_list);
      const pickedIds = readStoredIdList(row.picked_ids);
      const pool = rollcallPool(students, scope, excludeIds, pickedIds);
      const drawn = drawStudents(pool, count, random);
      if (!drawn.ok) {
        throw Errors.forbidden(
          drawn.reason === 'pool_short'
            ? `点名池只剩 ${drawn.available} 人，无法抽取 ${count} 人`
            : '抽取人数必须是正整数',
        );
      }
      const nextPicked = [...pickedIds, ...drawn.picked.map((student) => student.student_id)];
      await rollcallRepo.saveRoundLists(tx, rollcallId, excludeIds, nextPicked);
      const view = await viewOf(tx, { ...row, picked_ids: nextPicked, exclude_list: excludeIds });
      await publish(tx, view, 'draw', actorId, requestId);
      return view;
    },
  );
}

export async function exclude(
  actorId: string,
  rollcallId: string,
  studentIds: string[],
  requestId: string,
  db: Db = defaultDb,
): Promise<RollcallView> {
  const incoming = uniqueIds(studentIds);
  return idempotentTx(
    db,
    requestId,
    `POST /api/v1/rollcall/rounds/${rollcallId}/exclude`,
    { student_ids: incoming, request_id: requestId },
    async (tx) => {
      const row = await rollcallRepo.lockRound(tx, rollcallId);
      if (!row) throw Errors.notFound('点名轮次', rollcallId);
      if (row.status !== 'open') throw Errors.forbidden('点名已结束，不能再排除');
      const students = toPool(await rollcallRepo.listClassStudents(tx, row.class_id));
      assertKnown(students, incoming);
      const excludeIds = uniqueIds([...readStoredIdList(row.exclude_list), ...incoming]);
      const pickedIds = readStoredIdList(row.picked_ids);
      await rollcallRepo.saveRoundLists(tx, rollcallId, excludeIds, pickedIds);
      const view = await viewOf(tx, { ...row, exclude_list: excludeIds, picked_ids: pickedIds });
      await publish(tx, view, 'exclude', actorId, requestId);
      return view;
    },
  );
}

export async function close(
  actorId: string,
  rollcallId: string,
  requestId: string,
  db: Db = defaultDb,
): Promise<RollcallView> {
  return idempotentTx(
    db,
    requestId,
    `POST /api/v1/rollcall/rounds/${rollcallId}/close`,
    { request_id: requestId },
    async (tx) => {
      const row = await rollcallRepo.lockRound(tx, rollcallId);
      if (!row) throw Errors.notFound('点名轮次', rollcallId);
      if (row.status !== 'open') throw Errors.forbidden('点名已结束');
      await rollcallRepo.closeRound(tx, rollcallId);
      const view = await viewOf(tx, { ...row, status: 'closed' });
      await publish(tx, view, 'close', actorId, requestId);
      return view;
    },
  );
}
