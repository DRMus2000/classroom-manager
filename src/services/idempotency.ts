/**
 * 幂等执行服务：防止同一 request_id 重复执行。
 *
 * 约定（A7）：
 * - 同键首次调用：写入 state='in_flight'，执行逻辑，成功后更新 state='done' + 存响应体。
 * - 同键重试：命中 state='done' → 返回原响应；命中 state='in_flight' → 409 REQUEST_IN_FLIGHT。
 * - 同键不同体（request_hash 不匹配）→ 409 IDEMPOTENCY_MISMATCH。
 * - 失败后幂等记录保留（state='in_flight'），允许重试（应用层需要自己清理或设 TTL）。
 */

import { sql, type Db, type Tx, now, uuid as genUuid } from '../repo/db.js';
import { Errors } from '../lib/errors.js';
import { createHash } from 'node:crypto';

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

/**
 * 幂等执行器：包裹业务逻辑，自动处理幂等校验 + 响应缓存。
 *
 * @param db 数据库连接（需在事务内）
 * @param requestId 幂等键（UUID v4）
 * @param endpoint 端点标识（如 'POST /points/batches'）
 * @param requestBody 请求体（用于计算 hash）
 * @param fn 业务逻辑（返回 { statusCode, body }）
 * @returns 原始响应或缓存的响应
 */
export async function withIdempotency<T>(
  db: Tx,
  requestId: string,
  endpoint: string,
  requestBody: unknown,
  fn: () => Promise<{ statusCode: number; body: T }>,
): Promise<{ statusCode: number; body: T; fromCache: boolean }> {
  const requestHash = hashRequest(requestBody);

  // 1. 查询幂等记录
  const existing = await findIdempotencyRecord(db, requestId);

  if (existing) {
    // 同键不同体 → 拒绝
    if (existing.request_hash !== requestHash) {
      throw Errors.idempotencyMismatch('同一 request_id 但请求体不一致');
    }

    // 已完成 → 返回缓存
    if (existing.state === 'done') {
      return {
        statusCode: existing.status_code!,
        body: existing.response_body as T,
        fromCache: true,
      };
    }

    // 处理中 → 告知前端稍候
    if (existing.state === 'in_flight') {
      throw Errors.requestInFlight('请求正在处理中，请稍候');
    }
  }

  // 2. 首次调用：写入 in_flight
  await db.execute(
    sql`INSERT INTO idempotency (request_id, endpoint, request_hash, state, created_at)
        VALUES (${requestId}, ${endpoint}, ${requestHash}, 'in_flight', ${now()})
        ON CONFLICT (request_id) DO NOTHING`,
  );

  // 3. 执行业务逻辑
  const result = await fn();

  // 4. 成功后更新为 done + 存响应
  await db.execute(
    sql`UPDATE idempotency
        SET state = 'done',
            status_code = ${result.statusCode},
            response_body = ${JSON.stringify(result.body)},
            completed_at = ${now()}
        WHERE request_id = ${requestId}`,
  );

  return { ...result, fromCache: false };
}

/** 查询幂等记录（by request_id）。 */
async function findIdempotencyRecord(
  db: Db | Tx,
  requestId: string,
): Promise<IdempotencyRecord | null> {
  const rows = await db.execute<IdempotencyRecord>(
    sql`SELECT request_id, endpoint, request_hash, status_code, response_body, state, created_at, completed_at
        FROM idempotency WHERE request_id = ${requestId}`,
  );
  return rows[0] ?? null;
}

/** 计算请求体哈希（SHA-256）。 */
function hashRequest(body: unknown): string {
  const json = JSON.stringify(body);
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

/**
 * 清理过期幂等记录（维护命令用）。
 * 保留最近 7 天的记录，删除更早的 state='done' 记录。
 * state='in_flight' 的记录视为未完成请求，不自动删除（需人工介入排查）。
 */
export async function cleanupExpiredIdempotency(db: Db | Tx, retentionDays = 7): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const result = await db.execute<{ count: number }>(
    sql`DELETE FROM idempotency
        WHERE state = 'done' AND created_at < ${cutoff}
        RETURNING request_id`,
  );
  return result.length;
}
