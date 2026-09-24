/**
 * 匿名化账本的提交顺序：先提交数据库意图，再写库外文件，最后确认导出。
 * 文件写入失败时不执行确认；意图提交失败时不写文件。
 */

export async function runCommittedExport(steps: {
  commitIntent: () => Promise<void>;
  writeLedger: () => Promise<void>;
  confirmExport: () => Promise<void>;
}): Promise<void> {
  await steps.commitIntent();
  await steps.writeLedger();
  await steps.confirmExport();
}
