import { useEffect, useState } from 'react';
import { Modal, Segmented } from '../../components/ui';

type Action = 'release' | 'restore' | 'adjust_count';

/** 人工纠正任期。必须写理由；不能用重新抽签代替纠错。 */
export function CorrectDialog(props: {
  target: { duty_term_id: string; completed: number; required: number; status: string } | null;
  name: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: { action: Action; note: string; completed_count?: number; required_count?: number }) => void;
}) {
  const [action, setAction] = useState<Action>('adjust_count');
  const [note, setNote] = useState('');
  const [completed, setCompleted] = useState('0');
  const [required, setRequired] = useState('3');

  useEffect(() => {
    if (!props.target) return;
    setAction(props.target.status === 'active' ? 'adjust_count' : 'restore');
    setNote('');
    setCompleted(String(props.target.completed));
    setRequired(String(props.target.required));
  }, [props.target]);

  const c = Number(completed);
  const r = Number(required);
  const countsValid = Number.isInteger(c) && c >= 0 && Number.isInteger(r) && r >= 1;
  const valid = note.trim().length > 0 && (action !== 'adjust_count' || countsValid);

  return (
    <Modal
      open={props.target != null}
      onClose={props.onClose}
      title="人工纠正任期"
      subtitle={`${props.name} · 当前 ${props.target?.completed ?? 0}/${props.target?.required ?? 3}`}
      width={460}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={props.onClose}>
            取消
          </button>
          <button
            type="button"
            className={`btn ${action === 'release' ? 'btn-danger' : 'btn-primary'}`}
            disabled={!valid || props.busy}
            onClick={() =>
              props.onSubmit(
                action === 'adjust_count'
                  ? { action, note: note.trim(), completed_count: c, required_count: r }
                  : { action, note: note.trim() },
              )
            }
          >
            保存纠正
          </button>
        </>
      }
    >
      <Segmented
        value={action}
        onChange={setAction}
        options={[
          { value: 'adjust_count', label: '纠正次数' },
          { value: 'release', label: '解除任期' },
          { value: 'restore', label: '恢复任期' },
        ]}
      />
      {action === 'adjust_count' ? (
        <div className="field-row">
          <label className="field">
            <span>完成次数</span>
            <input inputMode="numeric" value={completed} onChange={(e) => setCompleted(e.target.value.replace(/[^\d]/g, ''))} />
          </label>
          <label className="field">
            <span>应完成次数</span>
            <input inputMode="numeric" value={required} onChange={(e) => setRequired(e.target.value.replace(/[^\d]/g, ''))} />
          </label>
        </div>
      ) : (
        <p className="muted small">
          {action === 'release' ? '解除后该生不再是卫生管理员，历史任期保留。' : '恢复为在任状态，完成次数保持不变。'}
        </p>
      )}
      <label className="field">
        <span>理由（必填，会写入操作记录）</span>
        <textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：登记错误" />
      </label>
      <p className="muted small">若被纠正的人正是待确认抽选的结果，该抽选会作废并释放候选。</p>
    </Modal>
  );
}
