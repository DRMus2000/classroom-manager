import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './lib/api';
import type { MeDto } from './lib/types';
import { AppProvider, useApp } from './hooks/useApp';
import { useWrite } from './hooks/useWrite';
import { Icon, type IconName } from './components/Icon';
import { Logo } from './components/Logo';
import { ConflictDialog, EmptyState, Spinner, Toasts } from './components/ui';
import { SyncStatus } from './components/SyncStatus';
import { Login } from './features/Login';
import { ClassroomPage } from './features/classroom/ClassroomPage';
import { DutyPage } from './features/duty/DutyPage';
import { BoardPage } from './features/board/BoardPage';
import { ToolsPage } from './features/tools/ToolsPage';
import { ScreenPage } from './features/screen/ScreenPage';
import { ManagePage } from './features/manage/ManagePage';
import { RosterPage } from './features/roster/RosterPage';

type Route = 'class' | 'duty' | 'board' | 'tools' | 'screen' | 'manage' | 'roster';

const NAV: { id: Exclude<Route, 'screen' | 'manage'>; label: string; icon: IconName }[] = [
  { id: 'class', label: '课堂', icon: 'seat' },
  { id: 'duty', label: '卫生', icon: 'broom' },
  { id: 'board', label: '榜单', icon: 'trophy' },
  { id: 'tools', label: '点名', icon: 'dice' },
];

function readRoute(): Route {
  const id = window.location.hash.replace(/^#\/?/, '').split('?')[0];
  return (['class', 'duty', 'board', 'tools', 'screen', 'manage', 'roster'] as const).find((r) => r === id) ?? 'class';
}

function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(readRoute);
  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const go = useCallback((r: Route) => {
    window.location.hash = `/${r}`;
  }, []);
  return [route, go];
}

export function App() {
  const [me, setMe] = useState<MeDto | null | undefined>(undefined);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    api<MeDto>('/auth/me')
      .then(setMe)
      .catch(() => setMe(null));
  }, []);

  const signedOut = useCallback(() => {
    setNotice('会话已失效，请重新登录。');
    setMe(null);
  }, []);

  if (me === undefined) {
    return (
      <div className="boot">
        <Logo size={40} />
        <Spinner />
      </div>
    );
  }
  if (me === null) {
    return (
      <Login
        notice={notice}
        onSignedIn={(user) => {
          setNotice('');
          setMe(user);
        }}
      />
    );
  }
  return (
    <AppProvider me={me} onSignedOut={signedOut}>
      <Shell />
    </AppProvider>
  );
}

function Shell() {
  const [route, go] = useRoute();
  const app = useApp();

  if (route === 'screen') {
    return (
      <>
        <ScreenPage onExit={() => go('class')} />
        <Toasts />
        <ConflictDialog />
      </>
    );
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <Logo size={34} />
          <div>
            <strong>电脑室积分</strong>
            <span>{app.termsKnown ? (app.currentTerm?.name ?? '尚无当前学期') : '…'}</span>
          </div>
        </div>
        <nav className="side-nav" aria-label="主导航">
          {NAV.map((item) => (
            <a key={item.id} href={`#/${item.id}`} className={route === item.id ? 'is-active' : ''} aria-current={route === item.id ? 'page' : undefined}>
              <Icon name={item.icon} size={19} />
              <span>{item.label}</span>
            </a>
          ))}
          <a href="#/manage" className={route === 'manage' ? 'is-active' : ''} aria-current={route === 'manage' ? 'page' : undefined}>
            <Icon name="settings" size={19} />
            <span>管理</span>
          </a>
        </nav>
        <a href="#/screen" className="side-screen">
          <Icon name="screen" size={18} />
          <span>全屏展示</span>
          <Icon name="arrowRight" size={15} className="side-screen-arrow" />
        </a>
        <UserMenu />
      </aside>

      <div className="main">
        <header className="topbar">
          <ClassSwitcher />
          {app.termsKnown && app.currentTerm ? (
            <a href="#/manage" className="term-chip" title="管理学期和班级">
              {app.currentTerm.name}
            </a>
          ) : app.termsKnown ? (
            <a href="#/manage" className="term-chip is-warn" title="去建立学期">
              未设置当前学期
            </a>
          ) : null}
          <span className="topbar-spacer" />
          <SyncStatus />
          <a href="#/screen" className="btn btn-ghost btn-sm topbar-screen">
            <Icon name="screen" size={16} />
            <span>展示</span>
          </a>
        </header>
        <OfflineBanner />
        <main className="page">
          <PageBody route={route} />
        </main>
      </div>

      <nav className="tabbar" aria-label="主导航">
        {NAV.map((item) => (
          <a key={item.id} href={`#/${item.id}`} className={route === item.id ? 'is-active' : ''}>
            <Icon name={item.icon} size={21} />
            <span>{item.label}</span>
          </a>
        ))}
        <a href="#/screen">
          <Icon name="screen" size={21} />
          <span>展示</span>
        </a>
        <a href="#/manage" className={route === 'manage' ? 'is-active' : ''}>
          <Icon name="settings" size={21} />
          <span>管理</span>
        </a>
      </nav>

      <Toasts />
      <ConflictDialog />
    </div>
  );
}

function PageBody(props: { route: Route }) {
  const app = useApp();
  if (props.route === 'manage') return <ManagePage />;
  if (!app.classesKnown) {
    return (
      <div className="page-loading">
        <Spinner />
      </div>
    );
  }
  if (!app.classId) {
    return (
      <EmptyState
        icon="users"
        title={app.classesError ? '班级列表没有加载出来' : '还没有可以上课的班级'}
        hint={app.classesError ? '请检查网络后再试。学期和班级可以在管理页建立。' : '先建立学期和班级，再导入名单。'}
        action={
          app.classesError ? (
            <button type="button" className="btn btn-primary" onClick={() => app.bump('classes')}>
              <Icon name="refresh" size={16} />
              重试
            </button>
          ) : (
            <a className="btn btn-primary" href="#/manage">
              去建立
              <Icon name="arrowRight" size={16} />
            </a>
          )
        }
      />
    );
  }
  if (props.route === 'class') return <ClassroomPage />;
  if (props.route === 'roster') return <RosterPage />;
  if (props.route === 'duty') return <DutyPage />;
  if (props.route === 'board') return <BoardPage />;
  return <ToolsPage />;
}

function ClassSwitcher() {
  const { classes, classId, setClassId, currentClass } = useApp();
  return (
    <label className="class-switch">
      <span className="class-switch-label">{currentClass?.name ?? '选择班级'}</span>
      <span className="class-switch-meta">{currentClass ? `${currentClass.active_student_count} 人` : ''}</span>
      <Icon name="chevronDown" size={16} />
      <select value={classId} onChange={(e) => setClassId(e.target.value)} aria-label="切换班级">
        {classes.map((c) => (
          <option key={c.class_id} value={c.class_id}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function OfflineBanner() {
  const { online, recheck } = useApp();
  if (online) return null;
  return (
    <div className="offline-banner" role="status">
      <Icon name="wifiOff" size={18} />
      <div>
        <strong>网络已断开</strong>
        <span>已保留当前页面内容，暂停一切修改。连接恢复后会自动刷新。</span>
      </div>
      <button type="button" className="btn btn-sm" onClick={recheck}>
        重试连接
      </button>
    </div>
  );
}

function UserMenu() {
  const { me, logout, toast } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const write = useWrite();

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  async function logoutOthers() {
    const ok = await write.run('logout-others', (requestId) =>
      api('/auth/logout-others', { method: 'POST', body: {}, requestId }),
      {
        onError: (err) => err instanceof ApiError && err.isAuthFailure,
      },
    );
    if (ok) toast({ tone: 'success', title: '其他设备已退出登录' });
    setOpen(false);
  }

  return (
    <div className="user" ref={ref}>
      <button type="button" className="user-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="avatar">{me.username.slice(0, 1).toUpperCase()}</span>
        <span className="user-name">{me.username}</span>
        <Icon name="more" size={16} />
      </button>
      {open ? (
        <div className="menu" role="menu">
          <button type="button" role="menuitem" disabled={write.disabled} onClick={() => void logoutOthers()}>
            <Icon name="users" size={16} />
            退出其他设备
          </button>
          <button type="button" role="menuitem" onClick={logout}>
            <Icon name="logout" size={16} />
            退出登录
          </button>
        </div>
      ) : null}
    </div>
  );
}
