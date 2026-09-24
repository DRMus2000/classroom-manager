import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';

describe('backup job helpers', () => {
  it('解析 pg_dump 参数时不把密码放进参数', async () => {
    const { pgDumpArgs, redactSecrets, resolveRetentionDays, backupFileName, diskWarning, DISK_WARN_BYTES, isDumpFileName } =
      await import('../src/services/backup.js');
    const parsed = pgDumpArgs('postgresql://classroom:s3cret%20x@postgres:5432/classroom_manager');
    assert.deepEqual(parsed.args, [
      '--format=custom',
      '--host',
      'postgres',
      '--port',
      '5432',
      '--username',
      'classroom',
      '--dbname',
      'classroom_manager',
    ]);
    assert.equal(parsed.password, 's3cret x');
    assert.equal(parsed.args.includes('s3cret x'), false);
    assert.throws(() => pgDumpArgs('mysql://root@localhost/db'), /协议无效/);
    assert.throws(() => pgDumpArgs('not a url'), /无法解析/);
    assert.throws(() => pgDumpArgs('postgresql://localhost/classroom_manager'), /缺少/);
    assert.equal(redactSecrets('fail postgresql://classroom:s3cret@postgres/db password=s3cret'), 'fail postgresql://*** password=***');
    assert.equal(resolveRetentionDays(undefined), 30);
    assert.equal(resolveRetentionDays('0'), 30);
    assert.equal(resolveRetentionDays('-3'), 30);
    assert.equal(resolveRetentionDays('15'), 15);
    assert.equal(resolveRetentionDays('99999'), 30);
    const taken = new Set(['2026-09-25.dump']);
    assert.equal(backupFileName(new Date('2026-09-25T01:02:03Z'), taken), '2026-09-25-090203.dump');
    assert.throws(() => backupFileName(new Date('2026-09-25T01:02:03Z'), new Set(['2026-09-25.dump', '2026-09-25-090203.dump'])), /已占用/);
    assert.equal(diskWarning(DISK_WARN_BYTES), false);
    assert.equal(diskWarning(DISK_WARN_BYTES - 1), true);
    assert.equal(diskWarning(null), false);
    assert.equal(diskWarning(Number.NaN), false);
    assert.equal(isDumpFileName('../2026-09-25.dump'), false);
    assert.equal(isDumpFileName('2026-09-25.dump'), true);
  });
});
