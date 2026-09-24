import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dropExpiredKeys } from '../src/lib/previewCache.js';
import { replayResumeSeq } from '../src/domain/replay.js';
import { applyReplayEvent, emptyWorld } from '../src/domain/replay.js';
import { sessionCookieOptions, trustProxyFromEnv } from '../src/lib/httpSecurity.js';
import { assertRestoreTarget, msUntilShanghai } from '../src/lib/backupPlan.js';
import Fastify from 'fastify';

describe('audit fixes', () => {
  it('过期预览同时丢掉解析结果', () => {
    const meta = new Map<string, { expiresAt: number }>([
      ['old', { expiresAt: 1 }],
      ['new', { expiresAt: 100 }],
    ]);
    const payloads = new Map<string, unknown>([
      ['old', { bytes: 2 }],
      ['new', { bytes: 1 }],
    ]);
    dropExpiredKeys(50, meta, payloads);
    assert.deepEqual([...meta.keys()], ['new']);
    assert.deepEqual([...payloads.keys()], ['new']);
  });

  it('后续回放页从游标继续，而不是从区间起点重放', () => {
    assert.equal(replayResumeSeq(0, 40), 40);
    assert.equal(replayResumeSeq(80, 40), 80);
  });

  it('记分事件上的备注不改变回放余额', () => {
    const world = emptyWorld();
    applyReplayEvent(
      world,
      {
        event_seq: 3,
        kind: 'points_appended',
        payload: {
          class_id: 'class',
          term_id: 'term',
          note: '补录',
          entries: [{ student_id: 's1', delta: 2, balance_after: 2 }],
        },
      },
      'class',
      'term',
    );
    assert.equal(world.students.get('s1')?.balance, 2);
  });

  it('HTTPS_ENABLED 决定 Secure Cookie', () => {
    assert.equal(sessionCookieOptions({ HTTPS_ENABLED: 'true' }).secure, true);
    assert.equal(sessionCookieOptions({}).secure, false);
  });

  it('只信任显式配置的代理跳数', async () => {
    assert.equal(trustProxyFromEnv({}), false);
    const trust = trustProxyFromEnv({ TRUST_PROXY: '1' });
    assert.equal(typeof trust, 'function');
    const app = Fastify({ trustProxy: trust });
    app.get('/ip', (request) => ({ ip: request.ip }));
    const response = await app.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress: '10.0.0.8',
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });
    assert.equal(JSON.parse(response.body).ip, '203.0.113.9');
    await app.close();
  });

  it('恢复不能指向当前数据库', () => {
    const live = 'postgresql://classroom:secret@postgres:5432/classroom_manager';
    assert.throws(() => assertRestoreTarget(live, live), /当前 DATABASE_URL/);
    assert.doesNotThrow(() =>
      assertRestoreTarget(live, 'postgresql://classroom:secret@postgres:5432/classroom_restore'),
    );
  });

  it('备份调度等待到上海时间 02:15', () => {
    const morning = new Date('2026-09-25T00:00:00+08:00');
    assert.equal(msUntilShanghai(2, 15, morning), (2 * 3600 + 15 * 60) * 1000);
  });
});
