/**
 * 匿名账本重试，以及恢复旧备份后的补做。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const PORT = 55450;
const KEY = 'cd'.repeat(32);

describe('anon ledger retry and reapply', { timeout: 180_000 }, () => {
  let databaseDir = '';
  let ledgerDir = '';
  let postgres: EmbeddedPostgres | undefined;

  after(async () => {
    const { closeDb } = await import('../src/repo/db.js').catch(() => ({ closeDb: async () => undefined }));
    await closeDb();
    await postgres?.stop().catch(() => undefined);
    if (databaseDir) await rm(databaseDir, { recursive: true, force: true });
    if (ledgerDir) await rm(ledgerDir, { recursive: true, force: true });
  });

  it('重试失败导出，并在确认后清空恢复出来的身份', async () => {
    databaseDir = await mkdtemp(path.join(tmpdir(), 'classroom-anon-pg-'));
    ledgerDir = await mkdtemp(path.join(tmpdir(), 'classroom-anon-ledger-'));
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
    process.env.ANON_LEDGER_KEY = KEY;
    process.env.ANON_LEDGER_PATH = path.join(ledgerDir, 'ledger.jsonl.enc');
    assert.match(await runMigrate(connectionString), /001_phase1_core\.sql/);

    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      const cls = await client.query<{ class_id: string }>(
        `INSERT INTO class (name) VALUES ('匿名班') RETURNING class_id`,
      );
      const classId = cls.rows[0]!.class_id;
      const students = await client.query<{ student_id: string; name: string }>(
        `INSERT INTO student (class_id, student_no, name, remark) VALUES
           ($1, '1', '甲', '备注甲'),
           ($1, '2', '乙', '备注乙')
         RETURNING student_id, name`,
        [classId],
      );
      const first = students.rows[0]!;
      const second = students.rows[1]!;
      const registry = await client.query<{ anon_id: string }>(
        `INSERT INTO anon_registry (student_id, class_id, anon_code, process_version)
         VALUES ($1, $2, '匿名-1', 1) RETURNING anon_id`,
        [first.student_id, classId],
      );
      await client.query(
        `INSERT INTO anon_ledger_export (anon_id, state, attempts, last_error) VALUES ($1, 'failed', 1, 'disk full')`,
        [registry.rows[0]!.anon_id],
      );

      const jobs = await import('../src/services/anonMaintenance.js');
      const retried = await jobs.retryFailedLedgerExports();
      assert.equal(retried.exported, 1);
      assert.equal(retried.failed, 0);
      const exported = await client.query<{ state: string; last_error: string | null }>(
        `SELECT state, last_error FROM anon_ledger_export WHERE anon_id = $1`,
        [registry.rows[0]!.anon_id],
      );
      assert.equal(exported.rows[0]!.state, 'exported');
      assert.equal(exported.rows[0]!.last_error, null);
      const again = await jobs.retryFailedLedgerExports();
      assert.equal(again.exported, 0);

      const broken = await client.query<{ anon_id: string }>(
        `INSERT INTO anon_registry (student_id, class_id, anon_code, process_version)
         VALUES ($1, $2, '匿名-2', 1) RETURNING anon_id`,
        [second.student_id, classId],
      );
      await client.query(
        `INSERT INTO anon_ledger_export (anon_id, state) VALUES ($1, 'pending')`,
        [broken.rows[0]!.anon_id],
      );
      process.env.ANON_LEDGER_KEY = 'short';
      const failed = await jobs.retryFailedLedgerExports();
      process.env.ANON_LEDGER_KEY = KEY;
      assert.equal(failed.exported, 0);
      assert.equal(failed.failed, 1);
      assert.equal(failed.errors[0]!.message.includes(second.name), false);
      const failedRow = await client.query<{ state: string; attempts: number }>(
        `SELECT state, attempts FROM anon_ledger_export WHERE anon_id = $1`,
        [broken.rows[0]!.anon_id],
      );
      assert.equal(failedRow.rows[0]!.state, 'failed');
      assert.equal(failedRow.rows[0]!.attempts, 1);

      const ledger = await import('../src/services/anonLedger.js');
      const missingId = '8f2c0000-0000-4000-8000-000000000099';
      await ledger.appendAnonLedgerEntry({
        student_id: missingId,
        class_id: classId,
        anon_code: '匿名-9',
        processed_at: '2026-09-24T00:00:00.000Z',
        process_version: 1,
      });
      await client.query(
        `UPDATE student SET name = '甲', student_no = '1', remark = '备注甲', status = 'active', anon_code = NULL
         WHERE student_id = $1`,
        [first.student_id],
      );
      const preview = await jobs.reapplyAnonLedger(false);
      assert.equal(preview.confirm, false);
      assert.equal(preview.applied, 0);
      assert.ok(preview.pending >= 1);
      assert.equal(preview.missing, 1);
      const stillNamed = await client.query<{ name: string }>(
        `SELECT name FROM student WHERE student_id = $1`,
        [first.student_id],
      );
      assert.equal(stillNamed.rows[0]!.name, '甲');

      const applied = await jobs.reapplyAnonLedger(true);
      assert.equal(applied.applied >= 1, true);
      const cleared = await client.query<{ name: string; student_no: string; remark: string | null; status: string; anon_code: string }>(
        `SELECT name, student_no, remark, status, anon_code FROM student WHERE student_id = $1`,
        [first.student_id],
      );
      assert.equal(cleared.rows[0]!.name, '');
      assert.equal(cleared.rows[0]!.student_no, '');
      assert.equal(cleared.rows[0]!.remark, null);
      assert.equal(cleared.rows[0]!.status, 'anonymized');
      assert.equal(cleared.rows[0]!.anon_code, '匿名-1');

      const secondPass = await jobs.reapplyAnonLedger(true);
      assert.equal(secondPass.applied, 0);
      assert.ok(secondPass.already >= 1);
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
