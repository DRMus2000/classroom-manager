/**
 * 数据库连接与事务管理（Drizzle ORM）。
 *
 * 约定：
 * - 所有写操作必须在事务内执行（使用 withTx）。
 * - 读操作可直接用 db，或在事务内共享连接以保证隔离级别。
 * - 连接池由 pg.Pool 管理，进程退出时调用 closeDb() 优雅关闭。
 */

import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { rowsOf } from './queryRows.js';
import { runWithCommitHooks } from './afterCommit.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL 环境变量未设置');
}

// 连接池
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

type RawDb = NodePgDatabase<Record<string, never>>;

/** 原始 SQL 客户端。`execute` 直接返回行数组，而不是 pg 的 QueryResult。 */
export interface SqlClient {
  execute<T = Record<string, unknown>>(query: SQL): Promise<T[]>;
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
}

function wrap(client: RawDb): SqlClient {
  return {
    async execute<T>(query: SQL): Promise<T[]> {
      const result = await client.execute(query);
      return rowsOf<T>(result);
    },
    transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
      return client.transaction((tx) => fn(wrap(tx as unknown as RawDb)));
    },
  };
}

// 无 schema：手写迁移 + 原始 SQL。execute 的返回值固定为行数组。
export const db = wrap(drizzle(pool));

export type Db = SqlClient;
export type Tx = SqlClient;

/**
 * 事务包裹器：自动提交/回滚 + 错误传播。
 *
 * 使用示例：
 * ```ts
 * await withTx(db, async (tx) => {
 *   await tx.execute(sql`INSERT INTO ...`);
 *   await tx.execute(sql`UPDATE ...`);
 *   // 事务结束时自动 COMMIT；抛异常则 ROLLBACK
 * });
 * ```
 */
export async function withTx<T>(database: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runWithCommitHooks(() => database.transaction(fn));
}

/**
 * 健康检查：验证数据库连接可用。
 */
export async function healthCheck(): Promise<{ ok: boolean; latency_ms?: number }> {
  const start = Date.now();
  try {
    await db.execute(sql`SELECT 1`);
    return { ok: true, latency_ms: Date.now() - start };
  } catch (err) {
    console.error('数据库健康检查失败:', err);
    return { ok: false };
  }
}

/**
 * 优雅关闭连接池（进程退出时调用）。
 */
export async function closeDb(): Promise<void> {
  await pool.end();
}

/**
 * 会话级咨询锁。拿到锁的连接必须用来解锁，所以锁和业务查询可以不在同一条连接上。
 * 没拿到锁时返回 null，调用方应跳过本次任务。
 */
export async function acquireAdvisoryLock(key: string): Promise<(() => Promise<void>) | null> {
  if (key.length === 0 || key.length > 200) {
    throw new Error('咨询锁键无效');
  }
  const client = await pool.connect();
  try {
    const locked = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1::text, 0)) AS locked',
      [key],
    );
    if (!locked.rows[0]?.locked) {
      client.release();
      return null;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1::text, 0))', [key]);
        client.release();
      } catch (err) {
        client.release(err instanceof Error ? err : new Error('咨询锁解锁失败'));
      }
    };
  } catch (err) {
    client.release();
    throw err;
  }
}

/**
 * 当前 UTC 时间（用于 `occurred_at`/`created_at` 等字段）。
 * 界面渲染时按 SERVER_TZ 转换。
 */
export function now(): Date {
  return new Date();
}

/**
 * 生成 UUID v4（用于 request_id 等）。
 */
export function uuid(): string {
  return crypto.randomUUID();
}

/**
 * SQL 标签函数（re-export drizzle-orm/sql，便于统一导入）。
 */
export { sql };
