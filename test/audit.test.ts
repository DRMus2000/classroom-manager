/**
 * 审计查询参数和未登录拒绝。
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { auditQuery } from '../src/lib/schema.js';

describe('audit query', () => {
  it('游标必须是数字，limit 有上限', () => {
    const parsed = auditQuery.parse({
      entity: 'class',
      limit: '2',
      date_from: '2026-09-24T00:00:00.000Z',
    });
    assert.equal(parsed.limit, 2);
    assert.equal(parsed.entity, 'class');
    assert.equal(auditQuery.safeParse({ cursor: 'abc' }).success, false);
    assert.equal(auditQuery.safeParse({ cursor: '-1' }).success, false);
    assert.equal(auditQuery.safeParse({ cursor: '12' }).success, true);
    assert.equal(auditQuery.safeParse({ limit: '0' }).success, false);
    assert.equal(auditQuery.safeParse({ limit: '201' }).success, false);
    assert.equal(auditQuery.parse({}).limit, 50);
  });
});

describe('audit routes', () => {
  after(async () => {
    const { closeDb } = await import('../src/repo/db.js');
    await closeDb();
  });

  it('未登录不能查询审计或备份', async () => {
    process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';
    const { buildServer } = await import('../src/server.js');
    const app = await buildServer();
    try {
      const audit = await app.inject({ method: 'GET', url: '/api/v1/audit?cursor=nope' });
      const backups = await app.inject({ method: 'GET', url: '/api/v1/backup/records' });
      assert.equal(audit.statusCode, 401);
      assert.equal(audit.json().error.code, 'UNAUTHENTICATED');
      assert.equal(backups.statusCode, 401);
      assert.equal(backups.json().error.code, 'UNAUTHENTICATED');
    } finally {
      await app.close();
    }
  });
});
