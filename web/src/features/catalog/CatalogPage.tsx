import { useState } from 'react';
import { api } from '../../lib/api';
import type { EffectiveTemplateDto, MarkDefDto, StudentDto } from '../../lib/schema';
import { useApp } from '../../hooks/useApp';
import { useResource } from '../../hooks/useResource';
import { useWrite } from '../../hooks/useWrite';
import { Icon } from '../../components/Icon';
import { EmptyState, Modal, OfflineHint, Segmented } from '../../components/ui';

type Tab = 'reasons' | 'marks';
type Polarity = 1 | -1;

const COLORS = ['#0d9488', '#d97706', '#e11d48', '#2563eb', '#7c3aed', '#475569'];
const ICONS = ['★', '◆', '●', '▲', '⚑'];

export function CatalogPage() {
  const [tab, setTab] = useState<Tab>('reasons');
  return (
    <div className="catalog">
      <div className="toolbar">
        <a href="#/manage" className="btn btn-ghost btn-sm">
          <Icon name="chevronLeft" size={16} />
          返回管理
        </a>
        <div>
          <h1 className="roster-title">原因和标记</h1>
          <p className="muted small">记分原因出现在座位图底部。普通标记只是座位上的小记号，不加分，也不是卫生管理员。</p>
        </div>
        <span className="toolbar-spacer" />
        <OfflineHint />
        <Segmented
          value={tab}
          onChange={setTab}
          ariaLabel="原因和标记"
          options={[
            { value: 'reasons', label: '记分原因', icon: 'flag' },
            { value: 'marks', label: '普通标记', icon: 'sparkle' },
          ]}
        />
      </div>
      {tab === 'reasons' ? <ReasonPanel /> : <MarkPanel />}
    </div>
  );
}

function ReasonPanel() {
  const { classId, currentClass, tick, bump, toast } = useApp();
  const write = useWrite();
  const list = useResource(
    classId ? () => api<EffectiveTemplateDto[]>(`/classes/${classId}/templates`) : null,
    [classId, tick('templates')],
  );
  const [name, setName] = useState('');
  const [polarity, setPolarity] = useState<Polarity>(1);
  const [amount, setAmount] = useState('1');
  const [scope, setScope] = useState<'global' | 'class'>('global');
  const [editing, setEditing] = useState<EffectiveTemplateDto | null>(null);
  const [editName, setEditName] = useState('');
  const [editAmount, setEditAmount] = useState('1');
  const parsed = Number(amount);
  const delta = polarity * Math.abs(parsed);
  const canAdd = name.trim().length > 0 && Number.isInteger(parsed) && parsed > 0 && parsed <= 1000 && classId;

  async function addReason() {
    if (!classId || !canAdd) return;
    const body = { name: name.trim(), polarity, default_delta: delta, sort_order: (list.data?.length ?? 0) + 1 };
    const path = scope === 'class' ? `/classes/${classId}/templates` : '/templates';
    const created = await write.run({ op: 'add-template', ...body, scope, classId }, (requestId) =>
      api(path, { method: 'POST', requestId, body }),
    );
    if (!created) return;
    setName('');
    bump('templates');
    toast({ tone: 'success', title: `已添加「${body.name}」`, detail: scope === 'class' ? '只在这个班的记分栏里。' : '所有班级的记分栏都能用。' });
  }

  function openEdit(row: EffectiveTemplateDto) {
    setEditing(row);
    setEditName(row.effective_name);
    setEditAmount(String(Math.abs(row.effective_delta)));
  }

  async function saveEdit(where: 'class' | 'all') {
    if (!editing || !classId) return;
    const nextName = editName.trim();
    const nextAmount = Number(editAmount);
    if (!nextName || !Number.isInteger(nextAmount) || nextAmount <= 0 || nextAmount > 1000) return;
    const signed = editing.polarity * nextAmount;
    const ok = await write.run(
      { op: 'edit-template', template_id: editing.template_id, where, name: nextName, default_delta: signed, classId },
      (requestId) =>
        where === 'all' || editing.added_in_class
          ? api(`/templates/${editing.template_id}`, {
              method: 'PATCH',
              requestId,
              body: { name: nextName, default_delta: signed },
            })
          : api(`/classes/${classId}/templates/${editing.template_id}/override`, {
              method: 'POST',
              requestId,
              body: { name: nextName, default_delta: signed },
            }),
    );
    if (!ok) return;
    setEditing(null);
    bump('templates');
    toast({ tone: 'success', title: `已保存「${nextName}」` });
  }

  async function setHidden(row: EffectiveTemplateDto, hidden: boolean) {
    if (!classId) return;
    const ok = await write.run({ op: 'hide-template', template_id: row.template_id, hidden, classId }, (requestId) =>
      api(`/classes/${classId}/templates/${row.template_id}/override`, {
        method: 'POST',
        requestId,
        body: { hidden },
      }),
    );
    if (!ok) return;
    bump('templates');
    toast({ tone: 'success', title: hidden ? `「${row.effective_name}」已从本班记分栏拿下` : `「${row.effective_name}」回到本班记分栏` });
  }

  async function clearOverride(row: EffectiveTemplateDto) {
    if (!classId) return;
    const ok = await write.run({ op: 'clear-template', template_id: row.template_id, classId }, (requestId) =>
      api(`/classes/${classId}/templates/${row.template_id}/override`, { method: 'DELETE', requestId, body: {} }),
    );
    if (!ok) return;
    bump('templates');
    toast({ tone: 'success', title: `「${row.effective_name}」已恢复全校设置` });
  }

  if (!classId) {
    return (
      <EmptyState icon="flag" title="先建立班级" hint="记分原因要挂在班级上才能看到。可以先到管理页建班。" action={<a className="btn btn-primary" href="#/manage">去建立</a>} />
    );
  }

  const rows = [...(list.data ?? [])].sort((a, b) => a.sort_order - b.sort_order);
  return (
    <section className="card">
      <p className="manage-note">当前班是「{currentClass?.name}」。加分原因的分值只能是正的，扣分原因只能是负的，建好之后不能把方向反过来。</p>
      <form
        className="catalog-add"
        onSubmit={(e) => {
          e.preventDefault();
          void addReason();
        }}
      >
        <label className="field">
          <span>名称</span>
          <input value={name} maxLength={32} aria-label="原因名称" onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>方向</span>
          <select value={String(polarity)} aria-label="记分方向" onChange={(e) => setPolarity(Number(e.target.value) as Polarity)}>
            <option value="1">加分</option>
            <option value="-1">扣分</option>
          </select>
        </label>
        <label className="field">
          <span>分值</span>
          <input value={amount} inputMode="numeric" aria-label="原因分值" onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))} />
        </label>
        <label className="field">
          <span>用在</span>
          <select value={scope} aria-label="原因范围" onChange={(e) => setScope(e.target.value as 'global' | 'class')}>
            <option value="global">所有班级</option>
            <option value="class">只在这个班</option>
          </select>
        </label>
        <button type="submit" className="btn btn-primary" disabled={write.disabled || !canAdd}>
          <Icon name="plus" size={16} />
          添加
        </button>
      </form>
      {rows.length === 0 ? (
        <EmptyState icon="flag" title="还没有记分原因" hint="添加之后，座位图底部会出现对应按钮。" />
      ) : (
        <ul className="manage-list">
          {rows.map((row) => (
            <li key={row.template_id} className="manage-row">
              <div className="manage-row-main">
                <strong>
                  {row.effective_name}
                  <em className={row.polarity > 0 ? 'catalog-plus' : 'catalog-minus'}>
                    {' '}
                    {row.effective_delta > 0 ? `+${row.effective_delta}` : row.effective_delta}
                  </em>
                </strong>
                <span>
                  {row.polarity > 0 ? '加分' : '扣分'}
                  {row.added_in_class ? ' · 只在这个班' : ' · 所有班级'}
                  {row.hidden ? ' · 本班记分栏不显示' : ''}
                  {row.has_override && !row.added_in_class ? ' · 本班改过' : ''}
                </span>
              </div>
              <div className="manage-actions">
                {row.has_override && !row.added_in_class ? (
                  <button type="button" className="btn btn-ghost btn-sm" disabled={write.disabled} onClick={() => void clearOverride(row)}>
                    恢复全校
                  </button>
                ) : null}
                <button type="button" className="btn btn-ghost btn-sm" disabled={write.disabled} onClick={() => void setHidden(row, !row.hidden)}>
                  {row.hidden ? '在本班显示' : '本班不用'}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" disabled={write.disabled} onClick={() => openEdit(row)}>
                  修改
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Modal
        open={editing != null}
        title="修改记分原因"
        subtitle={editing ? (editing.polarity > 0 ? '这是加分原因，不能改成扣分。' : '这是扣分原因，不能改成加分。') : undefined}
        onClose={() => setEditing(null)}
        width={440}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>取消</button>
            {editing && !editing.added_in_class ? (
              <button type="button" className="btn btn-ghost" disabled={write.disabled} onClick={() => void saveEdit('all')}>
                改全部班级
              </button>
            ) : null}
            <button type="button" className="btn btn-primary" disabled={write.disabled || !editName.trim()} onClick={() => void saveEdit(editing?.added_in_class ? 'all' : 'class')}>
              {editing?.added_in_class ? '保存' : '只改这个班'}
            </button>
          </>
        }
      >
        <label className="field">
          <span>名称</span>
          <input value={editName} maxLength={32} aria-label="修改原因名称" onChange={(e) => setEditName(e.target.value)} />
        </label>
        <label className="field">
          <span>分值</span>
          <input value={editAmount} inputMode="numeric" aria-label="修改原因分值" onChange={(e) => setEditAmount(e.target.value.replace(/[^\d]/g, ''))} />
        </label>
      </Modal>
    </section>
  );
}

function MarkPanel() {
  const { classId, tick, bump, toast, marks } = useApp();
  const write = useWrite();
  const students = useResource(
    classId ? () => api<StudentDto[]>(`/classes/${classId}/students`, { query: { status: 'active' } }) : null,
    [classId, tick('seats'), tick('marks')],
  );
  const [name, setName] = useState('');
  const [icon, setIcon] = useState(ICONS[0]);
  const [color, setColor] = useState(COLORS[0]);
  const [studentId, setStudentId] = useState('');
  const canAdd = name.trim().length > 0;
  const student = (students.data ?? []).find((row) => row.student_id === studentId) ?? null;

  async function addMark() {
    if (!canAdd) return;
    const created = await write.run({ op: 'add-mark', name: name.trim(), icon, color }, (requestId) =>
      api<MarkDefDto>('/marks', { method: 'POST', requestId, body: { name: name.trim(), icon, color, sort_order: marks.length + 1 } }),
    );
    if (!created) return;
    setName('');
    bump('marks');
    toast({ tone: 'success', title: `已添加标记「${created.name}」` });
  }

  async function archiveMark(mark: MarkDefDto) {
    const ok = await write.run({ op: 'archive-mark', mark_id: mark.mark_id }, (requestId) =>
      api(`/marks/${mark.mark_id}`, { method: 'PATCH', requestId, body: { archived: true } }),
    );
    if (!ok) return;
    bump('marks', 'seats');
    toast({ tone: 'success', title: `「${mark.name}」已停用`, detail: '已经打在学生身上的记号还留着。' });
  }

  async function toggle(mark: MarkDefDto) {
    if (!student) return;
    const has = student.marks.includes(mark.mark_id);
    const ok = await write.run({ op: 'toggle-mark', student_id: student.student_id, mark_id: mark.mark_id, has }, (requestId) =>
      api(`/students/${student.student_id}/marks/${mark.mark_id}`, {
        method: has ? 'DELETE' : 'POST',
        requestId,
        body: {},
      }),
    );
    if (!ok) return;
    bump('marks', 'seats');
    toast({ tone: 'success', title: has ? `已摘下「${mark.name}」` : `已给「${student.name}」加上「${mark.name}」` });
  }

  return (
    <section className="card">
      <form
        className="catalog-add catalog-mark-add"
        onSubmit={(e) => {
          e.preventDefault();
          void addMark();
        }}
      >
        <label className="field">
          <span>名称</span>
          <input value={name} maxLength={64} aria-label="标记名称" onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="field">
          <span>符号</span>
          <div className="catalog-choices" role="radiogroup" aria-label="标记符号">
            {ICONS.map((item) => (
              <button key={item} type="button" className={`catalog-choice${icon === item ? ' is-on' : ''}`} aria-pressed={icon === item} onClick={() => setIcon(item)}>
                {item}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span>颜色</span>
          <div className="catalog-choices" role="radiogroup" aria-label="标记颜色">
            {COLORS.map((item) => (
              <button
                key={item}
                type="button"
                className={`catalog-swatch${color === item ? ' is-on' : ''}`}
                style={{ background: item }}
                aria-label={item}
                aria-pressed={color === item}
                onClick={() => setColor(item)}
              />
            ))}
          </div>
        </div>
        <button type="submit" className="btn btn-primary" disabled={write.disabled || !canAdd}>
          <Icon name="plus" size={16} />
          添加
        </button>
      </form>
      {marks.length === 0 ? (
        <EmptyState icon="sparkle" title="还没有普通标记" hint="添加之后，可以标在学生的座位上。" />
      ) : (
        <ul className="manage-list">
          {marks.map((mark) => (
            <li key={mark.mark_id} className="manage-row">
              <div className="manage-row-main">
                <strong>
                  <span className="catalog-mark" style={{ color: mark.color }}>{mark.icon}</span>
                  {mark.name}
                </strong>
              </div>
              <div className="manage-actions">
                <button type="button" className="btn btn-ghost btn-sm" disabled={write.disabled} onClick={() => void archiveMark(mark)}>
                  停用
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="catalog-assign">
        <h2>打在学生身上</h2>
        {!classId ? (
          <p className="manage-note">先建立班级并添加学生，才能打标记。</p>
        ) : (
          <>
            <label className="field">
              <span>学生</span>
              <select value={studentId} aria-label="选择学生" onChange={(e) => setStudentId(e.target.value)}>
                <option value="">选择学生</option>
                {(students.data ?? []).map((row) => (
                  <option key={row.student_id} value={row.student_id}>
                    {row.name} · {row.student_no}
                  </option>
                ))}
              </select>
            </label>
            {student ? (
              <div className="catalog-choices">
                {marks.map((mark) => {
                  const on = student.marks.includes(mark.mark_id);
                  return (
                    <button
                      key={mark.mark_id}
                      type="button"
                      className={`btn btn-sm ${on ? 'btn-primary' : 'btn-ghost'}`}
                      disabled={write.disabled}
                      onClick={() => void toggle(mark)}
                    >
                      <span style={{ color: on ? '#fff' : mark.color }}>{mark.icon}</span>
                      {on ? `摘下${mark.name}` : `加上${mark.name}`}
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="manage-note">先选一名学生。点一下加上，再点一下摘下。</p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
