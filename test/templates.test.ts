import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../src/lib/errors.js';
import { listEntriesQuery } from '../src/lib/schema.js';

const REQUEST = '8f2c0000-0000-4000-8000-000000000071';

describe('templates and timeline query', () => {
  it('分值方向相反时拒绝，false 字符串不再被当成 true', async () => {
    process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';
    const points = await import('../src/services/points.js');
    await assert.rejects(
      () =>
        points.createGlobalTemplate('8f2c0000-0000-4000-8000-000000000072', {
          name: '回答',
          polarity: 1,
          default_delta: -2,
          request_id: REQUEST,
        }),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'POLARITY_MISMATCH');
        assert.equal(err.httpStatus, 422);
        return true;
      },
    );
    assert.equal(listEntriesQuery.parse({ include_reversals: 'false' }).include_reversals, false);
    assert.equal(listEntriesQuery.parse({ include_reversals: 'true' }).include_reversals, true);
    assert.equal(listEntriesQuery.parse({}).include_reversals, true);
  });
});
