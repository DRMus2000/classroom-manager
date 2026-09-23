/**
 * 写接口的幂等包装。
 *
 * 同键同体：返回首次的状态码和响应体，业务函数不会再执行。
 * 同键不同体，或同一个 request_id 打到了另一个端点：409 IDEMPOTENCY_MISMATCH。
 * 已占用且尚未完成：409 REQUEST_IN_FLIGHT。
 *
 * 单次业务事务用 idempotentTx：占位和业务一起提交，失败则整笔回滚，重试可以重新执行。
 * 必须拆成多次提交的写操作用 runReservedIdempotent：先提交占位，失败后删除占位。
 */

import { sql, type Db, type Tx, now, withTx } from '../repo/db.js';
import { executeReserved, runIdempotent, type IdempotencyStore } from './idempotencyRun.js';
import type { StoredIdempotency } from '../domain/idempotency.js';

export interface IdempotencyRecord {
  request_id: string;
  endpoint: string;
  request_hash: string;
  status_code: number | null;
  response_body: unknown;
  state: 'in_flight' | 'done';
  created_at: Date;
  completed_at: Date | null;
}

export async function withIdempotency<T>(
  tx: Tx,
  requestId: string,
  endpoint: string,
  requestBody: unknown,
  fn: () => Promise<{ statusCode: number; body: T }>,
): Promise<{ statusCode: number; body: T; fromCache: boolean }> {
  return runIdempotent(pgStore(tx), requestId, endpoint, requestBody, fn);
}

export async function completeIdempotent<T>(
  tx: Tx,
  requestId: string,
  endpoint: string,
  requestBody: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const result = await withIdempotency(tx, requestId, endpoint, requestBody, async () => ({
    statusCode: 200,
    body: await fn(),
  }));
  return result.body;
}

/** 在一个事务里完成占位、业务和响应缓存。 */
export async function idempotentTx<T>(
  db: Db,
  requestId: string,
  endpoint: string,
  requestBody: unknown,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return withTx(db, (tx) => completeIdempotent(tx, requestId, endpoint, requestBody, () => fn(tx)));
}

/** 占位单独提交。适合一次请求里包含多笔已经各自提交的写入。 */
export async function runReservedIdempotent<T>(
  db: Db,
  requestId: string,
  endpoint: string,
  requestBody: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  return executeReserved(autoCommitStore(db), requestId, endpoint, requestBody, fn);
}

/**
 * 清理过期幂等记录（维护命令用）。
 * 保留最近若干天的已完成记录。未完成的占位不自动删除。
 */
export async function cleanupExpiredIdempotency(db: Db | Tx, retentionDays = 7): Promise<number> {
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    throw new Error('retentionDays 必须是 1 到 3650 的整数');
  }
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const result = await db.execute<{ request_id: string }>(
    sql`DELETE FROM idempotency
        WHERE state = 'done' AND created_at < ${cutoff}
        RETURNING request_id`,
  );
  return result.length;
}

function pgStore(tx: Tx): IdempotencyStore {
  return {
    async find(requestId) {
      const rows = await tx.execute<{
        request_id: string;
        endpoint: string;
        request_hash: string;
        status_code: number | string | null;
        response_body: unknown;
        state: string;
      }>(
        sql`SELECT request_id, endpoint, request_hash, status_code, response_body, state
            FROM idempotency WHERE request_id = ${requestId}`,
      );
      const row = rows[0];
      if (!row) return null;
      return {
        request_id: row.request_id,
        endpoint: row.endpoint,
        request_hash: row.request_hash,
        status_code: coerceStatus(row.status_code),
        response_body: decodeBody(row.response_body),
        state: row.state === 'in_flight' || row.state === 'done' ? row.state : 'unknown',
      };
    },
    async insertInFlight(row) {
      const inserted = await tx.execute<{ request_id: string }>(
        sql`INSERT INTO idempotency (request_id, endpoint, request_hash, state, created_at)
            VALUES (${row.requestId}, ${row.endpoint}, ${row.requestHash}, 'in_flight', ${now()})
            ON CONFLICT (request_id) DO NOTHING
            RETURNING request_id`,
      );
      return inserted.length > 0;
    },
    async markDone(requestId, statusCode, body) {
      const updated = await tx.execute<{ request_id: string }>(
        sql`UPDATE idempotency
            SET state = 'done',
                status_code = ${statusCode},
                response_body = ${JSON.stringify(body ?? null)},
                completed_at = ${now()}
            WHERE request_id = ${requestId} AND state = 'in_flight'
            RETURNING request_id`,
      );
      return updated.length > 0;
    },
    async deleteInFlight(requestId, endpoint, requestHash) {
      await tx.execute(
        sql`DELETE FROM idempotency
            WHERE request_id = ${requestId}
              AND state = 'in_flight'
              AND endpoint = ${endpoint}
              AND request_hash = ${requestHash}`,
      );
    },
  };
}

function autoCommitStore(db: Db): IdempotencyStore {
  return {
    find: (requestId) => withTx(db, (tx) => pgStore(tx).find(requestId)),
    insertInFlight: (row) => withTx(db, (tx) => pgStore(tx).insertInFlight(row)),
    markDone: (requestId, statusCode, body) =>
      withTx(db, (tx) => pgStore(tx).markDone(requestId, statusCode, body)),
    deleteInFlight: (requestId, endpoint, requestHash) =>
      withTx(db, (tx) => pgStore(tx).deleteInFlight(requestId, endpoint, requestHash)),
  };
}

function coerceStatus(value: number | string | null): number | null {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(n) ? n : null;
}

function decodeBody(value: unknown): unknown {
  let current = value;
  for (let i = 0; i < 2 && typeof current === 'string'; i += 1) {
    const text = current.trim();
    if (!(text.startsWith('{') || text.startsWith('[') || text.startsWith('"') || text === 'null')) {
      break;
    }
    try {
      current = JSON.parse(text) as unknown;
    } catch {
      break;
    }
  }
  return current;
}

export type { StoredIdempotency };
