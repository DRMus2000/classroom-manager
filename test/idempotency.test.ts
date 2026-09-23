/**
 * 写接口幂等：同键同体重放首次响应，同键不同体 409，不重复执行业务。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  IdempotencyInputError,
  canonicalJson,
  classifyStored,
  hashRequestBody,
  normalizeRequestId,
  type StoredIdempotency,
} from '../src/domain/idempotency.js';
import { AppError } from '../src/lib/errors.js';
import {
  executeReserved,
  runIdempotent,
  type IdempotencyStore,
} from '../src/services/idempotencyRun.js';

const RID = '8f2c0000-0000-4000-8000-000000000001';
const ENDPOINT = 'POST /api/v1/points/batches';

interface MemoryRow extends StoredIdempotency {}

function memoryStore(seed: MemoryRow[] = []): IdempotencyStore & {
  rows: Map<string, MemoryRow>;
  calls: { find: number; insert: number; done: number; remove: number };
} {
  const rows = new Map(seed.map((row) => [row.request_id, structuredClone(row)]));
  const calls = { find: 0, insert: 0, done: 0, remove: 0 };
  return {
    rows,
    calls,
    async find(requestId) {
      calls.find += 1;
      const row = rows.get(requestId);
      return row ? structuredClone(row) : null;
    },
    async insertInFlight(row) {
      calls.insert += 1;
      if (rows.has(row.requestId)) return false;
      rows.set(row.requestId, {
        request_id: row.requestId,
        endpoint: row.endpoint,
        request_hash: row.requestHash,
        status_code: null,
        response_body: null,
        state: 'in_flight',
      });
      return true;
    },
    async markDone(requestId, statusCode, body) {
      calls.done += 1;
      const row = rows.get(requestId);
      if (!row || row.state !== 'in_flight') return false;
      row.state = 'done';
      row.status_code = statusCode;
      row.response_body = body;
      return true;
    },
    async deleteInFlight(requestId, endpoint, requestHash) {
      calls.remove += 1;
      const row = rows.get(requestId);
      if (!row || row.state !== 'in_flight') return;
      if (row.endpoint !== endpoint || row.request_hash !== requestHash) return;
      rows.delete(requestId);
    },
  };
}

function doneRow(patch: Partial<MemoryRow> = {}): MemoryRow {
  return {
    request_id: RID,
    endpoint: ENDPOINT,
    request_hash: hashRequestBody({ request_id: RID, name: '一班' }),
    status_code: 200,
    response_body: { class_id: 'c1', name: '一班' },
    state: 'done',
    ...patch,
  };
}

describe('idempotency canonical hash', () => {
  it('键顺序和 request_id 大小写不影响同一请求体', () => {
    const upper = '8F2C0000-0000-4000-8000-000000000001';
    const left = {
      request_id: upper,
      name: '一班',
      nested: { b: 1, a: ['x', 'y'] },
    };
    const right = {
      nested: { a: ['x', 'y'], b: 1 },
      name: '一班',
      request_id: upper.toLowerCase(),
    };
    assert.equal(hashRequestBody(left), hashRequestBody(right));
    assert.equal(hashRequestBody(left).length, 64);
  });

  it('数组顺序、空串、null 和缺省字段都分开', () => {
    assert.notEqual(hashRequestBody([1, 2]), hashRequestBody([2, 1]));
    assert.notEqual(hashRequestBody({ name: '' }), hashRequestBody({ name: null }));
    assert.notEqual(hashRequestBody({ name: null }), hashRequestBody({}));
    assert.equal(hashRequestBody({ name: 'A', extra: undefined }), hashRequestBody({ name: 'A' }));
    assert.equal(hashRequestBody(0), hashRequestBody(-0));
    assert.notEqual(hashRequestBody(''), hashRequestBody(null));
    assert.notEqual(hashRequestBody([]), hashRequestBody({}));
  });

  it('长文本、空对象和 unicode 可以稳定哈希', () => {
    const long = '测'.repeat(100_000);
    assert.equal(hashRequestBody({ note: long }), hashRequestBody({ note: long }));
    assert.equal(canonicalJson({}), '{}');
    assert.equal(hashRequestBody({ name: '张三🙂' }), hashRequestBody({ name: '张三🙂' }));
  });

  it('密码原文不进入规范化文本，不同密码哈希不同', () => {
    const json = canonicalJson({
      old_password: 'super-secret-value',
      new_password: 'another-secret-value',
      password: 'plain-password',
      request_id: RID,
    });
    assert.equal(json.includes('super-secret-value'), false);
    assert.equal(json.includes('another-secret-value'), false);
    assert.equal(json.includes('plain-password'), false);
    assert.notEqual(
      hashRequestBody({ old_password: 'one-password-1', new_password: 'new-password-1', request_id: RID }),
      hashRequestBody({ old_password: 'one-password-1', new_password: 'new-password-2', request_id: RID }),
    );
  });

  it('非法数字、非法时间和循环引用被拒绝', () => {
    assert.throws(() => hashRequestBody({ delta: Number.NaN }), IdempotencyInputError);
    assert.throws(() => hashRequestBody({ delta: Number.POSITIVE_INFINITY }), IdempotencyInputError);
    assert.throws(() => hashRequestBody({ at: new Date('not-a-date') }), IdempotencyInputError);
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    assert.throws(() => hashRequestBody(cycle), IdempotencyInputError);
    const list: unknown[] = [];
    list.push(list);
    assert.throws(() => hashRequestBody(list), IdempotencyInputError);
  });

  it('日期和 UUID 边界', () => {
    const at = new Date('2026-09-24T00:00:00.000Z');
    assert.equal(hashRequestBody({ at }), hashRequestBody({ at: at.toISOString() }));
    assert.equal(normalizeRequestId(RID.toUpperCase()), RID);
    assert.throws(() => normalizeRequestId(''), IdempotencyInputError);
    assert.throws(() => normalizeRequestId('not-a-uuid'), IdempotencyInputError);
    assert.throws(
      () => normalizeRequestId(`${RID}'; DROP TABLE idempotency;--`),
      IdempotencyInputError,
    );
    assert.throws(() => normalizeRequestId(` ${RID} `), IdempotencyInputError);
    assert.equal(normalizeRequestId('00000000-0000-0000-0000-000000000000'), '00000000-0000-0000-0000-000000000000');
  });

  it('已完成、冲突、处理中和损坏记录的判定', () => {
    const hash = hashRequestBody({ request_id: RID });
    const base: StoredIdempotency = {
      request_id: RID,
      endpoint: ENDPOINT,
      request_hash: hash,
      status_code: 200,
      response_body: { ok: true },
      state: 'done',
    };
    assert.equal(classifyStored(base, ENDPOINT, hash).kind, 'replay');
    assert.equal(classifyStored({ ...base, request_hash: 'other' }, ENDPOINT, hash).kind, 'mismatch');
    assert.equal(classifyStored({ ...base, endpoint: 'POST /api/v1/terms' }, ENDPOINT, hash).kind, 'mismatch');
    assert.equal(classifyStored({ ...base, state: 'in_flight' }, ENDPOINT, hash).kind, 'in_flight');
    assert.equal(classifyStored({ ...base, status_code: null }, ENDPOINT, hash).kind, 'corrupt');
    assert.equal(classifyStored({ ...base, status_code: 99 }, ENDPOINT, hash).kind, 'corrupt');
    assert.equal(classifyStored({ ...base, state: 'unknown' }, ENDPOINT, hash).kind, 'corrupt');
  });
});

describe('runIdempotent', () => {
  it('首次执行并在同键同体时重放，不再次执行业务', async () => {
    const store = memoryStore();
    let calls = 0;
    const body = { request_id: RID, name: '一班' };
    const first = await runIdempotent(store, RID, ENDPOINT, body, async () => {
      calls += 1;
      return { statusCode: 200, body: { class_id: 'c1', name: '一班', seats: [1, 2] } };
    });
    const replay = await runIdempotent(store, RID.toUpperCase(), ENDPOINT, { name: '一班', request_id: RID }, async () => {
      calls += 1;
      return { statusCode: 200, body: { class_id: 'other' } };
    });

    assert.equal(calls, 1);
    assert.equal(first.fromCache, false);
    assert.equal(replay.fromCache, true);
    assert.equal(replay.statusCode, 200);
    assert.deepEqual(replay.body, first.body);
    assert.equal(store.calls.done, 1);
  });

  it('重放结果被调用方修改后，下一次仍然是首次响应', async () => {
    const store = memoryStore();
    const body = { request_id: RID, delta: 1 };
    const first = await runIdempotent(store, RID, ENDPOINT, body, async () => ({
      statusCode: 200,
      body: { items: [{ student_id: 's1' }] },
    }));
    first.body.items.push({ student_id: 'mutated' });
    const replay = await runIdempotent(store, RID, ENDPOINT, body, async () => {
      throw new Error('不应执行');
    });
    assert.deepEqual(replay.body, { items: [{ student_id: 's1' }] });
  });

  it('同键不同体返回 409，不执行业务', async () => {
    const store = memoryStore();
    let calls = 0;
    await runIdempotent(store, RID, ENDPOINT, { request_id: RID, name: '一班' }, async () => {
      calls += 1;
      return { statusCode: 200, body: { name: '一班' } };
    });
    await assert.rejects(
      () =>
        runIdempotent(store, RID, ENDPOINT, { request_id: RID, name: '二班' }, async () => {
          calls += 1;
          return { statusCode: 200, body: { name: '二班' } };
        }),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'IDEMPOTENCY_MISMATCH');
        assert.equal(err.httpStatus, 409);
        return true;
      },
    );
    assert.equal(calls, 1);
    assert.equal(store.calls.done, 1);
  });

  it('同一个 request_id 打到另一个端点返回 409', async () => {
    const store = memoryStore([doneRow()]);
    await assert.rejects(
      () =>
        runIdempotent(
          store,
          RID,
          'POST /api/v1/terms',
          { request_id: RID, name: '一班' },
          async () => ({ statusCode: 200, body: { ok: true } }),
        ),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'IDEMPOTENCY_MISMATCH');
        return true;
      },
    );
    assert.equal(store.calls.insert, 0);
    assert.equal(store.calls.done, 0);
  });

  it('处理中的同键请求返回 409，不覆盖已有占位', async () => {
    const hash = hashRequestBody({ request_id: RID });
    const store = memoryStore([
      {
        request_id: RID,
        endpoint: ENDPOINT,
        request_hash: hash,
        status_code: null,
        response_body: null,
        state: 'in_flight',
      },
    ]);
    await assert.rejects(
      () =>
        runIdempotent(store, RID, ENDPOINT, { request_id: RID }, async () => ({
          statusCode: 200,
          body: { ok: true },
        })),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'REQUEST_IN_FLIGHT');
        assert.equal(err.httpStatus, 409);
        return true;
      },
    );
    assert.equal(store.rows.get(RID)?.state, 'in_flight');
  });

  it('插入冲突后读到已完成记录则重放，读不到则视为处理中', async () => {
    const body = { request_id: RID, name: '一班' };
    const conflictDone = memoryStore([doneRow()]);
    let finds = 0;
    const originalFind = conflictDone.find.bind(conflictDone);
    conflictDone.find = async (id) => {
      finds += 1;
      if (finds === 1) return null;
      return originalFind(id);
    };
    conflictDone.insertInFlight = async () => false;
    const replay = await runIdempotent(conflictDone, RID, ENDPOINT, body, async () => {
      throw new Error('不应执行');
    });
    assert.equal(replay.fromCache, true);
    assert.deepEqual(replay.body, { class_id: 'c1', name: '一班' });

    const hidden = memoryStore();
    hidden.insertInFlight = async () => false;
    await assert.rejects(
      () => runIdempotent(hidden, RID, ENDPOINT, body, async () => ({ statusCode: 200, body: 1 })),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'REQUEST_IN_FLIGHT');
        return true;
      },
    );
    assert.equal(hidden.calls.done, 0);
  });

  it('业务失败不写入完成态；调用方回滚后占位消失', async () => {
    const store = memoryStore();
    const snapshot = (): MemoryRow[] => [...store.rows.values()].map((row) => structuredClone(row));
    await assert.rejects(
      async () => {
        const before = snapshot();
        try {
          await runIdempotent(store, RID, ENDPOINT, { request_id: RID }, async () => {
            throw new AppError('NOT_FOUND', '班级不存在');
          });
        } catch (err) {
          store.rows.clear();
          for (const row of before) store.rows.set(row.request_id, row);
          throw err;
        }
      },
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'NOT_FOUND');
        return true;
      },
    );
    assert.equal(store.rows.size, 0);
    assert.equal(store.calls.done, 0);
  });

  it('存储故障不会执行业务', async () => {
    const store = memoryStore();
    let calls = 0;
    store.insertInFlight = async () => {
      throw new Error('connection reset');
    };
    await assert.rejects(
      () =>
        runIdempotent(store, RID, ENDPOINT, { request_id: RID }, async () => {
          calls += 1;
          return { statusCode: 200, body: { ok: true } };
        }),
      /connection reset/,
    );
    assert.equal(calls, 0);
  });

  it('非法 request_id、端点和状态码都不会记成完成', async () => {
    const rejected: Array<{ code: string; run: (store: ReturnType<typeof memoryStore>) => Promise<unknown> }> = [
      { code: 'VALIDATION_FAILED', run: (store) => runIdempotent(store, '', ENDPOINT, {}, async () => ({ statusCode: 200, body: 1 })) },
      { code: 'VALIDATION_FAILED', run: (store) => runIdempotent(store, RID, '', { request_id: RID }, async () => ({ statusCode: 200, body: 1 })) },
      {
        code: 'VALIDATION_FAILED',
        run: (store) => runIdempotent(store, RID, 'x'.repeat(301), { request_id: RID }, async () => ({ statusCode: 200, body: 1 })),
      },
      {
        code: 'VALIDATION_FAILED',
        run: (store) => runIdempotent(store, RID, ENDPOINT, { request_id: 'nope' }, async () => ({ statusCode: 200, body: 1 })),
      },
      {
        code: 'VALIDATION_FAILED',
        run: (store) =>
          runIdempotent(store, RID, ENDPOINT, { request_id: '8f2c0000-0000-4000-8000-000000000002' }, async () => ({
            statusCode: 200,
            body: 1,
          })),
      },
      {
        code: 'VALIDATION_FAILED',
        run: (store) => runIdempotent(store, RID, ENDPOINT, { request_id: RID, delta: Number.NaN }, async () => ({ statusCode: 200, body: 1 })),
      },
      {
        code: 'INTERNAL',
        run: (store) => runIdempotent(store, RID, ENDPOINT, { request_id: RID }, async () => ({ statusCode: 99, body: 1 })),
      },
      {
        code: 'INTERNAL',
        run: (store) => runIdempotent(store, RID, ENDPOINT, { request_id: RID }, async () => ({ statusCode: 600, body: 1 })),
      },
    ];
    for (const item of rejected) {
      const store = memoryStore();
      await assert.rejects(item.run(store), (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, item.code);
        return true;
      });
      assert.equal(store.calls.done, 0);
    }
  });

  it('重放保留首次状态码，损坏的完成记录返回内部错误', async () => {
    const hash = hashRequestBody({ request_id: RID });
    const created = memoryStore([
      doneRow({
        request_hash: hash,
        status_code: 201,
        response_body: { batch_id: 'b1' },
      }),
    ]);
    const replay = await runIdempotent(created, RID, ENDPOINT, { request_id: RID }, async () => {
      throw new Error('不应执行');
    });
    assert.equal(replay.statusCode, 201);
    assert.deepEqual(replay.body, { batch_id: 'b1' });

    const corrupt = memoryStore([doneRow({ request_hash: hash, status_code: null })]);
    await assert.rejects(
      () => runIdempotent(corrupt, RID, ENDPOINT, { request_id: RID }, async () => ({ statusCode: 200, body: 1 })),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'INTERNAL');
        return true;
      },
    );
  });
});

describe('executeReserved', () => {
  it('成功后重放首次结果，失败后释放占位并允许重试', async () => {
    const store = memoryStore();
    let calls = 0;
    const body = { request_id: RID };
    const first = await executeReserved(store, RID, 'POST /api/v1/classes/c1/anonymize', body, async () => {
      calls += 1;
      return { anonymized: 2, failed: 0, students: ['s1', 's2'] };
    });
    const replay = await executeReserved(store, RID, 'POST /api/v1/classes/c1/anonymize', body, async () => {
      calls += 1;
      return { anonymized: 0, failed: 0, students: [] };
    });
    assert.equal(calls, 1);
    assert.deepEqual(replay, first);

    const retryStore = memoryStore();
    await assert.rejects(
      () =>
        executeReserved(retryStore, RID, ENDPOINT, body, async () => {
          throw new AppError('FORBIDDEN', '外部账本失败');
        }),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'FORBIDDEN');
        return true;
      },
    );
    assert.equal(retryStore.rows.size, 0);
    const recovered = await executeReserved(retryStore, RID, ENDPOINT, body, async () => ({ ok: true }));
    assert.deepEqual(recovered, { ok: true });
  });

  it('未占住的处理中记录不会被删掉', async () => {
    const hash = hashRequestBody({ request_id: RID });
    const store = memoryStore([
      {
        request_id: RID,
        endpoint: ENDPOINT,
        request_hash: hash,
        status_code: null,
        response_body: null,
        state: 'in_flight',
      },
    ]);
    await assert.rejects(
      () => executeReserved(store, RID, ENDPOINT, { request_id: RID }, async () => ({ ok: true })),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'REQUEST_IN_FLIGHT');
        return true;
      },
    );
    assert.equal(store.calls.remove, 0);
    assert.equal(store.rows.get(RID)?.state, 'in_flight');
  });

  it('完成后的写入失败不会把已成功的占位删掉', async () => {
    const store = memoryStore();
    store.markDone = async () => false;
    await assert.rejects(
      () => executeReserved(store, RID, ENDPOINT, { request_id: RID }, async () => ({ ok: true })),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'INTERNAL');
        return true;
      },
    );
    assert.equal(store.calls.remove, 0);
    assert.equal(store.rows.get(RID)?.state, 'in_flight');
  });
});
