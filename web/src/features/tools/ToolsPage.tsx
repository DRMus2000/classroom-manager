import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { CountdownDto, RollcallDto } from '../../lib/types';
import { clock } from '../../lib/format';
import { useApp } from '../../hooks/useApp';
import { useWrite } from '../../hooks/useWrite';
import { useCountdown, useFinishChime, useRollcall } from '../../hooks/useClassroomTools';
import { Icon } from '../../components/Icon';
import { Modal, OfflineHint, Segmented } from '../../components/ui';

export function ToolsPage() {
  return (
    <div className="tools">
      <Rollcall />
      <Countdown />
    </div>
  );
}

function StudentPicker(props: {
  value: ReadonlySet<string>;
  onToggle: (id: string) => void;
  disabledIds?: ReadonlySet<string>;
  tone?: 'accent' | 'muted';
}) {
  const { roster } = useApp();
  return (
    <div className="picker">
      {roster.map((r) => {
        const on = props.value.has(r.student_id);
        const disabled = props.disabledIds?.has(r.student_id) ?? false;
        return (
          <button
            key={r.student_id}
            type="button"
            className={`picker-item ${on ? `is-on ${props.tone === 'muted' ? 'is-muted' : ''}` : ''}`}
            disabled={disabled}
            onClick={() => props.onToggle(r.student_id)}
          >
            <em>{r.seat_number}</em>
            {r.name}
          </button>
        );
      })}
    </div>
  );
}

function toggleIn(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

function Rollcall() {
  const { classId, roster, toast } = useApp();
  const { round, set } = useRollcall();
  const write = useWrite();
  const [scopeType, setScopeType] = useState<'all' | 'selected'>('all');
  const [scopeIds, setScopeIds] = useState<ReadonlySet<string>>(new Set());
  const [excludeIds, setExcludeIds] = useState<ReadonlySet<string>>(new Set());
  const [count, setCount] = useState(1);
  const [excludeOpen, setExcludeOpen] = useState(false);
  const [moreExclude, setMoreExclude] = useState<ReadonlySet<string>>(new Set());
  const [latest, setLatest] = useState(0);
  const [last, setLast] = useState<RollcallDto | null>(null);
  const prevPicked = useRef(0);

  useEffect(() => {
    const n = round?.picked.length ?? 0;
    if (n > prevPicked.current) setLatest(n - prevPicked.current);
    if (n === 0) setLatest(0);
    prevPicked.current = n;
  }, [round?.picked.length]);

  useEffect(() => {
    setScopeIds(new Set());
    setExcludeIds(new Set());
    setLast(null);
  }, [classId]);

  const pool = useMemo(() => {
    if (!round) {
      const base = scopeType === 'all' ? roster.map((r) => r.student_id) : [...scopeIds];
      return base.filter((id) => !excludeIds.has(id));
    }
    const inScope = round.scope.type === 'all' ? roster.map((r) => r.student_id) : round.scope.student_ids;
    const out = new Set([...round.exclude_student_ids, ...round.picked.map((p) => p.student_id)]);
    return inScope.filter((id) => !out.has(id) && roster.some((r) => r.student_id === id));
  }, [round, roster, scopeType, scopeIds, excludeIds]);

  async function open() {
    const body = {
      class_id: classId,
      scope: { type: scopeType, student_ids: scopeType === 'selected' ? [...scopeIds] : [] },
      exclude_student_ids: [...excludeIds],
    };
    const r = await write.run(body, (requestId) => api<RollcallDto>('/rollcall/rounds', { method: 'POST', body, requestId }));
    if (r) {
      set(r);
      setLast(null);
    }
  }

  async function draw() {
    if (!round) return;
    const body = { count };
    const r = await write.run(['draw', round.rollcall_id, round.picked.length, count], (requestId) =>
      api<RollcallDto>(`/rollcall/rounds/${round.rollcall_id}/draw`, { method: 'POST', body, requestId }),
    );
    if (r) set(r);
  }

  async function exclude() {
    if (!round || moreExclude.size === 0) return;
    const body = { student_ids: [...moreExclude] };
    const r = await write.run(['exclude', round.rollcall_id, body], (requestId) =>
      api<RollcallDto>(`/rollcall/rounds/${round.rollcall_id}/exclude`, { method: 'POST', body, requestId }),
    );
    if (r) {
      set(r);
      setExcludeOpen(false);
      setMoreExclude(new Set());
      toast({ tone: 'info', title: `已排除 ${body.student_ids.length} 人`, detail: '本轮不会再抽到' });
    }
  }

  async function close() {
    if (!round) return;
    const r = await write.run(['close', round.rollcall_id], (requestId) =>
      api<RollcallDto>(`/rollcall/rounds/${round.rollcall_id}/close`, { method: 'POST', body: {}, requestId }),
    );
    if (r) {
      setLast(r);
      set(null);
    }
  }

  const picked = round?.picked ?? [];
  const fresh = picked.slice(picked.length - latest);
  const earlier = picked.slice(0, picked.length - latest);
  const excludedSet = new Set(round?.exclude_student_ids ?? []);
  const pickedSet = new Set(picked.map((p) => p.student_id));

  return (
    <section className="card rollcall">
      <header className="card-head">
        <div>
          <h2>随机点名</h2>
          <p className="muted small">{round ? '本轮不重复，抽完后开启新一轮' : '临时排除缺席学生，与卫生无关'}</p>
        </div>
        <OfflineHint />
      </header>

      {!round ? (
        <div className="rollcall-setup">
          <div className="field">
            <span>点名范围</span>
            <Segmented
              value={scopeType}
              onChange={setScopeType}
              options={[
                { value: 'all', label: '全班' },
                { value: 'selected', label: '指定学生' },
              ]}
            />
          </div>
          {scopeType === 'selected' ? (
            <div className="field">
              <span>
                选择范围 <em className="muted">{scopeIds.size} 人</em>
              </span>
              <StudentPicker value={scopeIds} onToggle={(id) => setScopeIds((s) => toggleIn(s, id))} />
            </div>
          ) : null}
          <div className="field">
            <span>
              临时排除（缺席） <em className="muted">{excludeIds.size} 人</em>
            </span>
            <StudentPicker value={excludeIds} tone="muted" onToggle={(id) => setExcludeIds((s) => toggleIn(s, id))} />
          </div>
          {last && last.picked.length ? (
            <p className="muted small">上一轮抽到：{last.picked.map((p) => p.name).join('、')}</p>
          ) : null}
          <div className="rollcall-foot">
            <span className="pool-count">
              点名池 <strong>{pool.length}</strong> 人
            </span>
            <button type="button" className="btn btn-primary" disabled={write.disabled || pool.length === 0} onClick={() => void open()}>
              <Icon name="dice" size={16} />
              开始点名
            </button>
          </div>
        </div>
      ) : (
        <div className="rollcall-live">
          <div className="rollcall-stats">
            <span>
              剩余 <strong>{pool.length}</strong>
            </span>
            <span>
              已抽 <strong>{picked.length}</strong>
            </span>
            <span>
              排除 <strong>{round.exclude_student_ids.length}</strong>
            </span>
          </div>
          <div className={`stage ${fresh.length ? '' : 'is-idle'}`}>
            {fresh.length ? (
              fresh.map((p, i) => (
                <div key={`${p.student_id}-${picked.length}`} className="stage-card" style={{ animationDelay: `${i * 90}ms` }}>
                  <span className="stage-seat">{p.seat_number ?? '—'} 号</span>
                  <strong>{p.name || '匿名'}</strong>
                </div>
              ))
            ) : (
              <span className="muted">点击「抽取」开始</span>
            )}
          </div>
          {earlier.length ? (
            <div className="name-chips">
              {earlier.map((p) => (
                <span key={p.student_id} className="name-chip is-muted">
                  <em>{p.seat_number ?? '—'}</em>
                  {p.name}
                </span>
              ))}
            </div>
          ) : null}
          <div className="rollcall-foot">
            <div className="stepper-num" role="group" aria-label="抽取人数">
              <button type="button" onClick={() => setCount((c) => Math.max(1, c - 1))} aria-label="减少">
                <Icon name="minus" size={15} />
              </button>
              <span>{count} 人</span>
              <button type="button" onClick={() => setCount((c) => Math.min(Math.max(1, pool.length), c + 1))} aria-label="增加">
                <Icon name="plus" size={15} />
              </button>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" disabled={write.disabled} onClick={() => setExcludeOpen(true)}>
              <Icon name="userX" size={15} />
              临时排除
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={write.disabled} onClick={() => void close()}>
              结束本轮
            </button>
            <button type="button" className="btn btn-primary btn-lg" disabled={write.disabled || pool.length < count} onClick={() => void draw()}>
              <Icon name="dice" size={18} />
              抽取
            </button>
          </div>
          {pool.length === 0 ? <p className="muted small">本轮已抽完，请结束后开启新一轮。</p> : null}
        </div>
      )}

      <Modal
        open={excludeOpen}
        onClose={() => setExcludeOpen(false)}
        title="临时排除缺席学生"
        subtitle="只影响本轮点名，不影响卫生与积分"
        width={560}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setExcludeOpen(false)}>
              取消
            </button>
            <button type="button" className="btn btn-primary" disabled={moreExclude.size === 0 || write.disabled} onClick={() => void exclude()}>
              排除 {moreExclude.size} 人
            </button>
          </>
        }
      >
        <StudentPicker
          value={moreExclude}
          tone="muted"
          disabledIds={new Set([...excludedSet, ...pickedSet])}
          onToggle={(id) => setMoreExclude((s) => toggleIn(s, id))}
        />
      </Modal>
    </section>
  );
}

const PRESETS = [30, 60, 180, 300, 600];

function presetLabel(sec: number): string {
  return sec < 60 ? `${sec} 秒` : `${sec / 60} 分`;
}

function Countdown() {
  const { classId } = useApp();
  const cd = useCountdown();
  const write = useWrite();
  const [duration, setDuration] = useState(180);
  const [customMin, setCustomMin] = useState('');
  const [customSec, setCustomSec] = useState('');

  useEffect(() => {
    if (cd.duration) setDuration(cd.duration);
  }, [cd.duration]);

  const finished = cd.status === 'finished';
  useFinishChime(finished);

  async function command(action: 'start' | 'pause' | 'resume' | 'reset') {
    const body: { action: string; duration_sec?: number } = { action };
    if (action === 'start' || action === 'reset') body.duration_sec = duration;
    const r = await write.run([action, classId, body, cd.state?.updated_at], (requestId) =>
      api<CountdownDto>(`/countdown/${classId}`, { method: 'PUT', body, requestId }),
    );
    if (r) cd.set(r);
  }

  function applyCustom() {
    const total = (Number(customMin) || 0) * 60 + (Number(customSec) || 0);
    if (total >= 1 && total <= 86400) {
      setDuration(total);
      setCustomMin('');
      setCustomSec('');
    }
  }

  const shownSeconds = cd.status === 'reset' ? duration : cd.remaining ?? duration;
  const total = cd.status === 'reset' ? duration : cd.duration ?? duration;
  const progress = total > 0 ? Math.max(0, Math.min(1, shownSeconds / total)) : 0;
  const R = 88;
  const C = 2 * Math.PI * R;
  const editable = cd.status === 'reset' || cd.status === 'finished';

  return (
    <section className={`card countdown ${finished ? 'is-finished' : ''} is-${cd.status}`}>
      <header className="card-head">
        <div>
          <h2>倒计时</h2>
          <p className="muted small">展示屏同步显示，到时提示</p>
        </div>
      </header>
      <div className="ring">
        <svg viewBox="0 0 200 200" aria-hidden="true">
          <circle cx="100" cy="100" r={R} className="ring-track" />
          <circle
            cx="100"
            cy="100"
            r={R}
            className="ring-bar"
            strokeDasharray={C}
            strokeDashoffset={C * (1 - progress)}
            transform="rotate(-90 100 100)"
          />
        </svg>
        <div className="ring-center">
          <strong>{finished ? '时间到' : clock(shownSeconds)}</strong>
          <span>
            {cd.status === 'running' ? '进行中' : cd.status === 'paused' ? '已暂停' : finished ? clock(total) : '准备'}
          </span>
        </div>
      </div>

      <div className={`presets ${editable ? '' : 'is-locked'}`}>
        {PRESETS.map((p) => (
          <button key={p} type="button" className={`chip ${duration === p ? 'is-active' : ''}`} disabled={!editable} onClick={() => setDuration(p)}>
            {presetLabel(p)}
          </button>
        ))}
        <div className="custom-time">
          <input inputMode="numeric" placeholder="分" value={customMin} disabled={!editable} onChange={(e) => setCustomMin(e.target.value.replace(/\D/g, ''))} aria-label="分钟" />
          <span>:</span>
          <input inputMode="numeric" placeholder="秒" value={customSec} disabled={!editable} onChange={(e) => setCustomSec(e.target.value.replace(/\D/g, ''))} aria-label="秒" />
          <button type="button" className="chip" disabled={!editable || (!customMin && !customSec)} onClick={applyCustom}>
            设定
          </button>
        </div>
      </div>

      <div className="countdown-actions">
        {cd.status === 'running' ? (
          <button type="button" className="btn btn-primary btn-lg" disabled={write.disabled} onClick={() => void command('pause')}>
            <Icon name="pause" size={17} />
            暂停
          </button>
        ) : cd.status === 'paused' ? (
          <button type="button" className="btn btn-primary btn-lg" disabled={write.disabled} onClick={() => void command('resume')}>
            <Icon name="play" size={16} />
            继续
          </button>
        ) : (
          <button type="button" className="btn btn-primary btn-lg" disabled={write.disabled} onClick={() => void command('start')}>
            <Icon name="play" size={16} />
            开始 {clock(duration)}
          </button>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-lg"
          disabled={write.disabled || !cd.state || cd.state.duration_sec == null || cd.status === 'reset'}
          onClick={() => void command('reset')}
        >
          <Icon name="refresh" size={16} />
          重置
        </button>
      </div>
    </section>
  );
}
