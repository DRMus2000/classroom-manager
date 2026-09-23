/**
 * 幂等状态机。存储由调用方注入：业务事务内的写入走同一个 Tx，
 * 跨多个已提交事务的写入则每次存储调用各自提交。
 */

import { AppError, Errors } from '../lib/errors.js';
import {
  IdempotencyInputError,
  assertBodyRequestId,
  assertEndpoint,
  classifyStored,
  hashRequestBody,
  normalizeRequestId,
  type StoredIdempotency,
} from '../domain/idempotency.js';

export interface IdempotencyStore {
  find(requestId: string): Promise<StoredIdempotency | null>;
  insertInFlight(row: { requestId: string; endpoint: string; requestHash: string }): Promise<boolean>;
  markDone(requestId: string, statusCode: number, body: unknown): Promise<boolean>;
  deleteInFlight(requestId: string, endpoint: string, requestHash: string): Promise<void>;
}

type OwnedClaim = {
  kind: 'owned';
  requestId: string;
  endpoint: string;
  requestHash: string;
};

type ReplayClaim = {
  kind: 'replay';
  statusCode: number;
  body: unknown;
  fromCache: true;
};

async function claimIdempotency(
  store: IdempotencyStore,
  requestId: string,
  endpoint: string,
  requestBody: unknown,
): Promise<OwnedClaim | ReplayClaim> {
  let normalized: string;
  let stableEndpoint: string;
  let requestHash: string;
  try {
    normalized = normalizeRequestId(requestId);
    stableEndpoint = assertEndpoint(endpoint);
    assertBodyRequestId(requestBody, normalized);
    requestHash = hashRequestBody(requestBody);
  } catch (err) {
    if (err instanceof IdempotencyInputError) {
      throw new AppError('VALIDATION_FAILED', err.message, {
        issues: [{ path: [err.field], message: err.message }],
      });
    }
    throw err;
  }

  const decide = (existing: StoredIdempotency): ReplayClaim => {
    const decision = classifyStored(existing, stableEndpoint, requestHash);
    if (decision.kind === 'replay') {
      return {
        kind: 'replay',
        statusCode: decision.statusCode,
        body: cloneJson(decision.body),
        fromCache: true,
      };
    }
    if (decision.kind === 'mismatch') {
      throw Errors.idempotencyMismatch('同一 request_id 但请求体不一致');
    }
    if (decision.kind === 'in_flight') {
      throw Errors.requestInFlight('请求正在处理中，请稍候');
    }
    throw Errors.internal('幂等记录损坏');
  };

  const existing = await store.find(normalized);
  if (existing) return decide(existing);

  const inserted = await store.insertInFlight({
    requestId: normalized,
    endpoint: stableEndpoint,
    requestHash,
  });
  if (!inserted) {
    const raced = await store.find(normalized);
    if (!raced) throw Errors.requestInFlight('请求正在处理中，请稍候');
    return decide(raced);
  }

  return { kind: 'owned', requestId: normalized, endpoint: stableEndpoint, requestHash };
}

export async function runIdempotent<T>(
  store: IdempotencyStore,
  requestId: string,
  endpoint: string,
  requestBody: unknown,
  fn: () => Promise<{ statusCode: number; body: T }>,
): Promise<{ statusCode: number; body: T; fromCache: boolean }> {
  const claim = await claimIdempotency(store, requestId, endpoint, requestBody);
  if (claim.kind === 'replay') {
    return { statusCode: claim.statusCode, body: claim.body as T, fromCache: true };
  }

  const result = await fn();
  if (!Number.isInteger(result.statusCode) || result.statusCode < 100 || result.statusCode > 599) {
    throw new AppError('INTERNAL', '幂等响应状态码不合法');
  }
  const frozen = cloneJson(result.body);
  const saved = await store.markDone(claim.requestId, result.statusCode, frozen);
  if (!saved) throw new AppError('INTERNAL', '幂等记录未能完成');
  return { statusCode: result.statusCode, body: cloneJson(frozen) as T, fromCache: false };
}

/**
 * 占位先可见、业务随后分多次提交时使用。
 * 业务抛错会删掉占位，同一个 request_id 可以重试。
 * 成功后的再次调用直接重放，不再执行 fn。
 */
export async function executeReserved<T>(
  store: IdempotencyStore,
  requestId: string,
  endpoint: string,
  requestBody: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const claim = await claimIdempotency(store, requestId, endpoint, requestBody);
  if (claim.kind === 'replay') return claim.body as T;

  let result: T;
  try {
    result = await fn();
  } catch (err) {
    await store.deleteInFlight(claim.requestId, claim.endpoint, claim.requestHash).catch(() => undefined);
    throw err;
  }

  const frozen = cloneJson(result);
  const saved = await store.markDone(claim.requestId, 200, frozen);
  if (!saved) throw new AppError('INTERNAL', '幂等记录未能完成');
  return cloneJson(frozen) as T;
}

function cloneJson<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value === undefined ? null : value)) as T;
  } catch {
    throw new AppError('INTERNAL', '幂等响应无法序列化');
  }
}
