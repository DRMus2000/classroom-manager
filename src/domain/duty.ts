/**
 * 卫生轮次的纯判定。落库规则见 docs/DESIGN.md §4.2。
 * 新任者 is_original 为 false，不进候选池，本轮不计次。
 */

export type DutyPhase = 'marking' | 'substituting' | 'closed';
export type TermStatus = 'active' | 'retired' | 'released';

export interface DutyMember {
  student_id: string;
  is_original: boolean;
  attended: boolean;
  eligible_for_backfill: boolean;
  completed_count: number;
  required_count: number;
  term_status: TermStatus;
}

export function roundPhase(
  status: 'in_progress' | 'closed',
  frozenAt: Date | string | null,
): DutyPhase {
  if (status === 'closed') return 'closed';
  return frozenAt == null ? 'marking' : 'substituting';
}

/** 冻结池成员：原管理员、已打扫、仍在任、本轮有替补资格、尚未达标。 */
export function isFrozenCandidate(member: DutyMember): boolean {
  return (
    member.is_original &&
    member.attended &&
    member.term_status === 'active' &&
    member.eligible_for_backfill &&
    member.completed_count < member.required_count
  );
}

export function candidatesOf(members: DutyMember[]): DutyMember[] {
  return members.filter(isFrozenCandidate);
}

/**
 * 勾选打扫后的任期。同轮只计一次；达到应完成次数则退役。
 * 已计次的人再次勾选不改变计数。
 */
export function applyAttendance(member: DutyMember): {
  member: DutyMember;
  counted: boolean;
  retired: boolean;
} {
  if (!member.is_original || member.attended) {
    return { member, counted: false, retired: false };
  }
  const completed = member.completed_count + 1;
  const retired = completed >= member.required_count;
  return {
    counted: true,
    retired,
    member: {
      ...member,
      attended: true,
      completed_count: completed,
      term_status: retired ? 'retired' : member.term_status,
      eligible_for_backfill: retired ? false : member.eligible_for_backfill,
    },
  };
}

/** 应值日未参加：应完成次数 +1，本轮不能替补，不计完成次数。 */
export function applyAbsent(member: DutyMember): DutyMember {
  return {
    ...member,
    required_count: member.required_count + 1,
    eligible_for_backfill: false,
    attended: false,
  };
}

export type SelectionOutcome = 'preview' | 'direct_appoint';

export function selectionOutcome(remainingCandidates: number): SelectionOutcome {
  return remainingCandidates > 0 ? 'preview' : 'direct_appoint';
}

/** 在剩余候选中取下标。randomInt(n) 返回 [0, n)。 */
export function pickCandidateIndex(count: number, randomInt: (max: number) => number): number {
  if (count <= 0) throw new Error('没有可抽的候选');
  return randomInt(count);
}
