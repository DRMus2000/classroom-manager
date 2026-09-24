import { useCallback, useEffect, useRef, useState } from 'react';

export interface Resource<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
  /** 写操作成功后直接用响应覆盖，不必再发一次请求。 */
  set: (value: T) => void;
}

/**
 * 读接口。重新加载时保留上一份数据：断网或请求失败都不清空已显示的内容。
 * 只采用最后一次发起的请求结果，避免 SSE 连发事件时旧响应覆盖新响应。
 */
export function useResource<T>(
  fetcher: (() => Promise<T>) | null,
  deps: readonly unknown[],
): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const latest = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    const run = fetcherRef.current;
    if (!run) {
      setData(null);
      return;
    }
    const ticket = ++latest.current;
    setLoading(true);
    run()
      .then((value) => {
        if (ticket !== latest.current) return;
        setData(value);
        setError(null);
      })
      .catch((err: unknown) => {
        if (ticket !== latest.current) return;
        setError(err);
      })
      .finally(() => {
        if (ticket === latest.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, fetcher === null]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const set = useCallback((value: T) => {
    latest.current += 1;
    setData(value);
    setLoading(false);
  }, []);

  return { data, error, loading: loading || (fetcher != null && data == null && error == null), reload, set };
}
