/**
 * 幂等请求的纯判定：规范化请求体、计算哈希、决定重放还是拒绝。
 * 不访问数据库。密码字段只进入哈希，不保留原文。
 */

import { createHash } from 'node:crypto';

const UUID_RE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000)$/i;

const SECRET_KEYS = new Set(['password', 'old_password', 'new_password']);

export class IdempotencyInputError extends Error {
  constructor(
    message: string,
    readonly field: 'request_id' | 'endpoint' | 'body' = 'body',
  ) {
    super(message);
    this.name = 'IdempotencyInputError';
  }
}

export interface StoredIdempotency {
  request_id: string;
  endpoint: string;
  request_hash: string;
  status_code: number | null;
  response_body: unknown;
  state: 'in_flight' | 'done' | 'unknown';
}

export type IdempotencyDecision =
  | { kind: 'replay'; statusCode: number; body: unknown }
  | { kind: 'mismatch' }
  | { kind: 'in_flight' }
  | { kind: 'corrupt' };

export function normalizeRequestId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new IdempotencyInputError('request_id 必须是 UUID', 'request_id');
  }
  return value.toLowerCase();
}

export function assertEndpoint(endpoint: unknown): string {
  if (typeof endpoint !== 'string' || !/^[\x20-\x7e]{1,300}$/.test(endpoint)) {
    throw new IdempotencyInputError('幂等端点不合法', 'endpoint');
  }
  return endpoint;
}

/** 请求体里的 request_id 必须和幂等键是同一个 UUID。大小写不同视为相同。 */
export function assertBodyRequestId(body: unknown, normalizedId: string): void {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;
  if (!('request_id' in body)) return;
  const value = (body as { request_id: unknown }).request_id;
  if (value === undefined) return;
  const normalized = normalizeRequestId(value);
  if (normalized !== normalizedId) {
    throw new IdempotencyInputError('请求体中的 request_id 与幂等键不一致', 'request_id');
  }
}

export function canonicalJson(body: unknown): string {
  return JSON.stringify(canonicalize(body, new WeakSet()));
}

export function hashRequestBody(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');
}

export function classifyStored(
  existing: StoredIdempotency,
  endpoint: string,
  requestHash: string,
): IdempotencyDecision {
  if (existing.endpoint !== endpoint || existing.request_hash !== requestHash) {
    return { kind: 'mismatch' };
  }
  if (existing.state === 'in_flight') return { kind: 'in_flight' };
  if (existing.state !== 'done') return { kind: 'corrupt' };
  if (
    existing.status_code == null ||
    !Number.isInteger(existing.status_code) ||
    existing.status_code < 100 ||
    existing.status_code > 599
  ) {
    return { kind: 'corrupt' };
  }
  return { kind: 'replay', statusCode: existing.status_code, body: existing.response_body };
}

function canonicalize(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new IdempotencyInputError('请求体包含非法数字');
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === 'bigint') {
    throw new IdempotencyInputError('请求体包含无法序列化的整数');
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new IdempotencyInputError('请求体包含非法时间');
    }
    return value.toISOString();
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new IdempotencyInputError('请求体包含无法序列化的值');
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new IdempotencyInputError('请求体包含循环引用');
    seen.add(value);
    try {
      return value.map((item) => canonicalize(item, seen));
    } finally {
      seen.delete(value);
    }
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new IdempotencyInputError('请求体包含循环引用');
    seen.add(value);
    try {
      const record = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) {
        const child = record[key];
        if (child === undefined) continue;
        if (SECRET_KEYS.has(key) && typeof child === 'string') {
          out[key] = createHash('sha256').update(child, 'utf8').digest('hex');
          continue;
        }
        if (key === 'request_id' && typeof child === 'string' && UUID_RE.test(child)) {
          out[key] = child.toLowerCase();
          continue;
        }
        out[key] = canonicalize(child, seen);
      }
      return out;
    } finally {
      seen.delete(value);
    }
  }
  throw new IdempotencyInputError('请求体包含无法序列化的值');
}
