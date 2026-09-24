/**
 * 回放检查点任务。记分事务只写 event_log；本命令按班、当前学期补写 replay_checkpoint。
 *
 * 用法：
 *   npm run checkpoint           # 满阈值才写
 *   npm run checkpoint -- --daily  # 每日兜底，不足阈值也写
 */

import { closeDb } from '../src/repo/db.js';
import { writeDueCheckpoints } from '../src/services/replay.js';

async function main(): Promise<void> {
  const daily = process.argv.includes('--daily');
  const result = await writeDueCheckpoints({ daily });
  console.log(
    daily
      ? `✓ 每日检查点：写入 ${result.written} 条，跳过 ${result.skipped} 个班`
      : `✓ 阈值检查点：写入 ${result.written} 条，跳过 ${result.skipped} 个班`,
  );
}

main()
  .catch((err) => {
    console.error('检查点任务失败：', err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
