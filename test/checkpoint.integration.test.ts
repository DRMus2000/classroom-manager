/**
 * 回放检查点任务：阈值、每日兜底、重复执行、归档班、锁冲突、单班失败。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const PORT = 55448;
const USER = 'classroom';
const PASSWORD = 'classroom_password';
const DATABASE = 'classroom_manager';

describe('checkpoint job', { timeout: 180_000 }, () => {
  let databaseDir = '';
  let postgres: EmbeddedPostgres | undefined;
  let connectionString = '';

  after(async () => {
    const { closeDb } = await import('../src/repo/db.js').catch(() => ({ closeDb: async () => undefined }));
    await closeDb();
    await postgres?.stop().catch(() => undefined);
    if (databaseDir) await rm(databaseDir, { recursive: true, force: true });
  });

  it('按阈值和每日兜底写检查点，并挡住重复、归档、锁冲突和单班失败', async () => {
    databaseDir = await mkdtemp(path.join(tmpdir(), 'classroom-checkpoint-pg-'));
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
    assert.match(await runMigrate(connectionString), /001_phase1_core\.sql/);
    process.env.DATABASE_URL = connectionString;
    delete process.env.REPLAY_CHECKPOINT_EVENT_THRESHOLD;

    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      const { writeDueCheckpoints, CHECKPOINT_LOCK_KEY } = await import('../src/services/replay.js');

      const empty = await writeDueCheckpoints({ daily: false });
      assert.deepEqual(empty, { written: 0, skipped: 0, failed: 0, busy: false });

      const term = await client.query<{ term_id: string }>(
        `INSERT INTO term (name, status, is_current) VALUES ('2026秋', 'open', true) RETURNING term_id`,
      );
      const termId = term.rows[0]!.term_id;
      const oldTerm = await client.query<{ term_id: string }>(
        `INSERT INTO term (name, status, is_current) VALUES ('2025秋', 'closed', false) RETURNING term_id`,
      );
      const oldTermId = oldTerm.rows[0]!.term_id;

      const active = await client.query<{ class_id: string }>(
        `INSERT INTO class (name) VALUES ('在班') RETURNING class_id`,
      );
      const classId = active.rows[0]!.class_id;
      const archived = await client.query<{ class_id: string }>(
        `INSERT INTO class (name, archived_at) VALUES ('归档班', now()) RETURNING class_id`,
      );
      const archivedId = archived.rows[0]!.class_id;
      const student = await client.query<{ student_id: string }>(
        `INSERT INTO student (class_id, student_no, name) VALUES ($1, '1', '甲') RETURNING student_id`,
        [classId],
      );
      const studentId = student.rows[0]!.student_id;

      async function logPoints(targetClass: string, targetTerm: string, delta: number): Promise<void> {
        await client.query(
          `INSERT INTO event_log (class_id, kind, payload, replay_relevant)
           VALUES ($1, 'points_appended', $2::jsonb, true)`,
          [
            targetClass,
            JSON.stringify({
              class_id: targetClass,
              term_id: targetTerm,
              entries: [{ student_id: studentId, delta }],
            }),
          ],
        );
      }

      await logPoints(classId, oldTermId, 4);
      await logPoints(classId, oldTermId, 4);
      await logPoints(archivedId, termId, 9);
      await logPoints(archivedId, termId, 9);

      const below = await writeDueCheckpoints({ daily: false });
      assert.equal(below.written, 0);
      assert.equal(below.failed, 0);
      assert.equal(below.busy, false);

      const dailyEmpty = await writeDueCheckpoints({ daily: true });
      assert.equal(dailyEmpty.written, 0);
      const none = await client.query(`SELECT COUNT(*)::int AS n FROM replay_checkpoint`);
      assert.equal(none.rows[0]!.n, 0);

      await logPoints(classId, termId, 3);
      await logPoints(classId, termId, 2);

      await client.query(
        `UPDATE job_config SET value = '0'::jsonb WHERE key = 'replay_checkpoint_event_threshold'`,
      );
      const invalidThreshold = await writeDueCheckpoints({ daily: false });
      assert.equal(invalidThreshold.written, 0);

      process.env.REPLAY_CHECKPOINT_EVENT_THRESHOLD = '2';
      const fromEnv = await writeDueCheckpoints({ daily: false });
      delete process.env.REPLAY_CHECKPOINT_EVENT_THRESHOLD;
      assert.equal(fromEnv.written, 1);
      assert.equal(fromEnv.skipped, 0);

      const row = await client.query<{ trigger_reason: string; state: Record<string, { balance: number }> }>(
        `SELECT trigger_reason, state FROM replay_checkpoint WHERE class_id = $1 AND term_id = $2`,
        [classId, termId],
      );
      assert.equal(row.rows.length, 1);
      assert.equal(row.rows[0]!.trigger_reason, 'event_threshold');
      assert.equal(row.rows[0]!.state[studentId]!.balance, 5);

      const again = await writeDueCheckpoints({ daily: true });
      assert.equal(again.written, 0);
      const stillOne = await client.query(`SELECT COUNT(*)::int AS n FROM replay_checkpoint`);
      assert.equal(stillOne.rows[0]!.n, 1);

      await logPoints(classId, termId, 1);
      await client.query(
        `UPDATE job_config SET value = '200'::jsonb WHERE key = 'replay_checkpoint_event_threshold'`,
      );
      const daily = await writeDueCheckpoints({ daily: true });
      assert.equal(daily.written, 1);
      const reasons = await client.query<{ trigger_reason: string }>(
        `SELECT trigger_reason FROM replay_checkpoint WHERE class_id = $1 ORDER BY upto_event_seq`,
        [classId],
      );
      assert.deepEqual(
        reasons.rows.map((item) => item.trigger_reason),
        ['event_threshold', 'daily'],
      );

      const archivedRows = await client.query(
        `SELECT 1 FROM replay_checkpoint WHERE class_id = $1`,
        [archivedId],
      );
      assert.equal(archivedRows.rowCount, 0);

      const blocker = await client.query<{ class_id: string }>(
        `INSERT INTO class (name) VALUES ('失败班') RETURNING class_id`,
      );
      const blockedId = blocker.rows[0]!.class_id;
      await logPoints(blockedId, termId, 1);
      assert.match(blockedId, /^[0-9a-f-]{36}$/i);
      await client.query(
        `ALTER TABLE replay_checkpoint ADD CONSTRAINT ck_checkpoint_block_class CHECK (class_id <> '${blockedId}'::uuid)`,
      );
      await client.query(
        `UPDATE job_config SET value = '1'::jsonb WHERE key = 'replay_checkpoint_event_threshold'`,
      );
      const partial = await writeDueCheckpoints({ daily: false });
      assert.equal(partial.failed, 1);
      assert.equal(partial.written, 0);
      const blocked = await client.query(`SELECT 1 FROM replay_checkpoint WHERE class_id = $1`, [blockedId]);
      assert.equal(blocked.rowCount, 0);
      await client.query(`ALTER TABLE replay_checkpoint DROP CONSTRAINT ck_checkpoint_block_class`);

      const holder = new pg.Client({ connectionString });
      await holder.connect();
      const locked = await holder.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_lock(hashtextextended($1::text, 0)) AS locked`,
        [CHECKPOINT_LOCK_KEY],
      );
      assert.equal(locked.rows[0]!.locked, true);
      const busy = await writeDueCheckpoints({ daily: true });
      assert.equal(busy.busy, true);
      assert.equal(busy.written, 0);
      await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1::text, 0))`, [CHECKPOINT_LOCK_KEY]);
      await holder.end();

      const unknown = await runCheckpoint(connectionString, ['--force']);
      assert.equal(unknown.code, 1);
      assert.match(unknown.output, /未知参数/);

      const dailyRun = await runCheckpoint(connectionString, ['--daily']);
      assert.equal(dailyRun.code, 0);
      assert.match(dailyRun.output, /每日检查点/);
    } finally {
      await client.end();
    }
  });
});

function runMigrate(connectionString: string): Promise<string> {
  return runNode(['--import', 'tsx', 'scripts/migrate.ts', 'up'], connectionString);
}

function runCheckpoint(connectionString: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/checkpoint.ts', ...args], {
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
    child.on('exit', (code) => resolve({ code: code ?? 1, output }));
    child.on('error', reject);
  });
}

function runNode(args: string[], connectionString: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
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
      else reject(new Error(output || `exited ${code}`));
    });
  });
}
