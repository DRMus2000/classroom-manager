import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import type { BatchResultDto, SeatCardDto } from '../../lib/types';
import { signed } from '../../lib/format';
import { useApp } from '../../hooks/useApp';
import { useWrite } from '../../hooks/useWrite';
import { SeatMap, type Flash, type ZoomMode } from '../../components/SeatMap';
import { Icon } from '../../components/Icon';
import { Segmented } from '../../components/ui';
import { SeatList } from './SeatList';
import { ScoreBar, type ScoreIntent } from './ScoreBar';
import { ScoreDialog } from './ScoreDialog';
import { SwapFlow, useSwapDraft } from './SwapFlow';
import { RecentDrawer } from './RecentDrawer';

type Mode = 'score' | 'swap';
type View = 'map' | 'list';

const VIEW_KEY = 'cm.classroom.view';
/** 手机上整间教室缩到屏宽后卡片太小，默认用可点按的比例，平移查看。 */
const PHONE_ZOOM = 0.72;

export function ClassroomPage() {
  const app = useApp();
  const { seats, marks, dutyBadges, currentTerm, toast, bump, nameOf } = app;
  const [mode, setMode] = useState<Mode>('score');
  const [view, setView] = useState<View>(() => (localStorage.getItem(VIEW_KEY) as View | null) ?? 'map');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [zoom, setZoom] = useState<ZoomMode>(() => (window.matchMedia('(max-width: 820px)').matches ? PHONE_ZOOM : 'fit'));
  const [resolvedZoom, setResolvedZoom] = useState(1);
  const [flashes, setFlashes] = useState<ReadonlyMap<string, Flash>>(new Map());
  const [confirm, setConfirm] = useState<ScoreIntent | null>(null);
  const [custom, setCustom] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const write = useWrite();
  const swap = useSwapDraft();

  const markMap = useMemo(() => new Map(marks.map((m) => [m.mark_id, m])), [marks]);
  const cards = seats?.cards ?? [];
  const studentIds = useMemo(() => cards.flatMap((c) => (c.student ? [c.student.student_id] : [])), [cards]);

  useEffect(() => {
    localStorage.setItem(VIEW_KEY, view);
  }, [view]);

  // 名单变化后剔除已不在座的选择。
  useEffect(() => {
    const present = new Set(studentIds);
    setSelected((prev) => {
      const next = [...prev].filter((id) => present.has(id));
      return next.length === prev.size ? prev : new Set(next);
    });
  }, [studentIds]);

  useEffect(() => {
    setSelected(new Set());
    setMode('score');
    swap.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.classId]);

  const clear = useCallback(() => setSelected(new Set()), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable]');
      if (typing || document.querySelector('.modal')) return;
      if (e.key === 'Escape') {
        if (mode === 'swap') swap.back();
        else clear();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && mode === 'score') {
        e.preventDefault();
        setSelected(new Set(studentIds));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, clear, studentIds, swap]);

  const columnIds = useCallback(
    (code: string) => cards.filter((c) => c.column_code === code && c.student).map((c) => c.student!.student_id),
    [cards],
  );

  const onSeatClick = useCallback(
    (card: SeatCardDto, additive: boolean) => {
      if (mode === 'swap') {
        swap.onSeat(card);
        return;
      }
      const id = card.student?.student_id;
      if (!id) {
        if (!additive) clear();
        return;
      }
      setSelected((prev) => {
        if (additive) {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        }
        if (prev.size === 1 && prev.has(id)) return new Set();
        return new Set([id]);
      });
    },
    [mode, swap, clear],
  );

  const onColumnClick = useCallback(
    (code: string, additive: boolean) => {
      const ids = columnIds(code);
      if (mode === 'swap') {
        swap.addSources(ids);
        return;
      }
      setSelected((prev) => {
        if (additive) return new Set([...prev, ...ids]);
        const same = ids.length === prev.size && ids.every((id) => prev.has(id));
        return same ? new Set() : new Set(ids);
      });
    },
    [mode, swap, columnIds],
  );

  const onBoxSelect = useCallback(
    (ids: string[], additive: boolean) => {
      if (mode === 'swap') {
        swap.addSources(ids);
        return;
      }
      setSelected((prev) => (additive ? new Set([...prev, ...ids]) : new Set(ids)));
    },
    [mode, swap],
  );

  const termWritable = currentTerm != null && currentTerm.status === 'open' && seats?.term_id === currentTerm.term_id;

  async function submitScore(intent: ScoreIntent, ids: readonly string[]) {
    if (!seats || ids.length === 0) return;
    const body = {
      term_id: seats.term_id,
      class_id: seats.class_id,
      student_ids: [...ids],
      delta: intent.delta,
      template_id: intent.template?.template_id ?? null,
      note: intent.note ?? null,
    };
    const result = await write.run(body, (requestId) =>
      api<BatchResultDto>('/points/batches', { method: 'POST', body, requestId }),
    );
    if (!result) return;
    setConfirm(null);
    setCustom(false);
    setSelected(new Set());
    const stamp = Date.now();
    setFlashes(new Map(result.entries.map((e) => [e.student_id, { delta: e.delta, key: stamp }])));
    window.setTimeout(() => setFlashes(new Map()), 1600);
    bump('seats', 'points');
    const who = result.entries.length === 1 ? nameOf(result.entries[0]!.student_id) : `${result.entries.length} 人`;
    toast({
      tone: 'success',
      title: `${who} ${signed(intent.delta)}`,
      detail: intent.template ? intent.template.effective_name : '未选原因',
      action: { label: '撤销', run: () => void reverseBatch(result.batch_id) },
    });
  }

  async function reverseBatch(batchId: string) {
    const result = await write.run(['reverse-batch', batchId], (requestId) =>
      api<BatchResultDto>(`/points/batches/${batchId}/reverse`, { method: 'POST', body: {}, requestId }),
    );
    if (!result) return;
    bump('seats', 'points');
    toast({ tone: 'info', title: `已撤销 ${result.entries.length} 条记分` });
  }

  function requestScore(intent: ScoreIntent) {
    if (selected.size === 1) void submitScore(intent, [...selected]);
    else setConfirm(intent);
  }

  if (!seats) {
    return <div className="page-loading">正在载入座位…</div>;
  }

  const showBar = mode === 'score' && selected.size > 0;
  const swapDecor = mode === 'swap' ? swap.decorate : undefined;
  const mapSeats = mode === 'swap' && swap.previewSeats ? swap.previewSeats : seats;
  const mapSelected = mode === 'swap' ? swap.sourceSet : selected;

  return (
    <div className={`classroom ${showBar || mode === 'swap' ? 'has-dock' : ''}`}>
      <div className="toolbar">
        <Segmented
          value={mode}
          onChange={(m) => {
            if (m === 'swap') swap.start([...selected]);
            else swap.reset();
            setSelected(new Set());
            setMode(m);
          }}
          options={[
            { value: 'score', label: '记分', icon: 'sparkle' },
            { value: 'swap', label: '换座', icon: 'swap' },
          ]}
          ariaLabel="操作模式"
        />
        {mode === 'swap' ? <div className="toolbar-hint">换座草稿只保存在本机，确认后才提交</div> : null}
        <span className="toolbar-spacer" />
        {mode === 'score' ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set(studentIds))}>
            <Icon name="select" size={16} />
            <span>全班</span>
          </button>
        ) : null}
        {view === 'map' ? (
          <div className="zoom" role="group" aria-label="缩放">
            <button type="button" className="icon-btn" aria-label="缩小" onClick={() => setZoom(Math.max(0.4, +(resolvedZoom - 0.1).toFixed(2)))}>
              <Icon name="zoomOut" size={17} />
            </button>
            <button
              type="button"
              className={`zoom-value ${typeof zoom === 'string' ? 'is-fit' : ''}`}
              onClick={() => {
                const phone = window.matchMedia('(max-width: 820px)').matches;
                if (!phone) setZoom('fit');
                else setZoom(zoom === 'fit-width' ? PHONE_ZOOM : 'fit-width');
              }}
              title="适应窗口"
            >
              {Math.round(resolvedZoom * 100)}%
            </button>
            <button type="button" className="icon-btn" aria-label="放大" onClick={() => setZoom(Math.min(1.6, +(resolvedZoom + 0.1).toFixed(2)))}>
              <Icon name="zoomIn" size={17} />
            </button>
          </div>
        ) : null}
        <Segmented
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: 'map', label: '座位图', icon: 'grid' },
            { value: 'list', label: '列表', icon: 'list' },
          ]}
          ariaLabel="视图"
        />
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDrawer(true)}>
          <Icon name="history" size={16} />
          <span className="hide-sm">记录</span>
        </button>
      </div>

      {view === 'map' ? (
        <SeatMap
          seats={mapSeats}
          selected={mapSelected}
          marks={markMap}
          duty={dutyBadges}
          flashes={flashes}
          decorate={swapDecor}
          zoom={zoom}
          onZoomResolved={setResolvedZoom}
          onSeatClick={mode === 'swap' && swap.step === 3 ? undefined : onSeatClick}
          onColumnClick={mode === 'score' || swap.step === 1 ? onColumnClick : undefined}
          onBoxSelect={mode === 'score' || swap.step === 1 ? onBoxSelect : undefined}
          onBlankClick={mode === 'score' ? clear : undefined}
        />
      ) : (
        <SeatList
          seats={mapSeats}
          selected={mapSelected}
          marks={markMap}
          duty={dutyBadges}
          decorate={swapDecor}
          flashes={flashes}
          onSeatClick={mode === 'swap' && swap.step === 3 ? undefined : (card) => onSeatClick(card, true)}
        />
      )}

      {mode === 'score' && !showBar ? (
        <div className="dock dock-idle" aria-hidden="true">
          <Icon name="sparkle" size={16} />
          <span>
            <strong>选择学生后在这里记分</strong>
            单击选择 · Ctrl 增减 · 拖动框选 · 点列号选整列 · Ctrl+A 全班 · Esc 取消
          </span>
        </div>
      ) : null}

      {showBar ? (
        <ScoreBar
          count={selected.size}
          names={[...selected].slice(0, 4).map(nameOf)}
          disabled={write.disabled || !termWritable}
          disabledReason={!termWritable ? '当前学期不可写入' : undefined}
          onScore={requestScore}
          onCustom={() => setCustom(true)}
          onClear={clear}
        />
      ) : null}

      {mode === 'swap' ? (
        <SwapFlow
          draft={swap}
          onDone={() => {
            setMode('score');
            swap.reset();
          }}
        />
      ) : null}

      <ScoreDialog
        open={custom || confirm != null}
        count={selected.size}
        names={[...selected].map(nameOf)}
        preset={confirm}
        pending={write.pending}
        disabled={write.disabled || !termWritable}
        onClose={() => {
          setCustom(false);
          setConfirm(null);
        }}
        onSubmit={(intent) => void submitScore(intent, [...selected])}
      />

      <RecentDrawer open={drawer} onClose={() => setDrawer(false)} />
    </div>
  );
}
