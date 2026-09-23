/**
 * 事务提交之后才执行的回调。
 * 写在 withTx 里的 SSE 广播必须走这里，回滚时不会通知客户端。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const pending = new AsyncLocalStorage<Array<() => void>>();

/** 若当前处于 withTx 中，则推迟到提交成功后；否则立即执行。 */
export function afterCommit(fn: () => void): void {
  const hooks = pending.getStore();
  if (hooks) hooks.push(fn);
  else fn();
}

/** 执行 work。成功后按注册顺序运行回调；work 抛错则丢弃回调。 */
export async function runWithCommitHooks<T>(work: () => Promise<T>): Promise<T> {
  const hooks: Array<() => void> = [];
  const result = await pending.run(hooks, work);
  for (const hook of hooks) hook();
  return result;
}
