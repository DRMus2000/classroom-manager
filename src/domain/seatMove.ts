/**
 * planSwap() — 换座。规范：docs/DESIGN.md §3.2。
 *
 * 允许来源区与目标区重叠。选中学生按座位号升序对到目标座位。
 * 目标上未选中的学生轮换到腾出的座位，role 为 affected。
 * 人数不等、学生不在座、目标座位不存在则拒绝。
 */

export interface SeatOccupancy {
  seat_id: string;
  seat_number: number;
  student_id: string | null;
}

export interface SeatGeometry extends SeatOccupancy {
  column_id: string;
  display_order: number;
  sort_in_column: number;
}

export interface SwapAssignment {
  student_id: string;
  from_seat_id: string;
  to_seat_id: string;
  role: 'selected' | 'affected';
}

export type SwapIssueCode = 'COUNT_MISMATCH' | 'TARGET_NOT_FOUND' | 'SOURCE_STUDENT_NOT_FOUND';

export interface SwapIssue {
  code: SwapIssueCode;
  message: string;
  offending_seat_ids?: string[];
}

export interface SwapPlan {
  ok: boolean;
  assignments: SwapAssignment[];
  issues: SwapIssue[];
}

/**
 * 换座求值。来源学生与目标座位数量必须相等。
 * 返回的 assignments 同时包含选中学生和被轮换的未选中学生。
 */
export function planSwap(
  allSeats: SeatOccupancy[],
  sourceStudentIds: string[],
  targetSeatIds: string[],
): SwapPlan {
  const issues: SwapIssue[] = [];
  const seatMap = new Map(allSeats.map((s) => [s.seat_id, s]));
  const studentSeatMap = new Map<string, SeatOccupancy>();
  for (const s of allSeats) {
    if (s.student_id) studentSeatMap.set(s.student_id, s);
  }

  const uniqueStudents = [...new Set(sourceStudentIds)];
  const uniqueTargets = [...new Set(targetSeatIds)];

  if (uniqueStudents.length !== uniqueTargets.length || uniqueStudents.length === 0) {
    issues.push({
      code: 'COUNT_MISMATCH',
      message: `来源学生 ${uniqueStudents.length} 人与目标座位 ${uniqueTargets.length} 个数量不匹配`,
    });
  }

  for (const sid of uniqueStudents) {
    if (!studentSeatMap.has(sid)) {
      issues.push({
        code: 'SOURCE_STUDENT_NOT_FOUND',
        message: `学生 ${sid} 不在座次图中或已离班`,
      });
    }
  }

  for (const tid of uniqueTargets) {
    if (!seatMap.has(tid)) {
      issues.push({
        code: 'TARGET_NOT_FOUND',
        message: `目标座位 ${tid} 不存在`,
        offending_seat_ids: [tid],
      });
    }
  }

  if (issues.length > 0) return { ok: false, assignments: [], issues };

  const sourceOrdered = uniqueStudents
    .map((sid) => {
      const seat = studentSeatMap.get(sid)!;
      return { student_id: sid, seat_id: seat.seat_id, seat_number: seat.seat_number };
    })
    .sort((a, b) => a.seat_number - b.seat_number);

  const targetOrdered = uniqueTargets
    .map((tid) => seatMap.get(tid)!)
    .sort((a, b) => a.seat_number - b.seat_number);

  const selected: SwapAssignment[] = sourceOrdered.map((src, i) => ({
    student_id: src.student_id,
    from_seat_id: src.seat_id,
    to_seat_id: targetOrdered[i]!.seat_id,
    role: 'selected',
  }));

  const sourceSeatIds = new Set(sourceOrdered.map((s) => s.seat_id));
  const targetSet = new Set(uniqueTargets);
  const vacated = [...sourceSeatIds]
    .filter((id) => !targetSet.has(id))
    .map((id) => seatMap.get(id)!)
    .sort((a, b) => a.seat_number - b.seat_number);

  const outsiders = targetOrdered.filter(
    (seat) => seat.student_id != null && !uniqueStudents.includes(seat.student_id),
  );

  const affected: SwapAssignment[] = outsiders.map((seat, i) => ({
    student_id: seat.student_id!,
    from_seat_id: seat.seat_id,
    to_seat_id: vacated[i]!.seat_id,
    role: 'affected',
  }));

  return { ok: true, assignments: [...selected, ...affected], issues: [] };
}

/** 已选学生当前座位号，供手机第一步展示。 */
export function describeSourceSeats(
  allSeats: SeatOccupancy[],
  studentIds: string[],
): { student_id: string; seat_number: number | null }[] {
  const studentSeatMap = new Map<string, SeatOccupancy>();
  for (const s of allSeats) {
    if (s.student_id) studentSeatMap.set(s.student_id, s);
  }
  return studentIds.map((sid) => ({
    student_id: sid,
    seat_number: studentSeatMap.get(sid)?.seat_number ?? null,
  }));
}

export interface AnchorExpansion {
  ok: boolean;
  target_seat_ids: string[];
  missing: { student_id: string; display_order: number; sort_in_column: number }[];
}

/**
 * 手机第二步：锚点是座位号最小的已选学生的目标座位。
 * 其余学生使用相同的列偏移（display_order）和槽位偏移（sort_in_column）。
 * 任一目标不存在则 ok 为 false，调用方禁止提交。
 */
export function expandTargetsFromAnchor(
  seats: SeatGeometry[],
  sourceStudentIds: string[],
  anchorSeatId: string,
): AnchorExpansion {
  const byStudent = new Map<string, SeatGeometry>();
  const byPos = new Map<string, SeatGeometry>();
  for (const s of seats) {
    if (s.student_id) byStudent.set(s.student_id, s);
    byPos.set(`${s.display_order}:${s.sort_in_column}`, s);
  }

  const anchor = seats.find((s) => s.seat_id === anchorSeatId);
  const sources = [...new Set(sourceStudentIds)]
    .map((id) => byStudent.get(id))
    .filter((s): s is SeatGeometry => s != null)
    .sort((a, b) => a.seat_number - b.seat_number);

  if (!anchor || sources.length === 0) {
    return { ok: false, target_seat_ids: [], missing: [] };
  }

  const origin = sources[0]!;
  const dCol = anchor.display_order - origin.display_order;
  const dSort = anchor.sort_in_column - origin.sort_in_column;
  const targetIds: string[] = [];
  const missing: AnchorExpansion['missing'] = [];

  for (const src of sources) {
    const key = `${src.display_order + dCol}:${src.sort_in_column + dSort}`;
    const target = byPos.get(key);
    if (!target) {
      missing.push({
        student_id: src.student_id!,
        display_order: src.display_order + dCol,
        sort_in_column: src.sort_in_column + dSort,
      });
    } else {
      targetIds.push(target.seat_id);
    }
  }

  return { ok: missing.length === 0, target_seat_ids: targetIds, missing };
}
