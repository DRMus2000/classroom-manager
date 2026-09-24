import { useCallback, useRef, useState } from 'react';
import { ApiError, newRequestId } from '../lib/api';
import { useApp } from './useApp';

export interface WriteOptions {
  /** 版本冲突对话框里点「载入最新状态」时额外执行，例如丢弃换座草稿。 */
  onConflict?: () => void;
  /** 返回 true 表示调用方已自行处理该错误。 */
  onError?: (err: unknown) => boolean | void;
}

/**
 * 写操作。
 * - 离线时直接拒绝，不发请求。
 * - 同一时刻只允许一个在途请求，按钮用 `pending` 禁用。
 * - `intent` 描述这次用户意图（通常是请求体）。只有上一次同一意图因网络或
 *   REQUEST_IN_FLIGHT 失败时才复用原 request_id；其他情况都生成新的，
 *   避免改了内容却撞上 IDEMPOTENCY_MISMATCH。
 */
export function useWrite() {
  const { online, reportError, toast } = useApp();
  const [pending, setPending] = useState(false);
  const inflight = useRef(false);
  const retry = useRef<{ intent: string; requestId: string } | null>(null);

  const run = useCallback(
    async <T>(
      intent: unknown,
      fn: (requestId: string) => Promise<T>,
      opts: WriteOptions = {},
    ): Promise<T | undefined> => {
      if (!online) {
        toast({ tone: 'error', title: '当前离线，不能提交修改' });
        return undefined;
      }
      if (inflight.current) return undefined;
      const key = JSON.stringify(intent ?? null);
      const requestId = retry.current?.intent === key ? retry.current.requestId : newRequestId();
      retry.current = { intent: key, requestId };
      inflight.current = true;
      setPending(true);
      try {
        const result = await fn(requestId);
        retry.current = null;
        return result;
      } catch (err) {
        if (!(err instanceof ApiError && err.retryable)) retry.current = null;
        if (!opts.onError?.(err)) reportError(err, { onConflict: opts.onConflict });
        return undefined;
      } finally {
        inflight.current = false;
        setPending(false);
      }
    },
    [online, reportError, toast],
  );

  return { run, pending, disabled: pending || !online };
}
