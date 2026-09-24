import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  applyReplayEvent,
  baseStateFromWorld,
  emptyWorld,
  rankingFromWorld,
  snapshotBalances,
} from '../src/domain/replay.js';
import type { ReplayIdentity } from '../src/domain/replay.js';

describe('replay checkpoints', () => {
  it('满 200 个事件或每日兜底才写检查点，记分服务不调用它', async () => {
    process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';
    const { shouldWriteCheckpoint } = await import('../src/services/replay.js');
    assert.equal(shouldWriteCheckpoint(0, false), false);
    assert.equal(shouldWriteCheckpoint(199, false), false);
    assert.equal(shouldWriteCheckpoint(200, false), true);
    assert.equal(shouldWriteCheckpoint(0, true), true);
    assert.equal(shouldWriteCheckpoint(Number.NaN, true), false);
    assert.equal(shouldWriteCheckpoint(3, false, 3), true);
    assert.equal(shouldWriteCheckpoint(2, false, 3), false);
    assert.equal(shouldWriteCheckpoint(0, true, 0), true);
    assert.equal(shouldWriteCheckpoint(5, false, -1), false);
    assert.equal(shouldWriteCheckpoint(5, false, 1.5), false);
    assert.equal(shouldWriteCheckpoint(Number.POSITIVE_INFINITY, false), false);
    const { parseCheckpointArgs, resolveCheckpointThreshold } = await import('../src/services/replay.js');
    assert.deepEqual(parseCheckpointArgs([]), { daily: false });
    assert.deepEqual(parseCheckpointArgs(['--', '--daily']), { daily: true });
    assert.throws(() => parseCheckpointArgs(['--daily', '--daily']), /重复/);
    assert.throws(() => parseCheckpointArgs(['--force']), /未知参数/);
    assert.throws(() => parseCheckpointArgs(['']), /未知参数/);
    assert.equal(resolveCheckpointThreshold(200, '3'), 200);
    assert.equal(resolveCheckpointThreshold('15', undefined), 15);
    assert.equal(resolveCheckpointThreshold({ n: 1 }, '9'), 9);
    assert.equal(resolveCheckpointThreshold(null, '0'), 200);
    assert.equal(resolveCheckpointThreshold(null, '1000001'), 200);
    assert.equal(resolveCheckpointThreshold(null, ''), 200);
    const scoring = await readFile(new URL('../src/services/points.ts', import.meta.url), 'utf8');
    assert.equal(scoring.includes('shouldWriteCheckpoint'), false);
    assert.equal(scoring.includes('replay_checkpoint'), false);
    assert.equal(scoring.includes('writeDueCheckpoints'), false);
  });
});

describe('replay world', () => {
  const classId = 'c1';
  const termId = 't1';
  const identities = new Map<string, ReplayIdentity>([
    ['a', { student_id: 'a', class_id: classId, class_name: '一班', name: '甲', student_no: '1', anon_code: null }],
    ['b', { student_id: 'b', class_id: classId, class_name: '一班', name: '乙', student_no: '2', anon_code: null }],
    ['c', { student_id: 'c', class_id: classId, class_name: '一班', name: '', student_no: '', anon_code: '匿名-1' }],
  ]);

  function score(seq: number, entries: { student_id: string; delta: number }[]) {
    return {
      event_seq: seq,
      kind: 'points_appended',
      payload: { class_id: classId, term_id: termId, entries },
    };
  }

  it('cumulative 含区间前余额，net 只含区间内净增减，破并列用事件序号', () => {
    const world = emptyWorld();
    applyReplayEvent(world, { event_seq: 1, kind: 'roster_changed', payload: { class_id: classId, action: 'student_created', student_id: 'a' } }, classId, termId);
    applyReplayEvent(world, { event_seq: 2, kind: 'roster_changed', payload: { class_id: classId, action: 'student_created', student_id: 'b' } }, classId, termId);
    applyReplayEvent(world, score(10, [{ student_id: 'a', delta: 8 }, { student_id: 'b', delta: 8 }]), classId, termId);
    const before = snapshotBalances(world);
    applyReplayEvent(world, score(20, [{ student_id: 'a', delta: 3 }]), classId, termId);

    const cumulative = rankingFromWorld(world, identities, 'cumulative', 10, before);
    const net = rankingFromWorld(world, identities, 'net', 10, before);
    assert.equal(cumulative.find((row) => row.student_id === 'a')?.balance, 11);
    assert.equal(cumulative.find((row) => row.student_id === 'a')?.last_change_seq, 20);
    assert.equal(cumulative.find((row) => row.student_id === 'b')?.last_change_seq, 10);
    assert.equal(net.find((row) => row.student_id === 'a')?.balance, 3);
    assert.equal(net.find((row) => row.student_id === 'b')?.balance, 0);
    assert.equal(net.find((row) => row.student_id === 'b')?.last_change_seq, 0);

    const base = baseStateFromWorld(world, 'net');
    assert.equal(base.find((row) => row.student_id === 'a')?.balance_before_range, 11);
    assert.equal(base.find((row) => row.student_id === 'a')?.base_balance, 0);
  });

  it('离班前仍在 Top10，离班后退出；匿名化后显示代号', () => {
    const world = emptyWorld();
    applyReplayEvent(world, { event_seq: 1, kind: 'roster_changed', payload: { class_id: classId, action: 'student_created', student_id: 'a' } }, classId, termId);
    applyReplayEvent(world, { event_seq: 2, kind: 'roster_changed', payload: { class_id: classId, action: 'student_created', student_id: 'c' } }, classId, termId);
    applyReplayEvent(world, score(3, [{ student_id: 'a', delta: 5 }, { student_id: 'c', delta: 9 }]), classId, termId);
    const beforeLeave = rankingFromWorld(world, identities, 'cumulative', 0, new Map());
    assert.deepEqual(
      beforeLeave.map((row) => row.student_id),
      ['c', 'a'],
    );
    assert.equal(beforeLeave[0]?.anon_code, '匿名-1');
    assert.equal(beforeLeave[0]?.name, '');

    applyReplayEvent(world, { event_seq: 4, kind: 'roster_changed', payload: { class_id: classId, action: 'student_left', student_id: 'c' } }, classId, termId);
    const afterLeave = rankingFromWorld(world, identities, 'cumulative', 0, new Map());
    assert.deepEqual(
      afterLeave.map((row) => row.student_id),
      ['a'],
    );

    applyReplayEvent(world, { event_seq: 5, kind: 'roster_changed', payload: { class_id: classId, action: 'student_anonymized', student_id: 'a' } }, classId, termId);
    const afterAnon = rankingFromWorld(
      world,
      new Map([
        [
          'a',
          { student_id: 'a', class_id: classId, class_name: '一班', name: '', student_no: '', anon_code: '匿名-2' },
        ],
      ]),
      'cumulative',
      0,
      new Map(),
    );
    assert.equal(afterAnon[0]?.anon_code, '匿名-2');
    assert.equal(afterAnon[0]?.name, '');
  });
});
