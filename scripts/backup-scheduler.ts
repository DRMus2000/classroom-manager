/**
 * 每天 02:15（Asia/Shanghai）执行一次备份。失败只记录并在下一周期重试。
 */

import { closeDb } from '../src/repo/db.js';
import { msUntilShanghai } from '../src/lib/backupPlan.js';
import {
  dumpWithPgDump,
  measureDiskFree,
  redactSecrets,
  resolveRetentionDays,
  runDailyBackup,
} from '../src/services/backup.js';

async function runOnce(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '') throw new Error('DATABASE_URL 未设置');
  const result = await runDailyBackup({
    dir: process.env.BACKUP_DIR?.trim() || 'backups',
    retentionDays: resolveRetentionDays(process.env.BACKUP_RETENTION_DAYS),
    dump: (filePath) => dumpWithPgDump(databaseUrl, filePath),
    diskFree: measureDiskFree,
  });
  if (result.status === 'failed') {
    console.error(`备份失败告警：${result.error ?? '未知错误'}`);
    return;
  }
  if (result.disk_warning) console.error(`磁盘告警：剩余 ${result.disk_free_bytes} 字节，低于 3GB。`);
  if (result.status === 'success') console.log(`✓ 备份完成：${result.file_name}`);
}

async function main(): Promise<void> {
  for (;;) {
    const wait = msUntilShanghai(2, 15);
    console.log(`下次备份约在 ${Math.round(wait / 1000)} 秒后（Asia/Shanghai 02:15）。`);
    await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      await runOnce();
    } catch (err) {
      const message = err instanceof Error ? redactSecrets(err.message) : '未知错误';
      console.error(`备份失败告警：${message}`);
    }
  }
}

if (process.argv[1]?.endsWith('backup-scheduler.ts') || process.argv[1]?.endsWith('backup-scheduler.js')) {
  main().catch(async (err: unknown) => {
    const message = err instanceof Error ? redactSecrets(err.message) : '未知错误';
    console.error(`备份调度退出：${message}`);
    await closeDb();
    process.exit(1);
  });
}
