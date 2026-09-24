import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { BatchResultDto, Page, TimelineEventDto } from '../../lib/types';
import { formatDateTime, signed } from '../../lib/format';
import { useApp } from '../../hooks/useApp';
import { useResource } from '../../hooks/useResource';
import { useWrite } from '../../hooks/useWrite';
import { Icon } from '../../components/Icon';
import { EmptyState, OfflineHint, Spinner } from '../../components/ui';

const COLLAPSED = 6;

/** 本班当前学期的记分流水。撤销只插入反向明细，已撤销的明细不能再撤。 */
export function RecentDrawer(props: { open: boolean; onClose: () => void }) {
  const { classId, currentTerm, tick, bump, toast, currentClass } = useApp();
  const write = useWrite();
  const termId = currentTerm?.term_id;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const res = useResource(
    props.open && termId
      ? () =>
          api<Page<TimelineEventDto>>('/points/entries', {
            query: { class_id: classId, term_id: termId, limit: 200, include_reversals: 'true' },
          })
      : null,
    [props.open, classId, termId, tick('points')],
  );

  useEffect(() => {
    if (!props.open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.open, props.onClose]);

  async function undo(kind: 'batch' | 'entry', id: string) {
    const result = await write.run([kind, id], (requestId) =>
      api<BatchResultDto>(`/points/${kind === 'batch' ? 'batches' : 'entries'}/${id}/reverse`, {
        method: 'POST',
        body: {},
        requestId,
      }),
    );
    if (!result) return;
    bump('seats', 'points');
    toast({
      tone: 'info',
      title: kind === 'batch' ? `已撤销整批，冲销 ${result.entries.length} 条` : '已撤销 1 条记分',
      detail: result.undo.already_reversed_count ? `其中 ${result.undo.already_reversed_count} 条此前已撤销，未重复冲销` : undefined,
    });
  }

  if (!props.open) return null;
  const items = res.data?.items ?? [];

  return (
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <aside className="drawer" role="dialog" aria-label="记分记录">
        <header className="drawer-head">
          <div>
            <h2>记分记录</h2>
            <p className="muted">
              {currentClass?.name} · {currentTerm?.name}
            </p>
          </div>
          <OfflineHint />
          <button type="button" className="icon-btn" onClick={props.onClose} aria-label="关闭">
            <Icon name="x" />
          </button>
        </header>
        <div className="drawer-body">
          {res.loading && !res.data ? (
            <div className="page-loading">
              <Spinner />
            </div>
          ) : items.length === 0 ? (
            <EmptyState icon="history" title="本学期还没有记分" hint="在座位图上选中学生即可记分。" />
          ) : (
            <ol className="timeline">
              {items.map((b) => {
                const reversal = b.kind === 'reversal';
                const live = b.entries.filter((e) => e.status === 'effective');
                return (
                  <li key={b.batch_id} className={`tl-item ${reversal ? 'is-reversal' : ''}`}>
                    <div className="tl-rail">
                      <span className={`tl-delta ${b.delta_value > 0 ? 'pos' : 'neg'}`}>{signed(b.delta_value)}</span>
                    </div>
                    <div className="tl-main">
                      <div className="tl-head">
                        <strong>{reversal ? '撤销' : b.reason_snapshot?.name ?? '未选原因'}</strong>
                        <span className="muted small">
                          {formatDateTime(b.occurred_at)} · {b.member_count} 人
                        </span>
                        {!reversal && live.length > 1 ? (
                          <button type="button" className="link-btn" disabled={write.disabled} onClick={() => void undo('batch', b.batch_id)}>
                            <Icon name="undo" size={13} />
                            撤销整批
                          </button>
                        ) : null}
                      </div>
                      <ul className="tl-entries">
                        {(expanded.has(b.batch_id) ? b.entries : b.entries.slice(0, COLLAPSED)).map((e) => (
                          <li key={e.entry_id} className={e.status === 'reversed' ? 'is-reversed' : ''}>
                            <span className="tl-seat">{e.seat_number_snapshot ?? '—'}</span>
                            <span className="tl-name">{e.student_name || '匿名'}</span>
                            <span className="tl-after">→ {e.balance_after}</span>
                            {!reversal && e.status === 'effective' ? (
                              <button type="button" className="link-btn" disabled={write.disabled} onClick={() => void undo('entry', e.entry_id)}>
                                撤销
                              </button>
                            ) : e.status === 'reversed' ? (
                              <span className="tl-tag">已撤销</span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                      {b.entries.length > COLLAPSED ? (
                        <button
                          type="button"
                          className="link-btn tl-more"
                          onClick={() =>
                            setExpanded((prev) => {
                              const next = new Set(prev);
                              if (next.has(b.batch_id)) next.delete(b.batch_id);
                              else next.add(b.batch_id);
                              return next;
                            })
                          }
                        >
                          {expanded.has(b.batch_id) ? '收起' : `展开其余 ${b.entries.length - COLLAPSED} 人`}
                          <Icon name="chevronDown" size={13} />
                        </button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </aside>
    </div>
  );
}
