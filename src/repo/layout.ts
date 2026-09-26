/**
 * 全局机房布局数据访问：room_column / room_slot / layout_change。
 *
 * 约定（A1/A2）：
 * - 编号 seat_number 是显示属性，由应用层 renumerate() 统一回填。
 * - 删除机位前必须检查所有班级占用（见 countSlotOccupancy）。
 * - sort_in_column 是列内物理顺序，稳定不重排。
 */

import { sql, type Db, type Tx, now } from './db.js';
import type { SeatDirection, SeatFacing } from '../lib/schema.js';

export interface RoomColumnRow {
  column_id: string;
  code: string;
  display_order: number;
  direction: SeatDirection;
  facing: SeatFacing;
  label: string;
}

export interface RoomSlotRow {
  seat_id: string;
  column_id: string;
  column_code: string;
  sort_in_column: number;
  seat_number: number | null;
  label: string | null;
}

export interface RoomSlotWithOccupancy extends RoomSlotRow {
  occupant_class_count: number;
}

/** 全部列（按 display_order）。 */
export async function listColumns(db: Db | Tx): Promise<RoomColumnRow[]> {
  const rows = await db.execute<RoomColumnRow>(
    sql`SELECT column_id, code, display_order, direction, facing, label
        FROM room_column ORDER BY display_order`,
  );
  return rows;
}

/** 全部机位（含占用班级数）。 */
export async function listSlots(db: Db | Tx): Promise<RoomSlotWithOccupancy[]> {
  const rows = await db.execute<RoomSlotWithOccupancy>(
    sql`SELECT s.seat_id, s.column_id, c.code AS column_code, s.sort_in_column,
               s.seat_number, s.label,
               COALESCE(o.cnt, 0)::int AS occupant_class_count
        FROM room_slot s
        JOIN room_column c ON c.column_id = s.column_id
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS cnt FROM seat_assignment sa WHERE sa.seat_id = s.seat_id
        ) o ON true
        ORDER BY c.display_order, s.sort_in_column`,
  );
  return rows;
}

/** 查询单个机位。 */
export async function findSlot(db: Db | Tx, seatId: string): Promise<RoomSlotRow | null> {
  const rows = await db.execute<RoomSlotRow>(
    sql`SELECT s.seat_id, s.column_id, c.code AS column_code, s.sort_in_column, s.seat_number, s.label
        FROM room_slot s JOIN room_column c ON c.column_id = s.column_id
        WHERE s.seat_id = ${seatId}`,
  );
  return rows[0] ?? null;
}

/**
 * 该机位被多少个班级占用（删除前检查）。
 * 返回占用班级清单（用于 409 SEAT_OCCUPIED 的 details）。
 */
export async function slotOccupants(
  db: Db | Tx,
  seatId: string,
): Promise<{ class_id: string; name: string; student_id: string }[]> {
  const rows = await db.execute<{ class_id: string; name: string; student_id: string }>(
    sql`SELECT sa.class_id, c.name, sa.student_id
        FROM seat_assignment sa
        JOIN class c ON c.class_id = sa.class_id
        WHERE sa.seat_id = ${seatId}`,
  );
  return rows;
}

/**
 * 插入机位：把 after_sort 之后的槽位整体后移，为新槽位腾出位置。
 * sort_in_column 从 1 起；after_sort = 0 表示插到该列最前。
 */
export async function insertSlot(
  db: Tx,
  columnId: string,
  afterSort: number,
): Promise<RoomSlotRow> {
  // 后移既有槽位
  await db.execute(
    sql`UPDATE room_slot SET sort_in_column = sort_in_column + 1
        WHERE column_id = ${columnId} AND sort_in_column > ${afterSort}`,
  );

  const rows = await db.execute<RoomSlotRow>(
    sql`INSERT INTO room_slot (column_id, sort_in_column)
        VALUES (${columnId}, ${afterSort + 1})
        RETURNING seat_id, column_id, (SELECT code FROM room_column WHERE column_id = ${columnId}) AS column_code,
                  sort_in_column, seat_number, label`,
  );
  return rows[0]!;
}

/**
 * 调整机位位置（同一列内换槽位，或跨列移动）。
 * 跨列移动需要同时处理源列与目标列的槽位后移。
 */
export async function moveSlot(
  db: Tx,
  seatId: string,
  targetColumnId: string,
  afterSort: number,
): Promise<RoomSlotRow | null> {
  const current = await findSlot(db, seatId);
  if (!current) return null;

  const sameColumn = current.column_id === targetColumnId;

  if (sameColumn) {
    const from = current.sort_in_column;
    const to = afterSort + 1;

    if (from === to) return current; // 无变化

    if (from < to) {
      // 向后移动：中间的槽位整体前移
      await db.execute(
        sql`UPDATE room_slot SET sort_in_column = sort_in_column - 1
            WHERE column_id = ${targetColumnId}
              AND sort_in_column > ${from} AND sort_in_column <= ${to}`,
      );
    } else {
      // 向前移动：中间的槽位整体后移
      await db.execute(
        sql`UPDATE room_slot SET sort_in_column = sort_in_column + 1
            WHERE column_id = ${targetColumnId}
              AND sort_in_column >= ${to} AND sort_in_column < ${from}`,
      );
    }

    await db.execute(
      sql`UPDATE room_slot SET sort_in_column = ${to} WHERE seat_id = ${seatId}`,
    );
  } else {
    // 跨列移动：源列后面的槽位前移；目标列后面的槽位后移
    await db.execute(
      sql`UPDATE room_slot SET sort_in_column = sort_in_column - 1
          WHERE column_id = ${current.column_id} AND sort_in_column > ${current.sort_in_column}`,
    );
    await db.execute(
      sql`UPDATE room_slot SET sort_in_column = sort_in_column + 1
          WHERE column_id = ${targetColumnId} AND sort_in_column > ${afterSort}`,
    );
    await db.execute(
      sql`UPDATE room_slot
          SET column_id = ${targetColumnId}, sort_in_column = ${afterSort + 1}
          WHERE seat_id = ${seatId}`,
    );
  }

  return findSlot(db, seatId);
}

/**
 * 删除机位（调用方必须先检查占用）。
 * 删除后该编号永久作废，后续导入文件中出现该编号应报"座位不存在"。
 */
export async function deleteSlot(db: Tx, seatId: string): Promise<void> {
  const current = await findSlot(db, seatId);
  if (!current) return;

  await db.execute(sql`DELETE FROM room_slot WHERE seat_id = ${seatId}`);

  // 同列后续槽位前移，保持 sort_in_column 连续
  await db.execute(
    sql`UPDATE room_slot SET sort_in_column = sort_in_column - 1
        WHERE column_id = ${current.column_id} AND sort_in_column > ${current.sort_in_column}`,
  );
}

/**
 * 更新列的 direction / facing / label。
 * 只写入本次提供的字段，避免把未提供的值做成无类型 NULL。
 */
export async function updateColumn(
  db: Tx,
  columnId: string,
  patch: { direction?: SeatDirection; facing?: SeatFacing; label?: string },
): Promise<RoomColumnRow | null> {
  const returning = sql`RETURNING column_id, code, display_order, direction, facing, label`;
  const direction = patch.direction;
  const facing = patch.facing;
  const label = patch.label;
  let rows: RoomColumnRow[];
  if (direction !== undefined && facing !== undefined && label !== undefined) {
    rows = await db.execute<RoomColumnRow>(
      sql`UPDATE room_column SET direction = ${direction}, facing = ${facing}, label = ${label}
          WHERE column_id = ${columnId} ${returning}`,
    );
  } else if (direction !== undefined && facing !== undefined) {
    rows = await db.execute<RoomColumnRow>(
      sql`UPDATE room_column SET direction = ${direction}, facing = ${facing}
          WHERE column_id = ${columnId} ${returning}`,
    );
  } else if (direction !== undefined && label !== undefined) {
    rows = await db.execute<RoomColumnRow>(
      sql`UPDATE room_column SET direction = ${direction}, label = ${label}
          WHERE column_id = ${columnId} ${returning}`,
    );
  } else if (facing !== undefined && label !== undefined) {
    rows = await db.execute<RoomColumnRow>(
      sql`UPDATE room_column SET facing = ${facing}, label = ${label}
          WHERE column_id = ${columnId} ${returning}`,
    );
  } else if (direction !== undefined) {
    rows = await db.execute<RoomColumnRow>(
      sql`UPDATE room_column SET direction = ${direction} WHERE column_id = ${columnId} ${returning}`,
    );
  } else if (facing !== undefined) {
    rows = await db.execute<RoomColumnRow>(
      sql`UPDATE room_column SET facing = ${facing} WHERE column_id = ${columnId} ${returning}`,
    );
  } else if (label !== undefined) {
    rows = await db.execute<RoomColumnRow>(
      sql`UPDATE room_column SET label = ${label} WHERE column_id = ${columnId} ${returning}`,
    );
  } else {
    rows = await db.execute<RoomColumnRow>(
      sql`SELECT column_id, code, display_order, direction, facing, label
          FROM room_column WHERE column_id = ${columnId}`,
    );
  }
  return rows[0] ?? null;
}

/**
 * 回填座位编号（renumerate() 的结果落库）。
 * 先把全部编号置 NULL，再逐个写入，避免唯一索引冲突。
 */
export async function applySeatNumbers(
  db: Tx,
  diff: { seat_id: string; new_number: number }[],
): Promise<void> {
  await db.execute(sql`UPDATE room_slot SET seat_number = NULL`);

  // 批量更新（分组以控制语句长度）
  const CHUNK = 100;
  for (let i = 0; i < diff.length; i += CHUNK) {
    const chunk = diff.slice(i, i + CHUNK);
    for (const d of chunk) {
      await db.execute(
        sql`UPDATE room_slot SET seat_number = ${d.new_number} WHERE seat_id = ${d.seat_id}`,
      );
    }
  }
}

/** 记录布局变更审计。 */
export async function recordLayoutChange(
  db: Tx,
  input: {
    kind: string;
    payload: unknown;
    affectedClasses: unknown;
    renumberDiff: unknown;
    requestId: string;
  },
): Promise<void> {
  await db.execute(
    sql`INSERT INTO layout_change (kind, payload, affected_classes, renumber_diff, request_id)
        VALUES (${input.kind}, ${JSON.stringify(input.payload)},
                ${JSON.stringify(input.affectedClasses)}, ${JSON.stringify(input.renumberDiff)},
                ${input.requestId})`,
  );
}

/** 最近一次布局变更的重排差异（供 UI 提示"编号已重排"）。 */
export async function lastRenumberDiff(db: Db | Tx): Promise<
  { seat_id: string; old: number | null; new: number }[]
> {
  const rows = await db.execute<{ renumber_diff: { seat_id: string; old: number | null; new: number }[] }>(
    sql`SELECT renumber_diff FROM layout_change
        WHERE kind IN ('insert_slot','move_slot','delete_slot','change_column','renumber')
        ORDER BY created_at DESC LIMIT 1`,
  );
  return rows[0]?.renumber_diff ?? [];
}

/** 按座位号查找机位（导入用：文件里写的是显示编号）。 */
export async function findSlotByNumber(db: Db | Tx, seatNumber: number): Promise<RoomSlotRow | null> {
  const rows = await db.execute<RoomSlotRow>(
    sql`SELECT s.seat_id, s.column_id, c.code AS column_code, s.sort_in_column, s.seat_number, s.label
        FROM room_slot s JOIN room_column c ON c.column_id = s.column_id
        WHERE s.seat_number = ${seatNumber}`,
  );
  return rows[0] ?? null;
}
