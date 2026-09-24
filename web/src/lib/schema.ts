/**
 * 前端契约层 —— 后端 `src/lib/schema.ts` 的镜像。
 *
 * 【为什么是镜像而不是 import】
 * `web/` 是独立子项目（独立 package.json / tsconfig），运行时不加载后端代码；
 * 生产构建只产出静态资源。因此这里逐字复制后端 Zod 契约的类型与枚举，
 * 保证字段名、可空性、枚举值一一对应。
 *
 * 【漂移防线】
 * 这里同时保留 Zod schema（而非只写 TS 类型），在 lib/api.ts 的响应边界上
 * 做一次 safeParse。一旦后端改了字段而前端没同步，会在开发期立刻报错，
 * 而不是等到线上渲染出 undefined。任何改动都必须回到后端 schema.ts 对齐。
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* 基础类型                                                            */
/* ------------------------------------------------------------------ */

/** 所有写操作必须携带的幂等键（A7）。同一物理操作的重试必须复用同一个值。 */
export const requestId = z.string().uuid();

/** 乐观锁版本号（A12）。资源结构 = 班级座次 / 名单。 */
export const expectedVersion = z.number().int().nonnegative();

export const uuid = z.string().uuid();

/** 北京时间是渲染口径；服务端一律存 UTC 的 timestamptz。 */
export const SERVER_TZ = 'Asia/Shanghai';

export const isoDateTime = z.string().datetime({ offset: true });

/* ------------------------------------------------------------------ */
/* 枚举（与 001 迁移中的 PG 枚举一一对应）                             */
/* ------------------------------------------------------------------ */

export const seatDirection = z.enum(['toward_front', 'toward_back']);
export type SeatDirection = z.infer<typeof seatDirection>;

/** 学生朝向：列级统一，不跟随旋转渲染。 */
export const seatFacing = z.enum(['left', 'right']);
export type SeatFacing = z.infer<typeof seatFacing>;

export const studentStatus = z.enum(['active', 'left', 'anonymized']);
export type StudentStatus = z.infer<typeof studentStatus>;

export const leftReason = z.enum(['transfer', 'suspension', 'mistake', 'other']);
export type LeftReason = z.infer<typeof leftReason>;

export const entryStatus = z.enum(['effective', 'reversed']);
export type EntryStatus = z.infer<typeof entryStatus>;

export const termStatus = z.enum(['open', 'closed']);
export type TermStatus = z.infer<typeof termStatus>;

/** 回放口径。cumulative 起点带区间起点已有分数；net 起点恒为 0。 */
export const replayMode = z.enum(['cumulative', 'net']);
export type ReplayMode = z.infer<typeof replayMode>;

/* ------------------------------------------------------------------ */
/* 统一错误体                                                          */
/* ------------------------------------------------------------------ */

export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'SESSION_REVOKED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VERSION_CONFLICT',
  'IDEMPOTENCY_MISMATCH',
  'REQUEST_IN_FLIGHT',
  'SEAT_CONFLICT',
  'SEAT_OCCUPIED',
  'SEAT_REQUIRED',
  'SEAT_MOVE_UNBALANCED',
  'POLARITY_MISMATCH',
  'TERM_READONLY',
  'STUDENT_NO_SEAT',
  'IMPORT_INVALID',
  'IMPORT_TOKEN_EXPIRED',
  'ALREADY_REVERSED',
  'DUTY_SELECTION_PENDING',
  'DUTY_SELECTION_OPEN',
  'DUTY_NOT_FROZEN',
  'NO_PUSH_ALREADY_MARKED',
  'RATE_LIMITED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  SESSION_REVOKED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_MISMATCH: 409,
  REQUEST_IN_FLIGHT: 409,
  SEAT_CONFLICT: 409,
  SEAT_OCCUPIED: 409,
  SEAT_REQUIRED: 422,
  SEAT_MOVE_UNBALANCED: 422,
  POLARITY_MISMATCH: 422,
  TERM_READONLY: 422,
  STUDENT_NO_SEAT: 422,
  IMPORT_INVALID: 422,
  IMPORT_TOKEN_EXPIRED: 409,
  ALREADY_REVERSED: 409,
  DUTY_SELECTION_PENDING: 409,
  DUTY_SELECTION_OPEN: 409,
  DUTY_NOT_FROZEN: 409,
  NO_PUSH_ALREADY_MARKED: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export const errorBody = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.unknown().optional(),
    request_id: z.string().optional(),
  }),
});
export type ErrorBody = z.infer<typeof errorBody>;

/* ------------------------------------------------------------------ */
/* 认证                                                                */
/* ------------------------------------------------------------------ */

export const loginInput = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(8).max(256),
});
export type LoginInput = z.infer<typeof loginInput>;

export const changePasswordInput = z.object({
  old_password: z.string().min(1),
  new_password: z.string().min(12).max(256),
  request_id: requestId,
});
export type ChangePasswordInput = z.infer<typeof changePasswordInput>;

/** 登录态探针返回值。后端未在 schema.ts 中定义该形状，见交付说明。 */
export const sessionDto = z.object({ username: z.string() });
export type SessionDto = z.infer<typeof sessionDto>;

/* ------------------------------------------------------------------ */
/* 班级与学期                                                          */
/* ------------------------------------------------------------------ */

export const classDto = z.object({
  class_id: uuid,
  name: z.string(),
  archived_at: isoDateTime.nullable(),
  seat_version: z.number().int(),
  active_student_count: z.number().int(),
  current_term_id: uuid.nullable(),
  created_at: isoDateTime,
});
export type ClassDto = z.infer<typeof classDto>;

export const createClassInput = z.object({
  name: z.string().min(1).max(64),
  request_id: requestId,
});

export const termDto = z.object({
  term_id: uuid,
  name: z.string(),
  status: termStatus,
  is_current: z.boolean(),
  started_at: isoDateTime,
  closed_at: isoDateTime.nullable(),
});
export type TermDto = z.infer<typeof termDto>;

/* ------------------------------------------------------------------ */
/* 学生                                                                */
/* ------------------------------------------------------------------ */

export const studentDto = z.object({
  student_id: uuid,
  class_id: uuid,
  student_no: z.string(),
  name: z.string(),
  remark: z.string().nullable(),
  status: studentStatus,
  left_reason: leftReason.nullable(),
  left_note: z.string().nullable(),
  left_at: isoDateTime.nullable(),
  anon_code: z.string().nullable(),
  anon_at: isoDateTime.nullable(),
  /** 当前座位（离班/无座为 null）。seat_number 为当前显示编号，会随布局重排变化。 */
  seat: z
    .object({
      seat_id: uuid,
      seat_number: z.number().int(),
      column_code: z.string(),
    })
    .nullable(),
  marks: z.array(uuid),
});
export type StudentDto = z.infer<typeof studentDto>;

export const leaveStudentInput = z.object({
  reason: leftReason,
  note: z.string().max(500).nullable().optional(),
  confirm_token: z.string().min(1),
  expected_version: expectedVersion,
  request_id: requestId,
});
export type LeaveStudentInput = z.infer<typeof leaveStudentInput>;

/* ------------------------------------------------------------------ */
/* 机房布局                                                            */
/* ------------------------------------------------------------------ */

export const roomColumnDto = z.object({
  column_id: uuid,
  code: z.string(),
  display_order: z.number().int(),
  direction: seatDirection,
  facing: seatFacing,
  label: z.string(),
  slot_count: z.number().int(),
});
export type RoomColumnDto = z.infer<typeof roomColumnDto>;

export const roomSlotDto = z.object({
  seat_id: uuid,
  column_id: uuid,
  column_code: z.string(),
  sort_in_column: z.number().int(),
  /** 显示编号。由 renumerate() 生成，插入/删除座位后会整体重排。 */
  seat_number: z.number().int().nullable(),
  label: z.string().nullable(),
  occupant_class_count: z.number().int(),
});
export type RoomSlotDto = z.infer<typeof roomSlotDto>;

export const layoutDto = z.object({
  columns: z.array(roomColumnDto),
  slots: z.array(roomSlotDto),
  total_slots: z.number().int(),
  /** 前一次布局变更的重排差异，供 UI 提示「编号已重排」。 */
  last_renumber_diff: z
    .array(z.object({ seat_id: uuid, old: z.number().int().nullable(), new: z.number().int() }))
    .default([]),
});
export type LayoutDto = z.infer<typeof layoutDto>;

/* ------------------------------------------------------------------ */
/* 座次与换座                                                          */
/* ------------------------------------------------------------------ */

export const seatCardDto = z.object({
  seat_id: uuid,
  seat_number: z.number().int().nullable(),
  column_code: z.string(),
  sort_in_column: z.number().int(),
  facing: seatFacing,
  student: z
    .object({
      student_id: uuid,
      name: z.string(),
      student_no: z.string(),
      balance: z.number().int(),
      marks: z.array(uuid),
      /** 卫生管理员徽章：扫帚图标 + 琥珀色，与普通标记通道分离渲染。 */
      duty: z
        .object({
          duty_term_id: uuid,
          completed_count: z.number().int(),
          required_count: z.number().int(),
          status: z.enum(['active', 'retired', 'released']),
        })
        .nullable(),
    })
    .nullable(),
});
export type SeatCardDto = z.infer<typeof seatCardDto>;

export const classSeatsDto = z.object({
  class_id: uuid,
  seat_version: z.number().int(),
  term_id: uuid,
  columns: z.array(roomColumnDto),
  cards: z.array(seatCardDto),
});
export type ClassSeatsDto = z.infer<typeof classSeatsDto>;

export const planSeatsInput = z.object({
  source_student_ids: z.array(uuid).min(1),
  target_seat_ids: z.array(uuid).min(1),
});
export type PlanSeatsInput = z.infer<typeof planSeatsInput>;

export const seatPlanIssue = z.object({
  code: z.enum(['COUNT_MISMATCH', 'TARGET_NOT_FOUND', 'SOURCE_STUDENT_NOT_FOUND']),
  message: z.string(),
  offending_seat_ids: z.array(uuid).default([]),
});
export type SeatPlanIssue = z.infer<typeof seatPlanIssue>;

export const seatAssignmentsInput = z.object({
  assignments: z.array(z.object({ student_id: uuid, seat_id: uuid })).min(1),
  expected_version: expectedVersion,
  request_id: requestId,
});
export type SeatAssignmentsInput = z.infer<typeof seatAssignmentsInput>;

/* ------------------------------------------------------------------ */
/* 积分                                                                */
/* ------------------------------------------------------------------ */

export const polarity = z.union([z.literal(-1), z.literal(1)]);
export type Polarity = z.infer<typeof polarity>;

/** 模板有效值 = 全局基线叠加班级覆盖后的结果。 */
export const effectiveTemplateDto = z.object({
  template_id: uuid,
  effective_name: z.string(),
  effective_delta: z.number().int(),
  hidden: z.boolean(),
  polarity,
  added_in_class: z.boolean(),
  has_override: z.boolean(),
  sort_order: z.number().int(),
});
export type EffectiveTemplateDto = z.infer<typeof effectiveTemplateDto>;

export const createBatchInput = z.object({
  request_id: requestId,
  class_id: uuid,
  term_id: uuid,
  student_ids: z.array(uuid).min(1).max(200),
  delta: z.number().int().refine((v) => v !== 0, '加减分必须是非零整数'),
  template_id: uuid.nullable().default(null),
  note: z.string().max(500).nullable().default(null),
});
export type CreateBatchInput = z.infer<typeof createBatchInput>;

export const pointEntryDto = z.object({
  entry_id: uuid,
  batch_id: uuid,
  student_id: uuid,
  student_name: z.string(),
  delta: z.number().int(),
  balance_before: z.number().int(),
  balance_after: z.number().int(),
  seat_id: uuid.nullable(),
  /** 操作当时的座位号。永不因后续布局重排而变动。 */
  seat_number_snapshot: z.number().int().nullable(),
  reason_snapshot: z
    .object({ name: z.string(), polarity, source: z.enum(['global', 'class', 'none']) })
    .nullable(),
  status: entryStatus,
  reverses_entry_id: uuid.nullable(),
  reversed_by_entry_id: uuid.nullable(),
  occurred_at: isoDateTime,
  seq: z.number().int(),
});
export type PointEntryDto = z.infer<typeof pointEntryDto>;

export const batchResultDto = z.object({
  batch_id: uuid,
  term_id: uuid,
  class_id: uuid,
  kind: z.enum(['score', 'reversal']),
  reverses_batch_id: uuid.nullable(),
  delta_value: z.number().int(),
  member_count: z.number().int(),
  partial_reversed: z.boolean(),
  occurred_at: isoDateTime,
  entries: z.array(pointEntryDto),
  undo: z.object({
    batch_reverse_available: z.boolean(),
    already_reversed_count: z.number().int(),
  }),
});
export type BatchResultDto = z.infer<typeof batchResultDto>;

export const listEntriesQuery = z.object({
  term_id: uuid.optional(),
  class_id: uuid.optional(),
  student_id: uuid.optional(),
  date_from: isoDateTime.optional(),
  date_to: isoDateTime.optional(),
  direction: z.enum(['add', 'sub']).optional(),
  reason_template_id: uuid.optional(),
  include_reversals: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  cursor: z.string().regex(/^[1-9]\d{0,18}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListEntriesQuery = z.infer<typeof listEntriesQuery>;

export const timelineEventDto = z.object({
  batch_id: uuid,
  occurred_at: isoDateTime,
  delta_value: z.number().int(),
  member_count: z.number().int(),
  kind: z.enum(['score', 'reversal']),
  reason_snapshot: z
    .object({ name: z.string(), polarity, source: z.enum(['global', 'class', 'none']) })
    .nullable(),
  entries: z.array(
    z.object({
      entry_id: uuid,
      student_id: uuid,
      student_name: z.string(),
      delta: z.number().int(),
      balance_after: z.number().int(),
      status: entryStatus,
      seat_number_snapshot: z.number().int().nullable(),
    }),
  ),
});
export type TimelineEventDto = z.infer<typeof timelineEventDto>;

/* ------------------------------------------------------------------ */
/* SSE 事件                                                            */
/* ------------------------------------------------------------------ */

export const eventKind = z.enum([
  'seat_changed',
  'points_appended',
  'roster_changed',
  'layout_changed',
  'term_switched',
  'marks_changed',
  'duty_round_changed',
  'countdown_changed',
  'rollcall_changed',
  'resync',
]);
export type EventKind = z.infer<typeof eventKind>;

/** 影响回放的事件类型：用于检查点计数（每 N 个触发一次）。 */
export const REPLAY_RELEVANT_KINDS: readonly EventKind[] = [
  'points_appended',
  'roster_changed',
];

export const sseMessage = z.object({
  event_seq: z.number().int(),
  kind: eventKind,
  class_id: uuid.nullable(),
  payload: z.unknown(),
  occurred_at: isoDateTime,
});
export type SseMessage = z.infer<typeof sseMessage>;

/* ------------------------------------------------------------------ */
/* 审计 / 备份                                                         */
/* ------------------------------------------------------------------ */

export const auditQuery = z.object({
  entity: z.string().optional(),
  entity_id: z.string().optional(),
  action: z.string().optional(),
  date_from: isoDateTime.optional(),
  date_to: isoDateTime.optional(),
  cursor: z.string().regex(/^[1-9]\d{0,18}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditQuery = z.infer<typeof auditQuery>;

/**
 * 审计条目读取形状。
 * 【契约缺口】schema.ts 只定义了 auditQuery（筛选入参），没有定义返回条目的 DTO。
 * 这里按最小合理形状声明，等后端补 `auditEntryDto` 后回来对齐。
 */
export const auditEntryDto = z.object({
  audit_id: z.string(),
  actor: z.string().nullable(),
  entity: z.string(),
  entity_id: z.string().nullable(),
  action: z.string(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  occurred_at: isoDateTime,
  request_id: z.string().nullable(),
});
export type AuditEntryDto = z.infer<typeof auditEntryDto>;

export const backupRecordDto = z.object({
  backup_id: uuid,
  file_name: z.string(),
  size_bytes: z.number().int().nullable(),
  disk_free_bytes: z.number().int().nullable(),
  status: z.enum(['running', 'success', 'failed']),
  error: z.string().nullable(),
  started_at: isoDateTime,
  finished_at: isoDateTime.nullable(),
});
export type BackupRecordDto = z.infer<typeof backupRecordDto>;

/* ------------------------------------------------------------------ */
/* 普通标记                                                            */
/* ------------------------------------------------------------------ */

export const markColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

export const markDefDto = z.object({
  mark_id: uuid,
  name: z.string(),
  icon: z.string(),
  color: markColor,
  sort_order: z.number().int(),
});
export type MarkDefDto = z.infer<typeof markDefDto>;

export const createMarkInput = z.object({
  name: z.string().trim().min(1).max(64),
  icon: z.string().trim().min(1).max(32),
  color: markColor,
  sort_order: z.number().int().min(0).max(10_000).optional(),
  request_id: requestId,
});
export type CreateMarkInput = z.infer<typeof createMarkInput>;

export const patchMarkInput = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  icon: z.string().trim().min(1).max(32).optional(),
  color: markColor.optional(),
  sort_order: z.number().int().min(0).max(10_000).optional(),
  archived: z.boolean().optional(),
  request_id: requestId,
});
export type PatchMarkInput = z.infer<typeof patchMarkInput>;

export const markAssignInput = z.object({
  request_id: requestId,
});
export type MarkAssignInput = z.infer<typeof markAssignInput>;

/* ------------------------------------------------------------------ */
/* 导入                                                                */
/* ------------------------------------------------------------------ */

export const importTemplateKind = z.enum(['rows', 'seatmap']);
export type ImportTemplateKind = z.infer<typeof importTemplateKind>;

export const importTemplateQuery = z.object({
  kind: importTemplateKind,
});
export type ImportTemplateQuery = z.infer<typeof importTemplateQuery>;

export const importCommitResult = z.object({
  seat_version: z.number().int(),
  applied: z.object({
    create: z.number().int(),
    update: z.number().int(),
  }),
});
export type ImportCommitResult = z.infer<typeof importCommitResult>;

/* ------------------------------------------------------------------ */
/* 分页                                                                */
/* ------------------------------------------------------------------ */

export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    next_cursor: z.string().nullable(),
  });
}

export const auditPageDto = paginated(auditEntryDto);
export type AuditPageDto = z.infer<typeof auditPageDto>;

export const entriesPageDto = paginated(pointEntryDto);
export type EntriesPageDto = z.infer<typeof entriesPageDto>;
