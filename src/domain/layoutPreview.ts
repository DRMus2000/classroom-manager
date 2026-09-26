/**
 * 布局变更的编号试算。不访问数据库。
 * 槽位挪动与 src/repo/layout.ts 的插入、删除、移动保持同一顺序。
 */

import { renumerate, type RenumberDiff, type RoomColumn, type RoomSlot } from './renumber.js';

export type LayoutPreviewKind = 'insert_slot' | 'move_slot' | 'delete_slot' | 'change_column' | 'renumber';

/** 按拟议变更重排后，每个既有机位的旧号与新号。新插入的机位不在结果里。 */
export function previewRenumber(
  columns: RoomColumn[],
  slots: RoomSlot[],
  kind: LayoutPreviewKind,
  payload: Record<string, unknown>,
): RenumberDiff[] {
  const nextColumns = columns.map((column) => ({ ...column }));
  let nextSlots = slots.map((slot) => ({ ...slot }));

  if (kind === 'insert_slot') {
    const columnId = String(payload['column_id'] ?? '');
    const afterSort = Number(payload['after_sort'] ?? 0);
    nextSlots = nextSlots.map((slot) =>
      slot.column_id === columnId && slot.sort_in_column > afterSort
        ? { ...slot, sort_in_column: slot.sort_in_column + 1 }
        : slot,
    );
    nextSlots.push({
      seat_id: '__new__',
      column_id: columnId,
      sort_in_column: afterSort + 1,
      seat_number: null,
    });
  } else if (kind === 'delete_slot') {
    const seatId = String(payload['seat_id'] ?? '');
    const target = nextSlots.find((slot) => slot.seat_id === seatId);
    if (target) {
      nextSlots = nextSlots
        .filter((slot) => slot.seat_id !== seatId)
        .map((slot) =>
          slot.column_id === target.column_id && slot.sort_in_column > target.sort_in_column
            ? { ...slot, sort_in_column: slot.sort_in_column - 1 }
            : slot,
        );
    }
  } else if (kind === 'move_slot') {
    nextSlots = moveSlots(nextSlots, String(payload['seat_id'] ?? ''), String(payload['column_id'] ?? ''), Number(payload['after_sort'] ?? 0));
  } else if (kind === 'change_column') {
    const columnId = String(payload['column_id'] ?? '');
    const direction = payload['direction'];
    if (direction === 'toward_back' || direction === 'toward_front') {
      for (const column of nextColumns) {
        if (column.column_id === columnId) column.direction = direction;
      }
    }
  }

  return renumerate(nextColumns, nextSlots).filter((diff) => diff.seat_id !== '__new__');
}

function moveSlots(slots: RoomSlot[], seatId: string, targetColumnId: string, afterSort: number): RoomSlot[] {
  const current = slots.find((slot) => slot.seat_id === seatId);
  if (!current) return slots;
  const from = current.sort_in_column;
  const to = afterSort + 1;
  if (current.column_id === targetColumnId) {
    if (from === to) return slots;
    return slots.map((slot) => {
      if (slot.column_id !== targetColumnId) return slot;
      if (slot.seat_id === seatId) return { ...slot, sort_in_column: to };
      if (from < to && slot.sort_in_column > from && slot.sort_in_column <= to) {
        return { ...slot, sort_in_column: slot.sort_in_column - 1 };
      }
      if (from > to && slot.sort_in_column >= to && slot.sort_in_column < from) {
        return { ...slot, sort_in_column: slot.sort_in_column + 1 };
      }
      return slot;
    });
  }
  return slots.map((slot) => {
    if (slot.seat_id === seatId) return { ...slot, column_id: targetColumnId, sort_in_column: to };
    if (slot.column_id === current.column_id && slot.sort_in_column > from) {
      return { ...slot, sort_in_column: slot.sort_in_column - 1 };
    }
    if (slot.column_id === targetColumnId && slot.sort_in_column > afterSort) {
      return { ...slot, sort_in_column: slot.sort_in_column + 1 };
    }
    return slot;
  });
}
