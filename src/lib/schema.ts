/**
 * 全系统唯一的契约层（Zod）。
 *
 * 约定：路由的入参/出参、服务的领域类型、前端复用的 DTO 全部从这里 import。
 * 任何在别处手写重复形状的行为都属于契约漂移，必须回到本文件修正。
 * OpenAPI 由本文件通过 scripts/emit-openapi.ts 生成。
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
/* 枚举（与 001 迁移中的 PG 枚举一一对应，改一处必须改两处）           */
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

/** HTTP 状态映射。路由层统一用它，避免各处各写一套。 */
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
export type CreateClassInput = z.infer<typeof createClassInput>;

export const patchClassInput = z.object({
  name: z.string().min(1).max(64).optional(),
  archived: z.boolean().optional(),
  request_id: requestId,
});
export type PatchClassInput = z.infer<typeof patchClassInput>;

export const termDto = z.object({
  term_id: uuid,
  name: z.string(),
  status: termStatus,
  is_current: z.boolean(),
  started_at: isoDateTime,
  closed_at: isoDateTime.nullable(),
});
export type TermDto = z.infer<typeof termDto>;

export const createTermInput = z.object({
  name: z.string().min(1).max(64),
  request_id: requestId,
});
export type CreateTermInput = z.infer<typeof createTermInput>;

/**
 * 切换学期：一次性全局操作（Q5）。
 * 事务内：关旧学期 → 开新学期 → 为全部在班学生初始化 point_balance=0。
 * 座次、普通标记、未结束卫生轮次不动。
 */
export const activateTermInput = z.object({
  request_id: requestId,
  expected_current_term_id: uuid.nullable(), // 防并发切换
});
export type ActivateTermInput = z.infer<typeof activateTermInput>;

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

export const createStudentInput = z.object({
  student_no: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  remark: z.string().max(500).nullable().optional(),
  seat_id: uuid, // 在班学生必须绑定独立座位，不设待排座区
  expected_version: expectedVersion,
  request_id: requestId,
});
export type CreateStudentInput = z.infer<typeof createStudentInput>;

export const patchStudentInput = z.object({
  student_no: z.string().min(1).max(64).optional(), // 改学号不改内部身份
  name: z.string().min(1).max(64).optional(), // 改名不改内部身份
  remark: z.string().max(500).nullable().optional(),
  request_id: requestId,
});
export type PatchStudentInput = z.infer<typeof patchStudentInput>;

/**
 * 离班。前端必须二次确认后才提交；confirm_token 由前端在确认弹窗中由
 * 用户输入姓名生成，服务端比对姓名，防止误触。
 */
export const leaveStudentInput = z.object({
  reason: leftReason,
  note: z.string().max(500).nullable().optional(),
  confirm_token: z.string().min(1), // 必须等于该生当前姓名
  expected_version: expectedVersion,
  request_id: requestId,
}).refine((v) => v.reason !== 'other' || (v.note != null && v.note.trim() !== ''), {
  message: '原因为「其他」时必须填写说明',
  path: ['note'],
});
export type LeaveStudentInput = z.infer<typeof leaveStudentInput>;

export const restoreStudentInput = z.object({
  seat_id: uuid, // 恢复必须同时指定座位
  expected_version: expectedVersion,
  request_id: requestId,
});
export type RestoreStudentInput = z.infer<typeof restoreStudentInput>;

export const anonymizeStudentInput = z.object({
  request_id: requestId,
});
export const anonymizeClassInput = z.object({
  request_id: requestId,
});

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
  /** 前一次布局变更的重排差异，供 UI 提示"编号已重排"。 */
  last_renumber_diff: z
    .array(z.object({ seat_id: uuid, old: z.number().int().nullable(), new: z.number().int() }))
    .default([]),
});
export type LayoutDto = z.infer<typeof layoutDto>;

export const layoutChangeKind = z.enum([
  'insert_slot',
  'move_slot',
  'delete_slot',
  'change_column',
  'renumber',
]);
export type LayoutChangeKind = z.infer<typeof layoutChangeKind>;

export const insertSlotInput = z.object({
  column_id: uuid,
  after_sort: z.number().int().min(0), // 0 = 插到该列最前
  request_id: requestId,
});

export const moveSlotInput = z.object({
  column_id: uuid,
  after_sort: z.number().int().min(0),
  request_id: requestId,
});

export const changeColumnInput = z.object({
  direction: seatDirection.optional(),
  facing: seatFacing.optional(),
  label: z.string().min(1).max(32).optional(),
  request_id: requestId,
});

export const previewLayoutChangeInput = z.object({
  kind: layoutChangeKind,
  payload: z.record(z.unknown()),
});

/** 布局变更影响预览：提交前必须让教师看到会影响哪些班级。 */
export const layoutImpactDto = z.object({
  kind: layoutChangeKind,
  affected_classes: z.array(
    z.object({
      class_id: uuid,
      name: z.string(),
      students_moved: z.number().int(),
      seat_assignments_removed: z.number().int(),
    }),
  ),
  renumber_diff: z.array(
    z.object({ seat_id: uuid, old: z.number().int().nullable(), new: z.number().int() }),
  ),
  blockers: z.array(z.object({ code: z.enum(ERROR_CODES), message: z.string() })),
  /** 预览内容哈希：提交时必须回传，防止预览后布局被他人改动。 */
  preview_hash: z.string(),
});
export type LayoutImpactDto = z.infer<typeof layoutImpactDto>;

export const applyLayoutChangeInput = z.object({
  kind: layoutChangeKind,
  payload: z.record(z.unknown()),
  preview_hash: z.string(),
  request_id: requestId,
});

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
  /** 叠加后的展示名（班级覆盖优先）。 */
  effective_name: z.string(),
  /** 叠加后的默认分值（班级覆盖优先）。 */
  effective_delta: z.number().int(),
  hidden: z.boolean(),
  /** 全局基线的方向，永不可被班级反转。 */
  polarity,
  added_in_class: z.boolean(),
  has_override: z.boolean(),
  sort_order: z.number().int(),
});
export type EffectiveTemplateDto = z.infer<typeof effectiveTemplateDto>;

export const createTemplateInput = z.object({
  name: z.string().min(1).max(32),
  polarity,
  default_delta: z.number().int().refine((v) => v !== 0, '分值不能为 0'),
  sort_order: z.number().int().default(0),
  request_id: requestId,
});

export const patchTemplateInput = z.object({
  name: z.string().min(1).max(32).optional(),
  default_delta: z.number().int().refine((v) => v !== 0, '分值不能为 0').optional(),
  request_id: requestId,
});
export type PatchTemplateInput = z.infer<typeof patchTemplateInput>;

export const overrideTemplateInput = z.object({
  name: z.string().min(1).max(32).nullable().optional(),
  default_delta: z.number().int().nullable().optional(),
  hidden: z.boolean().nullable().optional(),
  request_id: requestId,
});
export type OverrideTemplateInput = z.infer<typeof overrideTemplateInput>;

/**
 * 记账请求：单人/批量共用同一入口。
 * 一次批量 → 一个批次，整体成功或整体失败（A6）。
 * delta 非零整数；带模板时符号必须与模板 polarity 一致，不能反转方向。
 */
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
    /** 整批撤销是否可用（存在 effective 明细）。 */
    batch_reverse_available: z.boolean(),
    /** 已撤销的明细数，用于"部分撤销后整批撤销"的提示。 */
    already_reversed_count: z.number().int(),
  }),
});
export type BatchResultDto = z.infer<typeof batchResultDto>;

export const reverseBatchInput = z.object({
  request_id: requestId,
});
export const reverseEntryInput = z.object({
  request_id: requestId,
});

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

/* ------------------------------------------------------------------ */
/* 时间线 / 榜单（第一阶段只做时间线；榜单在第二阶段）                  */
/* ------------------------------------------------------------------ */

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
/* SSE 事件（A8 / 多端同步）                                            */
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
  'roster_changed', // 入班/离班/恢复/匿名化影响历史成员集合
];

export const sseMessage = z.object({
  event_seq: z.number().int(),
  kind: eventKind,
  class_id: uuid.nullable(),
  payload: z.unknown(),
  occurred_at: isoDateTime,
});
export type SseMessage = z.infer<typeof sseMessage>;

export const sseQuery = z.object({
  since: z.coerce.number().int().nonnegative().default(0),
  class_id: uuid.optional(),
});
export type SseQuery = z.infer<typeof sseQuery>;

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

export const dutyVersionInput = z.object({
  request_id: requestId,
  expected_version: expectedVersion,
});

export const dutyAttendanceInput = dutyVersionInput.extend({
  duty_term_ids: z.array(uuid).min(1),
});

export const dutyNoPushInput = dutyVersionInput.extend({
  student_ids: z.array(uuid).min(1),
});

export const dutyAbsentInput = dutyVersionInput.extend({
  duty_term_id: uuid,
});

export const dutySelectionInput = dutyVersionInput.extend({
  student_id: uuid,
});

export const dutyFreezeInput = dutyVersionInput;

export const dutyCorrectInput = dutyVersionInput.extend({
  action: z.enum(['release', 'restore', 'adjust_count']),
  note: z.string().min(1).max(500),
  completed_count: z.number().int().nonnegative().optional(),
  required_count: z.number().int().positive().optional(),
});

/* ------------------------------------------------------------------ */
/* 导入（第一阶段）                                                    */
/* ------------------------------------------------------------------ */

export const importTemplateKind = z.enum(['rows', 'seatmap']);
export type ImportTemplateKind = z.infer<typeof importTemplateKind>;

export const importTemplateQuery = z.object({
  kind: importTemplateKind,
});
export type ImportTemplateQuery = z.infer<typeof importTemplateQuery>;

/** 逐条导入问题：必须能定位到工作表 + 单元格或行。 */
export const importIssue = z.object({
  severity: z.enum(['error', 'warning']),
  code: z.string(),
  message: z.string(),
  sheet: z.string(),
  /** 如 "B7"；平面模板必须给出单元格。 */
  cell: z.string().nullable(),
  row: z.number().int().nullable(),
  student_no: z.string().nullable(),
});
export type ImportIssue = z.infer<typeof importIssue>;

export const importChange = z.object({
  kind: z.enum(['create', 'update', 'keep', 'seat_change']),
  student_no: z.string(),
  name: z.string(),
  student_id: uuid.nullable(),
  from_seat_number: z.number().int().nullable(),
  to_seat_number: z.number().int().nullable(),
  /** 学号相同但姓名变化：预览必须高亮提示。 */
  name_changed: z.boolean().default(false),
});
export type ImportChange = z.infer<typeof importChange>;

export const importPreviewDto = z.object({
  /** 承诺令牌：提交时必须回传；绑定内容哈希 + class.seat_version + TTL。 */
  preview_token: z.string(),
  template_kind: importTemplateKind,
  issues: z.array(importIssue),
  changes: z.array(importChange),
  summary: z.object({
    create: z.number().int(),
    update: z.number().int(),
    keep: z.number().int(),
    seat_changes: z.number().int(),
    errors: z.number().int(),
    warnings: z.number().int(),
  }),
  /** 存在 error 级问题时禁止提交。 */
  committable: z.boolean(),
  /** 阻塞原因（如"存在无座在班学生"）。 */
  blockers: z.array(z.object({ code: z.enum(ERROR_CODES), message: z.string() })),
});
export type ImportPreviewDto = z.infer<typeof importPreviewDto>;

export const importCommitInput = z.object({
  preview_token: z.string(),
  expected_version: expectedVersion,
  request_id: requestId,
});
export type ImportCommitInput = z.infer<typeof importCommitInput>;

/** 提交成功体。与 docs/API.md 的导入预览一节一致。 */
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
