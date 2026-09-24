/**
 * 回放读取与检查点任务。检查点在记分事务之外由独立命令写入。
 */

import { acquireAdvisoryLock, type Db, db as defaultDb } from '../repo/db.js';
import * as replayRepo from '../repo/replay.js';
import * as auditRepo from '../repo/audit.js';
import * as classRepo from '../repo/class.js';
import {
  applyReplayEvent,
  baseStateFromWorld,
  emptyWorld,
  rankingFromWorld,
  replayResumeSeq,
  snapshotBalances,
  snapshotWorld,
  worldFromCheckpoint,
  type ReplayIdentity,
  type ReplayWorld,
} from '../domain/replay.js';
import type { ReplayMode } from '../lib/schema.js';
import { toIsoTimestamp } from '../lib/time.js';

export const CHECKPOINT_EVENT_THRESHOLD = 200;
export const CHECKPOINT_LOCK_KEY = 'classroom:replay_checkpoint';

export function shouldWriteCheckpoint(
  eventsSinceLast: number,
  dailyDue: boolean,
  threshold = CHECKPOINT_EVENT_THRESHOLD,
): boolean {
  if (!Number.isFinite(eventsSinceLast) || eventsSinceLast < 0) return false;
  if (dailyDue) return true;
  if (!Number.isInteger(threshold) || threshold <= 0) return false;
  return eventsSinceLast >= threshold;
}

/** 合法阈值：job_config 优先，其次环境变量，最后默认 200。非法值不采用。 */
export function resolveCheckpointThreshold(
  configured: unknown,
  envValue: string | undefined,
  fallback = CHECKPOINT_EVENT_THRESHOLD,
): number {
  return positiveThreshold(configured) ?? positiveThreshold(envValue) ?? fallback;
}

function positiveThreshold(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 1_000_000) {
    return value;
  }
  if (typeof value === 'string' && /^[1-9]\d{0,6}$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (parsed <= 1_000_000) return parsed;
  }
  return null;
}

export function parseCheckpointArgs(argv: readonly string[]): { daily: boolean } {
  let daily = false;
  for (const arg of argv) {
    if (arg === '--') continue;
    if (arg === '--daily') {
      if (daily) throw new Error('参数 --daily 重复');
      daily = true;
      continue;
    }
    throw new Error(`未知参数：${arg}`);
  }
  return { daily };
}

function iso(value: Date | string): string {
  return toIsoTimestamp(value);
}

function identityMap(rows: ReplayIdentity[]): Map<string, ReplayIdentity> {
  return new Map(rows.map((row) => [row.student_id, row]));
}

async function worldAtSeq(
  termId: string,
  classId: string,
  uptoSeq: number,
  db: Db,
): Promise<ReplayWorld> {
  if (uptoSeq <= 0) return emptyWorld();
  const checkpoint = await auditRepo.findNearestCheckpoint(db, classId, termId, uptoSeq);
  const world = checkpoint ? worldFromCheckpoint(checkpoint.state) : emptyWorld();
  const afterSeq = checkpoint ? Number(checkpoint.upto_event_seq) : 0;
  const events = await replayRepo.listReplayEventsBetween(db, {
    termId,
    classId,
    afterSeq,
    uptoSeq,
  });
  for (const event of events) {
    applyReplayEvent(
      world,
      { event_seq: Number(event.event_seq), kind: event.kind, payload: event.payload },
      classId,
      termId,
    );
  }
  return world;
}

export async function replayTimeline(
  input: { termId: string; classId: string; from: string; to: string; mode: ReplayMode },
  db: Db = defaultDb,
) {
  const rangeStartSeq = await replayRepo.maxReplaySeqAt(db, {
    termId: input.termId,
    classId: input.classId,
    at: input.from,
    inclusive: false,
  });
  const world = await worldAtSeq(input.termId, input.classId, rangeStartSeq, db);
  const [frameCount, checkpoints, density] = await Promise.all([
    replayRepo.countReplayFrames(db, input),
    replayRepo.listReplayCheckpoints(db, input.classId, input.termId),
    replayRepo.listReplayDensity(db, input),
  ]);
  return {
    mode: input.mode,
    from: input.from,
    to: input.to,
    base_state: baseStateFromWorld(world, input.mode),
    frame_count: frameCount,
    checkpoints: checkpoints.map((row) => ({
      upto_event_seq: Number(row.upto_event_seq),
      created_at: iso(row.created_at),
    })),
    density: density.map((row) => ({
      at: iso(row.at),
      frames: Number(row.frames),
    })),
  };
}

export async function replayFrames(
  input: {
    termId: string;
    classId: string;
    from: string;
    to: string;
    mode: ReplayMode;
    cursor?: string;
    limit: number;
  },
  db: Db = defaultDb,
) {
  const cursor = input.cursor ? Number(input.cursor) : 0;
  const rows = await replayRepo.listReplayFrameEvents(db, {
    termId: input.termId,
    classId: input.classId,
    from: input.from,
    to: input.to,
    afterSeq: cursor,
    limit: input.limit + 1,
  });
  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  if (page.length === 0) {
    return { items: [], next_cursor: null };
  }

  const lastPageSeq = Number(page[page.length - 1]!.event_seq);
  const pageSeqs = new Set(page.map((row) => Number(row.event_seq)));
  const rangeStartSeq = await replayRepo.maxReplaySeqAt(db, {
    termId: input.termId,
    classId: input.classId,
    at: input.from,
    inclusive: false,
  });
  const floor = replayResumeSeq(cursor, rangeStartSeq);
  const rangeWorld = await worldAtSeq(input.termId, input.classId, rangeStartSeq, db);
  const rangeStartBalances = snapshotBalances(rangeWorld);
  const world = floor === rangeStartSeq ? rangeWorld : await worldAtSeq(input.termId, input.classId, floor, db);
  const events = await replayRepo.listReplayEventsBetween(db, {
    termId: input.termId,
    classId: input.classId,
    afterSeq: floor,
    uptoSeq: lastPageSeq,
  });
  const identities = identityMap(await replayRepo.listReplayIdentities(db, input.classId));

  const items = [];
  for (const event of events) {
    const eventSeq = Number(event.event_seq);
    applyReplayEvent(
      world,
      { event_seq: eventSeq, kind: event.kind, payload: event.payload },
      input.classId,
      input.termId,
    );
    if (!pageSeqs.has(eventSeq)) continue;
    items.push({
      event_seq: eventSeq,
      kind: event.kind,
      occurred_at: iso(event.occurred_at),
      mode: input.mode,
      top10: rankingFromWorld(
        world,
        identities,
        input.mode,
        rangeStartSeq,
        rangeStartBalances,
      ),
    });
  }

  const last = page[page.length - 1];
  return {
    items,
    next_cursor: hasMore && last ? String(Number(last.event_seq)) : null,
  };
}

export async function replayStateAt(
  input: { termId: string; classId: string; at: string; mode: ReplayMode },
  db: Db = defaultDb,
) {
  const uptoSeq = await replayRepo.maxReplaySeqAt(db, {
    termId: input.termId,
    classId: input.classId,
    at: input.at,
    inclusive: true,
  });
  const rangeStartSeq = 0;
  const world = await worldAtSeq(input.termId, input.classId, uptoSeq, db);
  const identities = identityMap(await replayRepo.listReplayIdentities(db, input.classId));
  return {
    at: input.at,
    mode: input.mode,
    ranking: rankingFromWorld(world, identities, input.mode, rangeStartSeq, new Map()),
  };
}

/**
 * 按班、当前学期写入到期检查点。由 `scripts/checkpoint.ts` 调用，不在记分事务里调用。
 */
export async function writeDueCheckpoints(
  input: { daily: boolean },
  db: Db = defaultDb,
): Promise<{ written: number; skipped: number; failed: number; busy: boolean }> {
  const release = await acquireAdvisoryLock(CHECKPOINT_LOCK_KEY);
  if (!release) return { written: 0, skipped: 0, failed: 0, busy: true };
  try {
    return await writeDueCheckpointsUnlocked(input, db);
  } finally {
    await release();
  }
}

async function writeDueCheckpointsUnlocked(
  input: { daily: boolean },
  db: Db,
): Promise<{ written: number; skipped: number; failed: number; busy: boolean }> {
  const term = await classRepo.currentTerm(db);
  if (!term) return { written: 0, skipped: 0, failed: 0, busy: false };

  const configured = await auditRepo.getJobConfig<unknown>(
    db,
    'replay_checkpoint_event_threshold',
    null,
  );
  const threshold = resolveCheckpointThreshold(
    configured,
    process.env.REPLAY_CHECKPOINT_EVENT_THRESHOLD,
  );
  const classes = await classRepo.listClasses(db, false);
  let written = 0;
  let skipped = 0;
  let failed = 0;

  for (const cls of classes) {
    try {
      const outcome = await writeClassCheckpoint(db, cls.class_id, term.term_id, input.daily, threshold);
      if (outcome === 'written') written += 1;
      else skipped += 1;
    } catch (err) {
      failed += 1;
      const detail = err instanceof Error ? err.message : '未知错误';
      console.error(`检查点写入失败 class_id=${cls.class_id} ${detail.slice(0, 300)}`);
    }
  }

  return { written, skipped, failed, busy: false };
}

async function writeClassCheckpoint(
  db: Db,
  classId: string,
  termId: string,
  daily: boolean,
  threshold: number,
): Promise<'written' | 'skipped'> {
  const latest = await auditRepo.latestCheckpoint(db, classId, termId);
  const sinceSeq = latest ? Number(latest.upto_event_seq) : 0;
  const eventsSinceLast = await replayRepo.countReplayEventsSince(db, classId, termId, sinceSeq);
  if (!shouldWriteCheckpoint(eventsSinceLast, daily, threshold)) return 'skipped';
  const uptoSeq = await replayRepo.maxReplaySeqForClass(db, classId, termId);
  if (!Number.isInteger(uptoSeq) || uptoSeq <= 0 || uptoSeq === sinceSeq) return 'skipped';
  const world = await worldAtSeq(termId, classId, uptoSeq, db);
  const inserted = await auditRepo.insertCheckpoint(db, {
    class_id: classId,
    term_id: termId,
    upto_event_seq: uptoSeq,
    state: snapshotWorld(world),
    trigger_reason: daily && eventsSinceLast < threshold ? 'daily' : 'event_threshold',
  });
  return inserted ? 'written' : 'skipped';
}
