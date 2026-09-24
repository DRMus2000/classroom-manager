import { useState } from 'react';
import { api, API_BASE } from '../../lib/api';
import type { Page, RankRow } from '../../lib/types';
import { rowName } from '../../lib/format';
import { useApp } from '../../hooks/useApp';
import { useResource } from '../../hooks/useResource';
import { Icon } from '../../components/Icon';
import { EmptyState, Segmented, Spinner } from '../../components/ui';
import { ReplayPlayer } from './ReplayPlayer';

type Tab = 'rank' | 'replay';

export function BoardPage() {
  const [tab, setTab] = useState<Tab>('rank');
  return (
    <div className="board">
      <div className="toolbar">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'rank', label: '排行榜', icon: 'trophy' },
            { value: 'replay', label: '动态回放', icon: 'play' },
          ]}
        />
      </div>
      {tab === 'rank' ? <Leaderboard /> : <ReplayPlayer />}
    </div>
  );
}

function Leaderboard() {
  const { classId, terms, currentTerm, tick, currentClass } = useApp();
  const [scope, setScope] = useState<'class' | 'all'>('class');
  const [termId, setTermId] = useState<string>('');
  const term = terms.find((t) => t.term_id === termId) ?? currentTerm;

  const query = term ? { term_id: term.term_id, class_id: scope === 'all' ? 'all' : classId } : null;
  const res = useResource(
    query ? () => api<Page<RankRow>>('/leaderboard', { query }) : null,
    [query?.term_id, query?.class_id, tick('points')],
  );
  const rows = res.data?.items ?? [];
  const exportHref = query ? `${API_BASE}/export/leaderboard?${new URLSearchParams(query).toString()}` : undefined;
  const top = rows[0]?.balance ?? 0;

  return (
    <section className="card board-card">
      <header className="card-head board-head">
        <div>
          <h2>{scope === 'all' ? '全部班级' : currentClass?.name}</h2>
          <p className="muted small">同分并列（1、1、3），较早达到当前分数者在前</p>
        </div>
        <div className="board-filters">
          <Segmented
            size="sm"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'class', label: '本班' },
              { value: 'all', label: '全部班级' },
            ]}
          />
          <label className="select-sm">
            <select value={term?.term_id ?? ''} onChange={(e) => setTermId(e.target.value)} aria-label="学期">
              {terms.map((t) => (
                <option key={t.term_id} value={t.term_id}>
                  {t.name}
                  {t.is_current ? '（当前）' : t.status === 'closed' ? '（只读）' : ''}
                </option>
              ))}
            </select>
            <Icon name="chevronDown" size={14} />
          </label>
          {exportHref ? (
            <a className="btn btn-ghost btn-sm" href={exportHref} download>
              <Icon name="download" size={15} />
              导出
            </a>
          ) : null}
        </div>
      </header>
      {res.loading && !res.data ? (
        <div className="page-loading">
          <Spinner />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState icon="trophy" title="还没有上榜的学生" hint="记分后会自动出现在这里。" />
      ) : (
        <ol className="ranks">
          {rows.map((row, i) => {
            const tied = (rows[i - 1]?.rank === row.rank) || (rows[i + 1]?.rank === row.rank);
            const width = top > 0 ? Math.max(0, (row.balance / top) * 100) : 0;
            return (
              <li key={row.student_id} className={`rank-row ${row.rank <= 3 ? `is-top is-top-${row.rank}` : ''}`}>
                <span className="rank-no">
                  {row.rank}
                  {tied ? <em>并列</em> : null}
                </span>
                <span className="rank-name">
                  <strong>{rowName(row)}</strong>
                  <small>
                    {scope === 'all' ? `${row.class_name} · ` : ''}
                    {row.student_no}
                  </small>
                </span>
                <span className="rank-bar" aria-hidden="true">
                  <span style={{ width: `${width}%` }} />
                </span>
                <span className={`rank-score ${row.balance < 0 ? 'neg' : ''}`}>{row.balance}</span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
