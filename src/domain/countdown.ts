/**
 * 倒计时状态机。服务端只保存动作和绝对截止时间，不按秒推送。
 * finished 在读取、暂停或重置时把已超时的 running 落成终态。
 */

export type CountdownStatus = 'running' | 'paused' | 'reset' | 'finished';
export type CountdownAction = 'start' | 'pause' | 'resume' | 'reset';

export interface CountdownSnapshot {
  status: CountdownStatus;
  duration_sec: number | null;
  /** 绝对截止时间，毫秒。暂停和重置时为 null。 */
  deadline_ms: number | null;
  remaining_sec: number | null;
}

export type CountdownFailure = 'duration_required' | 'illegal' | 'not_started';

const MAX_DURATION_SEC = 24 * 60 * 60;

export function settleCountdown(state: CountdownSnapshot, nowMs: number): CountdownSnapshot {
  if (state.status !== 'running' || state.deadline_ms == null) return state;
  if (nowMs < state.deadline_ms) return state;
  return {
    ...state,
    status: 'finished',
    remaining_sec: 0,
  };
}

export function applyCountdown(
  current: CountdownSnapshot | null,
  action: CountdownAction,
  durationSec: number | undefined,
  nowMs: number,
): { ok: true; state: CountdownSnapshot } | { ok: false; reason: CountdownFailure } {
  if (durationSec !== undefined && (!Number.isInteger(durationSec) || durationSec < 1 || durationSec > MAX_DURATION_SEC)) {
    return { ok: false, reason: 'duration_required' };
  }
  const settled = current ? settleCountdown(current, nowMs) : null;

  if (action === 'start') {
    const duration = durationSec ?? settled?.duration_sec ?? null;
    if (duration == null || duration < 1) return { ok: false, reason: 'duration_required' };
    return {
      ok: true,
      state: {
        status: 'running',
        duration_sec: duration,
        deadline_ms: nowMs + duration * 1000,
        remaining_sec: null,
      },
    };
  }

  if (!settled) return { ok: false, reason: 'not_started' };

  if (action === 'pause') {
    if (settled.status === 'finished' && current?.status === 'running') {
      return { ok: true, state: settled };
    }
    if (settled.status !== 'running' || settled.deadline_ms == null) {
      return { ok: false, reason: 'illegal' };
    }
    const leftMs = settled.deadline_ms - nowMs;
    const remaining = Math.max(1, Math.ceil(leftMs / 1000));
    return {
      ok: true,
      state: {
        status: 'paused',
        duration_sec: settled.duration_sec,
        deadline_ms: null,
        remaining_sec: remaining,
      },
    };
  }

  if (action === 'resume') {
    if (settled.status !== 'paused') return { ok: false, reason: 'illegal' };
    const remaining = settled.remaining_sec ?? 0;
    if (remaining < 1) {
      return {
        ok: true,
        state: {
          ...settled,
          status: 'finished',
          deadline_ms: settled.deadline_ms,
          remaining_sec: 0,
        },
      };
    }
    return {
      ok: true,
      state: {
        status: 'running',
        duration_sec: settled.duration_sec,
        deadline_ms: nowMs + remaining * 1000,
        remaining_sec: null,
      },
    };
  }

  const duration = durationSec ?? settled.duration_sec;
  if (duration == null || duration < 1) return { ok: false, reason: 'duration_required' };
  return {
    ok: true,
    state: {
      status: 'reset',
      duration_sec: duration,
      deadline_ms: null,
      remaining_sec: null,
    },
  };
}

/** 读取时的剩余秒数。running 用截止时间现算，不落库。 */
export function displayRemaining(state: CountdownSnapshot, nowMs: number): number | null {
  const settled = settleCountdown(state, nowMs);
  if (settled.status === 'finished') return 0;
  if (settled.status === 'paused') return settled.remaining_sec;
  if (settled.status === 'running' && settled.deadline_ms != null) {
    return Math.max(0, Math.ceil((settled.deadline_ms - nowMs) / 1000));
  }
  return null;
}
