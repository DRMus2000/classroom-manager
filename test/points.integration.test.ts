/**
 * 一次记分两名学生：ANY(uuid[]) 不把数组拆开，两条明细共用同一回放序号。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const PORT = 55447;
const USER = 'classroom';
const PASSWORD = 'classroom_password';
const DATABASE = 'classroom_manager';

describe('point batches', { timeout: 180_000 }, () => {
  let databaseDir = '';
  let postgres: EmbeddedPostgres | undefined;

  after(async () => {
    const { closeDb } = await import('../src/repo/db.js').catch(() => ({ closeDb: async () => undefined }));
    await closeDb();
    await postgres?.stop().catch(() => undefined);
    if (databaseDir) await rm(databaseDir, { recursive: true, force: true });
  });

  it('一批两人各有一条明细，并列破序序号相同', async () => {
    databaseDir = await mkdtemp(path.join(tmpdir(), 'classroom-points-pg-'));
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
    assert.match(await runMigrate(connectionString), /003_term_open_return_new\.sql/);
    process.env.DATABASE_URL = connectionString;

    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      const teacher = await client.query<{ teacher_id: string }>(
        `INSERT INTO teacher (username, password_hash) VALUES ('score-teacher', 'hash') RETURNING teacher_id`,
      );
      const cls = await client.query<{ class_id: string }>(
        `INSERT INTO class (name) VALUES ('记分班') RETURNING class_id`,
      );
      const term = await client.query<{ term_id: string }>(
        `INSERT INTO term (name, status, is_current) VALUES ('2026秋', 'open', true) RETURNING term_id`,
      );
      const students = await client.query<{ student_id: string }>(
        `INSERT INTO student (class_id, student_no, name) VALUES
           ($1, '1', '甲'), ($1, '2', '乙')
         RETURNING student_id`,
        [cls.rows[0]!.class_id],
      );
      const points = await import('../src/services/points.js');
      const batch = await points.createBatch(teacher.rows[0]!.teacher_id, {
        request_id: '8f2c0000-0000-4000-8000-0000000000b1',
        class_id: cls.rows[0]!.class_id,
        term_id: term.rows[0]!.term_id,
        student_ids: students.rows.map((row) => row.student_id),
        delta: 2,
        template_id: null,
      });
      assert.equal(batch.entries.length, 2);
      const stored = await client.query<{ n: number; seqs: number }>(
        `SELECT COUNT(*)::int AS n, COUNT(DISTINCT last_change_seq)::int AS seqs
         FROM point_entry e
         JOIN point_balance b ON b.student_id = e.student_id AND b.term_id = e.term_id
         WHERE e.batch_id = $1`,
        [batch.batch_id],
      );
      assert.equal(stored.rows[0]!.n, 2);
      assert.equal(stored.rows[0]!.seqs, 1);
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
