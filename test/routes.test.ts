import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:9/unused';

describe('route catalog', () => {
  it('注册下载、学生积分和余额，不提供 OpenAPI 与座次历史', async () => {
    const { buildServer } = await import('../src/server.js');
    const app = await buildServer();
    const routes = app.printRoutes({ includeHooks: false });
    assert.match(routes, /:backup_id \(GET/);
    assert.match(routes, /:student_id \(GET/);
    assert.match(routes, /students\/\n/);
    assert.doesNotMatch(routes, /openapi/);
    assert.doesNotMatch(routes, /seats\/history/);
    await app.close();
  });
});
