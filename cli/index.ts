/**
 * 维护命令 CLI。
 *
 * 用法：
 *   node dist/cli/index.js create-teacher --username <name>            # 交互式输入密码
 *   node dist/cli/index.js reset-password --username <name>            # 交互式输入新密码
 *   node dist/cli/index.js recompute-balance --term <term_id>          # 重算余额并比对
 *   node dist/cli/index.js cleanup-idempotency --days 7                # 清理过期幂等记录
 *   node dist/cli/index.js anon-export-status                          # 查看匿名化账本导出状态
 *
 * 密码通过交互式隐藏输入提供，避免进入命令历史（第14项）。
 */

import { createInterface } from 'node:readline';
import { db, withTx, sql, closeDb } from '../src/repo/db.js';
import * as authRepo from '../src/repo/auth.js';
import * as pointsRepo from '../src/repo/points.js';
import { cleanupExpiredIdempotency } from '../src/services/idempotency.js';
import { writeDueCheckpoints } from '../src/services/replay.js';
import { dumpWithPgDump, redactSecrets, resolveRetentionDays, runDailyBackup } from '../src/services/backup.js';
import { reapplyAnonLedger, retryFailedLedgerExports } from '../src/services/anonMaintenance.js';
import { hashPassword } from '../src/lib/crypto.js';

/** 交互式读取隐藏输入（不回显）。 */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });

    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    process.stdout.write(question);

    // 关闭回显
    const onData = (char: Buffer) => {
      const str = char.toString('utf8');
      if (str === '\n' || str === '\r' || str === '\u0004') {
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(buffer.trim());
        rl.close();
        if (stdin.isTTY && wasRaw !== undefined) stdin.setRawMode(wasRaw);
      } else if (str === '\u0003') {
        // Ctrl+C
        process.stdout.write('\n');
        process.exit(130);
      } else if (str === '\u007f' || str === '\b') {
        // Backspace
        if (buffer.length > 0) {
          buffer = buffer.slice(0, -1);
        }
      } else {
        buffer += str;
      }
    };

    let buffer = '';
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith('--')) {
      const key = arg.slice(2);
      const val = argv[i + 1];
      if (val && !val.startsWith('--')) {
        out[key] = val;
        i++;
      } else {
        out[key] = 'true';
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */

async function createTeacher(args: Record<string, string>): Promise<void> {
  const username = args['username'];
  if (!username) {
    console.error('用法：create-teacher --username <name>');
    process.exit(1);
  }

  const existing = await authRepo.findTeacherByUsername(db, username);
  if (existing) {
    console.error(`教师账号「${username}」已存在。如需改密请使用 reset-password。`);
    process.exit(1);
  }

  const password = await promptHidden(`为「${username}」设置密码（至少 12 位）：`);
  if (password.length < 12) {
    console.error('密码至少 12 位。');
    process.exit(1);
  }

  const confirm = await promptHidden('再次输入确认：');
  if (password !== confirm) {
    console.error('两次输入不一致。');
    process.exit(1);
  }

  await withTx(db, async (tx) => {
    await authRepo.createTeacher(tx, { username, password });
  });

  console.log(`✓ 教师账号「${username}」已创建。`);
}

async function resetPassword(args: Record<string, string>): Promise<void> {
  const username = args['username'];
  if (!username) {
    console.error('用法：reset-password --username <name>');
    process.exit(1);
  }

  const teacher = await authRepo.findTeacherByUsername(db, username);
  if (!teacher) {
    console.error(`教师账号「${username}」不存在。`);
    process.exit(1);
  }

  const password = await promptHidden(`为「${username}」设置新密码（至少 12 位）：`);
  if (password.length < 12) {
    console.error('密码至少 12 位。');
    process.exit(1);
  }

  const confirm = await promptHidden('再次输入确认：');
  if (password !== confirm) {
    console.error('两次输入不一致。');
    process.exit(1);
  }

  await withTx(db, async (tx) => {
    const newHash = await hashPassword(password);
    await tx.execute(
      sql`UPDATE teacher
          SET password_hash = ${newHash},
              token_version = token_version + 1,   -- 撤销全部已有登录会话
              password_changed_at = now()
          WHERE teacher_id = ${teacher.teacher_id}`,
    );
  });

  console.log(`✓ 「${username}」密码已重置，全部登录会话已撤销。`);
}

async function recomputeBalance(args: Record<string, string>): Promise<void> {
  const termId = args['term'];
  if (!termId) {
    console.error('用法：recompute-balance --term <term_id>');
    process.exit(1);
  }

  const diffs = await pointsRepo.recomputeBalances(db, termId);

  if (diffs.length === 0) {
    console.log('✓ 账本与余额缓存完全一致。');
    return;
  }

  console.warn(`⚠️  发现 ${diffs.length} 处不一致：\n`);
  console.log('学生 ID'.padEnd(40) + '缓存'.padStart(10) + '账本'.padStart(10));
  console.log('-'.repeat(60));
  for (const d of diffs) {
    console.log(d.student_id.padEnd(40) + String(d.cached).padStart(10) + String(d.computed).padStart(10));
  }
  console.log('\n余额以账本为准。如需修复，请执行：');
  console.log(`  docker compose exec api node dist/cli/index.js fix-balance --term ${termId}`);
  process.exitCode = 2;
}

async function cleanupIdempotency(args: Record<string, string>): Promise<void> {
  const days = Number(args['days'] ?? 7);
  const count = await withTx(db, async (tx) => cleanupExpiredIdempotency(tx, days));
  console.log(`✓ 清理了 ${count} 条过期幂等记录（保留最近 ${days} 天）。`);
}

async function checkpoint(args: Record<string, string>): Promise<void> {
  if (args['daily'] !== undefined && args['daily'] !== 'true') {
    console.error('用法：checkpoint [--daily]');
    process.exit(1);
  }
  const result = await writeDueCheckpoints({ daily: args['daily'] === 'true' });
  if (result.busy) {
    console.log('另一检查点任务正在运行，本次跳过。');
    return;
  }
  const summary = `写入 ${result.written} 条，跳过 ${result.skipped} 个班，失败 ${result.failed} 个班`;
  if (result.failed > 0) {
    console.error(`检查点部分失败：${summary}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ 检查点：${summary}`);
}

async function backup(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '') throw new Error('DATABASE_URL 未设置');
  const result = await runDailyBackup({
    dir: process.env.BACKUP_DIR?.trim() || 'backups',
    retentionDays: resolveRetentionDays(process.env.BACKUP_RETENTION_DAYS),
    dump: (filePath) => dumpWithPgDump(databaseUrl, filePath),
  });
  if (result.status === 'busy') {
    console.log('另一备份任务正在运行，本次跳过。');
    return;
  }
  if (result.disk_warning) console.error(`磁盘告警：剩余 ${result.disk_free_bytes} 字节，低于 3GB。`);
  if (result.status === 'failed') {
    console.error(`备份失败告警：${result.error ?? '未知错误'}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ 备份完成：${result.file_name}，清理 ${result.removed.length} 个过期文件`);
}

async function anonLedgerRetry(): Promise<void> {
  const result = await retryFailedLedgerExports();
  if (result.failed > 0) {
    console.error(`匿名账本重试：导出 ${result.exported} 条，失败 ${result.failed} 条`);
    for (const item of result.errors) console.error(`  ${item.anon_id}  ${item.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ 匿名账本重试：导出 ${result.exported} 条`);
}

async function anonReapply(args: Record<string, string>): Promise<void> {
  const confirm = args['confirm'] === 'true';
  const result = await reapplyAnonLedger(confirm);
  if (!confirm) {
    console.log(`待补做 ${result.pending} 条，已完成 ${result.already} 条，库中无此人 ${result.missing} 条。`);
    console.log('确认后执行：anon-reapply --confirm');
    if (result.pending > 0) process.exitCode = 2;
    return;
  }
  console.log(`✓ 已补做 ${result.applied} 条，原本已匿名 ${result.already} 条，库中无此人 ${result.missing} 条。`);
}

async function anonExportStatus(): Promise<void> {
  const rows = await db.execute<{
    anon_id: string;
    state: string;
    attempts: number;
    last_error: string | null;
    updated_at: Date;
  }>(sql`
    SELECT anon_id, state, attempts, last_error, updated_at
    FROM anon_ledger_export
    WHERE state <> 'exported'
    ORDER BY updated_at DESC
    LIMIT 50
  `);

  if (rows.length === 0) {
    console.log('✓ 匿名化账本全部导出成功。');
    return;
  }

  console.warn(`⚠️  ${rows.length} 条匿名化账本条目未成功导出：\n`);
  for (const r of rows) {
    console.warn(`  ${r.anon_id}  [${r.state}]  尝试 ${r.attempts} 次  ${r.last_error ?? ''}`);
  }
  console.warn('\n请检查匿名账本目录写入权限与磁盘空间，然后执行 anon-ledger-retry。');
  process.exitCode = 2;
}

/* ------------------------------------------------------------------ */

const COMMANDS: Record<string, (args: Record<string, string>) => Promise<void>> = {
  'create-teacher': createTeacher,
  'reset-password': resetPassword,
  'recompute-balance': recomputeBalance,
  'cleanup-idempotency': cleanupIdempotency,
  'anon-export-status': anonExportStatus,
  checkpoint,
  backup,
  'anon-ledger-retry': anonLedgerRetry,
  'anon-reapply': anonReapply,
};

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const args = parseArgs(process.argv.slice(3));

  if (!cmd || !COMMANDS[cmd]) {
    console.log('可用命令：\n');
    console.log('  create-teacher --username <name>          创建教师账号（交互式输入密码）');
    console.log('  reset-password --username <name>          重置密码（撤销全部会话）');
    console.log('  recompute-balance --term <term_id>        重算余额并与缓存比对');
    console.log('  cleanup-idempotency --days 7              清理过期幂等记录');
    console.log('  anon-export-status                        查看匿名化账本导出状态');
    console.log('  checkpoint [--daily]                     写入到期回放检查点');
    console.log('  backup                                    执行 pg_dump 并记录结果');
    console.log('  anon-ledger-retry                         重试未导出的匿名账本');
    console.log('  anon-reapply [--confirm]                  恢复旧备份后补做匿名化');
    process.exit(cmd ? 1 : 0);
  }

  try {
    await COMMANDS[cmd]!(args);
  } catch (err) {
    const message = err instanceof Error ? redactSecrets(err.message) : '未知错误';
    console.error(`命令执行失败：${message}`);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

main();
