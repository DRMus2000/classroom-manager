import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../../lib/api';
import type { ClassDto, TermDto, TermSummaryDto } from '../../lib/types';
import { useApp } from '../../hooks/useApp';
import { useResource } from '../../hooks/useResource';
import { useWrite } from '../../hooks/useWrite';
import { Icon } from '../../components/Icon';
import { Modal, OfflineHint, Spinner } from '../../components/ui';

export function ManagePage() {
  const { currentTerm, termsKnown } = useApp();
  return (
    <div className="manage">
      {termsKnown && !currentTerm ? (
        <div className="manage-banner" role="status">
          <Icon name="flag" size={18} />
          <div>
            <strong>还没有当前学期</strong>
            <p>先建立学期，再点「设为当前」。不设为当前时，座位图上的记分不能用。</p>
          </div>
        </div>
      ) : null}
      <TermSection />
      <ClassSection />
      <section className="card manage-layout">
        <header className="card-head">
          <div>
            <h2>机房布局</h2>
            <p className="muted small">所有班级共用这一间电脑室。加减座位或调转列的方向之后，座位号会重排，已经记过的号不变。</p>
          </div>
          <a className="btn btn-primary" href="#/layout">
            调整布局
            <Icon name="arrowRight" size={16} />
          </a>
        </header>
      </section>
      <section className="card manage-layout">
        <header className="card-head">
          <div>
            <h2>原因和标记</h2>
            <p className="muted small">记分原因出现在座位图底部。普通标记只标在座位上，不加分。</p>
          </div>
          <a className="btn btn-primary" href="#/catalog">
            维护原因和标记
            <Icon name="arrowRight" size={16} />
          </a>
        </header>
      </section>
      <section className="card manage-layout">
        <header className="card-head">
          <div>
            <h2>审计和备份</h2>
            <p className="muted small">查看操作记录，下载每天的数据库备份。恢复要在另一台数据库上做。</p>
          </div>
          <a className="btn btn-primary" href="#/records">
            查看记录
            <Icon name="arrowRight" size={16} />
          </a>
        </header>
      </section>
      <PasswordSection />
    </div>
  );
}

function PasswordSection() {
  const { toast } = useApp();
  const write = useWrite();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [formError, setFormError] = useState('');
  const mismatch = again.length > 0 && again !== next;
  const short = next.length > 0 && next.length < 12;
  const ready = current.length > 0 && next.length >= 12 && again === next;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setFormError('');
    const ok = await write.run(
      { op: 'change-password', old_password: current, new_password: next },
      (requestId) =>
        api<{ ok: true }>('/auth/password', {
          method: 'POST',
          requestId,
          body: { old_password: current, new_password: next },
        }),
      {
        onError: (err) => {
          if (err instanceof ApiError && err.code === 'UNAUTHENTICATED' && err.message.includes('原密码')) {
            setFormError('当前密码不对');
            return true;
          }
          return false;
        },
      },
    );
    if (!ok) return;
    setCurrent('');
    setNext('');
    setAgain('');
    toast({ tone: 'success', title: '密码已更新', detail: '其他设备需要重新登录，这台电脑保持登录。' });
  }

  return (
    <section className="card manage-password" id="password">
      <header className="card-head">
        <div>
          <h2>修改密码</h2>
          <p className="muted small">至少 12 位。保存后其他设备要重新登录，这台电脑保持登录。忘了当前密码时，仍要在服务器上重置。</p>
        </div>
      </header>
      <form className="manage-password-form" onSubmit={(e) => void save(e)}>
        <label className="field">
          <span>当前密码</span>
          <input
            type="password"
            autoComplete="current-password"
            value={current}
            aria-label="当前密码"
            onChange={(e) => {
              setCurrent(e.target.value);
              setFormError('');
            }}
          />
        </label>
        <label className="field">
          <span>新密码</span>
          <input
            type="password"
            autoComplete="new-password"
            value={next}
            aria-label="新密码"
            onChange={(e) => setNext(e.target.value)}
          />
        </label>
        <label className="field">
          <span>再输入一次</span>
          <input
            type="password"
            autoComplete="new-password"
            value={again}
            aria-label="再输入一次新密码"
            onChange={(e) => setAgain(e.target.value)}
          />
        </label>
        <button type="submit" className="btn btn-primary" disabled={write.disabled || !ready}>
          保存新密码
        </button>
      </form>
      {short ? <p className="manage-note">新密码至少 12 位，还差 {12 - next.length} 位。</p> : null}
      {mismatch ? <p className="manage-note">两次输入的新密码不一致。</p> : null}
      {formError ? <p className="form-error" role="alert">{formError}</p> : null}
    </section>
  );
}

function TermSection() {
  const { terms, currentTerm, tick, bump, toast } = useApp();
  const write = useWrite();
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [activate, setActivate] = useState<TermDto | null>(null);
  const selectedId = picked ?? currentTerm?.term_id ?? terms[0]?.term_id ?? '';
  const summary = useResource(
    selectedId ? () => api<TermSummaryDto>(`/terms/${selectedId}/summary`) : null,
    [selectedId, tick('classes'), tick('points')],
  );
  const trimmed = name.trim();

  async function createTerm() {
    if (!trimmed) return;
    const created = await write.run({ op: 'create-term', name: trimmed }, (requestId) =>
      api<TermDto>('/terms', { method: 'POST', body: { name: trimmed }, requestId }),
    );
    if (!created) return;
    setName('');
    setPicked(created.term_id);
    bump('classes');
    toast({
      tone: 'success',
      title: `已建立学期「${created.name}」`,
      detail: '它还不是当前学期。记分前请设为当前。',
    });
  }

  async function confirmActivate() {
    if (!activate) return;
    const term = activate;
    const result = await write.run(
      { op: 'activate-term', term_id: term.term_id, expected_current_term_id: currentTerm?.term_id ?? null },
      (requestId) =>
        api<{ term: TermDto; initialized_students: number }>(`/terms/${term.term_id}/activate`, {
          method: 'POST',
          body: { expected_current_term_id: currentTerm?.term_id ?? null },
          requestId,
        }),
    );
    if (!result) return;
    setActivate(null);
    bump('classes');
    const count = Number(result.initialized_students);
    toast({
      tone: 'success',
      title: `当前学期已改为「${result.term.name}」`,
      detail: count > 0 ? `${count} 名在班学生本学期积分从 0 开始。` : '在班学生本学期积分从 0 开始。',
    });
  }

  return (
    <section className="card">
      <header className="card-head">
        <div>
          <h2>学期</h2>
          <p className="muted small">全校共用。切换后旧学期只能查询。</p>
        </div>
        <OfflineHint />
      </header>
      <form
        className="manage-create"
        onSubmit={(e) => {
          e.preventDefault();
          void createTerm();
        }}
      >
        <input
          value={name}
          maxLength={64}
          placeholder="例如 2026 秋季"
          aria-label="新学期名称"
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={write.disabled || !trimmed}>
          <Icon name="plus" size={16} />
          建立学期
        </button>
      </form>
      <p className="manage-note">新建后不会自动启用。点「设为当前」才会开始记分，座位和卫生都会留下。</p>
      {terms.length === 0 ? (
        <p className="manage-note">还没有学期。</p>
      ) : (
        <ul className="manage-list">
          {terms.map((term) => {
            const selected = term.term_id === selectedId;
            return (
              <li key={term.term_id}>
                <div className={`manage-row ${term.is_current ? 'is-current' : ''} ${selected ? 'is-selected' : ''}`}>
                  <button type="button" className="manage-row-main" onClick={() => setPicked(term.term_id)}>
                    <strong>{term.name}</strong>
                    <span>{termStatus(term)}</span>
                  </button>
                  <div className="manage-actions">
                    {term.is_current ? (
                      <span className="status-pill is-current">当前</span>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-soft btn-sm"
                        disabled={write.disabled}
                        onClick={() => {
                          setPicked(term.term_id);
                          setActivate(term);
                        }}
                      >
                        设为当前
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {selectedId ? (
        <SummaryBlock summary={summary.data} loading={summary.loading && !summary.data} failed={summary.error != null && summary.data == null} />
      ) : null}
      <Modal
        open={activate != null}
        title={currentTerm ? '切换学期' : '启用学期'}
        subtitle={activate ? `「${activate.name}」` : undefined}
        onClose={() => setActivate(null)}
        width={460}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setActivate(null)}>
              取消
            </button>
            <button type="button" className="btn btn-primary" disabled={write.disabled} onClick={() => void confirmActivate()}>
              {currentTerm ? '切换并重新计分' : '设为当前学期'}
            </button>
          </>
        }
      >
        {currentTerm ? (
          <p>
            所有班级会一起进入「{activate?.name}」。在班学生的积分从 0 开始。座位、标记和还没结束的卫生都留下。旧学期「{currentTerm.name}」之后只能查询和导出，不能再记分。
          </p>
        ) : (
          <p>启用后，记分会记到「{activate?.name}」。以后再切换时，这个学期的分数会保留，但不能再往里记。</p>
        )}
      </Modal>
    </section>
  );
}

function SummaryBlock(props: { summary: TermSummaryDto | null; loading: boolean; failed: boolean }) {
  if (!props.summary) {
    if (props.loading) {
      return (
        <div className="manage-summary-loading">
          <Spinner />
        </div>
      );
    }
    if (props.failed) return <p className="manage-note">这个学期的汇总暂时没有加载出来。</p>;
    return null;
  }
  const stats = [
    ['记分批次', props.summary.total_batches],
    ['积分流水', props.summary.total_entries],
    ['撤销', props.summary.total_reversals],
    ['有分学生', props.summary.students_scored],
  ];
  return (
    <div className="manage-summary" aria-label={`${props.summary.term.name}的汇总`}>
      {stats.map(([label, value]) => (
        <div key={label} className="manage-stat">
          <b>{Number(value)}</b>
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}

function termStatus(term: TermDto): string {
  if (term.is_current) return '正在记分';
  if (term.closed_at) return '只读，可查询';
  return '尚未启用';
}

function ClassSection() {
  const { classId, tick, bump, toast } = useApp();
  const write = useWrite();
  const [name, setName] = useState('');
  const [rename, setRename] = useState<ClassDto | null>(null);
  const [renameTo, setRenameTo] = useState('');
  const [archive, setArchive] = useState<ClassDto | null>(null);
  const list = useResource(
    () => api<ClassDto[]>('/classes', { query: { include_archived: 'true' } }),
    [tick('classes')],
  );
  const rows = list.data ?? [];
  const active = rows.filter((row) => !row.archived_at);
  const archived = rows.filter((row) => row.archived_at);
  const trimmed = name.trim();

  async function createClass() {
    if (!trimmed) return;
    const created = await write.run({ op: 'create-class', name: trimmed }, (requestId) =>
      api<ClassDto>('/classes', { method: 'POST', body: { name: trimmed }, requestId }),
    );
    if (!created) return;
    setName('');
    bump('classes');
    toast({ tone: 'success', title: `已建立班级「${created.name}」` });
  }

  async function saveRename() {
    if (!rename) return;
    const next = renameTo.trim();
    if (!next || next === rename.name) return;
    const updated = await write.run({ op: 'rename-class', class_id: rename.class_id, name: next }, (requestId) =>
      api<ClassDto>(`/classes/${rename.class_id}`, { method: 'PATCH', body: { name: next }, requestId }),
    );
    if (!updated) return;
    setRename(null);
    bump('classes');
    toast({ tone: 'success', title: `已改名为「${updated.name}」` });
  }

  async function confirmArchive() {
    if (!archive) return;
    const target = archive;
    const updated = await write.run({ op: 'archive-class', class_id: target.class_id }, (requestId) =>
      api<ClassDto>(`/classes/${target.class_id}`, { method: 'PATCH', body: { archived: true }, requestId }),
    );
    if (!updated) return;
    setArchive(null);
    bump('classes');
    toast({ tone: 'success', title: `已归档「${target.name}」`, detail: '它已退出日常列表，历史还在，可以恢复。' });
  }

  async function restore(row: ClassDto) {
    const updated = await write.run({ op: 'restore-class', class_id: row.class_id }, (requestId) =>
      api<ClassDto>(`/classes/${row.class_id}`, { method: 'PATCH', body: { archived: false }, requestId }),
    );
    if (!updated) return;
    bump('classes');
    toast({ tone: 'success', title: `已恢复「${updated.name}」` });
  }

  return (
    <section className="card">
      <header className="card-head">
        <div>
          <h2>班级</h2>
          <p className="muted small">日常列表只显示未归档的班。</p>
        </div>
        <OfflineHint />
      </header>
      <form
        className="manage-create"
        onSubmit={(e) => {
          e.preventDefault();
          void createClass();
        }}
      >
        <input
          value={name}
          maxLength={64}
          placeholder="例如 初一1班"
          aria-label="新班级名称"
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={write.disabled || !trimmed}>
          <Icon name="plus" size={16} />
          建立班级
        </button>
      </form>
      {list.loading && !list.data ? (
        <div className="page-loading">
          <Spinner />
        </div>
      ) : list.error && !list.data ? (
        <p className="manage-note">班级列表没有加载出来。可以先建立，或稍后刷新。</p>
      ) : active.length === 0 ? (
        <p className="manage-note">还没有班级。建立后就可以导入名单。</p>
      ) : (
        <ul className="manage-list">
          {active.map((row) => (
            <li key={row.class_id} className={`manage-row ${row.class_id === classId ? 'is-current' : ''}`}>
              <div className="manage-row-main">
                <strong>{row.name}</strong>
                <span>
                  {row.active_student_count} 人
                  {row.class_id === classId ? ' · 正在查看' : ''}
                </span>
              </div>
              <div className="manage-actions">
                <button type="button" className="btn btn-ghost btn-sm" disabled={write.disabled} onClick={() => setArchive(row)}>
                  归档
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={write.disabled}
                  onClick={() => {
                    setRename(row);
                    setRenameTo(row.name);
                  }}
                >
                  <Icon name="pen" size={14} />
                  改名
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {archived.length > 0 ? (
        <div className="manage-archived">
          <h3>已归档</h3>
          <ul className="manage-list">
            {archived.map((row) => (
              <li key={row.class_id} className="manage-row">
                <div className="manage-row-main">
                  <strong>{row.name}</strong>
                  <span>{row.active_student_count} 人 · 不在日常列表</span>
                </div>
                <div className="manage-actions">
                  <button type="button" className="btn btn-soft btn-sm" disabled={write.disabled} onClick={() => void restore(row)}>
                    恢复
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <Modal
        open={rename != null}
        title="修改班级名称"
        onClose={() => setRename(null)}
        width={420}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setRename(null)}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={write.disabled || !renameTo.trim() || renameTo.trim() === rename?.name}
              onClick={() => void saveRename()}
            >
              保存
            </button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void saveRename();
          }}
        >
          <label className="field">
            <span>班级名称</span>
            <input value={renameTo} maxLength={64} autoFocus aria-label="班级名称" onChange={(e) => setRenameTo(e.target.value)} />
          </label>
        </form>
      </Modal>
      <Modal
        open={archive != null}
        title="归档班级"
        tone="danger"
        subtitle={archive?.name}
        onClose={() => setArchive(null)}
        width={440}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setArchive(null)}>
              取消
            </button>
            <button type="button" className="btn btn-danger" disabled={write.disabled} onClick={() => void confirmArchive()}>
              归档这个班
            </button>
          </>
        }
      >
        <p>
          「{archive?.name}」会退出顶栏和日常页面
          {archive && archive.active_student_count > 0 ? `，${archive.active_student_count} 名在班学生暂时不会出现在座位图上` : ''}
          。学生、积分和座次都还在。需要时可以在本页恢复。
        </p>
      </Modal>
    </section>
  );
}
