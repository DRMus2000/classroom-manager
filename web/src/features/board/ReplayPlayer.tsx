import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import type { Page, RankRow, ReplayFrameDto, ReplayMode, ReplayStateDto, ReplayTimelineDto } from '../../lib/types';
import { beijingDay, beijingDayBoundary, formatDateTimeSeconds, rowName, timeMs } from '../../lib/format';
import { useApp } from '../../hooks/useApp';
import { useResource } from '../../hooks/useResource';
import { Icon } from '../../components/Icon';
import { EmptyState, Segmented, Spinner } from '../../components/ui';

const MAX_FRAMES = 2000;
const SPEEDS = [0.5, 1, 2, 4];
const PALETTE = ['#2cc1ad', '#4fb3e8', '#3fc98f', '#26a7c2', '#7f9cf0', '#139c8f', '#3a93d6', '#5fbf7a', '#56c3d6', '#8aa8e6'];

function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

interface Loaded {
  timeline: ReplayTimelineDto;
  frames: ReplayFrameDto[];
  start: RankRow[];
  truncated: boolean;
}

async function loadReplay(q: { term_id: string; class_id: string; from: string; to: string; mode: ReplayMode }): Promise<Loaded> {
  const [timeline, start] = await Promise.all([
    api<ReplayTimelineDto>('/replay/timeline', { query: q }),
    q.mode === 'cumulative'
      ? api<ReplayStateDto>('/replay/state-at', {
          query: { term_id: q.term_id, class_id: q.class_id, mode: q.mode, at: new Date(timeMs(q.from) - 1).toISOString() },
        }).then((s) => s.ranking)
      : Promise.resolve([] as RankRow[]),
  ]);
  const frames: ReplayFrameDto[] = [];
  let cursor: string | null = null;
  do {
    const page: Page<ReplayFrameDto> = await api<Page<ReplayFrameDto>>('/replay/frames', {
      query: { ...q, limit: 200, cursor: cursor ?? undefined },
    });
    frames.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor && frames.length < MAX_FRAMES);
  return { timeline, frames, start, truncated: cursor != null };
}

export function ReplayPlayer() {
  const { classId, currentTerm, terms, currentClass } = useApp();
  const [termId, setTermId] = useState('');
  const term = terms.find((t) => t.term_id === termId) ?? currentTerm;
  const [from, setFrom] = useState(() => (term ? beijingDay(term.started_at) : beijingDay()));
  const [to, setTo] = useState(() => beijingDay());
  const [mode, setMode] = useState<ReplayMode>('cumulative');
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  useEffect(() => {
    if (term) setFrom(beijingDay(term.started_at));
    if (term?.closed_at) setTo(beijingDay(term.closed_at));
    else setTo(beijingDay());
  }, [term?.term_id]);

  const query = term
    ? {
        term_id: term.term_id,
        class_id: classId,
        from: beijingDayBoundary(from, 'start'),
        to: beijingDayBoundary(to, 'end'),
        mode,
      }
    : null;
  const res = useResource(query ? () => loadReplay(query) : null, [query?.term_id, query?.class_id, query?.from, query?.to, query?.mode]);
  const data = res.data;
  const total = data?.frames.length ?? 0;

  useEffect(() => {
    setIndex(0);
    setPlaying(false);
  }, [data]);

  useEffect(() => {
    if (!playing) return;
    if (index >= total) {
      setPlaying(false);
      return;
    }
    const t = window.setTimeout(() => setIndex((i) => Math.min(total, i + 1)), 900 / speed);
    return () => window.clearTimeout(t);
  }, [playing, index, total, speed]);

  const frame = index > 0 ? data?.frames[index - 1] : undefined;
  const rows = frame ? frame.top10 : data?.start ?? [];
  const at = frame ? frame.occurred_at : query?.from;

  const density = useMemo(() => {
    if (!data || !query) return [];
    const start = timeMs(query.from);
    const end = timeMs(query.to);
    const max = Math.max(1, ...data.timeline.density.map((d) => d.frames));
    return data.timeline.density.map((d) => ({
      left: ((timeMs(d.at) - start) / Math.max(1, end - start)) * 100,
      height: (d.frames / max) * 100,
      frames: d.frames,
      at: d.at,
    }));
  }, [data, query?.from, query?.to]);
  const playhead = query && at ? ((timeMs(at) - timeMs(query.from)) / Math.max(1, timeMs(query.to) - timeMs(query.from))) * 100 : 0;

  const toggle = () => {
    if (index >= total) setIndex(0);
    setPlaying((p) => !p);
  };

  return (
    <section className="card replay">
      <header className="card-head replay-head">
        <div>
          <h2>{currentClass?.name} · 动态回放</h2>
          <p className="muted small">每个积分批次是一帧；按当时在班状态显示当时的 Top10</p>
        </div>
        <div className="replay-filters">
          <Segmented
            size="sm"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'cumulative', label: '学期累计' },
              { value: 'net', label: '区间净增减' },
            ]}
          />
          <label className="select-sm">
            <select value={term?.term_id ?? ''} onChange={(e) => setTermId(e.target.value)} aria-label="学期">
              {terms.map((t) => (
                <option key={t.term_id} value={t.term_id}>
                  {t.name}
                </option>
              ))}
            </select>
            <Icon name="chevronDown" size={14} />
          </label>
          <div className="date-range">
            <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} aria-label="开始日期" />
            <span>至</span>
            <input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} aria-label="结束日期" />
          </div>
        </div>
      </header>

      {res.loading && !data ? (
        <div className="page-loading">
          <Spinner />
        </div>
      ) : !data ? (
        <EmptyState icon="history" title="回放暂不可用" hint="请检查日期范围后重试。" />
      ) : (
        <>
          <div className="race-stage">
            <div className="race-clock">
              <strong>{at ? formatDateTimeSeconds(at) : ''}</strong>
              <span>
                {index === 0 ? '区间起点' : `第 ${index} / ${total} 帧`}
                {frame && frame.kind !== 'points_appended' ? ' · 名单变化' : ''}
              </span>
            </div>
            {rows.length === 0 ? (
              <div className="race-empty">{mode === 'net' && index === 0 ? '区间起点，净增减均为 0' : '此时没有在班学生'}</div>
            ) : (
              <BarRace rows={rows} duration={Math.min(700, (900 / speed) * 0.85)} />
            )}
          </div>

          <div className="player">
            <button type="button" className="play-btn" onClick={toggle} disabled={total === 0} aria-label={playing ? '暂停' : '播放'}>
              <Icon name={playing ? 'pause' : 'play'} size={18} />
            </button>
            <div className="scrub">
              <div className="density" aria-hidden="true">
                {density.map((d) => (
                  <span key={d.at} style={{ left: `${d.left}%`, height: `${Math.max(8, d.height)}%` }} />
                ))}
                <i style={{ left: `${Math.min(100, Math.max(0, playhead))}%` }} />
              </div>
              <input
                type="range"
                min={0}
                max={total}
                value={index}
                onChange={(e) => {
                  setPlaying(false);
                  setIndex(Number(e.target.value));
                }}
                aria-label="时间轴"
              />
            </div>
            <div className="speeds" role="group" aria-label="倍速">
              {SPEEDS.map((s) => (
                <button key={s} type="button" className={s === speed ? 'is-active' : ''} onClick={() => setSpeed(s)}>
                  {s}×
                </button>
              ))}
            </div>
          </div>
          {data.truncated ? <p className="muted small">事件较多，只加载了前 {MAX_FRAMES} 帧，可缩小日期范围。</p> : null}
          {total === 0 ? <p className="muted small">所选区间内没有积分变化。</p> : null}
        </>
      )}
    </section>
  );
}

const ROW_H = 44;

export function BarRace(props: { rows: RankRow[]; duration: number; large?: boolean }) {
  const values = props.rows.map((r) => r.balance);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || 1;
  const zero = (-min / span) * 100;
  const rowH = props.large ? 64 : ROW_H;

  return (
    <div className={`race ${props.large ? 'race-lg' : ''}`} style={{ height: props.rows.length * rowH, ['--dur' as string]: `${props.duration}ms` }}>
      <div className="race-zero" style={{ left: `calc(var(--race-label) + (100% - var(--race-label)) * ${zero / 100})` }} />
      {props.rows.map((row, i) => {
        const w = (Math.abs(row.balance) / span) * 100;
        const left = row.balance >= 0 ? zero : zero - w;
        return (
          <div key={row.student_id} className="race-row" style={{ transform: `translateY(${i * rowH}px)`, height: rowH }}>
            <span className="race-rank">{row.rank}</span>
            <span className="race-name">
              {rowName(row)}
              {row.anon_code && !row.name ? <em>匿名</em> : null}
            </span>
            <span className="race-track">
              <span
                className={`race-bar ${row.balance < 0 ? 'neg' : ''}`}
                style={{ left: `${left}%`, width: `${Math.max(w, 0.6)}%`, background: row.balance < 0 ? undefined : colorFor(row.student_id) }}
              />
              <span
                className="race-value"
                style={
                  row.balance >= 0
                    ? { left: `calc(${left + w}% + 8px)` }
                    : { left: `calc(${left}% - 8px)`, transform: 'translateX(-100%)' }
                }
              >
                {row.balance}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
