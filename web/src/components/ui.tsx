import { useEffect, useRef, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { useApp } from '../hooks/useApp';

export function Segmented<T extends string>(props: {
  value: T;
  options: { value: T; label: ReactNode; icon?: IconName }[];
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  ariaLabel?: string;
}) {
  return (
    <div className={`segmented ${props.size === 'sm' ? 'segmented-sm' : ''}`} role="tablist" aria-label={props.ariaLabel}>
      {props.options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="tab"
          aria-selected={opt.value === props.value}
          className={opt.value === props.value ? 'is-active' : ''}
          onClick={() => props.onChange(opt.value)}
        >
          {opt.icon ? <Icon name={opt.icon} size={15} /> : null}
          <span>{opt.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Modal(props: {
  open: boolean;
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  tone?: 'default' | 'danger';
}) {
  const panel = useRef<HTMLDivElement>(null);
  const { onClose, open } = props;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    const field = panel.current?.querySelector<HTMLElement>('input, textarea, select');
    (field ?? panel.current)?.focus();
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panel}
        className={`modal ${props.tone === 'danger' ? 'modal-danger' : ''}`}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        style={props.width ? { maxWidth: props.width } : undefined}
      >
        <header className="modal-head">
          <div>
            <h2>{props.title}</h2>
            {props.subtitle ? <p className="muted">{props.subtitle}</p> : null}
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <Icon name="x" />
          </button>
        </header>
        <div className="modal-body">{props.children}</div>
        {props.footer ? <footer className="modal-foot">{props.footer}</footer> : null}
      </div>
    </div>
  );
}

export function Toasts() {
  const { toasts, dismissToast } = useApp();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone ?? 'info'}`}>
          <span className="toast-dot" />
          <div className="toast-text">
            <strong>{t.title}</strong>
            {t.detail ? <span>{t.detail}</span> : null}
          </div>
          {t.action ? (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          ) : null}
          <button type="button" className="toast-close" aria-label="关闭提示" onClick={() => dismissToast(t.id)}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function ConflictDialog() {
  const { conflict, resolveConflict } = useApp();
  return (
    <Modal
      open={conflict != null}
      title="数据已被其他设备修改"
      subtitle="为避免覆盖对方的修改，本次提交没有生效。"
      onClose={resolveConflict}
      width={420}
      footer={
        <button type="button" className="btn btn-primary" onClick={resolveConflict}>
          <Icon name="refresh" size={16} />
          载入最新状态
        </button>
      }
    >
      <p className="conflict-msg">{conflict?.message}</p>
    </Modal>
  );
}

export function EmptyState(props: { icon: IconName; title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name={props.icon} size={26} />
      </div>
      <h3>{props.title}</h3>
      {props.hint ? <p className="muted">{props.hint}</p> : null}
      {props.action}
    </div>
  );
}

export function OfflineHint() {
  const { online } = useApp();
  if (online) return null;
  return (
    <span className="offline-hint">
      <Icon name="lock" size={13} />
      离线中，仅可查看
    </span>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="加载中" />;
}
