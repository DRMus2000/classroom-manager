/**
 * 全局布局服务：插入/调整/删除机位、改列属性、编号重排。
 *
 * 约定（A1/A2）：
 * - 编号是显示属性：任何插入/删除都触发 renumerate()，编号整体重排。
 * - 历史快照（point_entry.seat_number_snapshot）永不因重排改写。
 * - 删除机位前必须检查所有班级：仍有人占用 → 禁止删除。
 * - 影响预览 + 审计记录。
 */

import { type Db, db as defaultDb } from '../repo/db.js';
import { idempotentTx } from './idempotency.js';
import * as layoutRepo from '../repo/layout.js';
import * as auditRepo from '../repo/audit.js';
import { writeEvent } from './publishEvent.js';
import { renumerate, changedDiff, type RoomColumn, type RoomSlot } from '../domain/renumber.js';
import { Errors } from '../lib/errors.js';
import type {
  LayoutDto,
  LayoutImpactDto,
  LayoutChangeKind,
  RoomSlotDto,
  RoomColumnDto,
} from '../lib/schema.js';
import { createHash } from 'node:crypto';

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

export async function getLayout(db: Db = defaultDb): Promise<LayoutDto> {
  const [columns, slots, lastDiff] = await Promise.all([
    layoutRepo.listColumns(db),
    layoutRepo.listSlots(db),
    layoutRepo.lastRenumberDiff(db),
  ]);

  const columnDtos: RoomColumnDto[] = columns.map((c) => ({
    column_id: c.column_id,
    code: c.code,
    display_order: c.display_order,
    direction: c.direction,
    facing: c.facing,
    label: c.label,
    slot_count: slots.filter((s) => s.column_id === c.column_id).length,
  }));

  const slotDtos: RoomSlotDto[] = slots.map((s) => ({
    seat_id: s.seat_id,
    column_id: s.column_id,
    column_code: s.column_code,
    sort_in_column: s.sort_in_column,
    seat_number: s.seat_number,
    label: s.label,
    occupant_class_count: s.occupant_class_count,
  }));

  return {
    columns: columnDtos,
    slots: slotDtos,
    total_slots: slots.length,
    last_renumber_diff: lastDiff,
  };
}

/* ------------------------------------------------------------------ */
/* 影响预览                                                            */
/* ------------------------------------------------------------------ */

/**
 * 预览布局变更的影响：受影响班级、座次变化、编号重排差异、阻塞原因。
 * 返回 preview_hash，提交时必须回传（防止预览后布局被他人改动）。
 */
export async function previewLayoutChange(
  kind: LayoutChangeKind,
  payload: Record<string, unknown>,
  db: Db = defaultDb,
): Promise<LayoutImpactDto> {
  const [columns, slots, allAssignments] = await Promise.all([
    layoutRepo.listColumns(db),
    layoutRepo.listSlots(db),
    db.execute<{ class_id: string; name: string; seat_id: string }>(
      // 所有班级的座次占用
      (await import('../repo/db.js')).sql`
        SELECT sa.class_id, c.name, sa.seat_id
        FROM seat_assignment sa JOIN class c ON c.class_id = sa.class_id`,
    ),
  ]);

  const blockers: { code: 'SEAT_OCCUPIED'; message: string }[] = [];
  const affected = new Map<string, { class_id: string; name: string; students_moved: number; seat_assignments_removed: number }>();

  // 删除/移动机位时，检查占用
  if (kind === 'delete_slot' || kind === 'move_slot') {
    const seatId = payload['seat_id'] as string;
    const occupants = allAssignments.filter((a) => a.seat_id === seatId);

    if (kind === 'delete_slot' && occupants.length > 0) {
      blockers.push({
        code: 'SEAT_OCCUPIED',
        message: `该机位仍被 ${occupants.length} 个班级占用，无法删除`,
      });
    }

    for (const o of occupants) {
      const cur = affected.get(o.class_id) ?? {
        class_id: o.class_id,
        name: o.name,
        students_moved: 0,
        seat_assignments_removed: 0,
      };
      if (kind === 'delete_slot') cur.seat_assignments_removed++;
      else cur.students_moved++;
      affected.set(o.class_id, cur);
    }
  }

  // 计算重排差异（模拟变更后的编号）
  const simulatedDiff = simulateRenumber(columns, slots, kind, payload);

  const previewHash = createHash('sha256')
    .update(
      JSON.stringify({
        kind,
        payload,
        columns: columns.map((c) => ({ id: c.column_id, dir: c.direction, ord: c.display_order })),
        slots: slots.map((s) => ({ id: s.seat_id, col: s.column_id, sort: s.sort_in_column })),
        occupied: allAssignments.length,
      }),
    )
    .digest('hex');

  return {
    kind,
    affected_classes: [...affected.values()],
    renumber_diff: changedDiff(simulatedDiff).map((d) => ({
      seat_id: d.seat_id,
      old: d.old_number,
      new: d.new_number,
    })),
    blockers,
    preview_hash: previewHash,
  };
}

/** 模拟变更后的编号（不落库），用于预览差异。 */
function simulateRenumber(
  columns: { column_id: string; code: string; display_order: number; direction: any }[],
  slots: { seat_id: string; column_id: string; sort_in_column: number; seat_number: number | null }[],
  kind: LayoutChangeKind,
  payload: Record<string, unknown>,
): { seat_id: string; old_number: number | null; new_number: number }[] {
  let simulatedSlots: RoomSlot[] = slots.map((s) => ({ ...s }));

  if (kind === 'insert_slot') {
    const columnId = payload['column_id'] as string;
    const afterSort = Number(payload['after_sort'] ?? 0);
    // 模拟插入一个新槽位（用临时 id）
    simulatedSlots = simulatedSlots.map((s) =>
      s.column_id === columnId && s.sort_in_column > afterSort
        ? { ...s, sort_in_column: s.sort_in_column + 1 }
        : s,
    );
    simulatedSlots.push({
      seat_id: '__new__',
      column_id: columnId,
      sort_in_column: afterSort + 1,
      seat_number: null,
    });
  } else if (kind === 'delete_slot') {
    const seatId = payload['seat_id'] as string;
    const target = simulatedSlots.find((s) => s.seat_id === seatId);
    if (target) {
      simulatedSlots = simulatedSlots
        .filter((s) => s.seat_id !== seatId)
        .map((s) =>
          s.column_id === target.column_id && s.sort_in_column > target.sort_in_column
            ? { ...s, sort_in_column: s.sort_in_column - 1 }
            : s,
        );
    }
  }

  const cols: RoomColumn[] = columns.map((c) => ({
    column_id: c.column_id,
    code: c.code,
    display_order: c.display_order,
    direction: c.direction,
  }));

  return renumerate(cols, simulatedSlots).filter((d) => d.seat_id !== '__new__');
}

/* ------------------------------------------------------------------ */
/* 提交变更                                                            */
/* ------------------------------------------------------------------ */

export async function applyLayoutChange(
  actorId: string,
  kind: LayoutChangeKind,
  payload: Record<string, unknown>,
  previewHash: string,
  requestId: string,
  db: Db = defaultDb,
): Promise<{ renumber_diff: { seat_id: string; old: number | null; new: number }[]; total_slots: number }> {
  return idempotentTx(
    db,
    requestId,
    'POST /api/v1/layout/apply-change',
    { kind, payload, preview_hash: previewHash, request_id: requestId },
    async (tx) => {
    // 1. 重新预览，校验 preview_hash 仍有效（防止预览后布局被改动）
    const fresh = await previewLayoutChange(kind, payload, tx);
    if (fresh.preview_hash !== previewHash) {
      throw Errors.versionConflict('布局已被其他设备修改，请重新预览');
    }
    if (fresh.blockers.length > 0) {
      throw Errors.seatOccupied(
        String(payload['seat_id'] ?? ''),
        fresh.affected_classes.map((c) => c.name),
      );
    }

    // 2. 执行变更
    const beforeSlots = await layoutRepo.listSlots(tx);

    switch (kind) {
      case 'insert_slot': {
        await layoutRepo.insertSlot(
          tx,
          String(payload['column_id']),
          Number(payload['after_sort'] ?? 0),
        );
        break;
      }
      case 'move_slot': {
        await layoutRepo.moveSlot(
          tx,
          String(payload['seat_id']),
          String(payload['column_id']),
          Number(payload['after_sort'] ?? 0),
        );
        break;
      }
      case 'delete_slot': {
        await layoutRepo.deleteSlot(tx, String(payload['seat_id']));
        break;
      }
      case 'change_column': {
        await layoutRepo.updateColumn(tx, String(payload['column_id']), {
          direction: payload['direction'] as any,
          facing: payload['facing'] as any,
          label: payload['label'] as string | undefined,
        });
        break;
      }
      case 'renumber':
        break; // 仅触发重排
    }

    // 3. 重排编号
    const [columns, slotsAfter] = await Promise.all([
      layoutRepo.listColumns(tx),
      layoutRepo.listSlots(tx),
    ]);

    const diff = renumerate(
      columns.map((c) => ({
        column_id: c.column_id,
        code: c.code,
        display_order: c.display_order,
        direction: c.direction,
      })),
      slotsAfter.map((s) => ({
        seat_id: s.seat_id,
        column_id: s.column_id,
        sort_in_column: s.sort_in_column,
        seat_number: s.seat_number,
      })),
    );

    await layoutRepo.applySeatNumbers(
      tx,
      diff.map((d) => ({ seat_id: d.seat_id, new_number: d.new_number })),
    );

    const changed = changedDiff(diff);

    // 4. 审计 + 事件
    await layoutRepo.recordLayoutChange(tx, {
      kind,
      payload,
      affectedClasses: fresh.affected_classes,
      renumberDiff: changed,
      requestId,
    });

    await auditRepo.writeAudit(tx, {
      actor: actorId,
      entity: 'room_layout',
      entity_id: kind,
      action: `layout_${kind}`,
      before: { slots: beforeSlots.length },
      after: { slots: slotsAfter.length, renumber_changes: changed.length },
      request_id: requestId,
    });

    await writeEvent(tx, {
      class_id: null, // 全局事件
      kind: 'layout_changed',
      payload: {
        kind,
        renumber_diff: changed.map((d) => ({
          seat_id: d.seat_id,
          old: d.old_number,
          new: d.new_number,
        })),
        total_slots: slotsAfter.length,
      },
    });

    return {
      renumber_diff: changed.map((d) => ({
        seat_id: d.seat_id,
        old: d.old_number,
        new: d.new_number,
      })),
      total_slots: slotsAfter.length,
    };
  });
}

/** 删除机位前的占用检查（供路由层预览用）。 */
export async function checkSlotOccupancy(
  seatId: string,
  db: Db = defaultDb,
): Promise<{ occupied: boolean; classes: { class_id: string; name: string }[] }> {
  const occupants = await layoutRepo.slotOccupants(db, seatId);
  const byClass = new Map<string, string>();
  for (const o of occupants) byClass.set(o.class_id, o.name);
  return {
    occupied: occupants.length > 0,
    classes: [...byClass.entries()].map(([class_id, name]) => ({ class_id, name })),
  };
}
