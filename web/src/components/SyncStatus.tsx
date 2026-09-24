import { useApp } from '../hooks/useApp';

export function SyncStatus() {
  const { online, sse } = useApp();
  const state = !online ? 'offline' : sse === 'open' ? 'live' : 'wait';
  const label = state === 'offline' ? '离线' : state === 'live' ? '实时同步' : '正在连接';
  return (
    <span className={`sync sync-${state}`} title={state === 'live' ? '其他设备的修改会自动出现在这里' : undefined}>
      <span className="sync-dot" />
      {label}
    </span>
  );
}
