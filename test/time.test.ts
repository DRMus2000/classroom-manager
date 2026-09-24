import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../src/lib/errors.js';
import { timestampMs, toIsoTimestamp } from '../src/lib/time.js';

describe('database timestamps', () => {
  it('接受 PostgreSQL 文本时间，解析失败抛 INTERNAL', () => {
    const iso = toIsoTimestamp('2026-09-25 02:20:22.09+08');
    assert.equal(iso, '2026-09-24T18:20:22.090Z');
    assert.equal(timestampMs('2026-09-25 02:20:22.09+08'), Date.parse(iso));
    assert.equal(toIsoTimestamp('2026-09-25T02:20:22.090+08:00'), '2026-09-24T18:20:22.090Z');
    assert.throws(
      () => toIsoTimestamp('not-a-time'),
      (err: unknown) => err instanceof AppError && err.code === 'INTERNAL',
    );
  });
});
