/**
 * 每日备份：成功记录、失败告警、空文件、磁盘阈值、过期清理、锁冲突。
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const DISK_WARN_BYTES = 3 * 1024 * 1024 * 1024;

const PORT = 55449;
const USER = 'classroom';
const PASSWORD = 'classroom_password';
const DATABASE = 'classroom_manager';

describe('daily pg_dump job', { timeout: 180_000 }, () => {
  let databaseDir = '';
  let postgres: EmbeddedPostgres | undefined;
  let backupDir = '';

  after(async () => {
    const { closeDb } = await import('../src/repo/db.js').catch(() => ({ closeDb: async () => undefined }));
    await closeDb();
    await postgres?.stop().catch(() => undefined);
    if (databaseDir) await rm(databaseDir, { recursive: true, force: true });
    if (backupDir) await rm(backupDir, { recursive: true, force: true });
  });

  it('把成功和失败都记进 backup_record，并清理过期 dump', async () => {
    databaseDir = await mkdtemp(path.join(tmpdir(), 'classroom-backup-pg-'));
    backupDir = await mkdtemp(path.join(tmpdir(), 'classroom-backup-files-'));
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
    process.env.DATABASE_URL = connectionString;
    const { spawn } = await import('node:child_process');
    const migrated = await new Promise<string>((resolve, reject) => {
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
      child.on('exit', (code) => (code === 0 ? resolve(output) : reject(new Error(output))));
    });
    assert.match(migrated, /001_phase1_core\.sql/);

    const oldName = '2020-01-01.dump';
    const oldPath = path.join(backupDir, oldName);
    await writeFile(oldPath, 'old');
    const oldTime = new Date('2020-01-02T00:00:00Z');
    await utimes(oldPath, oldTime, oldTime);

    const { runDailyBackup, BACKUP_LOCK_KEY } = await import('../src/services/backup.js');
    const ok = await runDailyBackup({
      dir: backupDir,
      retentionDays: 30,
      now: new Date('2026-09-25T02:00:00Z'),
      diskFree: async () => DISK_WARN_BYTES - 1,
      dump: async (filePath) => {
        await writeFile(filePath, 'PGDMP');
      },
    });
    assert.equal(ok.status, 'success');
    assert.equal(ok.file_name, '2026-09-25.dump');
    assert.equal(ok.disk_warning, true);
    assert.deepEqual(ok.removed, [oldName]);

    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      const rows = await client.query<{ status: string; size_bytes: string; error: string | null }>(
        `SELECT status, size_bytes, error FROM backup_record ORDER BY started_at`,
      );
      assert.equal(rows.rows[0]!.status, 'success');
      assert.equal(Number(rows.rows[0]!.size_bytes), 5);
      assert.equal(rows.rows[0]!.error, null);

      const failed = await runDailyBackup({
        dir: backupDir,
        retentionDays: 30,
        now: new Date('2026-09-25T03:00:00Z'),
        diskFree: async () => null,
        dump: async (filePath) => {
          await writeFile(filePath, 'partial');
          throw new Error('pg_dump failed postgresql://classroom:s3cret@127.0.0.1/classroom_manager');
        },
      });
      assert.equal(failed.status, 'failed');
      assert.match(failed.error ?? '', /postgresql:\/\/\*\*\*/);
      assert.equal((failed.error ?? '').includes('s3cret'), false);
      await assert.rejects(import('node:fs/promises').then((fs) => fs.stat(path.join(backupDir, failed.file_name!))));

      const empty = await runDailyBackup({
        dir: backupDir,
        retentionDays: 30,
        now: new Date('2026-09-26T02:00:00Z'),
        dump: async (filePath) => {
          await writeFile(filePath, '');
        },
      });
      assert.equal(empty.status, 'failed');
      assert.match(empty.error ?? '', /为空/);
      assert.equal(typeof empty.disk_free_bytes, 'number');
      assert.ok((empty.disk_free_bytes ?? 0) > 0);

      const holder = new pg.Client({ connectionString });
      await holder.connect();
      await holder.query(`SELECT pg_try_advisory_lock(hashtextextended($1::text, 0))`, [BACKUP_LOCK_KEY]);
      const busy = await runDailyBackup({
        dir: backupDir,
        retentionDays: 30,
        dump: async () => {
          throw new Error('不应执行');
        },
      });
      assert.equal(busy.status, 'busy');
      await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1::text, 0))`, [BACKUP_LOCK_KEY]);
      await holder.end();

      const recorded = await client.query<{ status: string; disk_free_bytes: string | null }>(
        `SELECT status, disk_free_bytes FROM backup_record ORDER BY started_at`,
      );
      const measured = recorded.rows.filter((row) => row.disk_free_bytes != null);
      assert.ok(measured.length >= 1);
      assert.deepEqual(
        recorded.rows.map((row) => row.status),
        ['success', 'failed', 'failed'],
      );
    } finally {
      await client.end();
    }
  });
});
