/**
 * 导入冲突整单不写入。预览不落业务表，提交在冲突或版本过期时回滚。
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

const PORT = 55451;

describe('import conflict writes nothing', { timeout: 180_000 }, () => {
  let databaseDir = '';
  let postgres: EmbeddedPostgres | undefined;

  after(async () => {
    const { closeDb } = await import('../src/repo/db.js').catch(() => ({ closeDb: async () => undefined }));
    await closeDb();
    await postgres?.stop().catch(() => undefined);
    if (databaseDir) await rm(databaseDir, { recursive: true, force: true });
  });

  it('重复学号和过期版本都不留下学生', async () => {
    databaseDir = await mkdtemp(path.join(tmpdir(), 'classroom-import-pg-'));
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
    assert.match(await runMigrate(connectionString), /没有待执行的迁移/);

    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      const cls = await client.query<{ class_id: string }>(
        `INSERT INTO class (name) VALUES ('导入班') RETURNING class_id`,
      );
      const classId = cls.rows[0]!.class_id;
      await client.query(
        `INSERT INTO term (name, status, is_current) VALUES ('2026秋', 'open', true)`,
      );
      const teacher = await client.query<{ teacher_id: string }>(
        `INSERT INTO teacher (username, password_hash) VALUES ('importer', 'hash') RETURNING teacher_id`,
      );

      const imports = await import('../src/services/imports.js');
      const { buildImportTemplate } = await import('../src/services/importTemplate.js');
      const ExcelJS = (await import('exceljs')).default;
      const template = await buildImportTemplate('rows');
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(template.body);
      const sheet = book.getWorksheet('名单')!;
      sheet.addRow(['202401', '甲', 1, '']);
      sheet.addRow(['202401', '乙', 2, '']);
      const buffer = Buffer.from(await book.xlsx.writeBuffer());

      const preview = await imports.buildPreview(classId, 'rows', buffer);
      assert.equal(preview.committable, false);
      assert.ok(preview.issues.some((issue) => issue.code === 'DUPLICATE_STUDENT_NO'));
      assert.equal(await countStudents(client, classId), 0);

      await assert.rejects(
        () => imports.commitImport(teacher.rows[0]!.teacher_id, classId, preview.preview_token, 1, crypto.randomUUID()),
        (err: unknown) => err instanceof AppError && err.code === 'IMPORT_INVALID',
      );
      assert.equal(await countStudents(client, classId), 0);
      assert.equal(await countAssignments(client, classId), 0);

      const clean = new ExcelJS.Workbook();
      await clean.xlsx.load(template.body);
      clean.getWorksheet('名单')!.addRow(['202402', '丙', 3, '']);
      const cleanBuffer = Buffer.from(await clean.xlsx.writeBuffer());
      const okPreview = await imports.buildPreview(classId, 'rows', cleanBuffer);
      assert.equal(okPreview.committable, true);
      await client.query(`UPDATE class SET seat_version = seat_version + 1 WHERE class_id = $1`, [classId]);
      await assert.rejects(
        () => imports.commitImport(teacher.rows[0]!.teacher_id, classId, okPreview.preview_token, 1, crypto.randomUUID()),
        (err: unknown) => err instanceof AppError && (err.code === 'IMPORT_TOKEN_EXPIRED' || err.code === 'VERSION_CONFLICT'),
      );
      assert.equal(await countStudents(client, classId), 0);
    } finally {
      await client.end();
    }
  });
});

function countStudents(client: pg.Client, classId: string): Promise<number> {
  return client.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM student WHERE class_id = $1`, [classId]).then((r) => r.rows[0]!.n);
}

function countAssignments(client: pg.Client, classId: string): Promise<number> {
  return client.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM seat_assignment WHERE class_id = $1`, [classId]).then((r) => r.rows[0]!.n);
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
    child.on('exit', (code) => (code === 0 ? resolve(output) : reject(new Error(output || `migrate exited ${code}`))));
  });
}
