/**
 * 倒计时。只同步开始、暂停、继续、重置和绝对截止时间。
 * 已超时的 running 在读取、暂停或重置时记为 finished。
 */

import { type Db, db as defaultDb, withTx } from '../repo/db.js';
import * as classRepo from '../repo/class.js';
import * as countdownRepo from '../repo/countdown.js';
import * as auditRepo from '../repo/audit.js';
import { idempotentTx } from './idempotency.js';
import { Errors } from '../lib/errors.js';
import {
  applyCountdown,
  settleCountdown,
  type CountdownAction,
  type CountdownSnapshot,
} from '../domain/countdown.js';

export interface CountdownView {
  class_id: string;
  status: CountdownSnapshot['status'];
  duration_sec: number | null;
  deadline_at: string | null;
  remaining_sec: number | null;
  updated_at: string | null;
}

function toIso(value: Date | string | null): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function rowToSnapshot(row: countdownRepo.CountdownRow): CountdownSnapshot {
  const deadline = row.deadline_at == null ? null : new Date(row.deadline_at).getTime();
  return {
    status: row.status,
    duration_sec: Number(row.duration_sec),
    deadline_ms: deadline != null && Number.isNaN(deadline) ? null : deadline,
    remaining_sec: row.remaining_sec == null ? null : Number(row.remaining_sec),
  };
}

function toView(classId: string, state: CountdownSnapshot, updatedAt: string | null, nowMs: number): CountdownView {
  const settled = settleCountdown(state, nowMs);
  return {
    class_id: classId,
    status: settled.status,
    duration_sec: settled.duration_sec,
    deadline_at: settled.deadline_ms == null ? null : new Date(settled.deadline_ms).toISOString(),
    remaining_sec: settled.status === 'running' ? null : settled.remaining_sec,
    updated_at: updatedAt,
  };
}

async function ensureClass(db: Db, classId: string) {
  const cls = await classRepo.findClass(db, classId);
  if (!cls) throw Errors.notFound('班级', classId);
}

export async function getCountdown(classId: string, db: Db = defaultDb, nowMs = Date.now()): Promise<CountdownView> {
  await ensureClass(db, classId);
  const row = await countdownRepo.findCountdown(db, classId);
  if (!row) {
    return {
      class_id: classId,
      status: 'reset',
      duration_sec: null,
      deadline_at: null,
      remaining_sec: null,
      updated_at: null,
    };
  }
  const snapshot = rowToSnapshot(row);
  const settled = settleCountdown(snapshot, nowMs);
  if (settled.status === 'finished' && snapshot.status === 'running') {
    await withTx(db, async (tx) => {
      const locked = await countdownRepo.lockCountdown(tx, classId);
      if (!locked || locked.status !== 'running') return;
      const again = settleCountdown(rowToSnapshot(locked), nowMs);
      if (again.status !== 'finished' || again.duration_sec == null) return;
      await countdownRepo.upsertCountdown(tx, {
        class_id: classId,
        duration_sec: again.duration_sec,
        status: 'finished',
        deadline_at: again.deadline_ms == null ? null : new Date(again.deadline_ms),
        remaining_sec: 0,
        updated_by: locked.updated_by,
      });
    });
  }
  return toView(classId, settled, toIso(row.updated_at), nowMs);
}

export async function commandCountdown(
  actorId: string,
  classId: string,
  action: CountdownAction,
  durationSec: number | undefined,
  requestId: string,
  db: Db = defaultDb,
  nowMs = Date.now(),
): Promise<CountdownView> {
  return idempotentTx(
    db,
    requestId,
    `PUT /api/v1/countdown/${classId}`,
    { action, duration_sec: durationSec ?? null, request_id: requestId },
    async (tx) => {
      const cls = await classRepo.findClass(tx, classId);
      if (!cls) throw Errors.notFound('班级', classId);
      const locked = await countdownRepo.lockCountdown(tx, classId);
      const current = locked ? rowToSnapshot(locked) : null;
      const applied = applyCountdown(current, action, durationSec, nowMs);
      if (!applied.ok) {
        if (applied.reason === 'duration_required') throw Errors.forbidden('倒计时需要 1 到 86400 秒的时长');
        if (applied.reason === 'not_started') throw Errors.forbidden('倒计时尚未开始');
        throw Errors.forbidden('当前状态不能执行该倒计时动作');
      }
      const next = applied.state;
      if (next.duration_sec == null) throw Errors.forbidden('倒计时需要 1 到 86400 秒的时长');
      const saved = await countdownRepo.upsertCountdown(tx, {
        class_id: classId,
        duration_sec: next.duration_sec,
        status: next.status,
        deadline_at: next.deadline_ms == null ? null : new Date(next.deadline_ms),
        remaining_sec: next.remaining_sec,
        updated_by: actorId,
      });
      const view = toView(classId, next, toIso(saved.updated_at), nowMs);
      await auditRepo.writeEvent(tx, {
        class_id: classId,
        kind: 'countdown_changed',
        payload: {
          class_id: classId,
          action,
          status: view.status,
          duration_sec: view.duration_sec,
          deadline_at: view.deadline_at,
          remaining_sec: view.remaining_sec,
        },
      });
      await auditRepo.writeAudit(tx, {
        actor: actorId,
        entity: 'countdown_state',
        entity_id: classId,
        action,
        after: {
          status: view.status,
          duration_sec: view.duration_sec,
          deadline_at: view.deadline_at,
          remaining_sec: view.remaining_sec,
        },
        request_id: requestId,
      });
      return view;
    },
  );
}
