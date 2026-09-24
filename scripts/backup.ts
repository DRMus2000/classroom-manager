/**
 * 每日 pg_dump。成功和失败都写入 backup_record。失败退出码为 1，便于 cron 告警。
 *
 * 用法：
 *   npm run backup
 */

import { closeDb } from '../src/repo/db.js';
import { dumpWithPgDump, measureDiskFree, redactSecrets, resolveRetentionDays, runDailyBackup } from '../src/services/backup.js';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '') throw new Error('DATABASE_URL 未设置');
  const result = await runDailyBackup({
    dir: process.env.BACKUP_DIR?.trim() || 'backups',
    retentionDays: resolveRetentionDays(process.env.BACKUP_RETENTION_DAYS),
    dump: (filePath) => dumpWithPgDump(databaseUrl, filePath),
    diskFree: measureDiskFree,
  });
  if (result.status === 'busy') {
    console.log('另一备份任务正在运行，本次跳过。');
    return;
  }
  if (result.disk_warning) {
    console.error(`磁盘告警：剩余 ${result.disk_free_bytes} 字节，低于 3GB。`);
  }
  if (result.status === 'failed') {
    console.error(`备份失败告警：${result.error ?? '未知错误'}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ 备份完成：${result.file_name}，清理 ${result.removed.length} 个过期文件`);
}

main()
  .catch((err: unknown) => {
    const message = err instanceof Error ? redactSecrets(err.message) : '未知错误';
    console.error(`备份失败告警：${message}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
