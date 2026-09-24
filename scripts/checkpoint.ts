/**
 * 回放检查点任务。记分事务只写 event_log；本命令按班、当前学期补写 replay_checkpoint。
 *
 * 用法：
 *   npm run checkpoint           # 满阈值才写
 *   npm run checkpoint -- --daily  # 每日兜底，不足阈值也写
 */

import { closeDb } from '../src/repo/db.js';
import { parseCheckpointArgs, writeDueCheckpoints } from '../src/services/replay.js';

async function main(): Promise<void> {
  const { daily } = parseCheckpointArgs(process.argv.slice(2));
  const result = await writeDueCheckpoints({ daily });
  if (result.busy) {
    console.log('另一检查点任务正在运行，本次跳过。');
    return;
  }
  const summary = `写入 ${result.written} 条，跳过 ${result.skipped} 个班，失败 ${result.failed} 个班`;
  if (result.failed > 0) {
    console.error(daily ? `每日检查点部分失败：${summary}` : `阈值检查点部分失败：${summary}`);
    process.exitCode = 1;
    return;
  }
  console.log(daily ? `✓ 每日检查点：${summary}` : `✓ 阈值检查点：${summary}`);
}

main()
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : '未知错误';
    console.error(`检查点任务失败：${message}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
