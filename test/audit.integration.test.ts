/**
 * 审计分页和备份记录读取。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';

const PORT = 55443;
const USER = 'classroom';
const PASSWORD = 'classroom_password';
const DATABASE = 'classroom_manager';

describe('audit and backup reads', { timeout: 180_000 }, () => {
  let databaseDir = '';
  let postgres: EmbeddedPostgres | undefined;

  after(async () => {
    const { closeDb } = await import('../src/repo/db.js').catch(() => ({ closeDb: async () => undefined }));
    await closeDb();
    await postgres?.stop().catch(() => undefined);
    if (databaseDir) await rm(databaseDir, { recursive: true, force: true });
  });

  it('按实体分页，并返回备份记录', async () => {
    databaseDir = await mkdtemp(path.join(tmpdir(), 'classroom-audit-pg-'));
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
    assert.match(await runMigrate(connectionString), /001_phase1_core\.sql/);
    process.env.DATABASE_URL = connectionString;

    const pg = await import('pg');
    const client = new pg.default.Client({ connectionString });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO audit_log (entity, entity_id, action) VALUES
         ('class', 'c1', 'created'),
         ('class', 'c1', 'renamed'),
         ('student', 's1', 'left')`,
      );
      await client.query(
        `INSERT INTO backup_record (file_name, size_bytes, disk_free_bytes, status, error, finished_at)
         VALUES ('room.dump', 42, 99, 'failed', 'disk full', now())`,
      );

      const audit = await import('../src/services/audit.js');
      const first = await audit.listAudit({ entity: 'class', limit: 1 });
      assert.equal(first.items.length, 1);
      assert.equal(first.items[0]!.action, 'renamed');
      assert.equal(typeof first.items[0]!.created_at, 'string');
      assert.ok(first.next_cursor);
      const second = await audit.listAudit({ entity: 'class', limit: 1, cursor: first.next_cursor! });
      assert.equal(second.items.length, 1);
      assert.equal(second.items[0]!.action, 'created');
      assert.equal(second.next_cursor, null);

      const backups = await audit.listBackups();
      assert.equal(backups.length, 1);
      assert.equal(backups[0]!.file_name, 'room.dump');
      assert.equal(backups[0]!.status, 'failed');
      assert.equal(backups[0]!.error, 'disk full');
      assert.equal(backups[0]!.size_bytes, 42);
      const health = await audit.backupHealth();
      assert.equal(health.last_failure_error, 'disk full');
      assert.equal(health.disk_warning, true);
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
