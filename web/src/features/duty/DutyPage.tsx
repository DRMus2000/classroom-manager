import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import type { DutyCorrectResult, DutyMemberDto, DutySelectionDto } from '../../lib/types';
import { formatTime, initial } from '../../lib/format';
import { useApp } from '../../hooks/useApp';
import { useResource } from '../../hooks/useResource';
import { useWrite } from '../../hooks/useWrite';
import { Icon } from '../../components/Icon';
import { EmptyState, Modal, OfflineHint } from '../../components/ui';
import { CorrectDialog } from './CorrectDialog';

const PHASES = [
  { id: 'marking', label: '登记与计次', hint: '勾选实际打扫，达标者自动退役' },
  { id: 'freeze', label: '冻结候选', hint: '锁定本轮可被替补的原管理员' },
  { id: 'substituting', label: '抽选替补', hint: '逐个录入新发现的未推椅子学生' },
  { id: 'closed', label: '结束本轮', hint: '新任者下一轮开始值日' },
] as const;

function memberState(m: DutyMemberDto): { label: string; tone: string }[] {
  const tags: { label: string; tone: string }[] = [];
  if (m.term_status === 'retired') tags.push({ label: '已退役', tone: 'done' });
  if (m.term_status === 'released') tags.push({ label: '已解除', tone: 'muted' });
  if (m.counted_round) tags.push({ label: '已打扫', tone: 'ok' });
  if (m.no_push) tags.push({ label: '再次未推椅子', tone: 'warn' });
  if (!m.attended && !m.eligible_for_backfill && !m.no_push && !m.counted_round) tags.push({ label: '未参加 · 义务 +1', tone: 'bad' });
  return tags;
}

export function isCandidate(m: DutyMemberDto): boolean {
  return m.is_original && m.attended && m.term_status === 'active' && m.eligible_for_backfill && !m.no_push;
}

export function DutyPage() {
  const { duty, classId, roster, nameOf, dutyBadges, bump, toast, currentClass } = useApp();
  const write = useWrite();
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [newcomer, setNewcomer] = useState('');
  const [correcting, setCorrecting] = useState<{ duty_term_id: string; student_id: string; completed: number; required: number; status: string } | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [absentFor, setAbsentFor] = useState<DutyMemberDto | null>(null);

  const round = duty?.round ?? null;
  const open = duty?.open_selection ?? null;
  const seatOf = useMemo(() => new Map(roster.map((r) => [r.student_id, r.seat_number])), [roster]);

  const selection = useResource(
    open ? () => api<DutySelectionDto>(`/duty/selections/${open.selection_id}`) : null,
    [open?.selection_id, open?.status],
  );

  useEffect(() => {
    setChecked(new Set());
  }, [round?.round_id, round?.version]);

  const originals = (round?.members ?? [])
    .filter((m) => m.is_original)
    .sort((a, b) => (seatOf.get(a.student_id) ?? 0) - (seatOf.get(b.student_id) ?? 0));
  const candidates = originals.filter(isCandidate);
  const phaseIndex = !round ? -1 : round.phase === 'marking' ? 0 : 2;
  const busy = write.disabled;

  const eligibleNewcomers = roster.filter((r) => !dutyBadges.has(r.student_id));

  async function send<T>(intent: unknown, path: string, body: Record<string, unknown>) {
    const result = await write.run(intent, (requestId) => api<T>(path, { method: 'POST', body, requestId }));
    if (result !== undefined) bump('duty');
    return result;
  }

  async function startRound() {
    const r = await send<{ member_count: number }>(['start', classId], `/classes/${classId}/duty/rounds`, { expected_version: 0 });
    if (r) toast({ tone: 'success', title: '本轮检查已开始', detail: `原管理员 ${r.member_count} 人` });
  }

  async function markAttendance() {
    if (!round || checked.size === 0) return;
    const ids = [...checked];
    const body = { duty_term_ids: ids, expected_version: round.version };
    const r = await send(['attendance', round.round_id, body], `/duty/rounds/${round.round_id}/attendance`, body);
    if (r) toast({ tone: 'success', title: `已为 ${ids.length} 人计次`, detail: '达到应完成次数的人已自动退役' });
  }

  async function markNoPush(m: DutyMemberDto) {
    if (!round) return;
    const body = { student_ids: [m.student_id], expected_version: round.version };
    const r = await send(['no-push', round.round_id, body], `/duty/rounds/${round.round_id}/no-push`, body);
    if (r) toast({ tone: 'info', title: `${nameOf(m.student_id)} 本轮失去替补资格`, detail: '任期与完成次数保留' });
  }

  async function confirmAbsent(m: DutyMemberDto) {
    if (!round || !m.duty_term_id) return;
    const body = { duty_term_id: m.duty_term_id, expected_version: round.version };
    const r = await send<{ before_required: number; after_required: number }>(
      ['absent', round.round_id, body],
      `/duty/rounds/${round.round_id}/absent-confirmed`,
      body,
    );
    setAbsentFor(null);
    if (r) {
      toast({
        tone: 'info',
        title: `${nameOf(m.student_id)} 应完成次数 ${r.before_required} → ${r.after_required}`,
      });
    }
  }

  async function freeze() {
    if (!round) return;
    const body = { expected_version: round.version };
    const r = await send<{ candidates: unknown[] }>(['freeze', round.round_id, round.version], `/duty/rounds/${round.round_id}/candidates/freeze`, body);
    if (r) toast({ tone: 'success', title: `候选已冻结：${r.candidates.length} 人`, detail: r.candidates.length ? undefined : '候选为空，后续发现的学生将直接新任' });
  }

  async function draw() {
    if (!round || !newcomer) return;
    const body = { student_id: newcomer, expected_version: round.version };
    const r = await send<DutySelectionDto>(['draw', round.round_id, body], `/duty/rounds/${round.round_id}/selections`, body);
    if (!r) return;
    setNewcomer('');
    if (r.outcome === 'direct_appoint') {
      toast({ tone: 'success', title: `${nameOf(r.new_student_id)} 直接新任卫生管理员`, detail: '候选已用尽；下一轮开始值日' });
    }
  }

  async function selectionAction(action: 'cancel' | 'reopen' | 'confirm') {
    if (!round || !open) return;
    const body = { expected_version: round.version };
    const r = await send<DutySelectionDto>([action, open.selection_id, round.version], `/duty/selections/${open.selection_id}/${action}`, body);
    if (r && action === 'confirm') {
      const picked = selection.data?.picked[0];
      toast({
        tone: 'success',
        title: `${nameOf(open.new_student_id)} 成为新任管理员`,
        detail: picked ? `${nameOf(picked.student_id)} 已退役；新任者下一轮开始值日` : undefined,
      });
    }
  }

  async function closeRound() {
    if (!round) return;
    const body = { expected_version: round.version };
    const r = await send(['close', round.round_id, round.version], `/duty/rounds/${round.round_id}/close`, body);
    setConfirmClose(false);
    if (r) toast({ tone: 'success', title: `第 ${round.seq_no} 轮检查已结束` });
  }

  async function correct(input: { action: 'release' | 'restore' | 'adjust_count'; note: string; completed_count?: number; required_count?: number }) {
    if (!round || !correcting) return;
    const body = { ...input, expected_version: round.version };
    const r = await send<DutyCorrectResult>(['correct', correcting.duty_term_id, body], `/duty/terms/${correcting.duty_term_id}/correct`, body);
    if (!r) return;
    setCorrecting(null);
    toast({
      tone: r.invalidated_selection_id ? 'error' : 'success',
      title: `已纠正：${r.before.completed_count}/${r.before.required_count} → ${r.after.completed_count}/${r.after.required_count}`,
      detail: r.invalidated_selection_id ? '被纠正者是待确认抽选的结果，该抽选已作废并释放候选' : undefined,
    });
  }

  if (!duty) return <div className="page-loading">正在载入卫生状态…</div>;

  const standing = [
    ...duty.active_terms.map((t) => ({ ...t, upcoming: false })),
    ...duty.next_appointees.map((t) => ({ ...t, completed_count: 0, required_count: 3, upcoming: true })),
  ];
  const peopleCount = round ? originals.length : standing.length;

  return (
    <div className="duty">
      <section className="card duty-hero">
        <div className="duty-hero-title">
          <span className="duty-icon">
            <Icon name="broom" size={22} />
          </span>
          <div>
            <h1>{round ? `第 ${round.seq_no} 轮卫生检查` : '卫生管理员'}</h1>
            <p className="muted">
              {currentClass?.name}
              {round?.frozen_at ? ` · ${formatTime(round.frozen_at)} 冻结候选` : ''}
              {' · 卫生操作不影响积分'}
            </p>
          </div>
          <OfflineHint />
        </div>
        <ol className="phases">
          {PHASES.map((p, i) => {
            const state = phaseIndex < 0 ? '' : i < phaseIndex ? 'is-done' : i === phaseIndex ? 'is-current' : '';
            return (
              <li key={p.id} className={state}>
                <span className="phase-dot">{state === 'is-done' ? <Icon name="check" size={12} strokeWidth={3} /> : i + 1}</span>
                <div>
                  <strong>{p.label}</strong>
                  <span>{p.hint}</span>
                </div>
              </li>
            );
          })}
        </ol>
        <div className="duty-hero-actions">
          {!round ? (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void startRound()}>
              <Icon name="flag" size={16} />
              开始新一轮检查
            </button>
          ) : round.phase === 'marking' ? (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void freeze()}>
              <Icon name="snow" size={16} />
              冻结候选（{candidates.length} 人）
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy || open != null}
              title={open ? '还有未确认的抽选，先确认或处理后再结束' : undefined}
              onClick={() => setConfirmClose(true)}
            >
              结束本轮
            </button>
          )}
        </div>
      </section>

      <div className="duty-grid">
        <section className="card">
          <header className="card-head">
            <h2>{round ? '本轮值日人员' : '在任管理员'}</h2>
            <span className="muted small">{round ? '开轮时冻结的原管理员名单' : `${peopleCount} 人`}</span>
          </header>
          {peopleCount === 0 ? (
            <EmptyState icon="broom" title="暂无卫生管理员" hint={round ? '本轮开始时没有在任的原管理员。' : '抽选替补或直接新任后会出现在这里。'} />
          ) : (
            <ul className="members">
              {round
                ? originals.map((m) => {
                    const canCount = !m.counted_round && m.term_status === 'active' && m.duty_term_id != null;
                    const isChecked = m.duty_term_id != null && checked.has(m.duty_term_id);
                    const absent = !m.attended && !m.eligible_for_backfill && !m.no_push && !m.counted_round;
                    return (
                      <li key={m.student_id} className={`member ${m.term_status !== 'active' ? 'is-retired' : ''} ${isCandidate(m) ? 'is-candidate' : ''}`}>
                        <label className={`member-check ${canCount ? '' : 'is-disabled'}`}>
                          <input
                            type="checkbox"
                            disabled={!canCount || busy}
                            checked={isChecked || m.counted_round}
                            onChange={() => {
                              if (!m.duty_term_id) return;
                              setChecked((prev) => {
                                const next = new Set(prev);
                                if (next.has(m.duty_term_id!)) next.delete(m.duty_term_id!);
                                else next.add(m.duty_term_id!);
                                return next;
                              });
                            }}
                            aria-label={`${nameOf(m.student_id)} 实际参加打扫`}
                          />
                          <span className="checkbox" />
                        </label>
                        <span className="avatar avatar-amber">{initial(nameOf(m.student_id))}</span>
                        <div className="member-main">
                          <strong>
                            {nameOf(m.student_id)}
                            <em>{seatOf.get(m.student_id) ?? '—'} 号</em>
                          </strong>
                          <div className="tags">
                            {memberState(m).map((t) => (
                              <span key={t.label} className={`tag tag-${t.tone}`}>
                                {t.label}
                              </span>
                            ))}
                          </div>
                        </div>
                        <Progress done={m.completed_count} need={m.required_count} />
                        <div className="member-actions">
                          <button type="button" className="chip chip-sm" disabled={busy || m.no_push} onClick={() => void markNoPush(m)}>
                            未推椅子
                          </button>
                          <button
                            type="button"
                            className="chip chip-sm"
                            disabled={busy || absent || m.counted_round || !m.duty_term_id}
                            onClick={() => setAbsentFor(m)}
                          >
                            未参加
                          </button>
                          <button
                            type="button"
                            className="icon-btn"
                            disabled={busy || !m.duty_term_id}
                            aria-label="人工纠正"
                            title="人工纠正"
                            onClick={() =>
                              setCorrecting({
                                duty_term_id: m.duty_term_id!,
                                student_id: m.student_id,
                                completed: m.completed_count,
                                required: m.required_count,
                                status: m.term_status,
                              })
                            }
                          >
                            <Icon name="pen" size={15} />
                          </button>
                        </div>
                      </li>
                    );
                  })
                : standing.map((p) => (
                    <li key={p.duty_term_id} className="member member-plain">
                      <span className="avatar avatar-amber">{initial(nameOf(p.student_id))}</span>
                      <div className="member-main">
                        <strong>
                          {nameOf(p.student_id)}
                          <em>{seatOf.get(p.student_id) ?? '—'} 号</em>
                        </strong>
                        <div className="tags">{p.upcoming ? <span className="tag tag-new">下一轮开始</span> : null}</div>
                      </div>
                      <Progress done={Number(p.completed_count)} need={Number(p.required_count)} />
                    </li>
                  ))}
            </ul>
          )}
          {round && checked.size > 0 ? (
            <footer className="card-foot">
              <span>已勾选 {checked.size} 人实际参加打扫</span>
              <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void markAttendance()}>
                <Icon name="check" size={15} />
                计次
              </button>
            </footer>
          ) : null}
        </section>

        <div className="duty-side">
          {round ? (
            <section className="card">
              <header className="card-head">
                <h2>{round.phase === 'marking' ? '候选预览' : '替补候选池'}</h2>
                <span className="muted small">{round.phase === 'marking' ? '冻结后不再变化' : '不放回随机抽取'}</span>
              </header>
              {candidates.length ? (
                <div className="name-chips">
                  {candidates.map((m) => (
                    <span key={m.student_id} className="name-chip">
                      <em>{seatOf.get(m.student_id) ?? '—'}</em>
                      {nameOf(m.student_id)}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="muted small">没有符合条件的原管理员：需已打扫、仍在任、本轮有替补资格。</p>
              )}

              {round.phase === 'substituting' ? (
                open ? (
                  <SelectionCard
                    selection={selection.data}
                    status={open.status}
                    newStudent={nameOf(open.new_student_id)}
                    nameOf={nameOf}
                    busy={busy}
                    onAction={(a) => void selectionAction(a)}
                  />
                ) : (
                  <div className="draw">
                    <label className="field">
                      <span>录入新发现的未推椅子学生</span>
                      <select value={newcomer} onChange={(e) => setNewcomer(e.target.value)}>
                        <option value="">选择学生…</option>
                        {eligibleNewcomers.map((r) => (
                          <option key={r.student_id} value={r.student_id}>
                            {r.seat_number} 号 · {r.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button type="button" className="btn btn-primary btn-block" disabled={busy || !newcomer} onClick={() => void draw()}>
                      <Icon name="dice" size={16} />
                      {candidates.length ? '抽选替补' : '直接新任'}
                    </button>
                  </div>
                )
              ) : (
                <p className="muted small duty-note">勾选完打扫情况后冻结候选，才能开始抽选替补。</p>
              )}
            </section>
          ) : null}

          <section className="card">
            <header className="card-head">
              <h2>下一轮新任人员</h2>
              <span className="muted small">本轮不计次、不进候选</span>
            </header>
            {duty.next_appointees.length ? (
              <ul className="simple-list">
                {duty.next_appointees.map((n) => (
                  <li key={n.duty_term_id}>
                    <span className="avatar avatar-amber">{initial(nameOf(n.student_id))}</span>
                    <span>{nameOf(n.student_id)}</span>
                    <span className="muted small">{seatOf.get(n.student_id) ?? '—'} 号 · 0/3</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">暂无</p>
            )}
          </section>
        </div>
      </div>

      <Modal
        open={absentFor != null}
        onClose={() => setAbsentFor(null)}
        title="确认应值日却未参加？"
        subtitle={absentFor ? nameOf(absentFor.student_id) : undefined}
        width={420}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setAbsentFor(null)}>
              取消
            </button>
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => absentFor && void confirmAbsent(absentFor)}>
              应完成次数 +1
            </button>
          </>
        }
      >
        {absentFor ? (
          <p>
            应完成次数将从 <strong>{absentFor.required_count}</strong> 变为 <strong>{absentFor.required_count + 1}</strong>
            （{absentFor.completed_count}/{absentFor.required_count} → {absentFor.completed_count}/{absentFor.required_count + 1}）。本轮不计完成次数，也不能被替补。同一轮只能登记一次。
          </p>
        ) : null}
      </Modal>

      <Modal
        open={confirmClose}
        onClose={() => setConfirmClose(false)}
        title="结束本轮检查？"
        width={420}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmClose(false)}>
              取消
            </button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void closeRound()}>
              结束本轮
            </button>
          </>
        }
      >
        <p>结束后不能再录入本轮的未推椅子学生。下一轮新任人员会在开始下一轮时正式值日。</p>
      </Modal>

      <CorrectDialog
        target={correcting}
        name={correcting ? nameOf(correcting.student_id) : ''}
        busy={busy}
        onClose={() => setCorrecting(null)}
        onSubmit={(input) => void correct(input)}
      />
    </div>
  );
}

function Progress(props: { done: number; need: number }) {
  const dots = Math.max(props.need, props.done);
  return (
    <div className="progress" title={`完成 ${props.done} / 应完成 ${props.need}`}>
      <div className="progress-dots">
        {Array.from({ length: Math.min(dots, 8) }, (_, i) => (
          <span key={i} className={i < props.done ? 'is-on' : i >= props.need ? 'is-extra' : ''} />
        ))}
      </div>
      <strong>
        {props.done}/{props.need}
      </strong>
    </div>
  );
}

function SelectionCard(props: {
  selection: DutySelectionDto | null;
  status: string;
  newStudent: string;
  nameOf: (id: string) => string;
  busy: boolean;
  onAction: (a: 'cancel' | 'reopen' | 'confirm') => void;
}) {
  const picked = props.selection?.picked[0];
  const cancelled = props.status === 'cancelled';
  return (
    <div className={`selection ${cancelled ? 'is-cancelled' : ''}`}>
      <span className="selection-kicker">{cancelled ? '预览已关闭 · 结果已保留' : '抽选结果 · 待确认'}</span>
      <div className="selection-swap">
        <div>
          <span className="avatar avatar-amber avatar-lg">{picked ? initial(props.nameOf(picked.student_id)) : '·'}</span>
          <strong>{picked ? props.nameOf(picked.student_id) : '…'}</strong>
          <span className="muted small">原管理员 · 将退役</span>
        </div>
        <Icon name="arrowRight" size={20} />
        <div>
          <span className="avatar avatar-lg">{initial(props.newStudent)}</span>
          <strong>{props.newStudent}</strong>
          <span className="muted small">新任 · 下一轮开始</span>
        </div>
      </div>
      <p className="muted small">
        拟由 {props.newStudent} 接替原管理员 {picked ? props.nameOf(picked.student_id) : '…'}。结果保存在服务器，关闭后再次打开仍是同一人。
      </p>
      <div className="selection-actions">
        {cancelled ? (
          <button type="button" className="btn btn-primary btn-block" disabled={props.busy} onClick={() => props.onAction('reopen')}>
            重新打开预览
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-ghost" disabled={props.busy} onClick={() => props.onAction('cancel')}>
              关闭预览
            </button>
            <button type="button" className="btn btn-primary" disabled={props.busy} onClick={() => props.onAction('confirm')}>
              <Icon name="check" size={15} />
              确认替补
            </button>
          </>
        )}
      </div>
    </div>
  );
}
