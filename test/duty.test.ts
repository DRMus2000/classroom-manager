import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyAbsent,
  applyAttendance,
  candidatesOf,
  isFrozenCandidate,
  pickCandidateIndex,
  roundPhase,
  selectionOutcome,
  type DutyMember,
} from '../src/domain/duty.js';

function member(partial: Partial<DutyMember> = {}): DutyMember {
  return {
    student_id: 's',
    is_original: true,
    attended: false,
    eligible_for_backfill: true,
    completed_count: 1,
    required_count: 3,
    term_status: 'active',
    ...partial,
  };
}

describe('duty', () => {
  it('frozen_at 决定阶段', () => {
    assert.equal(roundPhase('in_progress', null), 'marking');
    assert.equal(roundPhase('in_progress', '2026-09-23T00:00:00Z'), 'substituting');
    assert.equal(roundPhase('closed', null), 'closed');
  });

  it('达标者、未参加者和新任者不进候选池', () => {
    const members = [
      member({ student_id: 'ok', attended: true, completed_count: 1, required_count: 3 }),
      member({ student_id: 'done', attended: true, completed_count: 3, required_count: 3, term_status: 'retired' }),
      member({ student_id: 'absent', attended: false }),
      member({ student_id: 'new', is_original: false, attended: true }),
      member({ student_id: 'blocked', attended: true, eligible_for_backfill: false }),
    ];
    assert.deepEqual(candidatesOf(members).map((m) => m.student_id), ['ok']);
    assert.equal(isFrozenCandidate(members[1]!), false);
  });

  it('计次达到应完成次数则退役，未参加把 3 变成 4', () => {
    const counted = applyAttendance(member({ completed_count: 2, required_count: 3 }));
    assert.equal(counted.retired, true);
    assert.equal(counted.member.term_status, 'retired');
    const again = applyAttendance(counted.member);
    assert.equal(again.counted, false);
    const absent = applyAbsent(member({ completed_count: 1, required_count: 3 }));
    assert.equal(absent.required_count, 4);
    assert.equal(absent.completed_count, 1);
    assert.equal(absent.eligible_for_backfill, false);
  });

  it('池空则直接任命，有人则预览且下标落在候选范围内', () => {
    assert.equal(selectionOutcome(0), 'direct_appoint');
    assert.equal(selectionOutcome(2), 'preview');
    assert.equal(pickCandidateIndex(3, () => 2), 2);
  });
});
