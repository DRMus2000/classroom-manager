import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { CountdownDto, RollcallDto } from '../lib/types';
import { useApp } from './useApp';
import { useResource } from './useResource';

/**
 * 倒计时。服务端只下发动作与 `deadline_at`，剩余秒数在本地按截止时间计算。
 */
export function useCountdown() {
  const { classId, tick } = useApp();
  const res = useResource(
    classId ? () => api<CountdownDto>(`/countdown/${classId}`) : null,
    [classId, tick('countdown')],
  );
  const state = res.data && res.data.class_id === classId ? res.data : null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (state?.status !== 'running') return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [state?.status, state?.deadline_at]);

  let remaining: number | null = null;
  let status = state?.status ?? 'reset';
  if (state) {
    if (state.status === 'running' && state.deadline_at) {
      remaining = Math.max(0, (new Date(state.deadline_at).getTime() - now) / 1000);
      if (remaining <= 0) status = 'finished';
    } else if (state.status === 'paused') {
      remaining = state.remaining_sec ?? 0;
    } else if (state.status === 'finished') {
      remaining = 0;
    } else {
      remaining = state.duration_sec;
    }
  }

  return { state, set: res.set, status, remaining, duration: state?.duration_sec ?? null };
}

/** 到时提示音：状态从未结束变为结束时响一次。 */
export function useFinishChime(finished: boolean, enabled = true) {
  const prev = useRef(finished);
  useEffect(() => {
    if (enabled && finished && !prev.current) chime();
    prev.current = finished;
  }, [finished, enabled]);
}

function chime() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [0, 0.28, 0.56].forEach((offset, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = i === 2 ? 1046 : 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + offset + 0.24);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.26);
    });
    window.setTimeout(() => void ctx.close(), 1200);
  } catch {
    /* 浏览器禁止自动播放时静默 */
  }
}

export function useRollcall() {
  const { classId, tick } = useApp();
  const res = useResource(
    classId ? () => api<{ round: RollcallDto | null }>(`/classes/${classId}/rollcall`).then((r) => ({ class_id: classId, round: r.round })) : null,
    [classId, tick('rollcall')],
  );
  const round = res.data && res.data.class_id === classId ? res.data.round : null;
  return {
    round,
    loaded: res.data != null,
    set: (next: RollcallDto | null) => res.set({ class_id: classId, round: next && next.status === 'open' ? next : null }),
  };
}
