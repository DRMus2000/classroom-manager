/**
 * 回放纯函数：按事件推进在班集合与余额，再截 Top10。
 *
 * 检查点 state 与区间起点都用同一套结构。名次规则与当前榜相同，
 * 但成员是该序号当时的在班集合，匿名化后显示代号。
 */

import { assignRanks, compareRank } from './points.js';
import type { ReplayMode } from '../lib/schema.js';

export interface ReplayStudentState {
  student_id: string;
  class_id: string;
  balance: number;
  last_change_seq: number;
  present: boolean;
  anonymized: boolean;
}

export interface ReplayWorld {
  students: Map<string, ReplayStudentState>;
}

export interface CheckpointStudentState {
  balance: number;
  last_change_seq: number;
  class_id: string;
  present: boolean;
  anonymized: boolean;
}

export type CheckpointState = Record<string, CheckpointStudentState>;

export interface ReplayEvent {
  event_seq: number;
  kind: string;
  payload: unknown;
}

export interface ReplayIdentity {
  student_id: string;
  class_id: string;
  class_name: string;
  name: string;
  student_no: string;
  anon_code: string | null;
}

export interface ReplayRankRow {
  rank: number;
  student_id: string;
  name: string;
  student_no: string;
  anon_code: string | null;
  class_id: string;
  class_name: string;
  balance: number;
  last_change_seq: number;
}

export function emptyWorld(): ReplayWorld {
  return { students: new Map() };
}

export function worldFromCheckpoint(state: unknown): ReplayWorld {
  const world = emptyWorld();
  if (!state || typeof state !== 'object' || Array.isArray(state)) return world;
  for (const [studentId, raw] of Object.entries(state as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    world.students.set(studentId, {
      student_id: studentId,
      class_id: String(row.class_id ?? ''),
      balance: Number(row.balance ?? 0),
      last_change_seq: Number(row.last_change_seq ?? 0),
      present: row.present === undefined ? true : Boolean(row.present),
      anonymized: Boolean(row.anonymized),
    });
  }
  return world;
}

export function snapshotWorld(world: ReplayWorld): CheckpointState {
  const state: CheckpointState = {};
  for (const [studentId, row] of world.students) {
    state[studentId] = {
      balance: row.balance,
      last_change_seq: row.last_change_seq,
      class_id: row.class_id,
      present: row.present,
      anonymized: row.anonymized,
    };
  }
  return state;
}

export function snapshotBalances(world: ReplayWorld): Map<string, number> {
  const out = new Map<string, number>();
  for (const [studentId, row] of world.students) {
    out.set(studentId, row.balance);
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function upsertStudent(world: ReplayWorld, studentId: string, classId: string): ReplayStudentState {
  const existing = world.students.get(studentId);
  if (existing) return existing;
  const created: ReplayStudentState = {
    student_id: studentId,
    class_id: classId,
    balance: 0,
    last_change_seq: 0,
    present: false,
    anonymized: false,
  };
  world.students.set(studentId, created);
  return created;
}

function applyRoster(world: ReplayWorld, classId: string, payload: Record<string, unknown>): void {
  const action = String(payload.action ?? '');
  const studentId = typeof payload.student_id === 'string' ? payload.student_id : '';
  if (action === 'student_created' && studentId) {
    const row = upsertStudent(world, studentId, classId);
    row.class_id = classId;
    row.present = true;
    return;
  }
  if (action === 'student_left' && studentId) {
    const row = upsertStudent(world, studentId, classId);
    row.present = false;
    return;
  }
  if (action === 'student_restored' && studentId) {
    const row = upsertStudent(world, studentId, classId);
    row.class_id = classId;
    row.present = true;
    return;
  }
  if (action === 'student_anonymized' && studentId) {
    const row = upsertStudent(world, studentId, classId);
    row.anonymized = true;
    return;
  }
  if (action === 'import_committed') {
    const ids = payload.created_student_ids;
    if (!Array.isArray(ids)) return;
    for (const id of ids) {
      if (typeof id !== 'string' || id.length === 0) continue;
      const row = upsertStudent(world, id, classId);
      row.class_id = classId;
      row.present = true;
    }
  }
}

function applyPoints(
  world: ReplayWorld,
  classId: string,
  termId: string,
  eventSeq: number,
  payload: Record<string, unknown>,
): void {
  if (payload.term_id != null && String(payload.term_id) !== termId) return;
  if (payload.class_id != null && String(payload.class_id) !== classId) return;
  const entries = payload.entries;
  if (!Array.isArray(entries)) return;
  for (const item of entries) {
    const entry = asRecord(item);
    if (!entry) continue;
    const studentId = typeof entry.student_id === 'string' ? entry.student_id : '';
    if (!studentId) continue;
    const delta = Number(entry.delta ?? 0);
    if (!Number.isFinite(delta) || delta === 0) continue;
    const row = upsertStudent(world, studentId, classId);
    row.class_id = classId;
    row.balance += delta;
    row.last_change_seq = eventSeq;
  }
}

export function applyReplayEvent(
  world: ReplayWorld,
  event: ReplayEvent,
  classId: string,
  termId: string,
): void {
  const payload = asRecord(event.payload) ?? {};
  const eventClassId = typeof payload.class_id === 'string' ? payload.class_id : classId;
  if (eventClassId && eventClassId !== classId) return;
  if (event.kind === 'roster_changed') {
    applyRoster(world, classId, payload);
    return;
  }
  if (event.kind === 'points_appended') {
    applyPoints(world, classId, termId, event.event_seq, payload);
  }
}

export function rankingFromWorld(
  world: ReplayWorld,
  identities: Map<string, ReplayIdentity>,
  mode: ReplayMode,
  rangeStartSeq: number,
  rangeStartBalances: Map<string, number>,
): ReplayRankRow[] {
  const rows: Array<Omit<ReplayRankRow, 'rank'> & { class_name: string; student_no: string }> = [];
  for (const [studentId, state] of world.students) {
    if (!state.present) continue;
    const identity = identities.get(studentId);
    if (!identity) continue;
    const anonymized = state.anonymized || Boolean(identity.anon_code);
    const before = rangeStartBalances.get(studentId) ?? 0;
    const balance = mode === 'net' ? state.balance - before : state.balance;
    const lastChangeSeq =
      mode === 'net' && state.last_change_seq <= rangeStartSeq ? 0 : state.last_change_seq;
    rows.push({
      student_id: studentId,
      name: anonymized ? '' : identity.name,
      student_no: identity.student_no,
      anon_code: anonymized ? identity.anon_code : null,
      class_id: identity.class_id,
      class_name: identity.class_name,
      balance,
      last_change_seq: lastChangeSeq,
    });
  }
  rows.sort(compareRank);
  return assignRanks(rows).slice(0, 10);
}

export function baseStateFromWorld(
  world: ReplayWorld,
  mode: ReplayMode,
): Array<{
  student_id: string;
  class_id: string;
  present: boolean;
  balance: number;
  balance_before_range: number;
  base_balance: number;
}> {
  const items = [];
  for (const [studentId, state] of world.students) {
    items.push({
      student_id: studentId,
      class_id: state.class_id,
      present: state.present,
      balance: state.balance,
      balance_before_range: state.balance,
      base_balance: mode === 'net' ? 0 : state.balance,
    });
  }
  items.sort((a, b) => a.student_id.localeCompare(b.student_id));
  return items;
}
