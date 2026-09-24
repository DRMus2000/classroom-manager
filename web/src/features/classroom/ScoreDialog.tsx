import { useEffect, useState } from 'react';
import type { EffectiveTemplateDto } from '../../lib/types';
import { signed } from '../../lib/format';
import { useApp } from '../../hooks/useApp';
import { Modal } from '../../components/ui';
import type { ScoreIntent } from './ScoreBar';

/**
 * 自定义记分，以及批量记分前的确认。
 * 模板方向固定：选了模板只能改绝对值，不能反转正负。
 */
export function ScoreDialog(props: {
  open: boolean;
  count: number;
  names: string[];
  preset: ScoreIntent | null;
  pending: boolean;
  disabled: boolean;
  onClose: () => void;
  onSubmit: (intent: ScoreIntent) => void;
}) {
  const { templates } = useApp();
  const [template, setTemplate] = useState<EffectiveTemplateDto | null>(null);
  const [sign, setSign] = useState<1 | -1>(1);
  const [amount, setAmount] = useState('1');

  useEffect(() => {
    if (!props.open) return;
    const p = props.preset;
    setTemplate(p?.template ?? null);
    setSign(p ? (p.delta < 0 ? -1 : 1) : 1);
    setAmount(String(p ? Math.abs(p.delta) : 1));
  }, [props.open, props.preset]);

  const magnitude = Number(amount);
  const valid = Number.isInteger(magnitude) && magnitude > 0 && magnitude <= 1000;
  const effectiveSign = template ? template.polarity : sign;
  const delta = valid ? effectiveSign * magnitude : 0;
  const confirmOnly = props.preset != null;

  const chooseTemplate = (t: EffectiveTemplateDto | null) => {
    setTemplate(t);
    if (t) {
      setSign(t.polarity);
      setAmount(String(Math.abs(t.effective_delta)));
    }
  };

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title={confirmOnly ? '确认批量记分' : '自定义记分'}
      subtitle={props.count > 1 ? `共 ${props.count} 人，将作为同一批次一起提交` : props.names[0]}
      width={480}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={props.onClose}>
            取消
          </button>
          <button
            type="button"
            className={`btn ${delta < 0 ? 'btn-danger' : 'btn-primary'}`}
            disabled={!valid || props.disabled || props.pending}
            onClick={() => props.onSubmit({ delta, template })}
          >
            {props.pending ? '提交中…' : `${props.count > 1 ? `${props.count} 人` : ''} ${valid ? signed(delta) : ''} 确认`}
          </button>
        </>
      }
    >
      <div className={`score-summary ${delta < 0 ? 'neg' : 'pos'}`}>
        <span className="score-summary-delta">{valid ? signed(delta) : '—'}</span>
        <div>
          <strong>{template ? template.effective_name : '未选原因'}</strong>
          <span>
            {props.names.slice(0, 6).join('、')}
            {props.names.length > 6 ? ` 等 ${props.names.length} 人` : ''}
          </span>
        </div>
      </div>

      {!confirmOnly || template == null ? null : (
        <p className="muted small">可以调整本次分值的大小，方向跟随原因模板。</p>
      )}

      <div className="field">
        <span>原因</span>
        <div className="chip-grid">
          <button type="button" className={`chip ${template == null ? 'is-active' : ''}`} onClick={() => chooseTemplate(null)}>
            不选原因
          </button>
          {templates.map((t) => (
            <button
              key={t.template_id}
              type="button"
              className={`chip ${t.polarity > 0 ? 'chip-pos' : 'chip-neg'} ${template?.template_id === t.template_id ? 'is-active' : ''}`}
              onClick={() => chooseTemplate(t)}
            >
              {t.effective_name}
              <em>{signed(t.effective_delta)}</em>
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span>分值</span>
        <div className="delta-input">
          <div className="sign-toggle" role="group" aria-label="加分或减分">
            <button type="button" className={effectiveSign > 0 ? 'is-active pos' : ''} disabled={template != null} onClick={() => setSign(1)}>
              加分
            </button>
            <button type="button" className={effectiveSign < 0 ? 'is-active neg' : ''} disabled={template != null} onClick={() => setSign(-1)}>
              减分
            </button>
          </div>
          <input
            inputMode="numeric"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
            aria-label="分值大小"
          />
        </div>
        {!valid ? <small className="form-error">请输入 1–1000 的整数</small> : null}
      </div>

    </Modal>
  );
}
