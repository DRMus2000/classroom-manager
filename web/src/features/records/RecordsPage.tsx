import { useState } from 'react';
import { API_BASE, api } from '../../lib/api';
import { useApp } from '../../hooks/useApp';
import { useResource } from '../../hooks/useResource';
import { Icon } from '../../components/Icon';
import { EmptyState, Segmented, Spinner } from '../../components/ui';

type Tab = 'audit' | 'backup';

interface AuditItem {
  audit_id: number;
  actor: string;
  entity: string;
  entity_id: string;
  action: string;
  before: unknown;
  after: unknown;
  request_id: string | null;
  created_at: string;
}

interface AuditPage {
  items: AuditItem[];
  next_cursor: string | null;
}

interface BackupRecord {
  backup_id: string;
  file_name: string;
  size_bytes: number | null;
  status: 'running' | 'success' | 'failed';
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

const ACTION_LABEL: Record<string, string> = {
  login: '登录',
  change_password: '修改密码',
  logout: '退出登录',
  layout_insert_slot: '加了一座',
  layout_delete_slot: '删了一座',
  layout_move_slot: '移动了座位',
  layout_change_column: '调整了列',
  layout_renumber: '重排了编号',
  leave: '学生离班',
  restore: '学生回班',
  create: '新建',
  updated: '修改',
  overridden: '按班级改了原因',
  cleared: '恢复全校原因',
  added: '打上标记',
  removed: '摘下标记',
  archived: '停用标记',
};

export function RecordsPage() {
  const [tab, setTab] = useState<Tab>('audit');
  return (
    <div className="records">
      <div className="toolbar">
        <a href="#/manage" className="btn btn-ghost btn-sm">
          <Icon name="chevronLeft" size={16} />
          返回管理
        </a>
        <div>
          <h1 className="roster-title">审计和备份</h1>
          <p className="muted small">这里看做过什么，以及下载数据库备份。不能把备份恢复进正在使用的库。</p>
        </div>
        <span className="toolbar-spacer" />
        <Segmented
          value={tab}
          onChange={setTab}
          ariaLabel="审计和备份"
          options={[
            { value: 'audit', label: '操作记录', icon: 'history' },
            { value: 'backup', label: '备份', icon: 'download' },
          ]}
        />
      </div>
      {tab === 'audit' ? <AuditPanel /> : <BackupPanel />}
    </div>
  );
}

function AuditPanel() {
  const { me, reportError } = useApp();
  const page = useResource(() => api<AuditPage>('/audit', { query: { limit: 40 } }), []);
  const [more, setMore] = useState<AuditItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const cursor = nextCursor === undefined ? page.data?.next_cursor ?? null : nextCursor;
  const items = [...(page.data?.items ?? []), ...more];

  async function loadOlder() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await api<AuditPage>('/audit', { query: { limit: 40, cursor } });
      setMore((list) => list.concat(next.items));
      setNextCursor(next.next_cursor);
    } catch (err) {
      reportError(err);
    } finally {
      setLoadingMore(false);
    }
  }

  if (page.loading && items.length === 0) {
    return (
      <div className="page-loading">
        <Spinner />
      </div>
    );
  }
  if (!page.data && page.error) {
    return <EmptyState icon="history" title="操作记录没有加载出来" hint="请检查网络后再试。" action={<button type="button" className="btn btn-primary" onClick={() => page.reload()}>重试</button>} />;
  }
  if (items.length === 0) {
    return <EmptyState icon="history" title="还没有操作记录" />;
  }

  return (
    <section className="card">
      <ul className="manage-list">
        {items.map((item) => (
          <li key={item.audit_id} className="manage-row records-row">
            <div className="manage-row-main">
              <strong>{ACTION_LABEL[item.action] ?? item.action}</strong>
              <span>
                {item.actor === me.teacher_id ? '当前账号' : '教师'}
                {' · '}
                {item.entity}
                {' · '}
                {formatTime(item.created_at)}
              </span>
            </div>
            <details className="records-detail">
              <summary>详情</summary>
              <pre>{JSON.stringify({ before: item.before, after: item.after }, null, 2)}</pre>
            </details>
          </li>
        ))}
      </ul>
      {cursor ? (
        <button type="button" className="btn btn-ghost records-more" disabled={loadingMore} onClick={() => void loadOlder()}>
          看更早的记录
        </button>
      ) : null}
    </section>
  );
}

function BackupPanel() {
  const list = useResource(() => api<BackupRecord[]>('/backup/records'), []);
  if (list.loading && !list.data) {
    return (
      <div className="page-loading">
        <Spinner />
      </div>
    );
  }
  if (!list.data && list.error) {
    return <EmptyState icon="download" title="备份记录没有加载出来" action={<button type="button" className="btn btn-primary" onClick={() => list.reload()}>重试</button>} />;
  }
  const rows = list.data ?? [];
  return (
    <section className="card">
      <p className="manage-note">服务器每天 02:15 做一次备份，保留 30 天。下载下来的文件要在另一台数据库上恢复，不能覆盖正在上课的这一份。</p>
      {rows.length === 0 ? (
        <EmptyState icon="download" title="还没有备份记录" hint="到了计划时间，成功或失败都会出现在这里。" />
      ) : (
        <ul className="manage-list">
          {rows.map((row) => (
            <li key={row.backup_id} className="manage-row">
              <div className="manage-row-main">
                <strong>{row.file_name}</strong>
                <span>
                  {statusLabel(row.status)}
                  {row.size_bytes != null ? ` · ${formatBytes(row.size_bytes)}` : ''}
                  {' · '}
                  {formatTime(row.started_at)}
                  {row.error ? ` · ${row.error}` : ''}
                </span>
              </div>
              {row.status === 'success' ? (
                <a className="btn btn-primary btn-sm" href={`${API_BASE}/backup/download/${row.backup_id}`}>
                  <Icon name="download" size={14} />
                  下载
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function statusLabel(status: BackupRecord['status']): string {
  if (status === 'success') return '成功';
  if (status === 'failed') return '失败';
  return '进行中';
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
