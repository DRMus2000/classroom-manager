import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, ApiError, ERROR_HINTS, describeError } from '../lib/api';
import { SseClient, type SseStatus } from '../lib/sse';
import type { EventKind, SseMessage } from '../lib/schema';
import type {
  ClassDto,
  ClassDutyDto,
  ClassSeatsDto,
  EffectiveTemplateDto,
  MarkDefDto,
  MeDto,
  TermDto,
} from '../lib/types';
import { useOnlineStatus } from './useOnlineStatus';
import { useResource } from './useResource';

export type Channel = 'classes' | 'seats' | 'duty' | 'points' | 'rollcall' | 'countdown' | 'marks' | 'templates';

const ALL_CHANNELS: Channel[] = ['classes', 'seats', 'duty', 'points', 'rollcall', 'countdown', 'marks', 'templates'];

const CHANNELS_BY_EVENT: Record<Exclude<EventKind, 'resync'>, Channel[]> = {
  seat_changed: ['seats'],
  points_appended: ['seats', 'points'],
  roster_changed: ['classes', 'seats', 'duty', 'rollcall', 'points'],
  layout_changed: ['seats'],
  term_switched: ALL_CHANNELS,
  marks_changed: ['seats', 'marks'],
  duty_round_changed: ['duty'],
  countdown_changed: ['countdown'],
  rollcall_changed: ['rollcall'],
};

export interface DutyView {
  duty_term_id: string | null;
  completed_count: number;
  required_count: number;
  /** 本轮确认、下一轮才开始值日的新任者。 */
  upcoming: boolean;
}

export interface RosterEntry {
  student_id: string;
  name: string;
  student_no: string;
  seat_id: string;
  seat_number: number | null;
  column_code: string;
  balance: number;
}

export interface ToastInput {
  tone?: 'info' | 'success' | 'error';
  title: string;
  detail?: string;
  action?: { label: string; run: () => void };
}

export interface Toast extends ToastInput {
  id: number;
}

interface Conflict {
  message: string;
  onReload?: () => void;
}

interface AppContextValue {
  me: MeDto;
  logout: () => void;
  online: boolean;
  recheck: () => void;
  sse: SseStatus;
  classes: ClassDto[];
  classId: string;
  setClassId: (id: string) => void;
  currentClass: ClassDto | null;
  terms: TermDto[];
  currentTerm: TermDto | null;
  seats: ClassSeatsDto | null;
  seatsLoading: boolean;
  duty: ClassDutyDto | null;
  dutyBadges: Map<string, DutyView>;
  templates: EffectiveTemplateDto[];
  marks: MarkDefDto[];
  roster: RosterEntry[];
  nameOf: (studentId: string) => string;
  tick: (channel: Channel) => number;
  bump: (...channels: Channel[]) => void;
  toasts: Toast[];
  toast: (input: ToastInput) => void;
  dismissToast: (id: number) => void;
  conflict: Conflict | null;
  resolveConflict: () => void;
  reportError: (err: unknown, opts?: { onConflict?: () => void }) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

const CLASS_KEY = 'cm.class_id';

export function AppProvider(props: { me: MeDto; onSignedOut: () => void; children: ReactNode }) {
  const status = useOnlineStatus();
  const [sse, setSse] = useState<SseStatus>('connecting');
  const [ticks, setTicks] = useState<Record<Channel, number>>(() =>
    Object.fromEntries(ALL_CHANNELS.map((c) => [c, 0])) as Record<Channel, number>,
  );
  const [classId, setClassIdState] = useState<string>(() => localStorage.getItem(CLASS_KEY) ?? '');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const toastSeq = useRef(0);

  const bump = useCallback((...channels: Channel[]) => {
    setTicks((prev) => {
      const next = { ...prev };
      for (const c of channels) next[c] += 1;
      return next;
    });
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (input: ToastInput) => {
      const id = ++toastSeq.current;
      setToasts((list) => [...list.slice(-3), { ...input, id }]);
      window.setTimeout(() => dismissToast(id), input.action ? 9000 : 4200);
    },
    [dismissToast],
  );

  const { onSignedOut } = props;
  const reportError = useCallback(
    (err: unknown, opts?: { onConflict?: () => void }) => {
      if (err instanceof ApiError && err.isAuthFailure) {
        onSignedOut();
        return;
      }
      if (err instanceof ApiError && err.isVersionConflict) {
        setConflict({ message: err.message, onReload: opts?.onConflict });
        return;
      }
      const detail = err instanceof ApiError ? ERROR_HINTS[err.code] : undefined;
      toast({ tone: 'error', title: describeError(err), detail });
    },
    [onSignedOut, toast],
  );

  const classesRes = useResource(() => api<ClassDto[]>('/classes'), [ticks.classes]);
  const termsRes = useResource(() => api<TermDto[]>('/terms'), [ticks.classes]);
  const classes = useMemo(() => (classesRes.data ?? []).filter((c) => !c.archived_at), [classesRes.data]);

  useEffect(() => {
    if (classes.length === 0) return;
    if (!classes.some((c) => c.class_id === classId)) setClassIdState(classes[0]!.class_id);
  }, [classes, classId]);

  const setClassId = useCallback((id: string) => {
    localStorage.setItem(CLASS_KEY, id);
    setClassIdState(id);
  }, []);

  const validClass = classes.some((c) => c.class_id === classId) ? classId : '';

  const seatsRes = useResource(
    validClass ? () => api<ClassSeatsDto>(`/classes/${validClass}/seats`) : null,
    [validClass, ticks.seats],
  );
  const dutyRes = useResource(
    validClass
      ? () => api<ClassDutyDto>(`/classes/${validClass}/duty`).then((state) => ({ class_id: validClass, state }))
      : null,
    [validClass, ticks.duty],
  );
  const dutyState = dutyRes.data && dutyRes.data.class_id === validClass ? dutyRes.data.state : null;
  const templatesRes = useResource(
    validClass ? () => api<EffectiveTemplateDto[]>(`/classes/${validClass}/templates`) : null,
    [validClass, ticks.templates],
  );
  const marksRes = useResource(() => api<MarkDefDto[]>('/marks'), [ticks.marks]);

  for (const error of [classesRes.error, seatsRes.error, dutyRes.error]) {
    if (error instanceof ApiError && error.isAuthFailure) {
      queueMicrotask(onSignedOut);
      break;
    }
  }

  // SSE：按事件种类刷新对应数据。
  const sseClient = useRef<SseClient | null>(null);
  useEffect(() => {
    const client = new SseClient({
      classId: validClass || undefined,
      onEvent: (msg: SseMessage) => {
        if (msg.kind === 'resync') {
          bump(...ALL_CHANNELS);
          return;
        }
        bump(...CHANNELS_BY_EVENT[msg.kind]);
      },
      onResync: () => bump(...ALL_CHANNELS),
      onStatus: setSse,
    });
    client.connect();
    sseClient.current = client;
    return () => {
      client.close();
      sseClient.current = null;
    };
  }, [validClass, bump]);

  // 断线恢复后全量刷新一次，SSE 补发只覆盖事件，不覆盖断线期间失败的读取。
  const wasOnline = useRef(status.online);
  useEffect(() => {
    if (status.online && !wasOnline.current) {
      sseClient.current?.reconnectNow();
      bump(...ALL_CHANNELS);
    }
    wasOnline.current = status.online;
  }, [status.online, bump]);

  const roster = useMemo<RosterEntry[]>(() => {
    const cards = seatsRes.data?.cards ?? [];
    return cards
      .filter((c) => c.student)
      .map((c) => ({
        student_id: c.student!.student_id,
        name: c.student!.name,
        student_no: c.student!.student_no,
        seat_id: c.seat_id,
        seat_number: c.seat_number,
        column_code: c.column_code,
        balance: c.student!.balance,
      }))
      .sort((a, b) => (a.seat_number ?? 0) - (b.seat_number ?? 0));
  }, [seatsRes.data]);

  const names = useMemo(() => new Map(roster.map((r) => [r.student_id, r.name])), [roster]);
  const nameOf = useCallback((id: string) => names.get(id) ?? '已离班学生', [names]);

  const dutyBadges = useMemo(() => {
    const map = new Map<string, DutyView>();
    const state = dutyState;
    for (const card of seatsRes.data?.cards ?? []) {
      const d = card.student?.duty;
      if (d && d.status === 'active') {
        map.set(card.student!.student_id, {
          duty_term_id: d.duty_term_id,
          completed_count: d.completed_count,
          required_count: d.required_count,
          upcoming: false,
        });
      }
    }
    if (!state) return map;
    for (const t of state.active_terms) {
      map.set(t.student_id, {
        duty_term_id: t.duty_term_id,
        completed_count: Number(t.completed_count),
        required_count: Number(t.required_count),
        upcoming: false,
      });
    }
    for (const m of state.round?.members ?? []) {
      if (!m.is_original) continue;
      if (m.term_status === 'active') {
        map.set(m.student_id, {
          duty_term_id: m.duty_term_id,
          completed_count: m.completed_count,
          required_count: m.required_count,
          upcoming: false,
        });
      } else {
        map.delete(m.student_id);
      }
    }
    for (const n of state.next_appointees) {
      map.set(n.student_id, { duty_term_id: n.duty_term_id, completed_count: 0, required_count: 3, upcoming: true });
    }
    return map;
  }, [dutyState, seatsRes.data]);

  const currentTerm = useMemo(() => (termsRes.data ?? []).find((t) => t.is_current) ?? null, [termsRes.data]);

  const logout = useCallback(() => {
    void api('/auth/logout', { method: 'POST', body: {} }).finally(onSignedOut);
  }, [onSignedOut]);

  const resolveConflict = useCallback(() => {
    conflict?.onReload?.();
    setConflict(null);
    bump(...ALL_CHANNELS);
  }, [conflict, bump]);

  const tick = useCallback((channel: Channel) => ticks[channel], [ticks]);

  const value: AppContextValue = {
    me: props.me,
    logout,
    online: status.online,
    recheck: status.recheck,
    sse,
    classes,
    classId: validClass,
    setClassId,
    currentClass: classes.find((c) => c.class_id === validClass) ?? null,
    terms: termsRes.data ?? [],
    currentTerm,
    seats: seatsRes.data && seatsRes.data.class_id === validClass ? seatsRes.data : null,
    seatsLoading: seatsRes.loading,
    duty: dutyState,
    dutyBadges,
    templates: (templatesRes.data ?? []).filter((t) => !t.hidden),
    marks: marksRes.data ?? [],
    roster,
    nameOf,
    tick,
    bump,
    toasts,
    toast,
    dismissToast,
    conflict,
    resolveConflict,
    reportError,
  };

  return <AppContext.Provider value={value}>{props.children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp 必须在 AppProvider 内使用');
  return ctx;
}
