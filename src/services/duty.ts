/**
 * 卫生轮次：开始、计次、未推椅子、缺席加次、冻结、抽选、取消、确认、纠正、关轮。
 * 判定在 domain/duty.ts。卫生不写 point_entry。
 */

import { sql, type Db, type Tx, db as defaultDb } from '../repo/db.js';
import * as classRepo from '../repo/class.js';
import * as auditRepo from '../repo/audit.js';
import { writeEvent } from './publishEvent.js';
import { idempotentTx } from './idempotency.js';
import { Errors } from '../lib/errors.js';
import {
  applyAbsent,
  applyAttendance,
  candidatesOf,
  pickCandidateIndex,
  roundPhase,
  selectionOutcome,
  type DutyMember,
} from '../domain/duty.js';

interface RoundRow {
  round_id: string;
  line_id: string;
  class_id: string;
  seq_no: number;
  status: 'in_progress' | 'closed';
  frozen_at: Date | string | null;
  version: number;
}

interface MemberRow {
  student_id: string;
  duty_term_id: string | null;
  is_original: boolean;
  attended: boolean;
  no_push: boolean;
  eligible_for_backfill: boolean;
  counted_round: boolean;
  completed_count: number;
  required_count: number;
  term_status: 'active' | 'retired' | 'released';
}

async function ensureLine(tx: Tx, classId: string): Promise<string> {
  const cls = await classRepo.findClass(tx, classId);
  if (!cls) throw Errors.notFound('班级', classId);
  const existing = await tx.execute<{ line_id: string }>(
    sql`SELECT line_id FROM duty_line WHERE class_id = ${classId} AND active LIMIT 1`,
  );
  if (existing[0]) return existing[0].line_id;
  const created = await tx.execute<{ line_id: string }>(
    sql`INSERT INTO duty_line (class_id) VALUES (${classId}) RETURNING line_id`,
  );
  return created[0]!.line_id;
}

async function lockRound(tx: Tx, roundId: string): Promise<RoundRow> {
  const rows = await tx.execute<RoundRow>(
    sql`SELECT r.round_id, r.line_id, l.class_id, r.seq_no, r.status, r.frozen_at, r.version
        FROM duty_round r
        JOIN duty_line l ON l.line_id = r.line_id
        WHERE r.round_id = ${roundId}
        FOR UPDATE OF r`,
  );
  const round = rows[0];
  if (!round) throw Errors.notFound('卫生轮次', roundId);
  return round;
}

function assertVersion(round: RoundRow, expected: number) {
  if (round.status === 'closed') throw Errors.forbidden('轮次已结束');
  if (Number(round.version) !== expected) {
    throw Errors.versionConflict(
      `卫生轮次已被其他设备修改（当前版本 ${round.version}，提交版本 ${expected}）`,
    );
  }
}

async function bump(tx: Tx, roundId: string): Promise<number> {
  const rows = await tx.execute<{ version: number }>(
    sql`UPDATE duty_round SET version = version + 1 WHERE round_id = ${roundId} RETURNING version`,
  );
  return Number(rows[0]!.version);
}

async function membersOf(tx: Tx, roundId: string): Promise<MemberRow[]> {
  return tx.execute<MemberRow>(
    sql`SELECT m.student_id, m.duty_term_id, m.is_original, m.attended, m.no_push,
               m.eligible_for_backfill, m.counted_round,
               COALESCE(t.completed_count, 0) AS completed_count,
               COALESCE(t.required_count, 3) AS required_count,
               COALESCE(t.status, 'active') AS term_status
        FROM duty_round_member m
        LEFT JOIN duty_term t ON t.duty_term_id = m.duty_term_id
        WHERE m.round_id = ${roundId}`,
  );
}

function toDomain(row: MemberRow): DutyMember {
  return {
    student_id: row.student_id,
    is_original: row.is_original,
    attended: row.attended,
    eligible_for_backfill: row.eligible_for_backfill,
    completed_count: Number(row.completed_count),
    required_count: Number(row.required_count),
    term_status: row.term_status,
  };
}

async function broadcast(tx: Tx, classId: string, roundId: string, action: string, requestId: string) {
  await writeEvent(tx, {
    class_id: classId,
    kind: 'duty_round_changed',
    payload: { class_id: classId, round_id: roundId, action },
  });
  await tx.execute(
    sql`INSERT INTO duty_action_log (round_id, action, request_id) VALUES (${roundId}, ${action}, ${requestId})`,
  );
}

export async function getClassDuty(classId: string, db: Db = defaultDb) {
  const line = await db.execute<{ line_id: string }>(
    sql`SELECT line_id FROM duty_line WHERE class_id = ${classId} AND active LIMIT 1`,
  );
  if (!line[0]) {
    return { line_id: null, round: null, open_selection: null, next_appointees: [], active_terms: [] };
  }
  const lineId = line[0].line_id;
  const rounds = await db.execute<RoundRow>(
    sql`SELECT round_id, line_id, ${classId}::uuid AS class_id, seq_no, status, frozen_at, version
        FROM duty_round WHERE line_id = ${lineId} AND status = 'in_progress'`,
  );
  const round = rounds[0];
  const members = round ? await membersOf(db, round.round_id) : [];
  const open = round
    ? await db.execute<{ selection_id: string; status: string; new_student_id: string }>(
        sql`SELECT selection_id, status, new_student_id FROM duty_selection
            WHERE round_id = ${round.round_id} AND status IN ('pending', 'cancelled')`,
      )
    : [];
  const next = await db.execute<{ duty_term_id: string; student_id: string }>(
    sql`SELECT duty_term_id, student_id FROM duty_term
        WHERE line_id = ${lineId} AND status = 'active' AND started_round_id IS NULL`,
  );
  const active = await db.execute<{ duty_term_id: string; student_id: string; completed_count: number; required_count: number }>(
    sql`SELECT duty_term_id, student_id, completed_count, required_count
        FROM duty_term WHERE line_id = ${lineId} AND status = 'active' AND started_round_id IS NOT NULL`,
  );
  return {
    line_id: lineId,
    round: round
      ? {
          round_id: round.round_id,
          seq_no: Number(round.seq_no),
          phase: roundPhase(round.status, round.frozen_at),
          version: Number(round.version),
          frozen_at: round.frozen_at,
          members: members.map((m) => ({ ...m, ...toDomain(m), no_push: m.no_push, counted_round: m.counted_round, duty_term_id: m.duty_term_id })),
        }
      : null,
    open_selection: open[0] ?? null,
    next_appointees: next,
    active_terms: active,
  };
}

export async function startRound(actorId: string, classId: string, requestId: string, db: Db = defaultDb) {
  return idempotentTx(db, requestId, `POST /api/v1/classes/${classId}/duty/rounds`, { request_id: requestId }, async (tx) => {
    const lineId = await ensureLine(tx, classId);
    const open = await tx.execute<{ round_id: string }>(
      sql`SELECT round_id FROM duty_round WHERE line_id = ${lineId} AND status = 'in_progress' FOR UPDATE`,
    );
    if (open[0]) throw Errors.versionConflict('该卫生线已有未结束轮次');
    const seq = await tx.execute<{ n: number }>(
      sql`SELECT COALESCE(MAX(seq_no), 0)::int AS n FROM duty_round WHERE line_id = ${lineId}`,
    );
    const terms = await tx.execute<{ duty_term_id: string; student_id: string }>(
      sql`SELECT duty_term_id, student_id FROM duty_term
          WHERE line_id = ${lineId} AND status = 'active'`,
    );
    const round = await tx.execute<{ round_id: string }>(
      sql`INSERT INTO duty_round (line_id, seq_no, members_snapshot)
          VALUES (${lineId}, ${(seq[0]?.n ?? 0) + 1}, ${JSON.stringify(terms)})
          RETURNING round_id`,
    );
    const roundId = round[0]!.round_id;
    for (const term of terms) {
      await tx.execute(
        sql`INSERT INTO duty_round_member (round_id, student_id, duty_term_id, is_original)
            VALUES (${roundId}, ${term.student_id}, ${term.duty_term_id}, true)`,
      );
      await tx.execute(
        sql`UPDATE duty_term SET started_round_id = ${roundId}
            WHERE duty_term_id = ${term.duty_term_id} AND started_round_id IS NULL`,
      );
    }
    await broadcast(tx, classId, roundId, 'round_started', requestId);
    await auditRepo.writeAudit(tx, {
      actor: actorId,
      entity: 'duty_round',
      entity_id: roundId,
      action: 'started',
      request_id: requestId,
    });
    return { round_id: roundId, version: 1, member_count: terms.length };
  });
}

export async function getRound(roundId: string, db: Db = defaultDb) {
  const round = await lockRound(db, roundId).catch(() => null);
  const found = await db.execute<RoundRow>(
    sql`SELECT r.round_id, r.line_id, l.class_id, r.seq_no, r.status, r.frozen_at, r.version
        FROM duty_round r JOIN duty_line l ON l.line_id = r.line_id WHERE r.round_id = ${roundId}`,
  );
  if (!found[0]) throw Errors.notFound('卫生轮次', roundId);
  void round;
  const members = await membersOf(db, roundId);
  return {
    round_id: found[0].round_id,
    phase: roundPhase(found[0].status, found[0].frozen_at),
    version: Number(found[0].version),
    members: members.map((m) => ({
      student_id: m.student_id,
      duty_term_id: m.duty_term_id,
      is_original: m.is_original,
      attended: m.attended,
      no_push: m.no_push,
      eligible_for_backfill: m.eligible_for_backfill,
      counted_round: m.counted_round,
      completed_count: Number(m.completed_count),
      required_count: Number(m.required_count),
      term_status: m.term_status,
    })),
  };
}

export async function markAttendance(
  actorId: string,
  roundId: string,
  dutyTermIds: string[],
  expectedVersion: number,
  requestId: string,
  db: Db = defaultDb,
) {
  return idempotentTx(db, requestId, `POST /api/v1/duty/rounds/${roundId}/attendance`, { duty_term_ids: dutyTermIds, request_id: requestId, expected_version: expectedVersion }, async (tx) => {
    const round = await lockRound(tx, roundId);
    assertVersion(round, expectedVersion);
    const members = await membersOf(tx, roundId);
    for (const termId of [...new Set(dutyTermIds)]) {
      const member = members.find((row) => row.duty_term_id === termId);
      if (!member) throw Errors.notFound('卫生任期', termId);
      const applied = applyAttendance(toDomain(member));
      if (applied.counted && member.duty_term_id) {
        await tx.execute(
          sql`UPDATE duty_round_member
              SET attended = true,
                  counted_round = true,
                  eligible_for_backfill = ${applied.member.eligible_for_backfill}
              WHERE round_id = ${roundId} AND student_id = ${member.student_id}`,
        );
        await tx.execute(
          sql`UPDATE duty_term
              SET completed_count = ${applied.member.completed_count},
                  status = ${applied.member.term_status},
                  retired_at = CASE WHEN ${applied.retired}::boolean THEN now() ELSE retired_at END,
                  retire_reason = CASE WHEN ${applied.retired}::boolean THEN '完成应值次数' ELSE retire_reason END
              WHERE duty_term_id = ${member.duty_term_id}`,
        );
      }
    }
    const version = await bump(tx, roundId);
    await broadcast(tx, round.class_id, roundId, 'attendance', requestId);
    return { version };
  });
}

export async function markNoPush(
  actorId: string,
  roundId: string,
  studentIds: string[],
  expectedVersion: number,
  requestId: string,
  db: Db = defaultDb,
) {
  return idempotentTx(db, requestId, `POST /api/v1/duty/rounds/${roundId}/no-push`, { student_ids: studentIds, request_id: requestId, expected_version: expectedVersion }, async (tx) => {
    const round = await lockRound(tx, roundId);
    assertVersion(round, expectedVersion);
    for (const studentId of [...new Set(studentIds)]) {
      const rows = await tx.execute<{ no_push: boolean }>(
        sql`SELECT no_push FROM duty_round_member WHERE round_id = ${roundId} AND student_id = ${studentId}`,
      );
      if (!rows[0]) throw Errors.notFound('轮次成员', studentId);
      if (rows[0].no_push) throw Errors.noPushAlreadyMarked();
      await tx.execute(
        sql`UPDATE duty_round_member
            SET no_push = true, eligible_for_backfill = false
            WHERE round_id = ${roundId} AND student_id = ${studentId}`,
      );
      if (round.frozen_at) {
        await tx.execute(
          sql`UPDATE duty_candidate
              SET invalidated_at = now()
              WHERE round_id = ${roundId} AND student_id = ${studentId} AND invalidated_at IS NULL`,
        );
        await tx.execute(
          sql`UPDATE duty_selection s
              SET status = 'invalidated', resolution_note = 'no_push', resolved_at = now()
              WHERE s.round_id = ${roundId}
                AND s.status IN ('pending', 'cancelled')
                AND EXISTS (
                  SELECT 1 FROM duty_selection_item i
                  WHERE i.selection_id = s.selection_id AND i.picked_student_id = ${studentId}
                )`,
        );
      }
    }
    const version = await bump(tx, roundId);
    await broadcast(tx, round.class_id, roundId, 'no_push', requestId);
    return { version };
  });
}

export async function confirmAbsent(
  actorId: string,
  roundId: string,
  dutyTermId: string,
  expectedVersion: number,
  requestId: string,
  db: Db = defaultDb,
) {
  return idempotentTx(db, requestId, `POST /api/v1/duty/rounds/${roundId}/absent-confirmed`, { duty_term_id: dutyTermId, request_id: requestId, expected_version: expectedVersion }, async (tx) => {
    const round = await lockRound(tx, roundId);
    assertVersion(round, expectedVersion);
    const members = await membersOf(tx, roundId);
    const member = members.find((row) => row.duty_term_id === dutyTermId);
    if (!member || !member.is_original) throw Errors.notFound('卫生任期', dutyTermId);
    const next = applyAbsent(toDomain(member));
    await tx.execute(
      sql`UPDATE duty_term
          SET required_count = ${next.required_count}
          WHERE duty_term_id = ${dutyTermId}`,
    );
    await tx.execute(
      sql`UPDATE duty_round_member
          SET eligible_for_backfill = false, attended = false
          WHERE round_id = ${roundId} AND student_id = ${member.student_id}`,
    );
    try {
      await tx.execute(
        sql`INSERT INTO duty_obligation_adjust (duty_term_id, round_id, before_required, after_required, reason)
            VALUES (${dutyTermId}, ${roundId}, ${member.required_count}, ${next.required_count}, '应值日未参加')`,
      );
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505') {
        throw Errors.forbidden('本轮已经登记过未参加');
      }
      const cause = err && typeof err === 'object' && 'cause' in err ? (err as { cause?: { code?: string } }).cause : undefined;
      if (cause?.code === '23505') throw Errors.forbidden('本轮已经登记过未参加');
      throw err;
    }
    const version = await bump(tx, roundId);
    await broadcast(tx, round.class_id, roundId, 'absent_confirmed', requestId);
    return {
      duty_term_id: dutyTermId,
      before_required: Number(member.required_count),
      after_required: next.required_count,
      version,
    };
  });
}

export async function freezeCandidates(
  actorId: string,
  roundId: string,
  expectedVersion: number,
  requestId: string,
  db: Db = defaultDb,
) {
  return idempotentTx(db, requestId, `POST /api/v1/duty/rounds/${roundId}/candidates/freeze`, { request_id: requestId, expected_version: expectedVersion }, async (tx) => {
    const round = await lockRound(tx, roundId);
    assertVersion(round, expectedVersion);
    if (round.frozen_at) {
      const existing = await tx.execute<{ student_id: string; duty_term_id: string }>(
        sql`SELECT student_id, duty_term_id FROM duty_candidate
            WHERE round_id = ${roundId} AND invalidated_at IS NULL`,
      );
      return { frozen: true, candidates: existing, version: Number(round.version) };
    }
    const pool = candidatesOf((await membersOf(tx, roundId)).map(toDomain));
    const members = await membersOf(tx, roundId);
    for (const candidate of pool) {
      const member = members.find((row) => row.student_id === candidate.student_id);
      if (!member?.duty_term_id) continue;
      await tx.execute(
        sql`INSERT INTO duty_candidate (round_id, student_id, duty_term_id)
            VALUES (${roundId}, ${candidate.student_id}, ${member.duty_term_id})
            ON CONFLICT DO NOTHING`,
      );
    }
    await tx.execute(sql`UPDATE duty_round SET frozen_at = now() WHERE round_id = ${roundId}`);
    const version = await bump(tx, roundId);
    await broadcast(tx, round.class_id, roundId, 'frozen', requestId);
    return {
      frozen: true,
      candidates: pool.map((item) => ({ student_id: item.student_id })),
      version,
    };
  });
}

export async function drawSelection(
  actorId: string,
  roundId: string,
  studentId: string,
  expectedVersion: number,
  requestId: string,
  db: Db = defaultDb,
) {
  return idempotentTx(db, requestId, `POST /api/v1/duty/rounds/${roundId}/selections`, { student_id: studentId, request_id: requestId, expected_version: expectedVersion }, async (tx) => {
    const round = await lockRound(tx, roundId);
    assertVersion(round, expectedVersion);
    if (!round.frozen_at) throw Errors.dutyNotFrozen();
    const open = await tx.execute<{ selection_id: string }>(
      sql`SELECT selection_id FROM duty_selection
          WHERE round_id = ${roundId} AND status IN ('pending', 'cancelled')`,
    );
    if (open[0]) throw Errors.dutySelectionPending();
    const pool = await tx.execute<{ student_id: string; duty_term_id: string }>(
      sql`SELECT student_id, duty_term_id FROM duty_candidate
          WHERE round_id = ${roundId}
            AND consumed_by_selection_id IS NULL
            AND invalidated_at IS NULL`,
    );
    const outcome = selectionOutcome(pool.length);
    if (outcome === 'direct_appoint') {
      const student = await tx.execute<{ class_id: string; status: string }>(
        sql`SELECT class_id, status FROM student WHERE student_id = ${studentId}`,
      );
      if (student[0]?.class_id !== round.class_id || student[0]?.status !== 'active') {
        throw Errors.notFound('本班在班学生', studentId);
      }
      const seq = await tx.execute<{ n: number }>(
        sql`SELECT COALESCE(MAX(seq_no), 0)::int AS n FROM duty_term
            WHERE line_id = ${round.line_id} AND student_id = ${studentId}`,
      );
      const term = await tx.execute<{ duty_term_id: string }>(
        sql`INSERT INTO duty_term (line_id, student_id, seq_no, started_round_id)
            VALUES (${round.line_id}, ${studentId}, ${(seq[0]?.n ?? 0) + 1}, NULL)
            RETURNING duty_term_id`,
      );
      const selection = await tx.execute<{ selection_id: string }>(
        sql`INSERT INTO duty_selection (round_id, new_student_id, status, request_id, resolved_at)
            VALUES (${roundId}, ${studentId}, 'confirmed', ${requestId}, now())
            RETURNING selection_id`,
      );
      await bump(tx, roundId);
      await broadcast(tx, round.class_id, roundId, 'direct_appoint', requestId);
      return {
        selection_id: selection[0]!.selection_id,
        status: 'confirmed',
        new_student_id: studentId,
        outcome,
        picked: [],
        duty_term_id: term[0]!.duty_term_id,
      };
    }
    const index = pickCandidateIndex(pool.length, (max) => Math.floor(Math.random() * max));
    const picked = pool[index]!;
    const selection = await tx.execute<{ selection_id: string }>(
      sql`INSERT INTO duty_selection (round_id, new_student_id, status, request_id)
          VALUES (${roundId}, ${studentId}, 'pending', ${requestId})
          RETURNING selection_id`,
    );
    const selectionId = selection[0]!.selection_id;
    await tx.execute(
      sql`INSERT INTO duty_selection_item (selection_id, picked_duty_term_id, picked_student_id, position)
          VALUES (${selectionId}, ${picked.duty_term_id}, ${picked.student_id}, 1)`,
    );
    await tx.execute(
      sql`UPDATE duty_candidate SET consumed_by_selection_id = ${selectionId}
          WHERE round_id = ${roundId} AND student_id = ${picked.student_id}`,
    );
    await bump(tx, roundId);
    await broadcast(tx, round.class_id, roundId, 'selection_drawn', requestId);
    return {
      selection_id: selectionId,
      status: 'pending',
      new_student_id: studentId,
      outcome,
      picked: [{ student_id: picked.student_id, duty_term_id: picked.duty_term_id, position: 1 }],
    };
  });
}

async function loadSelection(tx: Tx, selectionId: string) {
  const rows = await tx.execute<{
    selection_id: string;
    round_id: string;
    new_student_id: string;
    status: string;
    class_id: string;
    version: number;
  }>(
    sql`SELECT s.selection_id, s.round_id, s.new_student_id, s.status, l.class_id, r.version
        FROM duty_selection s
        JOIN duty_round r ON r.round_id = s.round_id
        JOIN duty_line l ON l.line_id = r.line_id
        WHERE s.selection_id = ${selectionId}
        FOR UPDATE OF s`,
  );
  const row = rows[0];
  if (!row) throw Errors.notFound('卫生抽选', selectionId);
  const picked = await tx.execute<{ student_id: string; duty_term_id: string; position: number }>(
    sql`SELECT picked_student_id AS student_id, picked_duty_term_id AS duty_term_id, position
        FROM duty_selection_item WHERE selection_id = ${selectionId} ORDER BY position`,
  );
  return { ...row, picked };
}

export async function getSelection(selectionId: string, db: Db = defaultDb) {
  const rows = await db.execute<{ selection_id: string; status: string; new_student_id: string }>(
    sql`SELECT selection_id, status, new_student_id FROM duty_selection WHERE selection_id = ${selectionId}`,
  );
  if (!rows[0]) throw Errors.notFound('卫生抽选', selectionId);
  const picked = await db.execute(
    sql`SELECT picked_student_id AS student_id, picked_duty_term_id AS duty_term_id, position
        FROM duty_selection_item WHERE selection_id = ${selectionId} ORDER BY position`,
  );
  return { ...rows[0], picked };
}

export async function cancelSelection(
  actorId: string,
  selectionId: string,
  expectedVersion: number,
  requestId: string,
  db: Db = defaultDb,
) {
  return idempotentTx(db, requestId, `POST /api/v1/duty/selections/${selectionId}/cancel`, { request_id: requestId, expected_version: expectedVersion }, async (tx) => {
    const selection = await loadSelection(tx, selectionId);
    const round = await lockRound(tx, selection.round_id);
    assertVersion(round, expectedVersion);
    if (selection.status === 'cancelled') return selection;
    if (selection.status !== 'pending') throw Errors.forbidden('只有待确认抽选可以取消');
    await tx.execute(
      sql`UPDATE duty_selection SET status = 'cancelled' WHERE selection_id = ${selectionId}`,
    );
    await broadcast(tx, selection.class_id, selection.round_id, 'selection_cancelled', requestId);
    return { ...selection, status: 'cancelled' };
  });
}

export async function reopenSelection(
  actorId: string,
  selectionId: string,
  expectedVersion: number,
  requestId: string,
  db: Db = defaultDb,
) {
  return idempotentTx(db, requestId, `POST /api/v1/duty/selections/${selectionId}/reopen`, { request_id: requestId, expected_version: expectedVersion }, async (tx) => {
    const selection = await loadSelection(tx, selectionId);
    const round = await lockRound(tx, selection.round_id);
    assertVersion(round, expectedVersion);
    if (selection.status === 'pending') return selection;
    if (selection.status !== 'cancelled') throw Errors.forbidden('只有已取消抽选可以重新打开');
    await tx.execute(
      sql`UPDATE duty_selection SET status = 'pending' WHERE selection_id = ${selectionId}`,
    );
    await broadcast(tx, selection.class_id, selection.round_id, 'selection_reopened', requestId);
    return { ...selection, status: 'pending' };
  });
}

export async function confirmSelection(
  actorId: string,
  selectionId: string,
  expectedVersion: number,
  requestId: string,
  db: Db = defaultDb,
) {
  return idempotentTx(db, requestId, `POST /api/v1/duty/selections/${selectionId}/confirm`, { request_id: requestId, expected_version: expectedVersion }, async (tx) => {
    const selection = await loadSelection(tx, selectionId);
    if (selection.status === 'confirmed') return selection;
    const round = await lockRound(tx, selection.round_id);
    assertVersion(round, expectedVersion);
    if (selection.status !== 'pending') throw Errors.forbidden('只有待确认抽选可以确认');
    for (const item of selection.picked) {
      await tx.execute(
        sql`UPDATE duty_term
            SET status = 'retired', retired_at = now(), retire_reason = '抽选替换'
            WHERE duty_term_id = ${item.duty_term_id} AND status = 'active'`,
      );
    }
    const line = await tx.execute<{ line_id: string }>(
      sql`SELECT line_id FROM duty_round WHERE round_id = ${selection.round_id}`,
    );
    const seq = await tx.execute<{ n: number }>(
      sql`SELECT COALESCE(MAX(seq_no), 0)::int AS n FROM duty_term
          WHERE line_id = ${line[0]!.line_id} AND student_id = ${selection.new_student_id}`,
    );
    await tx.execute(
      sql`INSERT INTO duty_term (line_id, student_id, seq_no)
          VALUES (${line[0]!.line_id}, ${selection.new_student_id}, ${(seq[0]?.n ?? 0) + 1})`,
    );
    await tx.execute(
      sql`UPDATE duty_selection SET status = 'confirmed', resolved_at = now() WHERE selection_id = ${selectionId}`,
    );
    await broadcast(tx, selection.class_id, selection.round_id, 'selection_confirmed', requestId);
    return { ...selection, status: 'confirmed' };
  });
}

export async function correctTerm(
  actorId: string,
  dutyTermId: string,
  input: {
    action: 'release' | 'restore' | 'adjust_count';
    note: string;
    completed_count?: number;
    required_count?: number;
    expected_version: number;
    request_id: string;
  },
  db: Db = defaultDb,
) {
  return idempotentTx(db, input.request_id, `POST /api/v1/duty/terms/${dutyTermId}/correct`, input, async (tx) => {
    const terms = await tx.execute<{
      duty_term_id: string;
      line_id: string;
      status: string;
      completed_count: number;
      required_count: number;
      class_id: string;
    }>(
      sql`SELECT t.duty_term_id, t.line_id, t.status, t.completed_count, t.required_count, l.class_id
          FROM duty_term t JOIN duty_line l ON l.line_id = t.line_id
          WHERE t.duty_term_id = ${dutyTermId} FOR UPDATE`,
    );
    const term = terms[0];
    if (!term) throw Errors.notFound('卫生任期', dutyTermId);
    const openRound = await tx.execute<RoundRow>(
      sql`SELECT r.round_id, r.line_id, l.class_id, r.seq_no, r.status, r.frozen_at, r.version
          FROM duty_round r
          JOIN duty_line l ON l.line_id = r.line_id
          WHERE r.line_id = ${term.line_id} AND r.status = 'in_progress'
          FOR UPDATE OF r`,
    );
    if (!openRound[0]) throw Errors.versionConflict('没有进行中的卫生轮次');
    assertVersion(openRound[0], input.expected_version);
    const before = { status: term.status, completed_count: Number(term.completed_count), required_count: Number(term.required_count) };
    if (input.action === 'release') {
      await tx.execute(
        sql`UPDATE duty_term SET status = 'released', retired_at = now(), retire_reason = ${input.note}
            WHERE duty_term_id = ${dutyTermId}`,
      );
    } else if (input.action === 'restore') {
      await tx.execute(
        sql`UPDATE duty_term SET status = 'active', retired_at = NULL, retire_reason = NULL
            WHERE duty_term_id = ${dutyTermId}`,
      );
    } else {
      if (input.completed_count == null && input.required_count == null) {
        throw Errors.forbidden('调整次数必须给出目标值');
      }
      await tx.execute(
        sql`UPDATE duty_term
            SET completed_count = COALESCE(${input.completed_count ?? null}, completed_count),
                required_count = COALESCE(${input.required_count ?? null}, required_count)
            WHERE duty_term_id = ${dutyTermId}`,
      );
    }
    const invalidated = await tx.execute<{ selection_id: string }>(
      sql`UPDATE duty_selection s
          SET status = 'invalidated', resolution_note = ${input.note}, resolved_at = now()
          WHERE s.status IN ('pending', 'cancelled')
            AND EXISTS (
              SELECT 1 FROM duty_selection_item i
              WHERE i.selection_id = s.selection_id AND i.picked_duty_term_id = ${dutyTermId}
            )
          RETURNING s.selection_id`,
    );
    const afterRows = await tx.execute<{ status: string; completed_count: number; required_count: number }>(
      sql`SELECT status, completed_count, required_count FROM duty_term WHERE duty_term_id = ${dutyTermId}`,
    );
    await auditRepo.writeAudit(tx, {
      actor: actorId,
      entity: 'duty_term',
      entity_id: dutyTermId,
      action: input.action,
      before,
      after: afterRows[0],
      request_id: input.request_id,
    });
    return {
      before,
      after: afterRows[0],
      invalidated_selection_id: invalidated[0]?.selection_id ?? null,
    };
  });
}

export async function closeRound(
  actorId: string,
  roundId: string,
  expectedVersion: number,
  requestId: string,
  db: Db = defaultDb,
) {
  return idempotentTx(db, requestId, `POST /api/v1/duty/rounds/${roundId}/close`, { request_id: requestId, expected_version: expectedVersion }, async (tx) => {
    const round = await lockRound(tx, roundId);
    assertVersion(round, expectedVersion);
    const open = await tx.execute<{ selection_id: string }>(
      sql`SELECT selection_id FROM duty_selection
          WHERE round_id = ${roundId} AND status IN ('pending', 'cancelled')`,
    );
    if (open[0]) throw Errors.dutySelectionPending('有未确认抽选，不能结束本轮');
    await tx.execute(
      sql`UPDATE duty_round SET status = 'closed', closed_at = now() WHERE round_id = ${roundId}`,
    );
    const version = await bump(tx, roundId);
    await broadcast(tx, round.class_id, roundId, 'closed', requestId);
    return { version, status: 'closed' };
  });
}
