/**
 * 卫生轮次：计次、缺席把 3 变成 4、取消不重抽、确认、未确认时不能关轮。
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

const PORT = 55445;
const USER = 'classroom';
const PASSWORD = 'classroom_password';
const DATABASE = 'classroom_manager';

describe('duty rounds', { timeout: 180_000 }, () => {
  let databaseDir = '';
  let postgres: EmbeddedPostgres | undefined;

  after(async () => {
    const { closeDb } = await import('../src/repo/db.js').catch(() => ({ closeDb: async () => undefined }));
    await closeDb();
    await postgres?.stop().catch(() => undefined);
    if (databaseDir) await rm(databaseDir, { recursive: true, force: true });
  });

  it('缺席加次、取消保留原抽选、确认后才能关轮', async () => {
    databaseDir = await mkdtemp(path.join(tmpdir(), 'classroom-duty-pg-'));
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

    const duty = await import('../src/services/duty.js');
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      const teacher = await client.query<{ teacher_id: string }>(
        `INSERT INTO teacher (username, password_hash) VALUES ('duty-teacher', 'hash') RETURNING teacher_id`,
      );
      const actor = teacher.rows[0]!.teacher_id;
      const created = await client.query<{ class_id: string }>(
        `INSERT INTO class (name) VALUES ('卫生班') RETURNING class_id`,
      );
      const classId = created.rows[0]!.class_id;
      const original = await client.query<{ student_id: string }>(
        `INSERT INTO student (class_id, student_no, name) VALUES ($1, '1', '原管理员') RETURNING student_id`,
        [classId],
      );
      const incoming = await client.query<{ student_id: string }>(
        `INSERT INTO student (class_id, student_no, name) VALUES ($1, '2', '新同学') RETURNING student_id`,
        [classId],
      );
      const originalId = original.rows[0]!.student_id;
      const incomingId = incoming.rows[0]!.student_id;
      const line = await client.query<{ line_id: string }>(
        `INSERT INTO duty_line (class_id) VALUES ($1) RETURNING line_id`,
        [classId],
      );
      const term = await client.query<{ duty_term_id: string }>(
        `INSERT INTO duty_term (line_id, student_id, seq_no, completed_count, required_count, started_round_id)
         VALUES ($1, $2, 1, 0, 3, '8f2c0000-0000-4000-8000-000000000081')
         RETURNING duty_term_id`,
        [line.rows[0]!.line_id, originalId],
      );
      const termId = term.rows[0]!.duty_term_id;

      const started = await duty.startRound(actor, classId, '8f2c0000-0000-4000-8000-000000000082');
      assert.equal(started.member_count, 1);
      const absent = await duty.confirmAbsent(
        actor,
        started.round_id,
        termId,
        1,
        '8f2c0000-0000-4000-8000-000000000083',
      );
      assert.equal(absent.before_required, 3);
      assert.equal(absent.after_required, 4);

      await assert.rejects(
        () =>
          duty.confirmAbsent(actor, started.round_id, termId, absent.version, '8f2c0000-0000-4000-8000-000000000084'),
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          return true;
        },
      );

      const frozen = await duty.freezeCandidates(actor, started.round_id, '8f2c0000-0000-4000-8000-000000000085');
      assert.equal(frozen.candidates.length, 0);
      const again = await duty.freezeCandidates(actor, started.round_id, '8f2c0000-0000-4000-8000-000000000086');
      assert.deepEqual(again.candidates, frozen.candidates);

      const state = await duty.getRound(started.round_id);
      const drawn = await duty.drawSelection(
        actor,
        started.round_id,
        incomingId,
        state.version,
        '8f2c0000-0000-4000-8000-000000000087',
      );
      assert.equal(drawn.outcome, 'direct_appoint');
      assert.equal(drawn.picked.length, 0);

      await assert.rejects(
        () => duty.closeRound(actor, started.round_id, state.version, '8f2c0000-0000-4000-8000-000000000088'),
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.code, 'VERSION_CONFLICT');
          return true;
        },
      );
      const latest = await duty.getRound(started.round_id);
      const closed = await duty.closeRound(
        actor,
        started.round_id,
        latest.version,
        '8f2c0000-0000-4000-8000-000000000089',
      );
      assert.equal(closed.status, 'closed');
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
