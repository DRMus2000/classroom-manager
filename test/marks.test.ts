/**
 * 普通标记的契约、未登录拒绝，以及定义和打标。
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { createMarkInput, patchMarkInput } from '../src/lib/schema.js';

const REQUEST = '8f2c0000-0000-4000-8000-000000000041';

describe('mark contract', () => {
  it('颜色必须是 #RRGGBB，空白名称会被拒绝', () => {
    const ok = createMarkInput.parse({
      name: ' 课代表 ',
      icon: ' ★ ',
      color: '#A1B2C3',
      request_id: REQUEST,
    });
    assert.equal(ok.name, '课代表');
    assert.equal(ok.icon, '★');
    for (const color of ['#12345', '#GGGGGG', 'A1B2C3', '#a1b2c3ff', '']) {
      assert.equal(
        createMarkInput.safeParse({ name: '甲', icon: '★', color, request_id: REQUEST }).success,
        false,
      );
    }
    assert.equal(createMarkInput.safeParse({ name: ' ', icon: '★', color: '#112233', request_id: REQUEST }).success, false);
    assert.equal(createMarkInput.safeParse({ name: '甲', icon: '', color: '#112233', request_id: REQUEST }).success, false);
    assert.equal(patchMarkInput.safeParse({ request_id: REQUEST, archived: true }).success, true);
    assert.equal(patchMarkInput.safeParse({ request_id: 'nope' }).success, false);
  });
});

describe('mark routes', () => {
  after(async () => {
    const { closeDb } = await import('../src/repo/db.js');
    await closeDb();
  });

  it('未登录不能读取或修改标记', async () => {
    process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';
    const { buildServer } = await import('../src/server.js');
    const app = await buildServer();
    const id = '8f2c0000-0000-4000-8000-000000000042';
    try {
      const paths: Array<[string, string]> = [
        ['GET', '/api/v1/marks'],
        ['POST', '/api/v1/marks'],
        ['PATCH', `/api/v1/marks/${id}`],
        ['POST', `/api/v1/students/${id}/marks/${id}`],
        ['DELETE', `/api/v1/students/${id}/marks/${id}`],
      ];
      for (const [method, url] of paths) {
        const response = await app.inject({ method: method as 'GET', url, payload: {} });
        assert.equal(response.statusCode, 401);
        assert.equal(response.json().error.code, 'UNAUTHENTICATED');
      }
    } finally {
      await app.close();
    }
  });
});
