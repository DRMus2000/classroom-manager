import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';

describe('backup timeout and ledger rejection', () => {
  it('超时后结束子进程，无法识别的账本条目不算可补做', async () => {
    process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';
    const { armProcessTimeout } = await import('../src/services/backup.js');
    const { ledgerEntryUsable } = await import('../src/services/anonMaintenance.js');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await new Promise<void>((resolve, reject) => {
      armProcessTimeout(child, 30, () => resolve());
      setTimeout(() => reject(new Error('超时回调没有触发')), 2000);
    });
    await exited;
    assert.equal(child.killed || child.exitCode !== null, true);

    const base = {
      entry_id: '8f2c0000-0000-4000-8000-0000000000c1',
      student_id: '8f2c0000-0000-4000-8000-0000000000c2',
      class_id: '8f2c0000-0000-4000-8000-0000000000c3',
      anon_code: '匿名-1',
      processed_at: '2026-09-25T00:00:00.000Z',
      process_version: 1,
    };
    assert.equal(ledgerEntryUsable(base), true);
    assert.equal(ledgerEntryUsable({ ...base, student_id: 'not-a-uuid' }), false);
    assert.equal(ledgerEntryUsable({ ...base, process_version: 0 }), false);
    assert.equal(ledgerEntryUsable({ ...base, anon_code: 'x'.repeat(41) }), false);
  });
});
