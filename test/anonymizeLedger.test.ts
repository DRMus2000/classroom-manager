/**
 * 外部匿名账本：追加、去重、失败不破坏已有文件。路由未登录时拒绝。
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
const KEY = 'ab'.repeat(32);
const CLASS_ID = '8f2c0000-0000-4000-8000-000000000021';
const STUDENT_ID = '8f2c0000-0000-4000-8000-000000000022';

describe('anon ledger file', () => {
  let dir = '';

  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('追加、去重，并且失败不会改掉已有账本', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'anon-ledger-'));
    process.env['ANON_LEDGER_PATH'] = path.join(dir, 'ledger.jsonl.enc');
    process.env['ANON_LEDGER_KEY'] = KEY;
    const ledger = await import('../src/services/anonLedger.js');

    assert.deepEqual(await ledger.appendAnonLedgerEntries([]), []);
    delete process.env['ANON_LEDGER_KEY'];
    await assert.rejects(
      () =>
        ledger.appendAnonLedgerEntry({
          student_id: STUDENT_ID,
          class_id: CLASS_ID,
          anon_code: '匿名-1',
          processed_at: '2026-09-24T00:00:00.000Z',
          process_version: 1,
        }),
      /ANON_LEDGER_KEY/,
    );
    process.env['ANON_LEDGER_KEY'] = KEY;

    const first = await ledger.appendAnonLedgerEntries([
      {
        student_id: STUDENT_ID,
        class_id: CLASS_ID,
        anon_code: '匿名-1',
        processed_at: '2026-09-24T00:00:00.000Z',
        process_version: 1,
      },
      {
        student_id: '8f2c0000-0000-4000-8000-000000000023',
        class_id: CLASS_ID,
        anon_code: '匿名-2',
        processed_at: '2026-09-24T00:00:01.000Z',
        process_version: 1,
      },
    ]);
    assert.equal(first.length, 2);
    const again = await ledger.appendAnonLedgerEntries([
      {
        student_id: STUDENT_ID,
        class_id: CLASS_ID,
        anon_code: '匿名-1',
        processed_at: '2026-09-24T00:00:00.000Z',
        process_version: 1,
      },
    ]);
    assert.deepEqual(again, [first[0]]);
    const stored = await ledger.readLedger();
    assert.equal(stored.length, 2);
    assert.equal(JSON.stringify(stored).includes('张三'), false);
    assert.equal(stored[0]?.anon_code, '匿名-1');

    process.env['ANON_LEDGER_KEY'] = 'short';
    await assert.rejects(
      () =>
        ledger.appendAnonLedgerEntry({
          student_id: STUDENT_ID,
          class_id: CLASS_ID,
          anon_code: '匿名-9',
          processed_at: '2026-09-24T00:00:02.000Z',
          process_version: 2,
        }),
      /ANON_LEDGER_KEY/,
    );
    delete process.env['ANON_LEDGER_KEY'];
    await assert.rejects(() => ledger.readLedger(), /ANON_LEDGER_KEY/);
    process.env['ANON_LEDGER_KEY'] = KEY;
    assert.equal((await ledger.readLedger()).length, 2);

    await assert.rejects(
      () =>
        ledger.appendAnonLedgerEntry({
          student_id: '',
          class_id: CLASS_ID,
          anon_code: '匿名-1',
          processed_at: '2026-09-24T00:00:00.000Z',
          process_version: 1,
        }),
      /缺少必要字段/,
    );
    await assert.rejects(
      () =>
        ledger.appendAnonLedgerEntry({
          student_id: STUDENT_ID,
          class_id: CLASS_ID,
          anon_code: '匿名-1',
          processed_at: 'not-a-date',
          process_version: 1,
        }),
      /时间不合法/,
    );
    await assert.rejects(
      () =>
        ledger.appendAnonLedgerEntry({
          student_id: STUDENT_ID,
          class_id: CLASS_ID,
          anon_code: '匿名-1',
          processed_at: '2026-09-24T00:00:00.000Z',
          process_version: 0,
        }),
      /处理版本/,
    );
  });
});

describe('anonymize routes', () => {
  after(async () => {
    const { closeDb } = await import('../src/repo/db.js');
    await closeDb();
  });

  it('未登录不能匿名化学生或班级', async () => {
    process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';
    const { buildServer } = await import('../src/server.js');
    const app = await buildServer();
    try {
      const student = await app.inject({
        method: 'POST',
        url: `/api/v1/students/${STUDENT_ID}/anonymize`,
        payload: { request_id: '8f2c0000-0000-4000-8000-000000000024' },
      });
      const cls = await app.inject({
        method: 'POST',
        url: `/api/v1/classes/${CLASS_ID}/anonymize`,
        payload: { request_id: '8f2c0000-0000-4000-8000-000000000025' },
      });
      assert.equal(student.statusCode, 401);
      assert.equal(cls.statusCode, 401);
      assert.equal(student.json().error.code, 'UNAUTHENTICATED');
    } finally {
      await app.close();
    }
  });
});
