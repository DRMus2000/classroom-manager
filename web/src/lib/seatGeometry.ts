/**
 * 座位图几何。只做显示和手机锚点展开，换座结果以服务端 `/seats/plan` 为准。
 */
import type { RoomColumnDto, SeatCardDto } from './schema';

export interface TableGroup {
  key: string;
  columns: RoomColumnDto[];
}

/**
 * 相邻两列若左列 `facing = left`、右列 `facing = right`，电脑在两列之间背对背，
 * 视为同一张长桌（初始布局：④③ 一桌、②① 一桌，中间是过道）。
 */
export function groupTables(columns: readonly RoomColumnDto[]): TableGroup[] {
  const ordered = [...columns].sort((a, b) => a.display_order - b.display_order);
  const tables: TableGroup[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const left = ordered[i]!;
    const right = ordered[i + 1];
    if (right && left.facing === 'left' && right.facing === 'right') {
      tables.push({ key: `${left.code}-${right.code}`, columns: [left, right] });
      i++;
    } else {
      tables.push({ key: left.code, columns: [left] });
    }
  }
  return tables;
}

export function maxRows(cards: readonly SeatCardDto[]): number {
  return cards.reduce((max, card) => Math.max(max, card.sort_in_column), 0);
}

export interface AnchorExpansion {
  ok: boolean;
  target_seat_ids: string[];
  missing_student_ids: string[];
  origin_student_id: string | null;
}

/**
 * 与 `src/domain/seatMove.ts` 的 `expandTargetsFromAnchor` 相同：
 * 锚点是座位号最小的已选学生要去的座位，其余学生沿用同样的列偏移（display_order）
 * 与槽位偏移（sort_in_column）。任一目标不存在则 ok 为 false。
 */
export function expandTargetsFromAnchor(
  cards: readonly SeatCardDto[],
  columns: readonly RoomColumnDto[],
  sourceStudentIds: readonly string[],
  anchorSeatId: string,
): AnchorExpansion {
  const orderOf = new Map(columns.map((c) => [c.code, c.display_order]));
  const geometry = cards.map((card) => ({
    card,
    display_order: orderOf.get(card.column_code) ?? 0,
  }));
  const byStudent = new Map<string, (typeof geometry)[number]>();
  const byPos = new Map<string, (typeof geometry)[number]>();
  for (const g of geometry) {
    if (g.card.student) byStudent.set(g.card.student.student_id, g);
    byPos.set(`${g.display_order}:${g.card.sort_in_column}`, g);
  }
  const anchor = geometry.find((g) => g.card.seat_id === anchorSeatId);
  const sources = [...new Set(sourceStudentIds)]
    .map((id) => byStudent.get(id))
    .filter((g): g is (typeof geometry)[number] => g != null)
    .sort((a, b) => (a.card.seat_number ?? 0) - (b.card.seat_number ?? 0));
  if (!anchor || sources.length === 0) {
    return { ok: false, target_seat_ids: [], missing_student_ids: [], origin_student_id: null };
  }
  const origin = sources[0]!;
  const dCol = anchor.display_order - origin.display_order;
  const dSort = anchor.card.sort_in_column - origin.card.sort_in_column;
  const targets: string[] = [];
  const missing: string[] = [];
  for (const src of sources) {
    const hit = byPos.get(`${src.display_order + dCol}:${src.card.sort_in_column + dSort}`);
    if (hit) targets.push(hit.card.seat_id);
    else missing.push(src.card.student!.student_id);
  }
  return {
    ok: missing.length === 0,
    target_seat_ids: targets,
    missing_student_ids: missing,
    origin_student_id: origin.card.student!.student_id,
  };
}
