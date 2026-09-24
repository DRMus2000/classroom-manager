/**
 * 在内嵌的 PostgreSQL 16 上执行 001 与 002。
 * 第二次 migrate up 必须成功；清掉迁移记录后再执行，SQL 本身也必须可重复跑。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const PORT = 55432;
const USER = 'classroom';
const PASSWORD = 'classroom_password';
const DATABASE = 'classroom_manager';

describe('postgres 16 migrations', { timeout: 180_000 }, () => {
  let databaseDir = '';
  let postgres: EmbeddedPostgres | undefined;
  let connectionString = '';

  after(async () => {
    await postgres?.stop().catch(() => undefined);
    if (databaseDir) await rm(databaseDir, { recursive: true, force: true });
  });

  it('执行两份迁移，重复执行成功，种子列方向与设计一致', async () => {
    databaseDir = await mkdtemp(path.join(tmpdir(), 'classroom-pg16-'));
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

    const first = await runMigrate(connectionString);
    assert.match(first, /001_phase1_core\.sql/);
    assert.match(first, /002_phase2_duty_marks\.sql/);
    assert.match(first, /003_term_open_return_new\.sql/);

    const second = await runMigrate(connectionString);
    assert.match(second, /没有待执行的迁移/);

    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      const version = await client.query<{ server_version: string }>('SHOW server_version');
      assert.match(version.rows[0]!.server_version, /^16\./);

      await client.query('DELETE FROM schema_migrations');
    } finally {
      await client.end();
    }

    const third = await runMigrate(connectionString);
    assert.match(third, /001_phase1_core\.sql/);
    assert.match(third, /002_phase2_duty_marks\.sql/);
    assert.match(third, /003_term_open_return_new\.sql/);

    const check = new pg.Client({ connectionString });
    await check.connect();
    try {
      const columns = await check.query<{
        code: string;
        display_order: number;
        direction: string;
        facing: string;
      }>(
        `SELECT code, display_order, direction::text AS direction, facing::text AS facing
         FROM room_column
         ORDER BY display_order`,
      );
      assert.deepEqual(columns.rows, [
        { code: '4', display_order: 1, direction: 'toward_front', facing: 'left' },
        { code: '3', display_order: 2, direction: 'toward_back', facing: 'right' },
        { code: '2', display_order: 3, direction: 'toward_front', facing: 'left' },
        { code: '1', display_order: 4, direction: 'toward_back', facing: 'right' },
      ]);

      const slots = await check.query<{ code: string; sort_in_column: number; seat_number: number }>(
        `SELECT c.code, s.sort_in_column, s.seat_number
         FROM room_slot s
         JOIN room_column c ON c.column_id = s.column_id`,
      );
      const numberOf = (code: string, sort: number) =>
        slots.rows.find((row) => row.code === code && row.sort_in_column === sort)?.seat_number;
      assert.equal(numberOf('1', 1), 1);
      assert.equal(numberOf('1', 14), 14);
      assert.equal(numberOf('2', 14), 15);
      assert.equal(numberOf('2', 1), 28);
      assert.equal(numberOf('3', 1), 29);
      assert.equal(numberOf('3', 13), 41);
      assert.equal(numberOf('4', 13), 42);
      assert.equal(numberOf('4', 1), 54);
      assert.equal(new Set(slots.rows.map((row) => row.seat_number)).size, 54);

      const indexes = await check.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexname = ANY($1::text[])
         ORDER BY indexname`,
        [[
          'uq_term_current',
          'uq_term_single_open',
          'uq_student_no_active',
          'uq_room_slot_number',
          'uq_seat_assign_student',
          'uq_entry_reversed_once',
          'uq_entry_reversed_by_once',
          'uq_round_single_open',
          'uq_selection_single_open',
          'uq_candidate_consumed',
          'idx_balance_rank',
        ]],
      );
      assert.deepEqual(
        indexes.rows.map((row) => row.indexname),
        [
          'idx_balance_rank',
          'uq_candidate_consumed',
          'uq_entry_reversed_by_once',
          'uq_entry_reversed_once',
          'uq_room_slot_number',
          'uq_round_single_open',
          'uq_seat_assign_student',
          'uq_selection_single_open',
          'uq_student_no_active',
          'uq_term_current',
          'uq_term_single_open',
        ],
      );

      const triggers = await check.query<{ tgname: string }>(
        `SELECT tgname FROM pg_trigger
         WHERE NOT tgisinternal AND tgname = ANY($1::text[])
         ORDER BY tgname`,
        [[
          'trg_batch_term_open',
          'trg_entry_term_open',
          'trg_four_columns',
          'trg_no_polarity_flip',
        ]],
      );
      assert.deepEqual(
        triggers.rows.map((row) => row.tgname),
        ['trg_batch_term_open', 'trg_entry_term_open', 'trg_four_columns', 'trg_no_polarity_flip'],
      );

      const foreignKeys = await check.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint
         WHERE contype = 'f' AND conname = ANY($1::text[])
         ORDER BY conname`,
        [['fk_candidate_selection', 'fk_obligation_round']],
      );
      assert.deepEqual(
        foreignKeys.rows.map((row) => row.conname),
        ['fk_candidate_selection', 'fk_obligation_round'],
      );

      const seatForeignKeys = await check.query<{ referenced: string }>(
        `SELECT r.relname AS referenced
         FROM pg_constraint fk
         JOIN pg_class c ON c.oid = fk.conrelid
         JOIN pg_class r ON r.oid = fk.confrelid
         WHERE fk.contype = 'f' AND c.relname = 'seat_assignment'
         ORDER BY r.relname`,
      );
      assert.deepEqual(
        seatForeignKeys.rows.map((row) => row.referenced),
        ['class', 'room_slot', 'student', 'term'],
      );

      const applied = await check.query<{ filename: string }>(
        'SELECT filename FROM schema_migrations ORDER BY filename',
      );
      assert.deepEqual(
        applied.rows.map((row) => row.filename),
        ['001_phase1_core.sql', '002_phase2_duty_marks.sql', '003_term_open_return_new.sql', '004_point_batch_note.sql'],
      );

      const cls = await check.query<{ class_id: string }>(
        `INSERT INTO class (name) VALUES ('触发器班') RETURNING class_id`,
      );
      const term = await check.query<{ term_id: string }>(
        `INSERT INTO term (name, status, is_current) VALUES ('开放学期', 'open', true) RETURNING term_id`,
      );
      const student = await check.query<{ student_id: string }>(
        `INSERT INTO student (class_id, student_no, name) VALUES ($1, '1', '甲') RETURNING student_id`,
        [cls.rows[0]!.class_id],
      );
      const batch = await check.query<{ batch_id: string }>(
        `INSERT INTO point_batch (term_id, class_id, delta_value, member_count, kind, request_id)
         VALUES ($1, $2, 1, 1, 'score', '8f2c0000-0000-4000-8000-0000000000a1')
         RETURNING batch_id`,
        [term.rows[0]!.term_id, cls.rows[0]!.class_id],
      );
      const entry = await check.query<{ entry_id: string }>(
        `INSERT INTO point_entry
           (batch_id, student_id, term_id, class_id_snapshot, delta, balance_after, occurred_at)
         VALUES ($1, $2, $3, $4, 1, 1, now())
         RETURNING entry_id`,
        [batch.rows[0]!.batch_id, student.rows[0]!.student_id, term.rows[0]!.term_id, cls.rows[0]!.class_id],
      );
      assert.equal(entry.rowCount, 1);
      const kept = await check.query(
        `SELECT entry_id FROM point_entry WHERE entry_id = $1`,
        [entry.rows[0]!.entry_id],
      );
      assert.equal(kept.rowCount, 1);

      await check.query(
        `UPDATE term SET status = 'closed', is_current = false, closed_at = now() WHERE term_id = $1`,
        [term.rows[0]!.term_id],
      );
      await assert.rejects(
        () =>
          check.query(
            `INSERT INTO point_entry
               (batch_id, student_id, term_id, class_id_snapshot, delta, balance_after, occurred_at)
             VALUES ($1, $2, $3, $4, 1, 2, now())`,
            [batch.rows[0]!.batch_id, student.rows[0]!.student_id, term.rows[0]!.term_id, cls.rows[0]!.class_id],
          ),
        /term_readonly/,
      );
    } finally {
      await check.end();
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
