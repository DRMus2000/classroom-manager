import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { Page, RankRow } from '../../lib/types';
import { clock, formatTime, rowName } from '../../lib/format';
import { useApp } from '../../hooks/useApp';
import { useResource } from '../../hooks/useResource';
import { useCountdown, useFinishChime, useRollcall } from '../../hooks/useClassroomTools';
import { SeatMap } from '../../components/SeatMap';
import { Icon } from '../../components/Icon';
import { Logo } from '../../components/Logo';
import { Segmented } from '../../components/ui';
import { SyncStatus } from '../../components/SyncStatus';

type View = 'seats' | 'board' | 'rollcall';

/**
 * 全屏展示：已登录页面的一种布局。只显示座位号与姓名，不渲染备注、标记与任何管理入口。
 */
export function ScreenPage(props: { onExit: () => void }) {
  const { seats, currentClass, dutyBadges, classes, classId, setClassId, currentTerm, tick } = useApp();
  const [view, setView] = useState<View>('seats');
  const [now, setNow] = useState(() => new Date());
  const [isFull, setIsFull] = useState(() => document.fullscreenElement != null);
  const { round, loaded } = useRollcall();
  const cd = useCountdown();
  const pickedCount = round?.picked.length ?? 0;
  const prevPicked = useRef<number | null>(null);

  useFinishChime(cd.status === 'finished');

  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 15_000);
    const onFs = () => setIsFull(document.fullscreenElement != null);
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      window.clearInterval(t);
      document.removeEventListener('fullscreenchange', onFs);
    };
  }, []);

  // 只在展示期间新抽到人时切到点名；首次载入已有结果不打断当前视图。
  useEffect(() => {
    if (!loaded) return;
    if (prevPicked.current != null && pickedCount > prevPicked.current) setView('rollcall');
    prevPicked.current = pickedCount;
  }, [pickedCount, loaded]);

  const board = useResource(
    currentTerm && view === 'board'
      ? () => api<Page<RankRow>>('/leaderboard', { query: { term_id: currentTerm.term_id, class_id: classId } })
      : null,
    [currentTerm?.term_id, classId, view, tick('points')],
  );

  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => undefined);
  };

  const exit = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    props.onExit();
  };

  const showClock = cd.state && cd.status !== 'reset';

  return (
    <div className="screen">
      <header className="screen-bar">
        <div className="screen-title">
          <Logo size={30} />
          <label className="screen-class">
            <strong>{currentClass?.name}</strong>
            <Icon name="chevronDown" size={16} />
            <select value={classId} onChange={(e) => setClassId(e.target.value)} aria-label="切换班级">
              {classes.map((c) => (
                <option key={c.class_id} value={c.class_id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <span className="screen-time">{formatTime(now)}</span>
        </div>
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: 'seats', label: '座位', icon: 'seat' },
            { value: 'board', label: '榜单', icon: 'trophy' },
            { value: 'rollcall', label: '点名', icon: 'dice' },
          ]}
        />
        <div className="screen-tools">
          <SyncStatus />
          <button type="button" className="icon-btn" onClick={toggleFull} aria-label={isFull ? '退出全屏' : '全屏'} title={isFull ? '退出全屏' : '全屏'}>
            <Icon name={isFull ? 'fit' : 'maximize'} />
          </button>
          <button type="button" className="icon-btn" onClick={exit} aria-label="退出展示" title="退出展示">
            <Icon name="x" />
          </button>
        </div>
      </header>

      <main className={`screen-body screen-view-${view}`}>
        {view === 'seats' ? (
          seats ? (
            <SeatMap seats={seats} variant="screen" duty={dutyBadges} zoom="fit" showScores={false} />
          ) : null
        ) : view === 'board' ? (
          <ScreenBoard rows={board.data?.items ?? []} />
        ) : (
          <ScreenRollcall picked={round?.picked ?? []} open={round != null} />
        )}
      </main>

      {showClock ? (
        <div className={`screen-clock is-${cd.status}`}>
          <Icon name={cd.status === 'finished' ? 'bell' : 'timer'} size={26} />
          <strong>{cd.status === 'finished' ? '时间到' : clock(cd.remaining ?? 0)}</strong>
          {cd.status === 'paused' ? <span>已暂停</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function ScreenBoard(props: { rows: RankRow[] }) {
  const podium = props.rows.filter((r) => r.rank <= 3).slice(0, 3);
  const rest = props.rows.slice(podium.length, 15);
  if (props.rows.length === 0) return <div className="screen-empty">还没有上榜的学生</div>;
  const order = [podium[1], podium[0], podium[2]].filter(Boolean) as RankRow[];
  return (
    <div className="screen-board">
      <div className="podium-stage">
        {order.map((r) => (
          <div key={r.student_id} className={`podium-col place-${Math.min(3, r.rank)}`}>
            <span className="podium-name">{rowName(r)}</span>
            <span className="podium-score">{r.balance}</span>
            <div className="podium-block">
              <span>{r.rank}</span>
            </div>
          </div>
        ))}
      </div>
      <ol className="screen-ranks">
        {rest.map((r) => (
          <li key={r.student_id}>
            <span className="rank-no">{r.rank}</span>
            <strong>{rowName(r)}</strong>
            <span className={`rank-score ${r.balance < 0 ? 'neg' : ''}`}>{r.balance}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ScreenRollcall(props: { picked: { student_id: string; name: string; seat_number: number | null }[]; open: boolean }) {
  const prev = useRef(props.picked.length);
  const [latest, setLatest] = useState(0);
  useEffect(() => {
    if (props.picked.length > prev.current) setLatest(props.picked.length - prev.current);
    prev.current = props.picked.length;
  }, [props.picked.length]);

  if (!props.open || props.picked.length === 0) {
    return (
      <div className="screen-empty">
        <Icon name="dice" size={48} />
        <span>{props.open ? '等待抽取…' : '暂无进行中的点名'}</span>
      </div>
    );
  }
  const fresh = props.picked.slice(props.picked.length - Math.max(1, latest));
  const earlier = props.picked.slice(0, props.picked.length - fresh.length);
  return (
    <div className="screen-roll">
      <div className="screen-roll-fresh">
        {fresh.map((p, i) => (
          <div key={`${p.student_id}-${props.picked.length}`} className="screen-roll-card" style={{ animationDelay: `${i * 120}ms` }}>
            <span>{p.seat_number ?? '—'} 号</span>
            <strong>{p.name || '匿名'}</strong>
          </div>
        ))}
      </div>
      {earlier.length ? (
        <div className="screen-roll-earlier">
          <span>本轮已抽</span>
          {earlier.map((p) => (
            <em key={p.student_id}>
              {p.seat_number ?? '—'} {p.name}
            </em>
          ))}
        </div>
      ) : null}
    </div>
  );
}
