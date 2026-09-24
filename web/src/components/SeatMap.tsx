import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { ClassSeatsDto, MarkDefDto, SeatCardDto } from '../lib/types';
import type { DutyView } from '../hooks/useApp';
import { groupTables, maxRows } from '../lib/seatGeometry';
import { Icon } from './Icon';

export type SeatTone = 'source' | 'target' | 'affected' | 'anchor' | 'dim' | 'missing' | 'picked';

export interface SeatDecor {
  tone: SeatTone;
  label?: string;
}

export type ZoomMode = number | 'fit' | 'fit-width';

export interface Flash {
  delta: number;
  key: number;
}

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧'];

export function columnGlyph(code: string): string {
  const n = Number(code);
  return Number.isInteger(n) && n >= 1 && n <= CIRCLED.length ? CIRCLED[n - 1]! : code;
}

interface SeatMapProps {
  seats: ClassSeatsDto;
  variant?: 'manage' | 'screen';
  selected?: ReadonlySet<string>;
  marks?: ReadonlyMap<string, MarkDefDto>;
  duty?: ReadonlyMap<string, DutyView>;
  decorate?: (card: SeatCardDto) => SeatDecor | undefined;
  flashes?: ReadonlyMap<string, Flash>;
  zoom?: ZoomMode;
  onZoomResolved?: (zoom: number) => void;
  /** 触屏点按时视为追加选择（手机没有 Ctrl）。 */
  onSeatClick?: (card: SeatCardDto, additive: boolean) => void;
  onColumnClick?: (code: string, additive: boolean) => void;
  onBoxSelect?: (studentIds: string[], additive: boolean) => void;
  onBlankClick?: () => void;
  showScores?: boolean;
}

interface DragState {
  x: number;
  y: number;
  additive: boolean;
  active: boolean;
  rects: { id: string; r: DOMRect }[];
}

export function SeatMap(props: SeatMapProps) {
  const variant = props.variant ?? 'manage';
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  const pointerType = useRef<string>('mouse');
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [boxed, setBoxed] = useState<ReadonlySet<string>>(new Set());
  const boxedRef = useRef<Set<string>>(new Set());
  const onBoxSelectRef = useRef(props.onBoxSelect);
  onBoxSelectRef.current = props.onBoxSelect;
  const [fitZoom, setFitZoom] = useState(1);

  const cards = props.seats.cards;
  const tables = useMemo(() => groupTables(props.seats.columns), [props.seats.columns]);
  const rows = useMemo(() => maxRows(cards), [cards]);
  const byColumn = useMemo(() => {
    const map = new Map<string, SeatCardDto[]>();
    for (const card of cards) {
      const list = map.get(card.column_code) ?? [];
      list.push(card);
      map.set(card.column_code, list);
    }
    return map;
  }, [cards]);

  const zoomMode = props.zoom ?? 1;
  const zoom = typeof zoomMode === 'number' ? zoomMode : fitZoom;
  const { onZoomResolved } = props;
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);

  // transform 不影响布局尺寸：offsetWidth/Height 始终是未缩放的自然尺寸。
  useLayoutEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const measure = () => {
      const w = inner.offsetWidth;
      const h = inner.offsetHeight;
      if (!w || !h) return;
      setNatural((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
      if (typeof zoomMode === 'number') return;
      const styles = getComputedStyle(el);
      const padX = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
      const padY = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
      const byW = (el.clientWidth - padX) / w;
      const byH = (el.clientHeight - padY) / h;
      const next = zoomMode === 'fit' ? Math.min(byW, byH) : byW;
      const clamped = Math.max(0.4, Math.min(variant === 'screen' ? 2.2 : 1.15, next));
      setFitZoom((prev) => (Math.abs(prev - clamped) > 0.005 ? clamped : prev));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [zoomMode, variant, rows, tables.length]);

  useEffect(() => {
    onZoomResolved?.(zoom);
  }, [zoom, onZoomResolved]);

  const interactive = variant === 'manage' && (props.onSeatClick || props.onBoxSelect);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointerType.current = e.pointerType;
    if (!props.onBoxSelect || e.pointerType !== 'mouse' || e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.col-head')) return;
    const rects = Array.from(content.current?.querySelectorAll<HTMLElement>('[data-student-id]') ?? []).map((node) => ({
      id: node.dataset.studentId!,
      r: node.getBoundingClientRect(),
    }));
    drag.current = { x: e.clientX, y: e.clientY, additive: e.ctrlKey || e.metaKey || e.shiftKey, active: false, rects };
  };

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.active && Math.hypot(dx, dy) < 6) return;
      d.active = true;
      const x = Math.min(d.x, e.clientX);
      const y = Math.min(d.y, e.clientY);
      const w = Math.abs(dx);
      const h = Math.abs(dy);
      setBox({ x, y, w, h });
      const hit = new Set<string>();
      for (const { id, r } of d.rects) {
        if (r.right >= x && r.left <= x + w && r.bottom >= y && r.top <= y + h) hit.add(id);
      }
      boxedRef.current = hit;
      setBoxed(hit);
      e.preventDefault();
    };
    const up = () => {
      const d = drag.current;
      drag.current = null;
      if (!d?.active) return;
      suppressClick.current = true;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      setBox(null);
      const hit = boxedRef.current;
      boxedRef.current = new Set();
      setBoxed(boxedRef.current);
      onBoxSelectRef.current?.([...hit], d.additive);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, []);

  const { onSeatClick, onBlankClick, onColumnClick } = props;
  const handleSeat = useCallback(
    (card: SeatCardDto, e: ReactMouseEvent) => {
      if (suppressClick.current) return;
      e.stopPropagation();
      const additive = e.ctrlKey || e.metaKey || e.shiftKey || pointerType.current !== 'mouse';
      onSeatClick?.(card, additive);
    },
    [onSeatClick],
  );

  const onBackgroundClick = (e: ReactMouseEvent) => {
    if (suppressClick.current) return;
    if ((e.target as HTMLElement).closest('.seat, .col-head')) return;
    onBlankClick?.();
  };

  return (
    <div
      ref={scroller}
      className={`seatmap-scroll seatmap-${variant} ${interactive ? 'is-interactive' : ''} ${zoomMode === 'fit' ? 'is-fit' : ''}`}
      onPointerDown={onPointerDown}
      onClick={onBackgroundClick}
    >
      <div className="seatmap-sizer" style={natural ? { width: natural.w * zoom, height: natural.h * zoom } : undefined}>
      <div ref={content} className="seatmap" style={{ transform: `scale(${zoom})` }}>
        <div className="room-front">
          <div className="podium">
            <span>讲台</span>
          </div>
        </div>
        <div className="room" style={{ ['--rows' as string]: rows }}>
          {tables.map((table, ti) => (
            <Fragment key={table.key}>
            {ti > 0 ? <div className="aisle" aria-hidden="true" /> : null}
            <div className={`desk ${table.columns.length === 2 ? 'desk-pair' : ''}`}>
              {table.columns.map((col) => {
                const list = byColumn.get(col.code) ?? [];
                const studentCount = list.filter((c) => c.student).length;
                return (
                  <div key={col.code} className={`col col-${col.facing}`}>
                    <button
                      type="button"
                      className="col-head"
                      disabled={!onColumnClick}
                      onClick={(e) => onColumnClick?.(col.code, e.ctrlKey || e.metaKey || e.shiftKey)}
                      title={onColumnClick ? `选择${columnGlyph(col.code)}列全部学生` : undefined}
                    >
                      <span className="col-glyph">{columnGlyph(col.code)}</span>
                      {variant === 'manage' ? (
                        <span className="col-count">
                          {studentCount}/{list.length}
                        </span>
                      ) : null}
                    </button>
                    <div className="col-seats">
                      {list.map((card) => (
                        <SeatCard
                          key={card.seat_id}
                          card={card}
                          variant={variant}
                          selected={card.student ? props.selected?.has(card.student.student_id) ?? false : false}
                          boxed={card.student ? boxed.has(card.student.student_id) : false}
                          marks={props.marks}
                          duty={card.student ? props.duty?.get(card.student.student_id) : undefined}
                          decor={props.decorate?.(card)}
                          flash={card.student ? props.flashes?.get(card.student.student_id) : undefined}
                          showScore={props.showScores ?? variant === 'manage'}
                          onClick={props.onSeatClick ? handleSeat : undefined}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            </Fragment>
          ))}
          <div className="door" aria-label="门">
            <Icon name="door" size={14} />
            <span>门</span>
          </div>
        </div>
      </div>
      </div>
      {box ? <div className="lasso" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} /> : null}
    </div>
  );
}

interface SeatCardProps {
  card: SeatCardDto;
  variant: 'manage' | 'screen';
  selected: boolean;
  boxed: boolean;
  marks?: ReadonlyMap<string, MarkDefDto>;
  duty?: DutyView;
  decor?: SeatDecor;
  flash?: Flash;
  showScore: boolean;
  onClick?: (card: SeatCardDto, e: ReactMouseEvent) => void;
}

const SeatCard = memo(function SeatCard(props: SeatCardProps) {
  const { card, duty, decor } = props;
  const student = card.student;
  const classes = ['seat', `face-${card.facing}`];
  if (!student) classes.push('is-empty');
  if (props.selected) classes.push('is-selected');
  if (props.boxed) classes.push('is-boxed');
  if (duty) classes.push('is-duty');
  if (decor) classes.push(`tone-${decor.tone}`);
  const balance = student?.balance ?? 0;
  const studentMarks = student && props.marks ? student.marks.map((id) => props.marks!.get(id)).filter(Boolean) : [];

  return (
    <button
      type="button"
      className={classes.join(' ')}
      style={{ gridRow: card.sort_in_column }}
      data-seat-id={card.seat_id}
      data-student-id={student?.student_id}
      onClick={props.onClick ? (e) => props.onClick!(card, e) : undefined}
      tabIndex={props.onClick ? 0 : -1}
      aria-pressed={props.onClick && student ? props.selected : undefined}
      aria-label={student ? `${card.seat_number ?? ''}号 ${student.name}` : `${card.seat_number ?? ''}号 空座`}
    >
      <span className="seat-pc" aria-hidden="true" />
      <span className="seat-no">{card.seat_number ?? '—'}</span>
      <span className="seat-body">
        <span className="seat-name">{student ? student.name || '匿名' : '空座'}</span>
        {student && (studentMarks.length > 0 || duty) ? (
          <span className="seat-meta">
            {duty ? (
              <span className={`duty-badge ${duty.upcoming ? 'is-upcoming' : ''}`} title={duty.upcoming ? '下一轮新任卫生管理员' : '卫生管理员'}>
                <Icon name="broom" size={11} strokeWidth={2} />
                {duty.upcoming ? '新任' : `${duty.completed_count}/${duty.required_count}`}
              </span>
            ) : null}
            {props.variant === 'manage'
              ? studentMarks.map((m) => (
                  <span key={m!.mark_id} className="mark-dot" style={{ color: m!.color }} title={m!.name}>
                    {m!.icon}
                  </span>
                ))
              : null}
          </span>
        ) : null}
      </span>
      {student && props.showScore ? (
        <span className={`seat-score ${balance > 0 ? 'pos' : balance < 0 ? 'neg' : ''}`}>{balance}</span>
      ) : null}
      {decor?.label ? <span className="seat-tag">{decor.label}</span> : null}
      {props.selected ? (
        <span className="seat-check" aria-hidden="true">
          <Icon name="check" size={11} strokeWidth={3} />
        </span>
      ) : null}
      {props.flash ? (
        <span key={props.flash.key} className={`seat-flash ${props.flash.delta > 0 ? 'pos' : 'neg'}`} aria-hidden="true">
          {props.flash.delta > 0 ? `+${props.flash.delta}` : `−${Math.abs(props.flash.delta)}`}
        </span>
      ) : null}
    </button>
  );
});
