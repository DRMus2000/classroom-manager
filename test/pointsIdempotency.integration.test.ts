/**
 * 同一 request_id 不重复记分。部分撤销后，整批撤销只冲销剩余明细。
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

const PORT = 55452;

describe('point idempotency and partial reverse', { timeout: 180_000 }, () => {
  let databaseDir = '';
  let postgres: EmbeddedPostgres | undefined;

  after(async () => {
    const { closeDb } = await import('../src/repo/db.js').catch(() => ({ closeDb: async () => undefined }));
    await closeDb();
    await postgres?.stop().catch(() => undefined);
    if (databaseDir) await rm(databaseDir, { recursive: true, force: true });
  });

  it('重放不新增明细，整批撤销跳过已冲销的人', async () => {
    databaseDir = await mkdtemp(path.join(tmpdir(), 'classroom-idem-pg-'));
    postgres = new EmbeddedPostgres({
      databaseDir,
      user: 'classroom',
      password: 'classroom_password',
      port: PORT,
      persistent: true,
      initdbFlags: ['--encoding=UTF8', '--locale=C'],
    });
    await postgres.initialise();
    await postgres.start();
    await postgres.createDatabase('classroom_manager');
    const connectionString = `postgresql://classroom:classroom_password@127.0.0.1:${PORT}/classroom_manager`;
    process.env.DATABASE_URL = connectionString;
    const migrated = await runMigrate(connectionString);
    assert.match(migrated, /001_phase1_core\.sql/);
    assert.match(migrated, /002_phase2_duty_marks\.sql/);

    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      const teacher = await client.query<{ teacher_id: string }>(
        `INSERT INTO teacher (username, password_hash) VALUES ('idem-teacher', 'hash') RETURNING teacher_id`,
      );
      const cls = await client.query<{ class_id: string }>(
        `INSERT INTO class (name) VALUES ('幂等班') RETURNING class_id`,
      );
      const term = await client.query<{ term_id: string }>(
        `INSERT INTO term (name, status, is_current) VALUES ('2026秋', 'open', true) RETURNING term_id`,
      );
      const students = await client.query<{ student_id: string }>(
        `INSERT INTO student (class_id, student_no, name) VALUES ($1, '1', '甲'), ($1, '2', '乙') RETURNING student_id`,
        [cls.rows[0]!.class_id],
      );
      const actor = teacher.rows[0]!.teacher_id;
      const classId = cls.rows[0]!.class_id;
      const termId = term.rows[0]!.term_id;
      const [first, second] = students.rows.map((row) => row.student_id);
      const points = await import('../src/services/points.js');
      const requestId = '8f2c0000-0000-4000-8000-0000000000c1';
      const input = {
        request_id: requestId,
        class_id: classId,
        term_id: termId,
        student_ids: [first!, second!],
        delta: 2,
        template_id: null,
      };
      const batch = await points.createBatch(actor, input);
      const replay = await points.createBatch(actor, input);
      assert.equal(replay.batch_id, batch.batch_id);
      assert.equal(replay.entries.length, 2);
      const stored = await client.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM point_entry WHERE batch_id = $1`,
        [batch.batch_id],
      );
      assert.equal(stored.rows[0]!.n, 2);
      await assert.rejects(
        () => points.createBatch(actor, { ...input, delta: 3 }),
        (err: unknown) => err instanceof AppError && err.code === 'IDEMPOTENCY_MISMATCH',
      );
      assert.equal(
        (await client.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM point_entry WHERE reverses_entry_id IS NULL`)).rows[0]!.n,
        2,
      );

      const reversed = await points.reverseEntry(actor, batch.entries[0]!.entry_id, '8f2c0000-0000-4000-8000-0000000000c2');
      assert.equal(reversed.entries.length, 1);
      const rest = await points.reverseBatch(actor, batch.batch_id, '8f2c0000-0000-4000-8000-0000000000c3');
      assert.equal(rest.entries.length, 1);
      assert.equal(rest.entries[0]!.student_id, batch.entries[1]!.student_id);
      const balances = await client.query<{ balance: string }>(
        `SELECT balance FROM point_balance WHERE term_id = $1 ORDER BY student_id`,
        [termId],
      );
      assert.deepEqual(balances.rows.map((row) => Number(row.balance)), [0, 0]);
      const reversals = await client.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM point_entry WHERE reverses_entry_id IS NOT NULL`,
      );
      assert.equal(reversals.rows[0]!.n, 2);
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
    child.on('exit', (code) => (code === 0 ? resolve(output) : reject(new Error(output || `migrate exited ${code}`))));
  });
}
