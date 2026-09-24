/**
 * 回放读接口、检查点任务、当前榜缺余额行。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const PORT = 55446;
const USER = 'classroom';
const PASSWORD = 'classroom_password';
const DATABASE = 'classroom_manager';

describe('replay reads and checkpoints', { timeout: 180_000 }, () => {
  let databaseDir = '';
  let postgres: EmbeddedPostgres | undefined;

  after(async () => {
    const { closeDb } = await import('../src/repo/db.js').catch(() => ({ closeDb: async () => undefined }));
    await closeDb();
    await postgres?.stop().catch(() => undefined);
    if (databaseDir) await rm(databaseDir, { recursive: true, force: true });
  });

  it('用回放事件序号和当时在班集合算帧，并写入检查点', async () => {
    databaseDir = await mkdtemp(path.join(tmpdir(), 'classroom-replay-pg-'));
    postgres = new EmbeddedPostgres({
      databaseDir,
      user: USER,
      password: PASSWORD,
      port: PORT,
      persistent: true,
      initdbFlags: ['--encoding=UTF8', '--locale=C'],
    });
    await postgres.initialise();
    await postgres.start();
    await postgres.createDatabase(DATABASE);
    const connectionString = `postgresql://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}`;
    assert.match(await runMigrate(connectionString), /001_phase1_core\.sql/);
    process.env.DATABASE_URL = connectionString;

    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      const cls = await client.query<{ class_id: string }>(
        `INSERT INTO class (name) VALUES ('回放班') RETURNING class_id`,
      );
      const classId = cls.rows[0]!.class_id;
      const term = await client.query<{ term_id: string }>(
        `INSERT INTO term (name, status, is_current) VALUES ('2026秋', 'open', true) RETURNING term_id`,
      );
      const termId = term.rows[0]!.term_id;
      const students = await client.query<{ student_id: string; student_no: string }>(
        `INSERT INTO student (class_id, student_no, name) VALUES
           ($1, '1', '甲'), ($1, '2', '乙'), ($1, '3', '丙')
         RETURNING student_id, student_no`,
        [classId],
      );
      const byNo = new Map(students.rows.map((row) => [row.student_no, row.student_id]));
      const a = byNo.get('1')!;
      const b = byNo.get('2')!;
      const c = byNo.get('3')!;

      async function logEvent(
        occurredAt: string,
        kind: 'roster_changed' | 'points_appended',
        payload: Record<string, unknown>,
      ): Promise<number> {
        const row = await client.query<{ event_seq: string }>(
          `INSERT INTO event_log (class_id, kind, payload, replay_relevant, occurred_at)
           VALUES ($1, $2, $3::jsonb, true, $4::timestamptz)
           RETURNING event_seq`,
          [classId, kind, JSON.stringify(payload), occurredAt],
        );
        return Number(row.rows[0]!.event_seq);
      }

      await logEvent('2026-09-20T00:00:00Z', 'roster_changed', {
        class_id: classId,
        action: 'student_created',
        student_id: a,
      });
      await logEvent('2026-09-20T00:00:01Z', 'roster_changed', {
        class_id: classId,
        action: 'student_created',
        student_id: b,
      });
      await logEvent('2026-09-20T00:00:02Z', 'roster_changed', {
        class_id: classId,
        action: 'student_created',
        student_id: c,
      });
      const beforeRangeSeq = await logEvent('2026-09-21T00:00:00Z', 'points_appended', {
        class_id: classId,
        term_id: termId,
        entries: [
          { student_id: a, delta: 8, balance_after: 8 },
          { student_id: b, delta: 8, balance_after: 8 },
        ],
      });
      const inRangeSeq = await logEvent('2026-09-22T12:00:00Z', 'points_appended', {
        class_id: classId,
        term_id: termId,
        entries: [
          { student_id: a, delta: 3, balance_after: 11 },
          { student_id: c, delta: 10, balance_after: 10 },
        ],
      });
      const leftSeq = await logEvent('2026-09-23T00:00:00Z', 'roster_changed', {
        class_id: classId,
        action: 'student_left',
        student_id: c,
      });
      await client.query(
        `UPDATE student SET status = 'left', left_at = '2026-09-23T00:00:00Z', left_reason = 'transfer'
         WHERE student_id = $1`,
        [c],
      );
      const anonSeq = await logEvent('2026-09-23T12:00:00Z', 'roster_changed', {
        class_id: classId,
        action: 'student_anonymized',
        student_id: b,
        anon_code: '匿名-1',
      });
      await client.query(
        `UPDATE student SET status = 'anonymized', name = '', student_no = '', anon_code = '匿名-1'
         WHERE student_id = $1`,
        [b],
      );

      const extra = await client.query<{ student_id: string }>(
        `INSERT INTO student (class_id, student_no, name) VALUES ($1, '9', '丁') RETURNING student_id`,
        [classId],
      );

      const replay = await import('../src/services/replay.js');
      const pointsRepo = await import('../src/repo/points.js');
      const { db } = await import('../src/repo/db.js');

      const from = '2026-09-22T00:00:00.000Z';
      const to = '2026-09-24T00:00:00.000Z';
      const timeline = await replay.replayTimeline({
        termId,
        classId,
        from,
        to,
        mode: 'cumulative',
      });
      assert.equal(timeline.frame_count, 3);
      const beforeA = timeline.base_state.find((row) => row.student_id === a);
      assert.equal(beforeA?.balance, 8);
      assert.equal(beforeA?.present, true);

      const netTimeline = await replay.replayTimeline({
        termId,
        classId,
        from,
        to,
        mode: 'net',
      });
      const netBase = netTimeline.base_state.find((row) => row.student_id === a);
      assert.equal(netBase?.base_balance, 0);
      assert.equal(netBase?.balance_before_range, 8);

      const frames = await replay.replayFrames({
        termId,
        classId,
        from,
        to,
        mode: 'cumulative',
        limit: 50,
      });
      const scoreFrame = frames.items.find((item) => item.event_seq === inRangeSeq);
      assert.ok(scoreFrame);
      const rankedA = scoreFrame.top10.find((row) => row.student_id === a);
      assert.equal(rankedA?.balance, 11);
      assert.equal(rankedA?.last_change_seq, inRangeSeq);
      assert.notEqual(rankedA?.last_change_seq, 1);
      const rankedC = scoreFrame.top10.find((row) => row.student_id === c);
      assert.equal(rankedC?.balance, 10);
      const rankedBBeforeAnon = scoreFrame.top10.find((row) => row.student_id === b);
      assert.equal(rankedBBeforeAnon?.last_change_seq, beforeRangeSeq);
      assert.ok(scoreFrame.top10.some((row) => row.student_id === b));

      const netFrames = await replay.replayFrames({
        termId,
        classId,
        from,
        to,
        mode: 'net',
        limit: 50,
      });
      const netScore = netFrames.items.find((item) => item.event_seq === inRangeSeq);
      assert.equal(netScore?.top10.find((row) => row.student_id === a)?.balance, 3);
      assert.equal(netScore?.top10.find((row) => row.student_id === b)?.balance, 0);
      assert.equal(netScore?.top10.find((row) => row.student_id === b)?.last_change_seq, 0);

      const leftFrame = frames.items.find((item) => item.event_seq === leftSeq);
      assert.equal(
        leftFrame?.top10.some((row) => row.student_id === c),
        false,
      );
      const anonFrame = frames.items.find((item) => item.event_seq === anonSeq);
      const rankedB = anonFrame?.top10.find((row) => row.student_id === b);
      assert.equal(rankedB?.anon_code, '匿名-1');
      assert.equal(rankedB?.name, '');

      const atScore = await replay.replayStateAt({
        termId,
        classId,
        at: '2026-09-22T12:00:00.000Z',
        mode: 'cumulative',
      });
      assert.equal(atScore.ranking.find((row) => row.student_id === a)?.last_change_seq, inRangeSeq);
      assert.equal(atScore.ranking.find((row) => row.student_id === a)?.balance, 11);

      await client.query(
        `UPDATE job_config SET value = '3'::jsonb WHERE key = 'replay_checkpoint_event_threshold'`,
      );
      const written = await replay.writeDueCheckpoints({ daily: false });
      assert.ok(written.written >= 1);
      const checkpoints = await client.query<{ upto_event_seq: string; trigger_reason: string }>(
        `SELECT upto_event_seq, trigger_reason FROM replay_checkpoint
         WHERE class_id = $1 AND term_id = $2`,
        [classId, termId],
      );
      assert.ok(checkpoints.rows.length >= 1);
      assert.ok(Number(checkpoints.rows[0]!.upto_event_seq) >= anonSeq);

      const rankedNow = await pointsRepo.listRanked(db, termId, classId);
      const ding = rankedNow.find((row) => row.student_id === extra.rows[0]!.student_id);
      assert.ok(ding);
      assert.equal(Number(ding.balance), 0);
      assert.equal(Number(ding.last_change_seq), 0);
      assert.equal(
        rankedNow.some((row) => row.student_id === c),
        false,
      );
      assert.equal(
        rankedNow.some((row) => row.student_id === b),
        false,
      );
    } finally {
      await client.end();
    }
  });
});

function runMigrate(connectionString: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/migrate.ts', 'up'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: connectionString },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('exit', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(output || `migrate exited ${code}`));
    });
  });
}
