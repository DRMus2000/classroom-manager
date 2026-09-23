/**
 * useOnlineStatus —— 在线/离线判定。
 *
 * 需求 §4「断网」：保留当前页面已加载内容并明确标记离线，禁止修改；
 * 恢复连接后刷新。首版不保证断网重新打开页面可用。
 *
 * 判定由两路合成：
 *   1. navigator.onLine + online/offline 事件 —— 立刻响应，但只反映「有没有网络接口」，
 *      连着一个没有出口的 Wi-Fi 时它是 true。
 *   2. 周期性 /healthz 探针 —— 真实反映后端可达性，但延迟最多一个间隔。
 * 只有当两者都通过才认为在线；任意一个失败即视为离线（宁可保守，不可漏判）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { probeHealth } from '../lib/api';

/** 探针间隔。选 20s：够快发现断网，又不至于在手机上耗电。 */
export const HEALTH_PROBE_INTERVAL_MS = 20_000;

/** 一次探针的硬超时，防止 fetch 挂死导致状态永远停在「在线」。 */
const PROBE_TIMEOUT_MS = 5_000;

export interface OnlineStatus {
  /** 综合判定：浏览器有网 且 后端可达。 */
  online: boolean;
  /** navigator.onLine 的原始值，仅供诊断展示。 */
  navigatorOnline: boolean;
  /** 后端探针是否通过。 */
  backendReachable: boolean;
  /** 手动立刻重探一次（用户点「重试连接」）。 */
  recheck: () => void;
}

export function useOnlineStatus(): OnlineStatus {
  const [navigatorOnline, setNavigatorOnline] = useState<boolean>(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  const [backendReachable, setBackendReachable] = useState<boolean>(true);
  const [manualTick, setManualTick] = useState(0);

  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const goOnline = () => setNavigatorOnline(true);
    const goOffline = () => setNavigatorOnline(false);

    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);

    // 标签页回到前台时立刻重探：手机锁屏期间定时器会被冻结。
    const onVisible = () => {
      if (document.visibilityState === 'visible') setManualTick((n) => n + 1);
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      // 浏览器自己都说没网，就不必再发探针了。
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        if (!cancelled) setBackendReachable(false);
        return;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      try {
        const ok = await probeHealth(controller.signal);
        if (!cancelled) setBackendReachable(ok);
      } catch {
        if (!cancelled) setBackendReachable(false);
      } finally {
        clearTimeout(timer);
      }
    };

    void run();
    const interval = setInterval(() => void run(), HEALTH_PROBE_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [manualTick]);

  const recheck = useCallback(() => setManualTick((n) => n + 1), []);

  return {
    online: navigatorOnline && backendReachable,
    navigatorOnline,
    backendReachable,
    recheck,
  };
}
