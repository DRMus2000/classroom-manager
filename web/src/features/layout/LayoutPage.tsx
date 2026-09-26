import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { LayoutDto, RoomColumnDto, RoomSlotDto, SeatDirection, SeatFacing } from '../../lib/schema';
import type { LayoutImpactDto } from '../../lib/types';
import { useApp } from '../../hooks/useApp';
import { useResource } from '../../hooks/useResource';
import { useWrite } from '../../hooks/useWrite';
import { Icon } from '../../components/Icon';
import { EmptyState, Modal, OfflineHint, Spinner } from '../../components/ui';

type Draft = {
  kind: 'insert_slot' | 'delete_slot' | 'change_column' | 'renumber';
  payload: Record<string, unknown>;
  title: string;
  detail: string;
  danger: boolean;
};

export function LayoutPage() {
  const { tick, bump, toast, reportError, online } = useApp();
  const write = useWrite();
  const layout = useResource(() => api<LayoutDto>('/layout'), [tick('seats')]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [impact, setImpact] = useState<LayoutImpactDto | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const ticket = useRef(0);

  const columns = useMemo(
    () => [...(layout.data?.columns ?? [])].sort((a, b) => a.display_order - b.display_order),
    [layout.data],
  );
  const slots = layout.data?.slots ?? [];
  const selected = slots.find((slot) => slot.seat_id === selectedId) ?? null;

  useEffect(() => {
    if (selectedId && layout.data && !layout.data.slots.some((slot) => slot.seat_id === selectedId)) {
      setSelectedId(null);
    }
  }, [layout.data, selectedId]);

  function seatsOf(column: RoomColumnDto): RoomSlotDto[] {
    return slots
      .filter((slot) => slot.column_id === column.column_id)
      .sort((a, b) => a.sort_in_column - b.sort_in_column);
  }

  async function openPreview(next: Draft) {
    if (!online) {
      toast({ tone: 'error', title: '当前离线，不能调整布局' });
      return;
    }
    const mine = ++ticket.current;
    setDraft(next);
    setImpact(null);
    setPreviewing(true);
    try {
      const result = await api<LayoutImpactDto>('/layout/preview-change', {
        method: 'POST',
        body: { kind: next.kind, payload: next.payload },
      });
      if (mine === ticket.current) setImpact(result);
    } catch (err) {
      if (mine === ticket.current) {
        setDraft(null);
        reportError(err);
      }
    } finally {
      if (mine === ticket.current) setPreviewing(false);
    }
  }

  function closePreview() {
    ticket.current += 1;
    setDraft(null);
    setImpact(null);
    setPreviewing(false);
  }

  function addSeat(column: RoomColumnDto, where: 'podium' | 'back') {
    const columnSeats = seatsOf(column);
    const afterSort = where === 'podium' ? 0 : (columnSeats[columnSeats.length - 1]?.sort_in_column ?? 0);
    void openPreview({
      kind: 'insert_slot',
      payload: { column_id: column.column_id, after_sort: afterSort },
      title: where === 'podium' ? `在${column.label}的讲台端加一座` : `在${column.label}的后墙端加一座`,
      detail: '新座位会出现在所有班级里。学生还坐在原来的机位上，屏幕上的座位号按规则重排。',
      danger: false,
    });
  }

  function flipDirection(column: RoomColumnDto) {
    const direction: SeatDirection = column.direction === 'toward_back' ? 'toward_front' : 'toward_back';
    void openPreview({
      kind: 'change_column',
      payload: { column_id: column.column_id, direction },
      title: `调转${column.label}的编号方向`,
      detail: `改成「${directionLabel(direction)}」。学生不换机位。`,
      danger: false,
    });
  }

  function flipFacing(column: RoomColumnDto) {
    const facing: SeatFacing = column.facing === 'left' ? 'right' : 'left';
    void openPreview({
      kind: 'change_column',
      payload: { column_id: column.column_id, facing },
      title: `调转${column.label}的椅背`,
      detail: `改成「${facingLabel(facing)}」。座位号不变。`,
      danger: false,
    });
  }

  function askDelete(slot: RoomSlotDto) {
    const busy = slot.occupant_class_count > 0;
    void openPreview({
      kind: 'delete_slot',
      payload: { seat_id: slot.seat_id },
      title: `删除 ${slot.seat_number ?? '未编号'} 号`,
      detail: busy
        ? '还有学生坐在这座时不能删除。先把人换走。'
        : '这座会从所有班级消失。后面的座位号会前移，已经记过的号不变。',
      danger: true,
    });
  }

  async function applyChange() {
    if (!draft || !impact || impact.blockers.length > 0) return;
    const current = draft;
    const hash = impact.preview_hash;
    const result = await write.run(
      { op: 'layout-apply', kind: current.kind, payload: current.payload, preview_hash: hash },
      (requestId) =>
        api<{ total_slots: number; renumber_diff: { old: number | null; new: number }[] }>('/layout/apply-change', {
          method: 'POST',
          requestId,
          body: { kind: current.kind, payload: current.payload, preview_hash: hash },
        }),
    );
    if (!result) return;
    closePreview();
    setSelectedId(null);
    bump('seats');
    const changed = result.renumber_diff.length;
    toast({
      tone: 'success',
      title: '机房布局已更新',
      detail: changed > 0 ? `${changed} 个座位换了编号，现在共 ${result.total_slots} 座。` : `现在共 ${result.total_slots} 座。`,
    });
  }

  const blocked = (impact?.blockers.length ?? 0) > 0;
  const noRenumber = draft?.kind === 'renumber' && impact != null && impact.renumber_diff.length === 0 && !blocked;
  const canApply = impact != null && !blocked && !noRenumber && !previewing;

  return (
    <div className="layout-page">
      <div className="toolbar">
        <a href="#/manage" className="btn btn-ghost btn-sm">
          <Icon name="chevronLeft" size={16} />
          返回管理
        </a>
        <div>
          <h1 className="roster-title">机房布局</h1>
          <p className="muted small">从左到右是面对屏幕的列，讲台在上方。所有班级共用。历史记录里的座位号不会改。</p>
        </div>
        <span className="toolbar-spacer" />
        <OfflineHint />
        <span className="status-pill">{layout.data ? `${layout.data.total_slots} 座` : '…'}</span>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={write.disabled || previewing}
          onClick={() =>
            void openPreview({
              kind: 'renumber',
              payload: {},
              title: '检查座位编号',
              detail: '按现在的列和方向重排。学生不换机位。',
              danger: false,
            })
          }
        >
          检查编号
        </button>
      </div>

      {layout.loading && !layout.data ? (
        <div className="page-loading">
          <Spinner />
        </div>
      ) : !layout.data ? (
        <EmptyState
          icon="grid"
          title="机房布局没有加载出来"
          hint="请检查网络后再试。"
          action={
            <button type="button" className="btn btn-primary" onClick={() => layout.reload()}>
              <Icon name="refresh" size={16} />
              重试
            </button>
          }
        />
      ) : (
        <>
          <div className="layout-pick">
            {selected ? (
              <>
                <div>
                  <strong>{selected.seat_number ?? '未编号'} 号</strong>
                  <span>{selected.occupant_class_count > 0 ? `${selected.occupant_class_count} 个班在用` : '空座，可以删除'}</span>
                </div>
                <button
                  type="button"
                  className={selected.occupant_class_count > 0 ? 'btn btn-ghost' : 'btn btn-danger'}
                  disabled={write.disabled || previewing}
                  onClick={() => askDelete(selected)}
                >
                  {selected.occupant_class_count > 0 ? '查看占用' : '删除这座'}
                </button>
              </>
            ) : (
              <p>点一座可以删除。有学生的座位要先换走，再回来删。</p>
            )}
          </div>
          <div className="layout-room">
            {columns.map((column) => {
              const columnSeats = seatsOf(column);
              return (
                <section key={column.column_id} className="card layout-col">
                  <header>
                    <h2>{column.label}</h2>
                    <p>{directionLabel(column.direction)}</p>
                    <p>{facingLabel(column.facing)} · {column.slot_count} 座</p>
                  </header>
                  <div className="layout-col-actions">
                    <button type="button" className="btn btn-soft btn-sm" disabled={write.disabled || previewing} onClick={() => addSeat(column, 'podium')}>
                      讲台端加一座
                    </button>
                    <button type="button" className="btn btn-soft btn-sm" disabled={write.disabled || previewing} onClick={() => addSeat(column, 'back')}>
                      后墙端加一座
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={write.disabled || previewing} onClick={() => flipDirection(column)}>
                      调转编号方向
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={write.disabled || previewing} onClick={() => flipFacing(column)}>
                      调转椅背
                    </button>
                  </div>
                  <p className="layout-end">讲台端</p>
                  <ul className="layout-seats">
                    {columnSeats.map((slot) => (
                      <li key={slot.seat_id}>
                        <button
                          type="button"
                          className={`layout-seat${selectedId === slot.seat_id ? ' is-selected' : ''}${slot.occupant_class_count > 0 ? ' is-busy' : ''}`}
                          aria-pressed={selectedId === slot.seat_id}
                          onClick={() => setSelectedId(slot.seat_id)}
                        >
                          <b>{slot.seat_number ?? '—'}</b>
                          <span>{slot.occupant_class_count > 0 ? `${slot.occupant_class_count} 个班` : '空'}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  <p className="layout-end">后墙端</p>
                </section>
              );
            })}
          </div>
        </>
      )}

      <Modal
        open={draft != null}
        title={draft?.title ?? ''}
        subtitle={previewing ? '正在计算会影响哪些编号…' : undefined}
        tone={draft?.danger ? 'danger' : 'default'}
        onClose={closePreview}
        width={480}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={closePreview}>
              {noRenumber ? '知道了' : '取消'}
            </button>
            {noRenumber ? null : (
              <button
                type="button"
                className={draft?.danger ? 'btn btn-danger' : 'btn btn-primary'}
                disabled={!canApply || write.disabled}
                onClick={() => void applyChange()}
              >
                {blocked ? (draft?.danger ? '不能删除' : '不能调整') : draft?.danger ? '确认删除' : '确认调整'}
              </button>
            )}
          </>
        }
      >
        <p>{draft?.detail}</p>
        {impact && impact.blockers.length > 0 ? (
          <ul className="roster-issues">
            {impact.blockers.map((item) => (
              <li key={item.message} className="is-error">{item.message}</li>
            ))}
          </ul>
        ) : null}
        {impact && impact.affected_classes.length > 0 ? (
          <ul className="layout-classes">
            {impact.affected_classes.map((item) => (
              <li key={item.class_id}>
                {item.name}
                {item.seat_assignments_removed > 0 ? ' 还有学生坐在这座' : ' 的学生会跟着这座移动'}
              </li>
            ))}
          </ul>
        ) : null}
        {impact ? <RenumberList diff={impact.renumber_diff} empty={noRenumber} /> : previewing ? <div className="page-loading"><Spinner /></div> : null}
      </Modal>
    </div>
  );
}

function RenumberList(props: { diff: LayoutImpactDto['renumber_diff']; empty: boolean }) {
  if (props.empty) return <p className="manage-note">编号已经符合规则，不用改。</p>;
  if (props.diff.length === 0) return <p className="manage-note">现有座位的编号不变。</p>;
  const shown = props.diff.slice(0, 8);
  return (
    <div className="layout-diff">
      <p>{props.diff.length} 个座位会换编号</p>
      <ul>
        {shown.map((item) => (
          <li key={item.seat_id}>
            {item.old ?? '无'} → {item.new}
          </li>
        ))}
      </ul>
      {props.diff.length > shown.length ? <p className="muted small">还有 {props.diff.length - shown.length} 个。</p> : null}
    </div>
  );
}

function directionLabel(direction: SeatDirection): string {
  return direction === 'toward_back' ? '编号从讲台数到后墙' : '编号从后墙数到讲台';
}

function facingLabel(facing: SeatFacing): string {
  return facing === 'right' ? '椅背朝右' : '椅背朝左';
}
