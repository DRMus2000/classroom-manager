/**
 * 点名不放回、排除、关轮后才能再开；倒计时暂停继续，并写入 SSE 事件。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { AppError } from '../src/lib/errors.js';

const PORT = 55460;
const USER = 'classroom';
const PASSWORD = 'classroom_password';
const DATABASE = 'classroom_manager';

describe('rollcall and countdown', { timeout: 180_000 }, () => {
  let databaseDir = '';
  let postgres: EmbeddedPostgres | undefined;

  after(async () => {
    const { closeDb } = await import('../src/repo/db.js').catch(() => ({ closeDb: async () => undefined }));
    await closeDb();
    await postgres?.stop().catch(() => undefined);
    if (databaseDir) await rm(databaseDir, { recursive: true, force: true });
  });

  it('不重复抽取、排除生效、重复请求不重复抽，倒计时可暂停继续', async () => {
    databaseDir = await mkdtemp(path.join(tmpdir(), 'classroom-rollcall-pg-'));
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
    assert.match(await runMigrate(connectionString), /002_phase2_duty_marks\.sql/);
    process.env.DATABASE_URL = connectionString;

    const rollcall = await import('../src/services/rollcall.js');
    const countdown = await import('../src/services/countdown.js');
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      const teacher = await client.query<{ teacher_id: string }>(
        `INSERT INTO teacher (username, password_hash) VALUES ('roll-teacher', 'hash') RETURNING teacher_id`,
      );
      const actor = teacher.rows[0]!.teacher_id;
      const created = await client.query<{ class_id: string }>(
        `INSERT INTO class (name) VALUES ('点名班') RETURNING class_id`,
      );
      const classId = created.rows[0]!.class_id;
      const ids: string[] = [];
      for (const [no, name] of [
        ['1', '甲'],
        ['2', '乙'],
        ['3', '丙'],
      ] as const) {
        const row = await client.query<{ student_id: string }>(
          `INSERT INTO student (class_id, student_no, name) VALUES ($1, $2, $3) RETURNING student_id`,
          [classId, no, name],
        );
        ids.push(row.rows[0]!.student_id);
      }
      const left = await client.query<{ student_id: string }>(
        `INSERT INTO student (class_id, student_no, name, status, left_at, left_reason)
         VALUES ($1, '9', '已离班', 'left', now(), 'transfer') RETURNING student_id`,
        [classId],
      );

      const openRequest = '8f2c0000-0000-4000-8000-000000000061';
      const opened = await rollcall.openRound(actor, {
        class_id: classId,
        scope: { type: 'all', student_ids: [] },
        exclude_student_ids: [],
        request_id: openRequest,
      });
      assert.equal(opened.status, 'open');
      const replay = await rollcall.openRound(actor, {
        class_id: classId,
        scope: { type: 'all', student_ids: [] },
        exclude_student_ids: [],
        request_id: openRequest,
      });
      assert.equal(replay.rollcall_id, opened.rollcall_id);

      await assert.rejects(
        () =>
          rollcall.openRound(actor, {
            class_id: classId,
            scope: { type: 'all', student_ids: [] },
            exclude_student_ids: [],
            request_id: '8f2c0000-0000-4000-8000-000000000062',
          }),
        (err: unknown) => err instanceof AppError && err.code === 'VERSION_CONFLICT',
      );

      const drawRequest = '8f2c0000-0000-4000-8000-000000000063';
      const first = await rollcall.draw(actor, opened.rollcall_id, 2, drawRequest, undefined, () => 0);
      assert.equal(first.picked.length, 2);
      const firstIds = first.picked.map((item) => item.student_id);
      assert.equal(firstIds.includes(left.rows[0]!.student_id), false);
      const replayDraw = await rollcall.draw(actor, opened.rollcall_id, 2, drawRequest, undefined, () => 0);
      assert.deepEqual(
        replayDraw.picked.map((item) => item.student_id),
        firstIds,
      );

      await assert.rejects(
        () => rollcall.draw(actor, opened.rollcall_id, 1, drawRequest),
        (err: unknown) => err instanceof AppError && err.code === 'IDEMPOTENCY_MISMATCH',
      );

      await assert.rejects(
        () =>
          rollcall.exclude(actor, opened.rollcall_id, ['8f2c0000-0000-4000-8000-0000000000ff'], '8f2c0000-0000-4000-8000-000000000064'),
        (err: unknown) => err instanceof AppError && err.code === 'NOT_FOUND',
      );
      const absent = ids.find((id) => !firstIds.includes(id))!;
      const afterExclude = await rollcall.exclude(
        actor,
        opened.rollcall_id,
        [absent],
        '8f2c0000-0000-4000-8000-000000000065',
      );
      assert.ok(afterExclude.exclude_student_ids.includes(absent));
      await assert.rejects(
        () => rollcall.draw(actor, opened.rollcall_id, 1, '8f2c0000-0000-4000-8000-000000000066', undefined, () => 0),
        (err: unknown) => err instanceof AppError && err.code === 'FORBIDDEN',
      );

      const closed = await rollcall.close(actor, opened.rollcall_id, '8f2c0000-0000-4000-8000-000000000067');
      assert.equal(closed.status, 'closed');
      assert.equal((await rollcall.getOpenRound(classId))?.rollcall_id, undefined);
      await assert.rejects(
        () => rollcall.draw(actor, opened.rollcall_id, 1, '8f2c0000-0000-4000-8000-000000000068'),
        (err: unknown) => err instanceof AppError && err.code === 'FORBIDDEN',
      );

      const selected = await rollcall.openRound(actor, {
        class_id: classId,
        scope: { type: 'selected', student_ids: [ids[0]!] },
        exclude_student_ids: [],
        request_id: '8f2c0000-0000-4000-8000-000000000069',
      });
      const only = await rollcall.draw(actor, selected.rollcall_id, 1, '8f2c0000-0000-4000-8000-00000000006a', undefined, () => 0);
      assert.deepEqual(
        only.picked.map((item) => item.student_id),
        [ids[0]!],
      );

      const now = Date.parse('2026-09-23T07:00:00.000Z');
      const started = await countdown.commandCountdown(
        actor,
        classId,
        'start',
        60,
        '8f2c0000-0000-4000-8000-00000000006b',
        undefined,
        now,
      );
      assert.equal(started.status, 'running');
      assert.equal(started.remaining_sec, null);
      assert.equal(started.deadline_at, new Date(now + 60_000).toISOString());

      const paused = await countdown.commandCountdown(
        actor,
        classId,
        'pause',
        undefined,
        '8f2c0000-0000-4000-8000-00000000006c',
        undefined,
        now + 20_000,
      );
      assert.equal(paused.status, 'paused');
      assert.equal(paused.deadline_at, null);
      assert.equal(paused.remaining_sec, 40);

      await assert.rejects(
        () =>
          countdown.commandCountdown(
            actor,
            classId,
            'pause',
            undefined,
            '8f2c0000-0000-4000-8000-00000000006d',
            undefined,
            now + 21_000,
          ),
        (err: unknown) => err instanceof AppError && err.code === 'FORBIDDEN',
      );

      const resumed = await countdown.commandCountdown(
        actor,
        classId,
        'resume',
        undefined,
        '8f2c0000-0000-4000-8000-00000000006e',
        undefined,
        now + 25_000,
      );
      assert.equal(resumed.status, 'running');
      const finished = await countdown.getCountdown(classId, undefined, now + 25_000 + 40_000);
      assert.equal(finished.status, 'finished');
      assert.equal(finished.remaining_sec, 0);

      const events = await client.query<{ kind: string }>(
        `SELECT kind FROM event_log WHERE class_id = $1 ORDER BY event_seq`,
        [classId],
      );
      const kinds = events.rows.map((row) => row.kind);
      assert.ok(kinds.includes('rollcall_changed'));
      assert.ok(kinds.includes('countdown_changed'));
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
