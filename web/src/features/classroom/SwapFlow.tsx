import { useCallback, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import type { ClassSeatsDto, SeatCardDto, SeatPlanDto } from '../../lib/types';
import { expandTargetsFromAnchor } from '../../lib/seatGeometry';
import { useApp } from '../../hooks/useApp';
import { useWrite } from '../../hooks/useWrite';
import type { SeatDecor } from '../../components/SeatMap';
import { Icon } from '../../components/Icon';

export type SwapStep = 1 | 2 | 3;

export interface SwapDraft {
  step: SwapStep;
  sources: string[];
  sourceSet: ReadonlySet<string>;
  anchor: string | null;
  expansion: ReturnType<typeof expandTargetsFromAnchor> | null;
  plan: SeatPlanDto | null;
  /** 预览时看到的 seat_version。提交必须携带它，而不是 SSE 刷新后的新版本。 */
  planVersion: number | null;
  planning: boolean;
  previewSeats: ClassSeatsDto | null;
  start: (ids: string[]) => void;
  reset: () => void;
  back: () => void;
  next: () => void;
  onSeat: (card: SeatCardDto) => void;
  addSources: (ids: string[]) => void;
  preview: () => Promise<void>;
  decorate: (card: SeatCardDto) => SeatDecor | undefined;
}

/** 手机三步换座的草稿：选学生 → 选锚点 → 预览确认。取消不产生任何写入。 */
export function useSwapDraft(): SwapDraft {
  const { seats, reportError } = useApp();
  const [step, setStep] = useState<SwapStep>(1);
  const [sources, setSources] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [plan, setPlan] = useState<SeatPlanDto | null>(null);
  const [planVersion, setPlanVersion] = useState<number | null>(null);
  const [planning, setPlanning] = useState(false);

  const sourceSet = useMemo(() => new Set(sources), [sources]);

  const expansion = useMemo(() => {
    if (!seats || !anchor || sources.length === 0) return null;
    return expandTargetsFromAnchor(seats.cards, seats.columns, sources, anchor);
  }, [seats, anchor, sources]);

  const start = useCallback(
    (ids: string[]) => {
      setSources(ids);
      setAnchor(null);
      setPlan(null);
      setPlanVersion(null);
      setStep(1);
    },
    [],
  );
  const reset = useCallback(() => start([]), [start]);

  const back = useCallback(() => {
    setStep((s) => {
      if (s === 3) {
        setPlan(null);
        setPlanVersion(null);
        return 2;
      }
      if (s === 2) {
        setAnchor(null);
        return 1;
      }
      setSources([]);
      return 1;
    });
  }, []);

  const next = useCallback(() => {
    if (sources.length > 0) setStep(2);
  }, [sources.length]);

  const onSeat = useCallback(
    (card: SeatCardDto) => {
      if (step === 1) {
        const id = card.student?.student_id;
        if (!id) return;
        setSources((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
      } else if (step === 2) {
        setAnchor(card.seat_id);
      }
    },
    [step],
  );

  const addSources = useCallback((ids: string[]) => {
    setSources((prev) => [...new Set([...prev, ...ids])]);
  }, []);

  const preview = useCallback(async () => {
    if (!seats || !expansion?.ok) return;
    setPlanning(true);
    const version = seats.seat_version;
    try {
      const result = await api<SeatPlanDto>(`/classes/${seats.class_id}/seats/plan`, {
        method: 'POST',
        body: { source_student_ids: sources, target_seat_ids: expansion.target_seat_ids },
      });
      setPlan(result);
      setPlanVersion(version);
      setStep(3);
    } catch (err) {
      reportError(err);
    } finally {
      setPlanning(false);
    }
  }, [seats, expansion, sources, reportError]);

  const previewSeats = useMemo<ClassSeatsDto | null>(() => {
    if (!seats || step !== 3 || !plan?.ok) return null;
    const bySeat = new Map(seats.cards.map((c) => [c.seat_id, c]));
    const movers = new Map(plan.assignments.map((a) => [a.to_seat_id, a]));
    const leaving = new Set(plan.assignments.map((a) => a.from_seat_id));
    const cards = seats.cards.map((card) => {
      const incoming = movers.get(card.seat_id);
      if (incoming) {
        const from = bySeat.get(incoming.from_seat_id);
        return { ...card, student: from?.student ?? null };
      }
      if (leaving.has(card.seat_id)) return { ...card, student: null };
      return card;
    });
    return { ...seats, cards };
  }, [seats, step, plan]);

  const decorate = useCallback(
    (card: SeatCardDto): SeatDecor | undefined => {
      if (!seats) return undefined;
      if (step === 2 && expansion) {
        const i = expansion.target_seat_ids.indexOf(card.seat_id);
        if (card.seat_id === anchor) return { tone: 'anchor', label: '锚点' };
        if (i >= 0) return { tone: 'target', label: '目标' };
        return undefined;
      }
      if (step === 3 && plan) {
        const numberOf = new Map(seats.cards.map((c) => [c.seat_id, c.seat_number]));
        const a = plan.assignments.find((x) => x.to_seat_id === card.seat_id);
        if (a) return { tone: a.role === 'selected' ? 'target' : 'affected', label: `原 ${numberOf.get(a.from_seat_id) ?? '—'}` };
        if (plan.assignments.some((x) => x.from_seat_id === card.seat_id)) return { tone: 'dim', label: '空出' };
        return undefined;
      }
      return undefined;
    },
    [seats, step, expansion, anchor, plan],
  );

  return useMemo(
    () => ({
      step,
      sources,
      sourceSet: step === 3 ? EMPTY : sourceSet,
      anchor,
      expansion,
      plan,
      planVersion,
      planning,
      previewSeats,
      start,
      reset,
      back,
      next,
      onSeat,
      addSources,
      preview,
      decorate,
    }),
    [step, sources, sourceSet, anchor, expansion, plan, planVersion, planning, previewSeats, start, reset, back, next, onSeat, addSources, preview, decorate],
  );
}

const EMPTY: ReadonlySet<string> = new Set();

const STEPS = ['选择学生', '选择目标', '预览确认'];

export function SwapFlow(props: { draft: SwapDraft; onDone: () => void }) {
  const { seats, nameOf, toast, bump } = useApp();
  const write = useWrite();
  const d = props.draft;
  const numberOf = useMemo(() => new Map((seats?.cards ?? []).map((c) => [c.seat_id, c.seat_number])), [seats]);
  const origin = d.expansion?.origin_student_id ?? [...d.sources].sort((a, b) => seatNo(a) - seatNo(b))[0];

  function seatNo(studentId: string): number {
    const card = seats?.cards.find((c) => c.student?.student_id === studentId);
    return card?.seat_number ?? 0;
  }

  async function apply() {
    if (!seats || !d.plan?.ok || d.planVersion == null) return;
    // 服务端只按 role=selected 的分配重算比对；把受影响学生一起提交会被判为不一致。
    const assignments = d.plan.assignments
      .filter((a) => a.role === 'selected')
      .map((a) => ({ student_id: a.student_id, seat_id: a.to_seat_id }));
    const body = { assignments, expected_version: d.planVersion };
    const result = await write.run(
      body,
      (requestId) => api<{ seat_version: number }>(`/classes/${seats.class_id}/seats/apply`, { method: 'POST', body, requestId }),
      { onConflict: props.onDone },
    );
    if (!result) return;
    const affected = d.plan.assignments.filter((a) => a.role === 'affected').length;
    toast({
      tone: 'success',
      title: `换座已保存：${assignments.length} 人移动`,
      detail: affected ? `另有 ${affected} 人随之轮换` : undefined,
    });
    bump('seats');
    props.onDone();
  }

  const selectedMoves = d.plan?.assignments.filter((a) => a.role === 'selected') ?? [];
  const affectedMoves = d.plan?.assignments.filter((a) => a.role === 'affected') ?? [];

  return (
    <div className="dock swap" role="region" aria-label="换座">
      <ol className="stepper">
        {STEPS.map((label, i) => (
          <li key={label} className={d.step === i + 1 ? 'is-current' : d.step > i + 1 ? 'is-done' : ''}>
            <span className="stepper-dot">{d.step > i + 1 ? <Icon name="check" size={12} strokeWidth={3} /> : i + 1}</span>
            <span className="stepper-label">{label}</span>
          </li>
        ))}
      </ol>

      <div className="swap-body">
        {d.step === 1 ? (
          <>
            <p className="swap-lead">
              {d.sources.length === 0 ? '点选要换座的学生，可多选；也可点列号整列加入。' : `已选 ${d.sources.length} 人`}
            </p>
            {d.sources.length > 0 ? (
              <div className="name-chips">
                {[...d.sources]
                  .sort((a, b) => seatNo(a) - seatNo(b))
                  .map((id) => (
                    <span key={id} className="name-chip">
                      <em>{seatNo(id)}</em>
                      {nameOf(id)}
                    </span>
                  ))}
              </div>
            ) : null}
          </>
        ) : null}

        {d.step === 2 ? (
          <>
            <p className="swap-lead">
              点选 <strong>{origin ? nameOf(origin) : ''}</strong>（{origin ? seatNo(origin) : ''} 号）要去的座位
              {d.sources.length > 1 ? `，其余 ${d.sources.length - 1} 人保持相对位置跟随` : ''}。
            </p>
            {d.expansion && !d.expansion.ok ? (
              <p className="swap-error">
                <Icon name="x" size={14} />
                {d.expansion.missing_student_ids.map(nameOf).join('、')} 的目标位置不存在，请换一个锚点。
              </p>
            ) : null}
          </>
        ) : null}

        {d.step === 3 && d.planVersion != null && seats && seats.seat_version !== d.planVersion ? (
          <p className="swap-error">
            <Icon name="refresh" size={14} />
            座次刚被其他设备修改，这份预览已过期。
            <button type="button" className="link-btn" onClick={() => void d.preview()}>
              按最新座次重新预览
            </button>
          </p>
        ) : null}

        {d.step === 3 && d.plan ? (
          d.plan.ok ? (
            <div className="moves">
              {selectedMoves.map((a) => (
                <div key={a.student_id} className="move">
                  <span className="move-name">{nameOf(a.student_id)}</span>
                  <span className="move-seat">{numberOf.get(a.from_seat_id)}</span>
                  <Icon name="arrowRight" size={14} />
                  <span className="move-seat is-to">{numberOf.get(a.to_seat_id)}</span>
                </div>
              ))}
              {affectedMoves.map((a) => (
                <div key={a.student_id} className="move is-affected">
                  <span className="move-name">
                    {nameOf(a.student_id)}
                    <em>受影响</em>
                  </span>
                  <span className="move-seat">{numberOf.get(a.from_seat_id)}</span>
                  <Icon name="arrowRight" size={14} />
                  <span className="move-seat is-to">{numberOf.get(a.to_seat_id)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="swap-error">{d.plan.issues.map((i) => i.message).join('；')}</p>
          )
        ) : null}
      </div>

      <div className="swap-actions">
        <button type="button" className="btn btn-ghost" onClick={props.onDone}>
          取消
        </button>
        {d.step > 1 ? (
          <button type="button" className="btn btn-ghost" onClick={d.back}>
            <Icon name="chevronLeft" size={16} />
            上一步
          </button>
        ) : null}
        {d.step === 1 ? (
          <button type="button" className="btn btn-primary" disabled={d.sources.length === 0} onClick={d.next}>
            下一步
            <Icon name="chevronRight" size={16} />
          </button>
        ) : null}
        {d.step === 2 ? (
          <button type="button" className="btn btn-primary" disabled={!d.expansion?.ok || d.planning} onClick={() => void d.preview()}>
            {d.planning ? '计算中…' : '预览'}
          </button>
        ) : null}
        {d.step === 3 ? (
          <button type="button" className="btn btn-primary" disabled={!d.plan?.ok || write.disabled} onClick={() => void apply()}>
            <Icon name="check" size={16} />
            {write.pending ? '提交中…' : '确认换座'}
          </button>
        ) : null}
      </div>
    </div>
  );
}
