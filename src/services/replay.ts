/**
 * 回放读取与检查点任务。检查点在记分事务之外由独立命令写入。
 */

import { type Db, db as defaultDb } from '../repo/db.js';
import * as replayRepo from '../repo/replay.js';
import * as auditRepo from '../repo/audit.js';
import * as classRepo from '../repo/class.js';
import {
  applyReplayEvent,
  baseStateFromWorld,
  emptyWorld,
  rankingFromWorld,
  snapshotBalances,
  snapshotWorld,
  worldFromCheckpoint,
  type ReplayIdentity,
  type ReplayWorld,
} from '../domain/replay.js';
import type { ReplayMode } from '../lib/schema.js';

export const CHECKPOINT_EVENT_THRESHOLD = 200;

export function shouldWriteCheckpoint(
  eventsSinceLast: number,
  dailyDue: boolean,
  threshold = CHECKPOINT_EVENT_THRESHOLD,
): boolean {
  if (!Number.isFinite(eventsSinceLast) || eventsSinceLast < 0) return false;
  if (!Number.isFinite(threshold) || threshold <= 0) return false;
  return dailyDue || eventsSinceLast >= threshold;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function identityMap(rows: ReplayIdentity[]): Map<string, ReplayIdentity> {
  return new Map(rows.map((row) => [row.student_id, row]));
}

function configNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return fallback;
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
  const checkpoint = await auditRepo.findNearestCheckpoint(
    db,
    input.classId,
    input.termId,
    rangeStartSeq,
  );
  const world = checkpoint ? worldFromCheckpoint(checkpoint.state) : emptyWorld();
  const afterSeq = checkpoint ? Number(checkpoint.upto_event_seq) : 0;
  const events = await replayRepo.listReplayEventsBetween(db, {
    termId: input.termId,
    classId: input.classId,
    afterSeq,
    uptoSeq: lastPageSeq,
  });
  const identities = identityMap(await replayRepo.listReplayIdentities(db, input.classId));

  let rangeStartBalances = new Map<string, number>();
  let capturedRangeStart = rangeStartSeq <= afterSeq;
  if (capturedRangeStart) rangeStartBalances = snapshotBalances(world);

  const items = [];
  for (const event of events) {
    const eventSeq = Number(event.event_seq);
    if (!capturedRangeStart && eventSeq > rangeStartSeq) {
      rangeStartBalances = snapshotBalances(world);
      capturedRangeStart = true;
    }
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
): Promise<{ written: number; skipped: number }> {
  const term = await classRepo.currentTerm(db);
  if (!term) return { written: 0, skipped: 0 };

  const threshold = configNumber(
    await auditRepo.getJobConfig(db, 'replay_checkpoint_event_threshold', CHECKPOINT_EVENT_THRESHOLD),
    CHECKPOINT_EVENT_THRESHOLD,
  );
  const classes = await classRepo.listClasses(db, true);
  let written = 0;
  let skipped = 0;

  for (const cls of classes) {
    const latest = await auditRepo.latestCheckpoint(db, cls.class_id, term.term_id);
    const sinceSeq = latest ? Number(latest.upto_event_seq) : 0;
    const eventsSinceLast = await auditRepo.countReplayEventsSince(db, cls.class_id, sinceSeq);
    if (!shouldWriteCheckpoint(eventsSinceLast, input.daily, threshold)) {
      skipped += 1;
      continue;
    }
    const uptoSeq = await replayRepo.maxReplaySeqForClass(db, cls.class_id, term.term_id);
    if (uptoSeq <= 0 || uptoSeq === sinceSeq) {
      skipped += 1;
      continue;
    }
    const world = await worldAtSeq(term.term_id, cls.class_id, uptoSeq, db);
    await auditRepo.insertCheckpoint(db, {
      class_id: cls.class_id,
      term_id: term.term_id,
      upto_event_seq: uptoSeq,
      state: snapshotWorld(world),
      trigger_reason: input.daily && eventsSinceLast < threshold ? 'daily' : 'event_threshold',
    });
    written += 1;
  }

  return { written, skipped };
}
