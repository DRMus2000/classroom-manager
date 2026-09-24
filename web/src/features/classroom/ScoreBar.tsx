import type { EffectiveTemplateDto } from '../../lib/types';
import { signed } from '../../lib/format';
import { useApp } from '../../hooks/useApp';
import { Icon } from '../../components/Icon';

export interface ScoreIntent {
  delta: number;
  template: EffectiveTemplateDto | null;
}

const QUICK = [1, 2, -1, -2];

/**
 * 选中学生后出现的底部操作栏。单人点击即提交，多人先确认。
 */
export function ScoreBar(props: {
  count: number;
  names: string[];
  disabled: boolean;
  disabledReason?: string;
  onScore: (intent: ScoreIntent) => void;
  onCustom: () => void;
  onClear: () => void;
}) {
  const { templates } = useApp();
  const plus = templates.filter((t) => t.polarity === 1);
  const minus = templates.filter((t) => t.polarity === -1);
  const more = props.count - props.names.length;

  return (
    <div className="dock scorebar" role="toolbar" aria-label="记分">
      <div className="scorebar-who">
        <span className="scorebar-count">{props.count}</span>
        <div className="scorebar-names">
          <strong>{props.count === 1 ? props.names[0] : `已选 ${props.count} 人`}</strong>
          <span>
            {props.count === 1
              ? '点击即记分'
              : `${props.names.join('、')}${more > 0 ? ` 等` : ''} · 提交前确认`}
          </span>
        </div>
        <button type="button" className="icon-btn" onClick={props.onClear} aria-label="取消选择">
          <Icon name="x" size={16} />
        </button>
      </div>

      <div className="scorebar-actions">
        <div className="quick">
          {QUICK.map((d) => (
            <button
              key={d}
              type="button"
              className={`quick-btn ${d > 0 ? 'pos' : 'neg'}`}
              disabled={props.disabled}
              onClick={() => props.onScore({ delta: d, template: null })}
            >
              {signed(d)}
            </button>
          ))}
        </div>
        <div className="reasons">
          {[...plus, ...minus].map((t) => (
            <button
              key={t.template_id}
              type="button"
              className={`reason ${t.polarity > 0 ? 'pos' : 'neg'}`}
              disabled={props.disabled}
              onClick={() => props.onScore({ delta: t.effective_delta, template: t })}
            >
              <span>{t.effective_name}</span>
              <em>{signed(t.effective_delta)}</em>
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-soft btn-sm scorebar-custom" disabled={props.disabled} onClick={props.onCustom}>
          <Icon name="pen" size={15} />
          自定义
        </button>
      </div>
      {props.disabledReason ? <p className="scorebar-warn">{props.disabledReason}</p> : null}
    </div>
  );
}
