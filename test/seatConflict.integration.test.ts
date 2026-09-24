/**
 * 换座版本过期返回 409，不覆盖另一台设备已经提交的座次。
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

const PORT = 55453;

describe('seat version conflict', { timeout: 180_000 }, () => {
  let databaseDir = '';
  let postgres: EmbeddedPostgres | undefined;

  after(async () => {
    const { closeDb } = await import('../src/repo/db.js').catch(() => ({ closeDb: async () => undefined }));
    await closeDb();
    await postgres?.stop().catch(() => undefined);
    if (databaseDir) await rm(databaseDir, { recursive: true, force: true });
  });

  it('旧版本提交失败，座位保持先提交的那一版', async () => {
    databaseDir = await mkdtemp(path.join(tmpdir(), 'classroom-seat-pg-'));
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
        `INSERT INTO teacher (username, password_hash) VALUES ('seat-teacher', 'hash') RETURNING teacher_id`,
      );
      const cls = await client.query<{ class_id: string; seat_version: number }>(
        `INSERT INTO class (name) VALUES ('换座班') RETURNING class_id, seat_version`,
      );
      const term = await client.query<{ term_id: string }>(
        `INSERT INTO term (name, status, is_current) VALUES ('2026秋', 'open', true) RETURNING term_id`,
      );
      const students = await client.query<{ student_id: string }>(
        `INSERT INTO student (class_id, student_no, name) VALUES ($1, '1', '甲'), ($1, '2', '乙') RETURNING student_id`,
        [cls.rows[0]!.class_id],
      );
      const seats = await client.query<{ seat_id: string }>(
        `SELECT seat_id FROM room_slot WHERE seat_number IN (1, 2) ORDER BY seat_number`,
      );
      const classId = cls.rows[0]!.class_id;
      const termId = term.rows[0]!.term_id;
      const [studentA, studentB] = students.rows.map((row) => row.student_id);
      const [seatA, seatB] = seats.rows.map((row) => row.seat_id);
      await client.query(
        `INSERT INTO seat_assignment (class_id, seat_id, student_id, term_id) VALUES
           ($1, $2, $3, $5), ($1, $4, $6, $5)`,
        [classId, seatA, studentA, seatB, termId, studentB],
      );
      const seatsApi = await import('../src/services/seats.js');
      const actor = teacher.rows[0]!.teacher_id;
      const version = cls.rows[0]!.seat_version;
      const plan = await seatsApi.planSeats(classId, {
        source_student_ids: [studentA!],
        target_seat_ids: [seatB!],
      });
      assert.equal(plan.ok, true);
      const selected = plan.assignments.filter((row) => row.role === 'selected');
      const swapped = await seatsApi.applySeatAssignments(classId, termId, actor, {
        assignments: selected.map((row) => ({ student_id: row.student_id, seat_id: row.to_seat_id })),
        expected_version: version,
        request_id: '8f2c0000-0000-4000-8000-0000000000d1',
      });
      assert.equal(swapped.seat_version, version + 1);
      await assert.rejects(
        () => seatsApi.applySeatAssignments(classId, termId, actor, {
          assignments: [{ student_id: studentA!, seat_id: seatA! }],
          expected_version: version,
          request_id: '8f2c0000-0000-4000-8000-0000000000d2',
        }),
        (err: unknown) => err instanceof AppError && err.code === 'VERSION_CONFLICT' && err.httpStatus === 409,
      );
      const placed = await client.query<{ student_id: string; seat_id: string }>(
        `SELECT student_id, seat_id FROM seat_assignment WHERE class_id = $1`,
        [classId],
      );
      const byStudent = new Map(placed.rows.map((row) => [row.student_id, row.seat_id]));
      assert.equal(byStudent.get(studentA!), seatB);
      assert.equal(byStudent.get(studentB!), seatA);
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
