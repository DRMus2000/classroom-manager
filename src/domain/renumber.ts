/**
 * renumerate() — 座位编号重排。规范：docs/DESIGN.md §3.1。
 *
 * 列按 ①→②→③→④（display_order 降序）遍历。
 * toward_back 按 sort_in_column 升序（讲台→后墙）。
 * toward_front 按 sort_in_column 降序（后墙→讲台）。
 * 历史 seat_number_snapshot 不因重排改写。
 */

import type { SeatDirection } from '../lib/schema.js';

export interface RoomColumn {
  column_id: string;
  code: string;
  display_order: number;
  direction: SeatDirection;
}

export interface RoomSlot {
  seat_id: string;
  column_id: string;
  sort_in_column: number;
  seat_number: number | null;
}

export interface RenumberDiff {
  seat_id: string;
  old_number: number | null;
  new_number: number;
}

/** 为全部座位生成新编号。返回每个座位的旧号与新号。 */
export function renumerate(columns: RoomColumn[], slots: RoomSlot[]): RenumberDiff[] {
  const sorted = [...columns].sort((a, b) => b.display_order - a.display_order);

  const slotsByColumn = new Map<string, RoomSlot[]>();
  for (const s of slots) {
    const arr = slotsByColumn.get(s.column_id) ?? [];
    arr.push(s);
    slotsByColumn.set(s.column_id, arr);
  }

  let num = 1;
  const diff: RenumberDiff[] = [];

  for (const col of sorted) {
    const colSlots = [...(slotsByColumn.get(col.column_id) ?? [])];
    colSlots.sort((a, b) =>
      col.direction === 'toward_back'
        ? a.sort_in_column - b.sort_in_column
        : b.sort_in_column - a.sort_in_column,
    );
    for (const s of colSlots) {
      diff.push({ seat_id: s.seat_id, old_number: s.seat_number, new_number: num });
      num++;
    }
  }

  return diff;
}

/** 把重排结果写回 slots，返回编号发生变化的座位数。 */
export function applyRenumberDiff(slots: RoomSlot[], diff: RenumberDiff[]): number {
  const map = new Map(diff.map((d) => [d.seat_id, d.new_number]));
  let changed = 0;
  for (const s of slots) {
    const newNum = map.get(s.seat_id);
    if (newNum != null && s.seat_number !== newNum) {
      s.seat_number = newNum;
      changed++;
    }
  }
  return changed;
}

/** 只保留编号实际变化的差异，供审计和界面提示。 */
export function changedDiff(diff: RenumberDiff[]): RenumberDiff[] {
  return diff.filter((d) => d.old_number !== d.new_number);
}
