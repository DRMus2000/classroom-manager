/**
 * 登录失败必须落库；第五次之后返回 429。改密后旧会话失效，当前设备拿到新 Cookie。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { AppError } from '../src/lib/errors.js';

const PORT = 55444;
const USER = 'classroom';
const PASSWORD = 'classroom_password';
const DATABASE = 'classroom_manager';

describe('login lock and password session', { timeout: 180_000 }, () => {
  let databaseDir = '';
  let postgres: EmbeddedPostgres | undefined;

  after(async () => {
    const { closeDb } = await import('../src/repo/db.js').catch(() => ({ closeDb: async () => undefined }));
    await closeDb();
    await postgres?.stop().catch(() => undefined);
    if (databaseDir) await rm(databaseDir, { recursive: true, force: true });
  });

  it('失败记录不被回滚，改密签发新会话', async () => {
    databaseDir = await mkdtemp(path.join(tmpdir(), 'classroom-auth-pg-'));
    postgres = new EmbeddedPostgres({
      databaseDir,
      user: USER,
      password: PASSWORD,
      port: PORT,
      persistent: true,
      initdbFlags: ['--encoding=UTF8', '--locale=C'],
    });
    await postgres.initialise();
    await postgres.start();
    await postgres.createDatabase(DATABASE);
    const connectionString = `postgresql://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}`;
    assert.match(await runMigrate(connectionString), /001_phase1_core\.sql/);
    process.env.DATABASE_URL = connectionString;

    const authRepo = await import('../src/repo/auth.js');
    const auth = await import('../src/services/auth.js');
    const { buildServer } = await import('../src/server.js');
    const pg = await import('pg');
    const client = new pg.default.Client({ connectionString });
    await client.connect();
    const dbMod = await import('../src/repo/db.js');
    await authRepo.createTeacher(dbMod.db, { username: 'teacher', password: 'correct-password' });

    for (let i = 0; i < 5; i += 1) {
      await assert.rejects(
        () => auth.login({ username: 'teacher', password: 'wrong-password-1' }, { ip: '10.1.1.1' }),
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.code, 'UNAUTHENTICATED');
          return true;
        },
      );
    }
    const stored = await client.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM login_attempt WHERE username = 'teacher' AND success = false`,
    );
    assert.equal(stored.rows[0]!.n, 5);
    await assert.rejects(
      () => auth.login({ username: 'teacher', password: 'wrong-password-1' }, { ip: '10.1.1.1' }),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'RATE_LIMITED');
        assert.equal(err.httpStatus, 429);
        return true;
      },
    );
    const afterLock = await client.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM login_attempt WHERE username = 'teacher' AND success = false`,
    );
    assert.equal(afterLock.rows[0]!.n, 5);

    await client.query(`DELETE FROM login_attempt`);
    const other = await auth.login(
      { username: 'no-such-user', password: 'wrong-password-1' },
      { ip: '10.9.9.9' },
    ).catch((err: unknown) => err);
    assert.ok(other instanceof AppError);
    for (let i = 0; i < 4; i += 1) {
      await auth.login({ username: 'nobody', password: 'wrong-password-1' }, { ip: '10.9.9.9' }).catch(() => undefined);
    }
    await assert.rejects(
      () => auth.login({ username: 'teacher', password: 'correct-password' }, { ip: '10.9.9.9' }),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'RATE_LIMITED');
        return true;
      },
    );

    await client.query(`DELETE FROM login_attempt`);
    const session = await auth.login(
      { username: 'teacher', password: 'correct-password' },
      { ip: '10.2.2.2', user_agent: 'old' },
    );
    const app = await buildServer();
    try {
      const changed = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password',
        cookies: { session: session.token },
        payload: {
          old_password: 'correct-password',
          new_password: 'new-password-123',
          request_id: '8f2c0000-0000-4000-8000-000000000061',
        },
      });
      assert.equal(changed.statusCode, 200);
      const setCookie = String(changed.headers['set-cookie']);
      assert.match(setCookie, /session=/);
      const oldMe = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        cookies: { session: session.token },
      });
      assert.equal(oldMe.statusCode, 401);
      assert.equal(oldMe.json().error.code, 'SESSION_REVOKED');
      const cookie = setCookie.split(';')[0]?.split('=')[1] ?? '';
      const me = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        cookies: { session: cookie },
      });
      assert.equal(me.statusCode, 200);
      assert.equal(me.json().username, 'teacher');
    } finally {
      await app.close();
      await client.end();
    }
  });
});

function runMigrate(connectionString: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/migrate.ts', 'up'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: connectionString },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('exit', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(output || `migrate exited ${code}`));
    });
  });
}
