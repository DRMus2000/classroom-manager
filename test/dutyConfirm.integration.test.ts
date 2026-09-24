/**
 * 取消预览不重抽，两台设备重复确认不二次退役，新任者不进本轮候选。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const PORT = 55454;

describe('duty confirm and candidates', { timeout: 180_000 }, () => {
  let databaseDir = '';
  let postgres: EmbeddedPostgres | undefined;

  after(async () => {
    const { closeDb } = await import('../src/repo/db.js').catch(() => ({ closeDb: async () => undefined }));
    await closeDb();
    await postgres?.stop().catch(() => undefined);
    if (databaseDir) await rm(databaseDir, { recursive: true, force: true });
  });

  it('取消保留原人，重复确认只退役一次，新任者不在本轮', async () => {
    databaseDir = await mkdtemp(path.join(tmpdir(), 'classroom-duty2-pg-'));
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
        `INSERT INTO teacher (username, password_hash) VALUES ('duty2', 'hash') RETURNING teacher_id`,
      );
      const actor = teacher.rows[0]!.teacher_id;
      const created = await client.query<{ class_id: string }>(
        `INSERT INTO class (name) VALUES ('卫生确认班') RETURNING class_id`,
      );
      const classId = created.rows[0]!.class_id;
      const students = await client.query<{ student_id: string; student_no: string }>(
        `INSERT INTO student (class_id, student_no, name) VALUES
           ($1, '1', '原管理员'), ($1, '2', '新同学'), ($1, '3', '旁观')
         RETURNING student_id, student_no`,
        [classId],
      );
      const byNo = new Map(students.rows.map((row) => [row.student_no, row.student_id]));
      const originalId = byNo.get('1')!;
      const incomingId = byNo.get('2')!;
      const line = await client.query<{ line_id: string }>(
        `INSERT INTO duty_line (class_id) VALUES ($1) RETURNING line_id`,
        [classId],
      );
      const term = await client.query<{ duty_term_id: string }>(
        `INSERT INTO duty_term (line_id, student_id, seq_no, completed_count, required_count, started_round_id)
         VALUES ($1, $2, 1, 0, 3, '8f2c0000-0000-4000-8000-000000000091')
         RETURNING duty_term_id`,
        [line.rows[0]!.line_id, originalId],
      );
      const duty = await import('../src/services/duty.js');
      const started = await duty.startRound(actor, classId, '8f2c0000-0000-4000-8000-000000000092');
      const attended = await duty.markAttendance(
        actor,
        started.round_id,
        [term.rows[0]!.duty_term_id],
        started.version,
        '8f2c0000-0000-4000-8000-00000000009a',
      );
      const frozen = await duty.freezeCandidates(
        actor,
        started.round_id,
        attended.version,
        '8f2c0000-0000-4000-8000-000000000093',
      );
      assert.equal(frozen.candidates.some((row) => row.student_id === incomingId), false);
      const drawn = await duty.drawSelection(
        actor,
        started.round_id,
        incomingId,
        frozen.version,
        '8f2c0000-0000-4000-8000-000000000094',
      );
      const afterDraw = await duty.getRound(started.round_id);
      const cancelled = await duty.cancelSelection(
        actor,
        drawn.selection_id,
        afterDraw.version,
        '8f2c0000-0000-4000-8000-000000000095',
      );
      assert.equal(cancelled.status, 'cancelled');
      assert.equal(cancelled.picked[0]?.student_id, originalId);
      const reopened = await duty.reopenSelection(
        actor,
        drawn.selection_id,
        (await duty.getRound(started.round_id)).version,
        '8f2c0000-0000-4000-8000-000000000096',
      );
      assert.equal(reopened.picked[0]?.student_id, originalId);
      const beforeConfirm = await duty.getRound(started.round_id);
      const first = await duty.confirmSelection(
        actor,
        drawn.selection_id,
        beforeConfirm.version,
        '8f2c0000-0000-4000-8000-000000000097',
      );
      const second = await duty.confirmSelection(
        actor,
        drawn.selection_id,
        beforeConfirm.version,
        '8f2c0000-0000-4000-8000-000000000098',
      );
      assert.equal(first.status, 'confirmed');
      assert.equal(second.status, 'confirmed');
      assert.equal(second.picked[0]?.student_id, originalId);
      const retired = await client.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM duty_term WHERE student_id = $1 AND status = 'retired'`,
        [originalId],
      );
      assert.equal(retired.rows[0]!.n, 1);
      const members = await client.query<{ student_id: string }>(
        `SELECT student_id FROM duty_round_member WHERE round_id = $1`,
        [started.round_id],
      );
      assert.equal(members.rows.some((row) => row.student_id === incomingId), false);
      const newcomers = await client.query<{ started_round_id: string | null }>(
        `SELECT started_round_id FROM duty_term WHERE student_id = $1 AND status = 'active'`,
        [incomingId],
      );
      assert.equal(newcomers.rows.length, 1);
      assert.equal(newcomers.rows[0]!.started_round_id, null);
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
