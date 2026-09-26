/**
 * 页面用到、但 schema.ts 里没有 Zod 定义的响应形状。
 * 字段名逐字对应后端服务的返回值与 docs/API.md，不另起名字。
 */
import type {
  BatchResultDto,
  ClassDto,
  ClassSeatsDto,
  EffectiveTemplateDto,
  LeftReason,
  MarkDefDto,
  ReplayMode,
  SeatCardDto,
  StudentDto,
  TermDto,
  TimelineEventDto,
} from './schema';

export type {
  BatchResultDto,
  ClassDto,
  ClassSeatsDto,
  EffectiveTemplateDto,
  LeftReason,
  MarkDefDto,
  ReplayMode,
  SeatCardDto,
  StudentDto,
  TermDto,
  TimelineEventDto,
};

export type SeatStudent = NonNullable<SeatCardDto['student']>;
export type DutyBadge = NonNullable<SeatStudent['duty']>;

export interface MeDto {
  teacher_id: string;
  username: string;
  token_version: number;
}

export interface SeatPlanDto {
  ok: boolean;
  assignments: {
    student_id: string;
    from_seat_id: string;
    to_seat_id: string;
    role: 'selected' | 'affected';
  }[];
  issues: { code: string; message: string; offending_seat_ids: string[] }[];
}

/* ---------------- 卫生 ---------------- */

export type DutyPhase = 'marking' | 'substituting' | 'closed';
export type DutyTermStatus = 'active' | 'retired' | 'released';

export interface DutyMemberDto {
  student_id: string;
  duty_term_id: string | null;
  is_original: boolean;
  attended: boolean;
  no_push: boolean;
  eligible_for_backfill: boolean;
  counted_round: boolean;
  completed_count: number;
  required_count: number;
  term_status: DutyTermStatus;
}

export interface DutyRoundDto {
  round_id: string;
  seq_no: number;
  phase: DutyPhase;
  version: number;
  frozen_at: string | null;
  members: DutyMemberDto[];
}

export type DutySelectionStatus = 'pending' | 'cancelled' | 'confirmed' | 'invalidated';

export interface ClassDutyDto {
  line_id: string | null;
  round: DutyRoundDto | null;
  open_selection: { selection_id: string; status: DutySelectionStatus; new_student_id: string } | null;
  next_appointees: { duty_term_id: string; student_id: string }[];
  active_terms: { duty_term_id: string; student_id: string; completed_count: number; required_count: number }[];
}

export interface DutySelectionDto {
  selection_id: string;
  status: DutySelectionStatus;
  new_student_id: string;
  outcome?: 'preview' | 'direct_appoint';
  picked: { student_id: string; duty_term_id: string; position: number }[];
  duty_term_id?: string;
  resolution_note?: string | null;
}

export interface DutyCorrectResult {
  before: { status: string; completed_count: number; required_count: number };
  after: { status: string; completed_count: number; required_count: number };
  invalidated_selection_id: string | null;
}

/* ---------------- 榜单与回放 ---------------- */

export interface RankRow {
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

export interface ReplayTimelineDto {
  mode: ReplayMode;
  from: string;
  to: string;
  base_state: {
    student_id: string;
    class_id: string;
    present: boolean;
    balance: number;
    balance_before_range: number;
    base_balance: number;
  }[];
  frame_count: number;
  checkpoints: { upto_event_seq: number; created_at: string }[];
  density: { at: string; frames: number }[];
}

export interface ReplayFrameDto {
  event_seq: number;
  occurred_at: string;
  kind: string;
  top10: RankRow[];
}

export interface ReplayStateDto {
  at: string;
  mode: ReplayMode;
  ranking: RankRow[];
}

/* ---------------- 课堂工具 ---------------- */

export interface RollcallDto {
  rollcall_id: string;
  class_id: string;
  status: 'open' | 'closed';
  scope: { type: 'all' | 'selected'; student_ids: string[] };
  exclude_student_ids: string[];
  picked: { student_id: string; name: string; seat_number: number | null }[];
}

export type CountdownStatus = 'running' | 'paused' | 'reset' | 'finished';

export interface CountdownDto {
  class_id: string;
  status: CountdownStatus;
  duration_sec: number | null;
  deadline_at: string | null;
  remaining_sec: number | null;
  updated_at: string | null;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export interface ImportIssueDto {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  sheet: string;
  cell: string | null;
  row: number | null;
  student_no: string | null;
}

export interface ImportChangeDto {
  kind: 'create' | 'update' | 'keep';
  student_no: string;
  name: string;
  student_id: string | null;
  from_seat_number: number | null;
  to_seat_number: number | null;
  name_changed: boolean;
}

export interface ImportPreviewDto {
  preview_token: string;
  template_kind: 'rows' | 'seatmap';
  issues: ImportIssueDto[];
  changes: ImportChangeDto[];
  summary: {
    create: number;
    update: number;
    keep: number;
    seat_changes: number;
    errors: number;
    warnings: number;
  };
  committable: boolean;
  blockers: { code: string; message: string }[];
}

export interface ImportCommitResultDto {
  seat_version: number;
  applied: { create: number; update: number };
}

export interface TermSummaryDto {
  term: TermDto;
  total_batches: number;
  total_entries: number;
  total_reversals: number;
  students_scored: number;
}
