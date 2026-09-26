import { useEffect, useRef, useState } from 'react';
import { API_BASE, api } from '../../lib/api';
import type { ImportPreviewDto, LeftReason, StudentDto } from '../../lib/types';
import { useApp } from '../../hooks/useApp';
import { useResource } from '../../hooks/useResource';
import { useWrite } from '../../hooks/useWrite';
import { Icon } from '../../components/Icon';
import { EmptyState, Modal, OfflineHint, Segmented, Spinner } from '../../components/ui';

type Tab = 'active' | 'left' | 'import';

const REASONS: { value: LeftReason; label: string }[] = [
  { value: 'transfer', label: '转学' },
  { value: 'suspension', label: '休学' },
  { value: 'mistake', label: '录错了' },
  { value: 'other', label: '其他' },
];

const CHANGE_LABEL = { create: '新增', update: '更新', keep: '保留' } as const;

export function RosterPage() {
  const { classId, currentClass } = useApp();
  const [tab, setTab] = useState<Tab>('active');
  return (
    <div className="roster">
      <div className="toolbar">
        <div>
          <h1 className="roster-title">{currentClass?.name ?? '名单'}</h1>
          <p className="muted small">导入会整份成功或整份不写入。文件里没有的学生会留下来。</p>
        </div>
        <span className="toolbar-spacer" />
        {classId ? (
          <a className="btn btn-ghost btn-sm" href={`${API_BASE}/classes/${classId}/export/roster`}>
            <Icon name="download" size={16} />
            导出花名册
          </a>
        ) : null}
        <OfflineHint />
        <Segmented
          value={tab}
          onChange={setTab}
          ariaLabel="名单"
          options={[
            { value: 'active', label: '在班', icon: 'users' },
            { value: 'left', label: '已离班', icon: 'userX' },
            { value: 'import', label: '导入', icon: 'download' },
          ]}
        />
      </div>
      {tab === 'import' ? <ImportPanel onImported={() => setTab('active')} /> : <StudentPanel status={tab} />}
    </div>
  );
}

function StudentPanel(props: { status: 'active' | 'left' }) {
  const { classId, seats, tick, bump, toast } = useApp();
  const write = useWrite();
  const [q, setQ] = useState('');
  const [studentNo, setStudentNo] = useState('');
  const [name, setName] = useState('');
  const [remark, setRemark] = useState('');
  const [seatId, setSeatId] = useState('');
  const [editing, setEditing] = useState<StudentDto | null>(null);
  const [editNo, setEditNo] = useState('');
  const [editName, setEditName] = useState('');
  const [editRemark, setEditRemark] = useState('');
  const [leaving, setLeaving] = useState<StudentDto | null>(null);
  const [reason, setReason] = useState<LeftReason>('transfer');
  const [leaveNote, setLeaveNote] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [restoring, setRestoring] = useState<StudentDto | null>(null);
  const [restoreSeat, setRestoreSeat] = useState('');

  const list = useResource(
    classId ? () => api<StudentDto[]>(`/classes/${classId}/students`, { query: { status: props.status } }) : null,
    [classId, props.status, tick('seats'), tick('classes')],
  );
  const version = seats?.seat_version;
  const emptySeats = (seats?.cards ?? [])
    .filter((card) => !card.student && card.seat_number != null)
    .sort((a, b) => (a.seat_number ?? 0) - (b.seat_number ?? 0));
  const query = q.trim();
  const rows = (list.data ?? []).filter((row) => !query || row.name.includes(query) || row.student_no.includes(query));
  const canAdd = studentNo.trim() && name.trim() && seatId && version != null;

  async function addStudent() {
    if (!classId || !canAdd || version == null) return;
    const created = await write.run(
      { op: 'add-student', classId, student_no: studentNo.trim(), name: name.trim(), seat_id: seatId, expected_version: version },
      (requestId) =>
        api<StudentDto>(`/classes/${classId}/students`, {
          method: 'POST',
          requestId,
          body: {
            student_no: studentNo.trim(),
            name: name.trim(),
            remark: remark.trim() || null,
            seat_id: seatId,
            expected_version: version,
          },
        }),
    );
    if (!created) return;
    setStudentNo('');
    setName('');
    setRemark('');
    setSeatId('');
    bump('seats', 'classes');
    toast({ tone: 'success', title: `已添加「${created.name}」`, detail: created.seat ? `${created.seat.seat_number} 号` : undefined });
  }

  function openEdit(row: StudentDto) {
    setEditing(row);
    setEditNo(row.student_no);
    setEditName(row.name);
    setEditRemark(row.remark ?? '');
  }

  async function saveEdit() {
    if (!editing) return;
    const nextNo = editNo.trim();
    const nextName = editName.trim();
    if (!nextNo || !nextName) return;
    const updated = await write.run(
      { op: 'edit-student', student_id: editing.student_id, student_no: nextNo, name: nextName, remark: editRemark.trim() },
      (requestId) =>
        api<StudentDto>(`/students/${editing.student_id}`, {
          method: 'PATCH',
          requestId,
          body: { student_no: nextNo, name: nextName, remark: editRemark.trim() || null },
        }),
    );
    if (!updated) return;
    setEditing(null);
    bump('seats', 'classes');
    toast({ tone: 'success', title: `已保存「${updated.name}」` });
  }

  async function confirmLeave() {
    if (!leaving || version == null) return;
    if (confirmName.trim() !== leaving.name) return;
    if (reason === 'other' && !leaveNote.trim()) return;
    const target = leaving;
    const updated = await write.run(
      { op: 'leave-student', student_id: target.student_id, reason, note: leaveNote.trim(), expected_version: version },
      (requestId) =>
        api<StudentDto>(`/students/${target.student_id}/leave`, {
          method: 'POST',
          requestId,
          body: {
            reason,
            note: leaveNote.trim() || null,
            confirm_token: confirmName.trim(),
            expected_version: version,
          },
        }),
    );
    if (!updated) return;
    setLeaving(null);
    bump('seats', 'classes', 'duty', 'rollcall');
    toast({ tone: 'success', title: `「${target.name}」已离班`, detail: '座位已释放，历史积分还在。' });
  }

  async function confirmRestore() {
    if (!restoring || !restoreSeat || version == null) return;
    const target = restoring;
    const updated = await write.run(
      { op: 'restore-student', student_id: target.student_id, seat_id: restoreSeat, expected_version: version },
      (requestId) =>
        api<StudentDto>(`/students/${target.student_id}/restore`, {
          method: 'POST',
          requestId,
          body: { seat_id: restoreSeat, expected_version: version },
        }),
    );
    if (!updated) return;
    setRestoring(null);
    bump('seats', 'classes', 'duty', 'rollcall');
    toast({
      tone: 'success',
      title: `「${updated.name}」已回班`,
      detail: updated.seat ? `${updated.seat.seat_number} 号` : undefined,
    });
  }

  return (
    <section className="card">
      {props.status === 'active' ? (
        <form
          className="roster-add"
          onSubmit={(e) => {
            e.preventDefault();
            void addStudent();
          }}
        >
          <label className="field">
            <span>学号</span>
            <input value={studentNo} maxLength={64} aria-label="学号" onChange={(e) => setStudentNo(e.target.value)} />
          </label>
          <label className="field">
            <span>姓名</span>
            <input value={name} maxLength={64} aria-label="姓名" onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span>备注 <em>可空</em></span>
            <input value={remark} maxLength={500} aria-label="备注" onChange={(e) => setRemark(e.target.value)} />
          </label>
          <label className="field">
            <span>座位</span>
            <select value={seatId} aria-label="座位" onChange={(e) => setSeatId(e.target.value)}>
              <option value="">{emptySeats.length ? '选择空座' : '没有空座'}</option>
              {emptySeats.map((seat) => (
                <option key={seat.seat_id} value={seat.seat_id}>
                  {seat.seat_number} 号
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn btn-primary" disabled={write.disabled || !canAdd}>
            <Icon name="plus" size={16} />
            添加
          </button>
        </form>
      ) : (
        <p className="manage-note">离班学生不出现在座位图、榜单和点名里。恢复时要重新选一个空座。</p>
      )}
      <div className="roster-search">
        <Icon name="search" size={16} />
        <input value={q} placeholder="按姓名或学号查找" aria-label="查找学生" onChange={(e) => setQ(e.target.value)} />
      </div>
      {list.loading && !list.data ? (
        <div className="page-loading">
          <Spinner />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={props.status === 'active' ? 'users' : 'userX'}
          title={query ? '没有匹配的学生' : props.status === 'active' ? '还没有在班学生' : '没有已离班的学生'}
          hint={props.status === 'active' && !query ? '可以在上面添加一名，或到「导入」一次放入整份名单。' : undefined}
        />
      ) : (
        <ul className="manage-list">
          {rows.map((row) => (
            <li key={row.student_id} className="manage-row">
              <div className="manage-row-main">
                <strong>{row.name}</strong>
                <span>
                  {row.student_no}
                  {row.seat ? ` · ${row.seat.seat_number} 号` : ''}
                  {row.remark ? ` · ${row.remark}` : ''}
                  {props.status === 'left' ? ` · ${reasonLabel(row.left_reason)}` : ''}
                </span>
              </div>
              <div className="manage-actions">
                {props.status === 'left' ? (
                  <button
                    type="button"
                    className="btn btn-soft btn-sm"
                    disabled={write.disabled || emptySeats.length === 0}
                    onClick={() => {
                      setRestoring(row);
                      setRestoreSeat(emptySeats[0]?.seat_id ?? '');
                    }}
                  >
                    恢复
                  </button>
                ) : (
                  <>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={write.disabled} onClick={() => {
                      setLeaving(row);
                      setReason('transfer');
                      setLeaveNote('');
                      setConfirmName('');
                    }}>
                      离班
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={write.disabled} onClick={() => openEdit(row)}>
                      <Icon name="pen" size={14} />
                      修改
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={editing != null}
        title="修改学生"
        subtitle="学号可以改，系统内部的学生不会换成另一个人。"
        onClose={() => setEditing(null)}
        width={440}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>取消</button>
            <button type="button" className="btn btn-primary" disabled={write.disabled || !editNo.trim() || !editName.trim()} onClick={() => void saveEdit()}>
              保存
            </button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void saveEdit();
          }}
        >
          <label className="field">
            <span>学号</span>
            <input value={editNo} maxLength={64} aria-label="修改学号" onChange={(e) => setEditNo(e.target.value)} />
          </label>
          <label className="field">
            <span>姓名</span>
            <input value={editName} maxLength={64} aria-label="修改姓名" onChange={(e) => setEditName(e.target.value)} />
          </label>
          <label className="field">
            <span>备注 <em>可空</em></span>
            <input value={editRemark} maxLength={500} aria-label="修改备注" onChange={(e) => setEditRemark(e.target.value)} />
          </label>
          <button type="submit" hidden>
            保存
          </button>
        </form>
      </Modal>

      <Modal
        open={leaving != null}
        title="学生离班"
        tone="danger"
        subtitle={leaving ? `${leaving.name} · ${leaving.student_no}` : undefined}
        onClose={() => setLeaving(null)}
        width={460}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setLeaving(null)}>取消</button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={write.disabled || confirmName.trim() !== leaving?.name || (reason === 'other' && !leaveNote.trim())}
              onClick={() => void confirmLeave()}
            >
              确认离班
            </button>
          </>
        }
      >
        <label className="field">
          <span>原因</span>
          <select value={reason} aria-label="离班原因" onChange={(e) => setReason(e.target.value as LeftReason)}>
            {REASONS.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
        </label>
        {reason === 'other' ? (
          <label className="field">
            <span>说明</span>
            <input value={leaveNote} maxLength={500} aria-label="离班说明" onChange={(e) => setLeaveNote(e.target.value)} />
          </label>
        ) : null}
        <label className="field">
          <span>输入姓名「{leaving?.name}」以确认</span>
          <input value={confirmName} aria-label="确认姓名" autoComplete="off" onChange={(e) => setConfirmName(e.target.value)} />
        </label>
        <p className="manage-note">座位会空出来。积分和卫生记录都保留，之后可以恢复。</p>
      </Modal>

      <Modal
        open={restoring != null}
        title="恢复到班级"
        subtitle={restoring?.name}
        onClose={() => setRestoring(null)}
        width={420}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setRestoring(null)}>取消</button>
            <button type="button" className="btn btn-primary" disabled={write.disabled || !restoreSeat} onClick={() => void confirmRestore()}>
              恢复到这个座位
            </button>
          </>
        }
      >
        <label className="field">
          <span>空座</span>
          <select value={restoreSeat} aria-label="恢复座位" onChange={(e) => setRestoreSeat(e.target.value)}>
            {emptySeats.map((seat) => (
              <option key={seat.seat_id} value={seat.seat_id}>{seat.seat_number} 号</option>
            ))}
          </select>
        </label>
        {emptySeats.length === 0 ? <p className="manage-note">现在没有空座，先空出一个座位再恢复。</p> : null}
      </Modal>
    </section>
  );
}

function ImportPanel(props: { onImported: () => void }) {
  const { classId, seats, bump, toast, reportError } = useApp();
  const write = useWrite();
  const fileRef = useRef<HTMLInputElement>(null);
  const previewTicket = useRef(0);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<ImportPreviewDto | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const version = seats?.seat_version;

  useEffect(() => {
    previewTicket.current += 1;
    setPreview(null);
    setFileName('');
  }, [classId]);

  async function onFile(file: File | undefined) {
    if (!file || !classId) return;
    setFileName(file.name);
    setPreview(null);
    setPreviewing(true);
    const ticket = ++previewTicket.current;
    const body = new FormData();
    body.append('file', file);
    try {
      const result = await api<ImportPreviewDto>(`/classes/${classId}/import/preview`, { method: 'POST', body });
      if (ticket === previewTicket.current) setPreview(result);
    } catch (err) {
      if (ticket === previewTicket.current) reportError(err);
    } finally {
      setPreviewing(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function commit() {
    if (!classId || !preview?.committable || version == null) return;
    const token = preview.preview_token;
    const result = await write.run({ op: 'import-commit', token, expected_version: version }, (requestId) =>
      api<{ seat_version: number; applied: { create: number; update: number } }>(`/classes/${classId}/import/commit`, {
        method: 'POST',
        requestId,
        body: { preview_token: token, expected_version: version },
      }),
    );
    if (!result) return;
    setPreview(null);
    setFileName('');
    bump('seats', 'classes', 'rollcall', 'duty');
    toast({
      tone: 'success',
      title: '名单已导入',
      detail: `新增 ${result.applied.create} 人，更新 ${result.applied.update} 人。`,
    });
    props.onImported();
  }

  const template = (kind: 'rows' | 'seatmap', label: string) =>
    classId ? (
      <a className="btn btn-ghost" href={`${API_BASE}/classes/${classId}/import/template?kind=${kind}`}>
        <Icon name="download" size={16} />
        {label}
      </a>
    ) : null;

  return (
    <section className="card">
      <header className="card-head">
        <div>
          <h2>导入名单</h2>
          <p className="muted small">先下载模板再填写。只接受 .xlsx，最大 2MB。有错误时不会写入任何人。</p>
        </div>
        <OfflineHint />
      </header>
      <div className="roster-templates">
        {template('rows', '下载行表模板')}
        {template('seatmap', '下载平面座位表')}
      </div>
      <p className="manage-note">行表从第 2 行填学号、姓名、座位号、备注。平面表每个有人的格子写成「12号：20240101 张三」。不要在一个文件里同时放两张表。</p>
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        hidden
        aria-label="选择名单文件"
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
      <div className="roster-file">
        <button type="button" className="btn btn-primary" disabled={write.disabled || previewing} onClick={() => fileRef.current?.click()}>
          <Icon name="plus" size={16} />
          选择文件并预览
        </button>
        <span className="muted small">{previewing ? '正在检查…' : fileName || '还没有选择文件'}</span>
      </div>
      {preview ? <PreviewResult preview={preview} pending={write.disabled || version == null} onCommit={() => void commit()} /> : null}
    </section>
  );
}

function PreviewResult(props: { preview: ImportPreviewDto; pending: boolean; onCommit: () => void }) {
  const { preview } = props;
  const stats = [
    ['新增', preview.summary.create],
    ['更新', preview.summary.update],
    ['保留', preview.summary.keep],
    ['换座', preview.summary.seat_changes],
  ];
  return (
    <div className="roster-preview">
      <div className="manage-summary">
        {stats.map(([label, value]) => (
          <div key={label} className="manage-stat">
            <b>{Number(value)}</b>
            <span>{label}</span>
          </div>
        ))}
      </div>
      {preview.blockers.length > 0 ? (
        <ul className="roster-issues">
          {preview.blockers.map((item) => (
            <li key={item.message} className="is-error">{item.message}</li>
          ))}
        </ul>
      ) : null}
      {preview.issues.length > 0 ? (
        <ul className="roster-issues">
          {preview.issues.map((issue, index) => (
            <li key={`${issue.sheet}-${issue.cell ?? issue.row ?? index}`} className={issue.severity === 'error' ? 'is-error' : ''}>
              <strong>{issue.sheet}{issue.cell ? ` ${issue.cell}` : issue.row ? ` 第 ${issue.row} 行` : ''}</strong>
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      {preview.changes.length > 0 ? (
        <ul className="manage-list">
          {preview.changes.map((change) => (
            <li key={`${change.kind}-${change.student_no}`} className="manage-row">
              <div className="manage-row-main">
                <strong>
                  {change.name}
                  {change.name_changed ? <em className="roster-rename"> 姓名有变化</em> : null}
                </strong>
                <span>
                  {change.student_no}
                  {change.to_seat_number != null ? ` · ${change.from_seat_number ?? '无'} 号 → ${change.to_seat_number} 号` : ''}
                </span>
              </div>
              <span className={`status-pill ${change.kind === 'create' ? 'is-current' : ''}`}>{CHANGE_LABEL[change.kind]}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="roster-commit">
        <button type="button" className="btn btn-primary" disabled={props.pending || !preview.committable} onClick={props.onCommit}>
          <Icon name="check" size={16} />
          {preview.committable ? '确认导入' : '请先修正文件'}
        </button>
        <span className="muted small">{preview.committable ? '确认后才会写入。' : `有 ${preview.summary.errors} 处错误，这一份不会写入。`}</span>
      </div>
    </div>
  );
}

function reasonLabel(reason: LeftReason | null): string {
  return REASONS.find((item) => item.value === reason)?.label ?? '已离班';
}
