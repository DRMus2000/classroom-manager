/**
 * 在测试库上验证标记定义、重名、打标和归档。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { AppError } from '../src/lib/errors.js';

const PORT = 55442;
const USER = 'classroom';
const PASSWORD = 'classroom_password';
const DATABASE = 'classroom_manager';
const REQUEST = '8f2c0000-0000-4000-8000-000000000041';

describe('mark definitions', { timeout: 180_000 }, () => {
  let databaseDir = '';
  let postgres: EmbeddedPostgres | undefined;

  after(async () => {
    const { closeDb } = await import('../src/repo/db.js').catch(() => ({ closeDb: async () => undefined }));
    await closeDb();
    await postgres?.stop().catch(() => undefined);
    if (databaseDir) await rm(databaseDir, { recursive: true, force: true });
  });

  it('创建、重名、打标、重复打标、归档和撤销', async () => {
    databaseDir = await mkdtemp(path.join(tmpdir(), 'classroom-marks-pg-'));
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
    assert.match(await runMigrate(connectionString), /002_phase2_duty_marks\.sql/);
    process.env.DATABASE_URL = connectionString;

    const marks = await import('../src/services/marks.js');
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      const teacher = await client.query<{ teacher_id: string }>(
        `INSERT INTO teacher (username, password_hash) VALUES ('mark-teacher', 'hash') RETURNING teacher_id`,
      );
      const actorId = teacher.rows[0]!.teacher_id;
      const createdClass = await client.query<{ class_id: string }>(
        `INSERT INTO class (name) VALUES ('标记班') RETURNING class_id`,
      );
      const student = await client.query<{ student_id: string }>(
        `INSERT INTO student (class_id, student_no, name) VALUES ($1, '1', '甲') RETURNING student_id`,
        [createdClass.rows[0]!.class_id],
      );
      const studentId = student.rows[0]!.student_id;
      const input = { name: '课代表', icon: '★', color: '#11AA22', request_id: REQUEST };
      const created = await marks.createMark(actorId, input);
      assert.equal(created.name, '课代表');
      const replay = await marks.createMark(actorId, input);
      assert.equal(replay.mark_id, created.mark_id);
      assert.equal((await marks.listMarks()).length, 1);

      await assert.rejects(
        () =>
          marks.createMark(actorId, {
            ...input,
            request_id: '8f2c0000-0000-4000-8000-000000000043',
          }),
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.code, 'FORBIDDEN');
          return true;
        },
      );

      await marks.addMark(actorId, studentId, created.mark_id, '8f2c0000-0000-4000-8000-000000000044');
      await marks.addMark(actorId, studentId, created.mark_id, '8f2c0000-0000-4000-8000-000000000045');
      const links = await client.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM student_mark WHERE student_id = $1`,
        [studentId],
      );
      assert.equal(links.rows[0]!.n, 1);

      await assert.rejects(
        () =>
          marks.addMark(
            actorId,
            '8f2c0000-0000-4000-8000-000000000099',
            created.mark_id,
            '8f2c0000-0000-4000-8000-000000000046',
          ),
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.code, 'NOT_FOUND');
          return true;
        },
      );

      await marks.removeMark(actorId, studentId, created.mark_id, '8f2c0000-0000-4000-8000-000000000047');
      const afterRemove = await client.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM student_mark WHERE student_id = $1`,
        [studentId],
      );
      assert.equal(afterRemove.rows[0]!.n, 0);

      await marks.patchMark(
        actorId,
        created.mark_id,
        { archived: true },
        '8f2c0000-0000-4000-8000-000000000048',
      );
      assert.equal((await marks.listMarks()).length, 0);
      const renamed = await marks.createMark(actorId, {
        name: '课代表',
        icon: '☆',
        color: '#000000',
        request_id: '8f2c0000-0000-4000-8000-000000000049',
      });
      assert.notEqual(renamed.mark_id, created.mark_id);

      await assert.rejects(
        () => marks.addMark(actorId, studentId, created.mark_id, '8f2c0000-0000-4000-8000-000000000050'),
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.code, 'NOT_FOUND');
          return true;
        },
      );
    } finally {
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
