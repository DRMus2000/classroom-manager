import type { ClassSeatsDto, MarkDefDto, SeatCardDto } from '../../lib/types';
import type { DutyView } from '../../hooks/useApp';
import { columnGlyph, type Flash, type SeatDecor } from '../../components/SeatMap';
import { Icon } from '../../components/Icon';

export function SeatList(props: {
  seats: ClassSeatsDto;
  selected: ReadonlySet<string>;
  marks: ReadonlyMap<string, MarkDefDto>;
  duty: ReadonlyMap<string, DutyView>;
  decorate?: (card: SeatCardDto) => SeatDecor | undefined;
  flashes?: ReadonlyMap<string, Flash>;
  onSeatClick?: (card: SeatCardDto) => void;
}) {
  const cards = [...props.seats.cards].sort((a, b) => (a.seat_number ?? 0) - (b.seat_number ?? 0));
  return (
    <div className="seatlist" role="list">
      {cards.map((card) => {
        const s = card.student;
        const selected = s ? props.selected.has(s.student_id) : false;
        const duty = s ? props.duty.get(s.student_id) : undefined;
        const decor = props.decorate?.(card);
        const flash = s ? props.flashes?.get(s.student_id) : undefined;
        return (
          <button
            key={card.seat_id}
            type="button"
            role="listitem"
            className={`seatrow ${s ? '' : 'is-empty'} ${selected ? 'is-selected' : ''} ${duty ? 'is-duty' : ''} ${decor ? `tone-${decor.tone}` : ''}`}
            onClick={props.onSeatClick ? () => props.onSeatClick!(card) : undefined}
            disabled={!props.onSeatClick}
          >
            <span className="seatrow-check">{selected ? <Icon name="check" size={12} strokeWidth={3} /> : null}</span>
            <span className="seatrow-no">
              {card.seat_number ?? '—'}
              <em>{columnGlyph(card.column_code)}</em>
            </span>
            <span className="seatrow-name">
              {s ? s.name || '匿名' : '空座'}
              {s ? <small>{s.student_no}</small> : null}
            </span>
            <span className="seatrow-meta">
              {decor?.label ? <span className="seat-tag-inline">{decor.label}</span> : null}
              {duty ? (
                <span className={`duty-badge ${duty.upcoming ? 'is-upcoming' : ''}`}>
                  <Icon name="broom" size={11} strokeWidth={2} />
                  {duty.upcoming ? '新任' : `${duty.completed_count}/${duty.required_count}`}
                </span>
              ) : null}
              {s?.marks.map((id) => {
                const m = props.marks.get(id);
                return m ? (
                  <span key={id} className="mark-dot" style={{ color: m.color }} title={m.name}>
                    {m.icon}
                  </span>
                ) : null;
              })}
            </span>
            {s ? (
              <span className={`seatrow-score ${s.balance > 0 ? 'pos' : s.balance < 0 ? 'neg' : ''}`}>
                {s.balance}
                {flash ? (
                  <span key={flash.key} className={`seat-flash ${flash.delta > 0 ? 'pos' : 'neg'}`}>
                    {flash.delta > 0 ? `+${flash.delta}` : `−${Math.abs(flash.delta)}`}
                  </span>
                ) : null}
              </span>
            ) : (
              <span />
            )}
          </button>
        );
      })}
    </div>
  );
}
