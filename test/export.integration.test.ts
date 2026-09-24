/**
 * 花名册可被行表解析；积分导出只含筛选方向；榜单名次与列表一致。
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

const PORT = 55461;
const USER = 'classroom';
const PASSWORD = 'classroom_password';
const DATABASE = 'classroom_manager';

describe('excel export', { timeout: 180_000 }, () => {
  let databaseDir = '';
  let postgres: EmbeddedPostgres | undefined;

  after(async () => {
    const { closeDb } = await import('../src/repo/db.js').catch(() => ({ closeDb: async () => undefined }));
    await closeDb();
    await postgres?.stop().catch(() => undefined);
    if (databaseDir) await rm(databaseDir, { recursive: true, force: true });
  });

  it('花名册可再解析，积分方向和榜单名次与查询一致', async () => {
    databaseDir = await mkdtemp(path.join(tmpdir(), 'classroom-export-pg-'));
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

    const exp = await import('../src/services/export.js');
    const points = await import('../src/services/points.js');
    const pointsRepo = await import('../src/repo/points.js');
    const imports = await import('../src/services/imports.js');
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      await assert.rejects(
        () => exp.exportRoster('8f2c0000-0000-4000-8000-000000000071'),
        (err: unknown) => err instanceof AppError && err.code === 'NOT_FOUND',
      );

      const term = await client.query<{ term_id: string }>(
        `INSERT INTO term (name, status, is_current) VALUES ('导出学期', 'open', true) RETURNING term_id`,
      );
      const termId = term.rows[0]!.term_id;
      const created = await client.query<{ class_id: string }>(
        `INSERT INTO class (name) VALUES ('导出班') RETURNING class_id`,
      );
      const classId = created.rows[0]!.class_id;
      const seat = await client.query<{ seat_id: string }>(
        `SELECT seat_id FROM room_slot WHERE seat_number = 12 LIMIT 1`,
      );
      const seatId = seat.rows[0]!.seat_id;
      const active = await client.query<{ student_id: string }>(
        `INSERT INTO student (class_id, student_no, name, remark) VALUES ($1, '01', '甲', '靠窗') RETURNING student_id`,
        [classId],
      );
      const other = await client.query<{ student_id: string }>(
        `INSERT INTO student (class_id, student_no, name) VALUES ($1, '02', '乙') RETURNING student_id`,
        [classId],
      );
      await client.query(
        `INSERT INTO student (class_id, student_no, name, status, left_at, left_reason)
         VALUES ($1, '09', '离班生', 'left', now(), 'transfer')`,
        [classId],
      );
      await client.query(
        `INSERT INTO seat_assignment (class_id, seat_id, student_id, term_id) VALUES ($1, $2, $3, $4)`,
        [classId, seatId, active.rows[0]!.student_id, termId],
      );

      const roster = await exp.exportRoster(classId);
      const parsed = await imports.parseWorkbook(roster.body, 'rows');
      assert.equal(parsed.issues.length, 0);
      assert.deepEqual(
        parsed.rows.map((row) => [row.student_no, row.name, row.seat_number, row.remark]),
        [
          ['01', '甲', 12, '靠窗'],
          ['02', '乙', null, null],
        ],
      );

      const batchAdd = await client.query<{ batch_id: string }>(
        `INSERT INTO point_batch (term_id, class_id, delta_value, member_count, kind, request_id, reason_snapshot)
         VALUES ($1, $2, 2, 1, 'score', '8f2c0000-0000-4000-8000-000000000072', '{"name":"回答","polarity":1,"source":"none"}')
         RETURNING batch_id`,
        [termId, classId],
      );
      const batchSub = await client.query<{ batch_id: string }>(
        `INSERT INTO point_batch (term_id, class_id, delta_value, member_count, kind, request_id, reason_snapshot)
         VALUES ($1, $2, -1, 1, 'score', '8f2c0000-0000-4000-8000-000000000073', '{"name":"迟到","polarity":-1,"source":"none"}')
         RETURNING batch_id`,
        [termId, classId],
      );
      await client.query(
        `INSERT INTO point_entry (batch_id, student_id, term_id, class_id_snapshot, delta, balance_after, seat_number_snapshot, reason_snapshot, occurred_at)
         VALUES ($1, $2, $3, $4, 2, 2, 12, '{"name":"回答"}', now())`,
        [batchAdd.rows[0]!.batch_id, active.rows[0]!.student_id, termId, classId],
      );
      await client.query(
        `INSERT INTO point_entry (batch_id, student_id, term_id, class_id_snapshot, delta, balance_after, reason_snapshot, occurred_at)
         VALUES ($1, $2, $3, $4, -1, 1, '{"name":"迟到"}', now())`,
        [batchSub.rows[0]!.batch_id, other.rows[0]!.student_id, termId, classId],
      );
      await client.query(
        `INSERT INTO point_balance (term_id, student_id, balance, last_change_seq) VALUES
         ($1, $2, 5, 1), ($1, $3, 5, 1)`,
        [termId, active.rows[0]!.student_id, other.rows[0]!.student_id],
      );

      const filtered = await exp.exportPoints({
        term_id: termId,
        class_id: classId,
        direction: 'add',
        include_reversals: true,
        limit: 50,
      });
      const ExcelJS = (await import('exceljs')).default;
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(filtered.body as unknown as ArrayBuffer);
      const sheet = book.getWorksheet('积分明细');
      assert.ok(sheet);
      const data: string[] = [];
      sheet.eachRow((row, index) => {
        if (index === 1) return;
        data.push(String(row.getCell(4).value));
      });
      assert.deepEqual(data, ['2']);

      const listed = await pointsRepo.listEntries(
        (await import('../src/repo/db.js')).db,
        points.entryFilterFromQuery({
          term_id: termId,
          class_id: classId,
          direction: 'add',
          include_reversals: true,
          limit: 50,
        }),
      );
      assert.equal(listed.length, 1);
      assert.equal(Number(listed[0]?.delta), 2);

      const board = await exp.exportLeaderboard(termId, classId);
      const ranks = new ExcelJS.Workbook();
      await ranks.xlsx.load(board.body as unknown as ArrayBuffer);
      const rankSheet = ranks.getWorksheet('排行榜');
      assert.ok(rankSheet);
      const places: number[] = [];
      rankSheet.eachRow((row, index) => {
        if (index === 1) return;
        places.push(Number(row.getCell(1).value));
      });
      assert.deepEqual(places.sort((a, b) => a - b), [1, 1]);

      await assert.rejects(
        () => exp.exportLeaderboard('8f2c0000-0000-4000-8000-000000000074', undefined),
        (err: unknown) => err instanceof AppError && err.code === 'NOT_FOUND',
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
