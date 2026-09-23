/**
 * 班级与学期服务。
 *
 * 约定（Q5 / 第19项）：
 * - 切学期是一次性全局操作：所有班级同时进入新学期。
 * - 旧学期只读：不能向已归档学期补记分，也不能把旧学期的反向记录记到新学期。
 * - 学生、座次、普通标记、未结束卫生任期在换学期时全部延续。
 */

import { type Db, db as defaultDb, sql } from '../repo/db.js';
import * as classRepo from '../repo/class.js';
import * as auditRepo from '../repo/audit.js';
import { idempotentTx } from './idempotency.js';
import { Errors } from '../lib/errors.js';
import type {
  ClassDto,
  TermDto,
  CreateClassInput,
  CreateTermInput,
  ActivateTermInput,
  PatchClassInput,
} from '../lib/schema.js';

/* ------------------------------------------------------------------ */
/* 班级                                                                */
/* ------------------------------------------------------------------ */

export async function listClasses(
  includeArchived: boolean,
  db: Db = defaultDb,
): Promise<ClassDto[]> {
  const [rows, current] = await Promise.all([
    classRepo.listClasses(db, includeArchived),
    classRepo.currentTerm(db),
  ]);

  return rows.map((c) => ({
    class_id: c.class_id,
    name: c.name,
    archived_at: c.archived_at?.toISOString() ?? null,
    seat_version: c.seat_version,
    active_student_count: c.active_student_count,
    current_term_id: current?.term_id ?? null,
    created_at: c.created_at.toISOString(),
  }));
}

export async function createClass(
  actorId: string,
  input: CreateClassInput,
  db: Db = defaultDb,
): Promise<ClassDto> {
  return idempotentTx(db, input.request_id, 'POST /api/v1/classes', input, async (tx) => {
    const cls = await classRepo.createClass(tx, input.name);

    await auditRepo.writeAudit(tx, {
      actor: actorId,
      entity: 'class',
      entity_id: cls.class_id,
      action: 'created',
      after: { name: cls.name },
      request_id: input.request_id,
    });

    await auditRepo.writeEvent(tx, {
      class_id: cls.class_id,
      kind: 'roster_changed',
      payload: { class_id: cls.class_id, action: 'class_created' },
    });

    const current = await classRepo.currentTerm(tx);

    return {
      class_id: cls.class_id,
      name: cls.name,
      archived_at: null,
      seat_version: cls.seat_version,
      active_student_count: 0,
      current_term_id: current?.term_id ?? null,
      created_at: cls.created_at.toISOString(),
    };
  });
}

export async function patchClass(
  actorId: string,
  classId: string,
  input: PatchClassInput,
  db: Db = defaultDb,
): Promise<ClassDto> {
  return idempotentTx(db, input.request_id, `PATCH /api/v1/classes/${classId}`, input, async (tx) => {
    const before = await classRepo.findClass(tx, classId);
    if (!before) throw Errors.notFound('班级', classId);

    const after = await classRepo.updateClass(tx, classId, {
      name: input.name,
      archived: input.archived,
    });
    if (!after) throw Errors.notFound('班级', classId);

    const count = await tx.execute<{ cnt: number }>(
      sql`SELECT COUNT(*)::int AS cnt FROM student WHERE class_id = ${classId} AND status = 'active'`,
    );

    await auditRepo.writeAudit(tx, {
      actor: actorId,
      entity: 'class',
      entity_id: classId,
      action: input.archived === true ? 'archived' : input.archived === false ? 'unarchived' : 'renamed',
      before: { name: before.name, archived_at: before.archived_at },
      after: { name: after.name, archived_at: after.archived_at },
      request_id: input.request_id,
    });

    const current = await classRepo.currentTerm(tx);

    return {
      class_id: after.class_id,
      name: after.name,
      archived_at: after.archived_at?.toISOString() ?? null,
      seat_version: after.seat_version,
      active_student_count: count[0]?.cnt ?? 0,
      current_term_id: current?.term_id ?? null,
      created_at: after.created_at.toISOString(),
    };
  });
}

/* ------------------------------------------------------------------ */
/* 学期                                                                */
/* ------------------------------------------------------------------ */

export async function listTerms(db: Db = defaultDb): Promise<TermDto[]> {
  const rows = await classRepo.listTerms(db);
  return rows.map((t) => ({
    term_id: t.term_id,
    name: t.name,
    status: t.status,
    is_current: t.is_current,
    started_at: t.started_at.toISOString(),
    closed_at: t.closed_at?.toISOString() ?? null,
  }));
}

export async function createTerm(
  actorId: string,
  input: CreateTermInput,
  db: Db = defaultDb,
): Promise<TermDto> {
  return idempotentTx(db, input.request_id, 'POST /api/v1/terms', input, async (tx) => {
    const term = await classRepo.createTerm(tx, input.name);

    await auditRepo.writeAudit(tx, {
      actor: actorId,
      entity: 'term',
      entity_id: term.term_id,
      action: 'created',
      after: { name: term.name },
      request_id: input.request_id,
    });

    return {
      term_id: term.term_id,
      name: term.name,
      status: term.status,
      is_current: term.is_current,
      started_at: term.started_at.toISOString(),
      closed_at: null,
    };
  });
}

/**
 * 全局切换学期（一次性操作，所有班级同时进入新学期）。
 *
 * 事务内：
 *   1. 关闭所有 open 学期（旧学期转为只读）
 *   2. 目标学期设为 open + is_current
 *   3. 为全部在班学生初始化 point_balance = 0（新学期积分从 0 开始）
 *
 * 不动的状态：学生身份、座次、普通标记、未结束卫生任期。
 * 注意：卫生轮次在第二阶段实现，本函数不触碰 duty_* 表 —— 这正是"未结束的
 * 卫生任期延续"的落地方式：不关轮次，不动 completed_count。
 */
export async function activateTerm(
  actorId: string,
  termId: string,
  input: ActivateTermInput,
  db: Db = defaultDb,
): Promise<{ term: TermDto; initialized_students: number; closed_terms: number }> {
  return idempotentTx(db, input.request_id, `POST /api/v1/terms/${termId}/activate`, input, async (tx) => {
    const target = await classRepo.findTerm(tx, termId);
    if (!target) throw Errors.notFound('学期', termId);

    // 并发保护：调用方看到的当前学期必须仍然一致
    const current = await classRepo.currentTerm(tx);
    const currentId = current?.term_id ?? null;
    if (currentId !== input.expected_current_term_id) {
      throw Errors.versionConflict('当前学期已被其他设备切换，请载入最新状态');
    }

    if (target.status === 'closed' && target.is_current) {
      throw Errors.versionConflict('目标学期状态异常，请刷新后重试');
    }

    const closedRow = await tx.execute<{ term_id: string }>(
      sql`SELECT term_id FROM term WHERE status = 'open' AND term_id != ${termId}`,
    );

    const { term, initialized } = await classRepo.activateTerm(tx, termId);

    await auditRepo.writeAudit(tx, {
      actor: actorId,
      entity: 'term',
      entity_id: termId,
      action: 'activated',
      before: { previous_term_id: currentId },
      after: { activated_term_id: termId, initialized_students: initialized },
      request_id: input.request_id,
    });

    await auditRepo.writeEvent(tx, {
      class_id: null, // 全局事件：所有班级同时进入新学期
      kind: 'term_switched',
      payload: {
        from_term_id: currentId,
        to_term_id: termId,
        initialized_students: initialized,
      },
    });

    return {
      term: {
        term_id: term.term_id,
        name: term.name,
        status: term.status,
        is_current: term.is_current,
        started_at: term.started_at.toISOString(),
        closed_at: term.closed_at?.toISOString() ?? null,
      },
      initialized_students: initialized,
      closed_terms: closedRow.length,
    };
  });
}

/** 归档学期的只读汇总。 */
export async function termSummary(
  termId: string,
  db: Db = defaultDb,
): Promise<{
  term: TermDto;
  total_batches: number;
  total_entries: number;
  total_reversals: number;
  students_scored: number;
}> {
  const term = await classRepo.findTerm(db, termId);
  if (!term) throw Errors.notFound('学期', termId);

  const rows = await db.execute<{
    total_batches: number;
    total_entries: number;
    total_reversals: number;
    students_scored: number;
  }>(sql`
    SELECT
      (SELECT COUNT(*)::int FROM point_batch WHERE term_id = ${termId}) AS total_batches,
      (SELECT COUNT(*)::int FROM point_entry WHERE term_id = ${termId}) AS total_entries,
      (SELECT COUNT(*)::int FROM point_entry WHERE term_id = ${termId} AND reverses_entry_id IS NOT NULL) AS total_reversals,
      (SELECT COUNT(DISTINCT student_id)::int FROM point_entry WHERE term_id = ${termId}) AS students_scored
  `);

  const r = rows[0]!;

  return {
    term: {
      term_id: term.term_id,
      name: term.name,
      status: term.status,
      is_current: term.is_current,
      started_at: term.started_at.toISOString(),
      closed_at: term.closed_at?.toISOString() ?? null,
    },
    ...r,
  };
}
