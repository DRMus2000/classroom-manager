/**
 * 班级与学期数据访问。
 *
 * 约定：
 * - 全局唯一当前学期（uq_term_current / uq_term_single_open 物理保证）。
 * - 切学期是一次性全局操作：关旧开新 + 为全部在班学生初始化余额。
 * - 乐观锁 seat_version 用于座次与导入的冲突检测。
 */

import { sql, type Db, type Tx, now, uuid as genUuid } from './db.js';

export interface ClassRow {
  class_id: string;
  name: string;
  archived_at: Date | null;
  seat_version: number;
  created_at: Date;
}

export interface ClassWithCounts extends ClassRow {
  active_student_count: number;
}

export interface TermRow {
  term_id: string;
  name: string;
  status: 'open' | 'closed';
  is_current: boolean;
  started_at: Date;
  closed_at: Date | null;
}

/** 班级列表（含在班人数）。 */
export async function listClasses(db: Db | Tx, includeArchived = false): Promise<ClassWithCounts[]> {
  const rows = await db.execute<ClassWithCounts>(
    sql`SELECT c.class_id, c.name, c.archived_at, c.seat_version, c.created_at,
               COALESCE(s.cnt, 0)::int AS active_student_count
        FROM class c
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS cnt FROM student st
          WHERE st.class_id = c.class_id AND st.status = 'active'
        ) s ON true
        ${includeArchived ? sql`` : sql`WHERE c.archived_at IS NULL`}
        ORDER BY c.created_at`,
  );
  return rows;
}

/** 查询班级。 */
export async function findClass(db: Db | Tx, classId: string): Promise<ClassRow | null> {
  const rows = await db.execute<ClassRow>(
    sql`SELECT class_id, name, archived_at, seat_version, created_at
        FROM class WHERE class_id = ${classId}`,
  );
  return rows[0] ?? null;
}

/** 锁定班级行（换座/导入提交前调用，防止并发修改座次）。 */
export async function lockClass(db: Tx, classId: string): Promise<ClassRow | null> {
  const rows = await db.execute<ClassRow>(
    sql`SELECT class_id, name, archived_at, seat_version, created_at
        FROM class WHERE class_id = ${classId} FOR UPDATE`,
  );
  return rows[0] ?? null;
}

/** 创建班级。 */
export async function createClass(db: Db | Tx, name: string): Promise<ClassRow> {
  const rows = await db.execute<ClassRow>(
    sql`INSERT INTO class (name) VALUES (${name})
        RETURNING class_id, name, archived_at, seat_version, created_at`,
  );
  return rows[0]!;
}

/**
 * 改名 / 归档。
 * 不把未提供的字段写成无类型 NULL：Postgres 无法推断 `WHEN $1 IS NULL` 里的参数类型。
 */
export async function updateClass(
  db: Db | Tx,
  classId: string,
  patch: { name?: string; archived?: boolean },
): Promise<ClassRow | null> {
  const returning = sql`RETURNING class_id, name, archived_at, seat_version, created_at`;
  let rows: ClassRow[];
  if (patch.name !== undefined && patch.archived === true) {
    rows = await db.execute<ClassRow>(
      sql`UPDATE class SET name = ${patch.name}, archived_at = ${now()} WHERE class_id = ${classId} ${returning}`,
    );
  } else if (patch.name !== undefined && patch.archived === false) {
    rows = await db.execute<ClassRow>(
      sql`UPDATE class SET name = ${patch.name}, archived_at = NULL WHERE class_id = ${classId} ${returning}`,
    );
  } else if (patch.name !== undefined) {
    rows = await db.execute<ClassRow>(
      sql`UPDATE class SET name = ${patch.name} WHERE class_id = ${classId} ${returning}`,
    );
  } else if (patch.archived === true) {
    rows = await db.execute<ClassRow>(
      sql`UPDATE class SET archived_at = ${now()} WHERE class_id = ${classId} ${returning}`,
    );
  } else if (patch.archived === false) {
    rows = await db.execute<ClassRow>(
      sql`UPDATE class SET archived_at = NULL WHERE class_id = ${classId} ${returning}`,
    );
  } else {
    return findClass(db, classId);
  }
  return rows[0] ?? null;
}

/** 递增座次版本（换座/导入提交成功后调用）。 */
export async function bumpSeatVersion(db: Tx, classId: string): Promise<number> {
  const rows = await db.execute<{ seat_version: number }>(
    sql`UPDATE class SET seat_version = seat_version + 1
        WHERE class_id = ${classId} RETURNING seat_version`,
  );
  return rows[0]!.seat_version;
}

/* ------------------------------------------------------------------ */
/* 学期                                                                */
/* ------------------------------------------------------------------ */

/** 学期列表。 */
export async function listTerms(db: Db | Tx): Promise<TermRow[]> {
  const rows = await db.execute<TermRow>(
    sql`SELECT term_id, name, status, is_current, started_at, closed_at
        FROM term ORDER BY started_at DESC`,
  );
  return rows;
}

/** 当前学期。 */
export async function currentTerm(db: Db | Tx): Promise<TermRow | null> {
  const rows = await db.execute<TermRow>(
    sql`SELECT term_id, name, status, is_current, started_at, closed_at
        FROM term WHERE is_current LIMIT 1`,
  );
  return rows[0] ?? null;
}

/** 查询学期。 */
export async function findTerm(db: Db | Tx, termId: string): Promise<TermRow | null> {
  const rows = await db.execute<TermRow>(
    sql`SELECT term_id, name, status, is_current, started_at, closed_at
        FROM term WHERE term_id = ${termId}`,
  );
  return rows[0] ?? null;
}

/** 创建学期（不自动切换）。 */
export async function createTerm(db: Db | Tx, name: string): Promise<TermRow> {
  const rows = await db.execute<TermRow>(
    sql`INSERT INTO term (name, status, is_current) VALUES (${name}, 'closed', false)
        RETURNING term_id, name, status, is_current, started_at, closed_at`,
  );
  return rows[0]!;
}

/**
 * 全局切换学期（一次性操作）。
 * 事务内：
 *   1. 关闭所有 open 学期
 *   2. 目标学期设为 open + is_current
 *   3. 为全部在班学生初始化 point_balance = 0
 * 座次、普通标记、未结束卫生轮次不动。
 */
export async function activateTerm(
  db: Tx,
  termId: string,
): Promise<{ term: TermRow; initialized: number }> {
  // 1. 关旧
  await db.execute(
    sql`UPDATE term SET status = 'closed', is_current = false, closed_at = ${now()}
        WHERE status = 'open' AND term_id != ${termId}`,
  );

  // 2. 开新
  const rows = await db.execute<TermRow>(
    sql`UPDATE term SET status = 'open', is_current = true, closed_at = NULL, started_at = ${now()}
        WHERE term_id = ${termId}
        RETURNING term_id, name, status, is_current, started_at, closed_at`,
  );
  const term = rows[0];
  if (!term) throw new Error(`学期 ${termId} 不存在`);

  // 3. 为全部在班学生初始化余额为 0（新学期积分从 0 开始）
  const init = await db.execute<{ student_id: string }>(
    sql`INSERT INTO point_balance (term_id, student_id, balance, last_change_seq)
        SELECT ${termId}, student_id, 0, 0 FROM student WHERE status = 'active'
        ON CONFLICT (term_id, student_id) DO NOTHING
        RETURNING student_id`,
  );

  return { term, initialized: init.length };
}

/**
 * 确保某学生在某学期有余额行（懒初始化，用于历史学期查询场景）。
 */
export async function ensureBalanceRow(db: Db | Tx, termId: string, studentId: string): Promise<void> {
  await db.execute(
    sql`INSERT INTO point_balance (term_id, student_id, balance, last_change_seq)
        VALUES (${termId}, ${studentId}, 0, 0)
        ON CONFLICT (term_id, student_id) DO NOTHING`,
  );
}
