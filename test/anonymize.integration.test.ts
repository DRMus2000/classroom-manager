/**
 * 匿名化写入外部账本。账本失败时学生身份保持原样，同一 request_id 可以在修好之后重试。
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

const PORT = 55441;
const USER = 'classroom';
const PASSWORD = 'classroom_password';
const DATABASE = 'classroom_manager';
const KEY = 'cd'.repeat(32);

describe('anonymize rolls back when the ledger fails', { timeout: 180_000 }, () => {
  let databaseDir = '';
  let ledgerDir = '';
  let postgres: EmbeddedPostgres | undefined;
  let connectionString = '';

  after(async () => {
    const { closeDb } = await import('../src/repo/db.js').catch(() => ({ closeDb: async () => undefined }));
    await closeDb();
    await postgres?.stop().catch(() => undefined);
    if (databaseDir) await rm(databaseDir, { recursive: true, force: true });
    if (ledgerDir) await rm(ledgerDir, { recursive: true, force: true });
  });

  it('单人与整班都在账本失败时保持原姓名，成功后可重放', async () => {
    databaseDir = await mkdtemp(path.join(tmpdir(), 'classroom-anon-pg-'));
    ledgerDir = await mkdtemp(path.join(tmpdir(), 'classroom-anon-ledger-'));
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
    connectionString = `postgresql://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}`;
    const migrated = await runMigrate(connectionString);
    assert.match(migrated, /001_phase1_core\.sql/);

    process.env['DATABASE_URL'] = connectionString;
    process.env['ANON_LEDGER_PATH'] = path.join(ledgerDir, 'ledger.jsonl.enc');
    process.env['ANON_LEDGER_KEY'] = KEY;

    const { anonymizeStudent, anonymizeClass } = await import('../src/services/students.js');
    const { readLedger } = await import('../src/services/anonLedger.js');
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      const teacher = await client.query<{ teacher_id: string }>(
        `INSERT INTO teacher (username, password_hash) VALUES ('anon-teacher', 'hash') RETURNING teacher_id`,
      );
      const actorId = teacher.rows[0]!.teacher_id;
      const createdClass = await client.query<{ class_id: string }>(
        `INSERT INTO class (name) VALUES ('匿名测试班') RETURNING class_id`,
      );
      const classId = createdClass.rows[0]!.class_id;
      const zhang = await insertStudent(client, classId, '202401', '张三');
      const requestId = '8f2c0000-0000-4000-8000-000000000031';

      process.env['ANON_LEDGER_KEY'] = 'short';
      await assert.rejects(
        () => anonymizeStudent(actorId, zhang, requestId),
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.code, 'INTERNAL');
          assert.equal(String(err.message).includes('short'), false);
          return true;
        },
      );
      assert.deepEqual(await namesOf(client, [zhang]), ['张三']);
      process.env['ANON_LEDGER_KEY'] = KEY;
      assert.equal((await readLedger()).length, 0);

      const done = await anonymizeStudent(actorId, zhang, requestId);
      assert.equal(done.student.name, '');
      assert.equal(done.student.student_no, '');
      assert.equal(done.student.status, 'anonymized');
      assert.ok(done.student.anon_code);
      const ledger = await readLedger();
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0]?.entry_id, done.ledger_entry_id);
      assert.equal(JSON.stringify(ledger).includes('张三'), false);
      assert.equal(JSON.stringify(ledger).includes('202401'), false);

      const replay = await anonymizeStudent(actorId, zhang, requestId);
      assert.equal(replay.ledger_entry_id, done.ledger_entry_id);
      assert.equal((await readLedger()).length, 1);

      await assert.rejects(
        () => anonymizeStudent(actorId, zhang, '8f2c0000-0000-4000-8000-000000000032'),
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.code, 'FORBIDDEN');
          return true;
        },
      );
      await assert.rejects(
        () =>
          anonymizeStudent(actorId, '8f2c0000-0000-4000-8000-000000000099', '8f2c0000-0000-4000-8000-000000000033'),
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.code, 'NOT_FOUND');
          return true;
        },
      );

      const li = await insertStudent(client, classId, '202402', '李四');
      const wang = await insertStudent(client, classId, '202403', '王五');
      const classRequest = '8f2c0000-0000-4000-8000-000000000034';
      process.env['ANON_LEDGER_KEY'] = 'short';
      await assert.rejects(() => anonymizeClass(actorId, classId, classRequest), (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'INTERNAL');
        return true;
      });
      assert.deepEqual(await namesOf(client, [li, wang]), ['李四', '王五']);
      process.env['ANON_LEDGER_KEY'] = KEY;
      assert.equal((await readLedger()).length, 1);
      const batch = await anonymizeClass(actorId, classId, classRequest);
      assert.equal(batch.failed, 0);
      assert.equal(batch.anonymized, 2);
      assert.deepEqual(new Set(batch.students), new Set([li, wang]));
      assert.deepEqual(await namesOf(client, [li, wang]), ['', '']);
      const afterBatch = await readLedger();
      assert.equal(afterBatch.length, 3);
      assert.equal(JSON.stringify(afterBatch).includes('李四'), false);
      assert.equal(JSON.stringify(afterBatch).includes('王五'), false);

      const replayBatch = await anonymizeClass(actorId, classId, classRequest);
      assert.deepEqual(replayBatch, batch);
      assert.equal((await readLedger()).length, 3);

      const exported = await client.query<{ state: string; n: number }>(
        `SELECT state, COUNT(*)::int AS n FROM anon_ledger_export GROUP BY state`,
      );
      assert.deepEqual(exported.rows, [{ state: 'exported', n: 3 }]);

      await assert.rejects(
        () => anonymizeClass(actorId, '8f2c0000-0000-4000-8000-000000000098', '8f2c0000-0000-4000-8000-000000000035'),
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

async function insertStudent(
  client: pg.Client,
  classId: string,
  studentNo: string,
  name: string,
): Promise<string> {
  const result = await client.query<{ student_id: string }>(
    `INSERT INTO student (class_id, student_no, name) VALUES ($1, $2, $3) RETURNING student_id`,
    [classId, studentNo, name],
  );
  return result.rows[0]!.student_id;
}

async function namesOf(client: pg.Client, ids: string[]): Promise<string[]> {
  const result = await client.query<{ name: string }>(
    `SELECT name FROM student WHERE student_id = ANY($1::uuid[]) ORDER BY student_no`,
    [ids],
  );
  return result.rows.map((row) => row.name);
}

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
