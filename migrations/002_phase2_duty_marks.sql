-- =====================================================================
-- 电脑室学生积分管理系统 · 迁移 002 · 第二阶段
-- 覆盖：普通标记 / 卫生管理员（轮次状态机 + 冻结候选 + 不放回随机）
-- 依赖：001_phase1_core.sql
-- 幂等：可重复执行
-- =====================================================================

-- ---------------------------------------------------------------------
-- 枚举（重复执行安全）
-- ---------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE round_status AS ENUM ('in_progress','closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE selection_status AS ENUM ('pending','confirmed','cancelled','invalidated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE duty_term_status AS ENUM ('active','retired','released');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =====================================================================
-- 1. 普通标记（与卫生管理员完全分离，不能通过打标记改变任职状态）
-- =====================================================================
CREATE TABLE IF NOT EXISTS mark_def (
  mark_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  icon        text NOT NULL,
  color       text NOT NULL CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  sort_order  int NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mark_name_active
  ON mark_def (lower(name)) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS student_mark (
  student_id uuid NOT NULL REFERENCES student ON DELETE CASCADE,
  mark_id    uuid NOT NULL REFERENCES mark_def ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (student_id, mark_id)
);
CREATE INDEX IF NOT EXISTS idx_student_mark_mark ON student_mark (mark_id);

-- =====================================================================
-- 2. 卫生管理员（A9 / A10：与学期和积分完全解耦；每班每线最多一个未结束轮次）
-- =====================================================================
CREATE TABLE IF NOT EXISTS duty_line (
  line_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id   uuid NOT NULL REFERENCES class ON DELETE CASCADE,
  name       text NOT NULL DEFAULT '卫生管理员',
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_duty_line_active
  ON duty_line (class_id) WHERE active;

CREATE TABLE IF NOT EXISTS duty_term (
  duty_term_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  line_id         uuid NOT NULL REFERENCES duty_line ON DELETE RESTRICT,
  student_id      uuid NOT NULL REFERENCES student ON DELETE RESTRICT,
  seq_no          int NOT NULL,                        -- 第几次任职（重复任职重新计数）
  completed_count int NOT NULL DEFAULT 0,
  required_count  int NOT NULL DEFAULT 3,              -- 默认 0/3
  status          duty_term_status NOT NULL DEFAULT 'active',
  started_round_id uuid,                               -- 从哪一轮开始生效（新任者下一轮）
  retired_round_id uuid,
  started_at      timestamptz NOT NULL DEFAULT now(),
  retired_at      timestamptz,
  retire_reason   text,
  CONSTRAINT uq_duty_term_seq UNIQUE (line_id, student_id, seq_no),
  CONSTRAINT ck_duty_term_counts CHECK (completed_count >= 0 AND required_count > 0)
);
-- 同一线内同一学生最多一个进行中任期
CREATE UNIQUE INDEX IF NOT EXISTS uq_duty_term_one_active
  ON duty_term (line_id, student_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_duty_term_line_active
  ON duty_term (line_id) WHERE status = 'active';

-- "应值日却未参加" → required_count +1（1/3 → 1/4，同轮最多一次）
CREATE TABLE IF NOT EXISTS duty_obligation_adjust (
  adjust_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  duty_term_id    uuid NOT NULL REFERENCES duty_term ON DELETE RESTRICT,
  round_id        uuid NOT NULL,                       -- 外键在 duty_round 创建后补上
  delta_required  int NOT NULL DEFAULT 1 CHECK (delta_required = 1),
  before_required int NOT NULL,
  after_required  int NOT NULL,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_obligation_adjust_round UNIQUE (duty_term_id, round_id)
);

CREATE TABLE IF NOT EXISTS duty_round (
  round_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  line_id          uuid NOT NULL REFERENCES duty_line ON DELETE RESTRICT,
  seq_no           int NOT NULL,
  status           round_status NOT NULL DEFAULT 'in_progress',
  members_snapshot jsonb NOT NULL,                     -- 本轮开始时的原管理员名单冻结
  frozen_at        timestamptz,                        -- 非空 = 已进入抽选阶段；空池也要写入
  version          int NOT NULL DEFAULT 1,             -- expected_version，与 class.seat_version 分开
  started_at       timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz,
  CONSTRAINT uq_round_seq UNIQUE (line_id, seq_no)
);
-- A10：每条线同时最多一个未结束轮次
CREATE UNIQUE INDEX IF NOT EXISTS uq_round_single_open
  ON duty_round (line_id) WHERE status = 'in_progress';
CREATE INDEX IF NOT EXISTS idx_round_line_status
  ON duty_round (line_id, status);

-- 本轮成员的逐项状态（原管理员 + 新任者）
CREATE TABLE IF NOT EXISTS duty_round_member (
  round_id              uuid NOT NULL REFERENCES duty_round ON DELETE CASCADE,
  student_id            uuid NOT NULL REFERENCES student ON DELETE RESTRICT,
  duty_term_id          uuid REFERENCES duty_term ON DELETE RESTRICT,  -- 新任者本轮为 NULL
  is_original           boolean NOT NULL,                     -- 是否为本轮开始时的原管理员
  attended              boolean NOT NULL DEFAULT false,       -- 实际参加打扫（计一次）
  no_push               boolean NOT NULL DEFAULT false,       -- 本轮登记未推椅子
  eligible_for_backfill boolean NOT NULL DEFAULT true,        -- 本轮是否有替补资格
  counted_round         boolean NOT NULL DEFAULT false,       -- 是否已计完成次数（同轮最多一次）
  added_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (round_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_round_member_eligible
  ON duty_round_member (round_id, eligible_for_backfill, attended);

-- 冻结的候选名单（不放回随机池）
CREATE TABLE IF NOT EXISTS duty_candidate (
  round_id                  uuid NOT NULL REFERENCES duty_round ON DELETE CASCADE,
  student_id                uuid NOT NULL REFERENCES student ON DELETE RESTRICT,
  duty_term_id              uuid NOT NULL REFERENCES duty_term ON DELETE RESTRICT,
  consumed_by_selection_id  uuid,                              -- 被哪次抽选抽走（不放回）
  frozen_at                 timestamptz NOT NULL DEFAULT now(),
  invalidated_at            timestamptz,                        -- 候选状态被修正导致失效
  PRIMARY KEY (round_id, student_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_candidate_consumed
  ON duty_candidate (consumed_by_selection_id) WHERE consumed_by_selection_id IS NOT NULL;

-- 待确认抽选（Q4：同一轮同时只有一个 pending）
CREATE TABLE IF NOT EXISTS duty_selection (
  selection_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id        uuid NOT NULL REFERENCES duty_round ON DELETE CASCADE,
  new_student_id  uuid NOT NULL REFERENCES student ON DELETE RESTRICT,  -- 未推椅子的学生
  status          selection_status NOT NULL DEFAULT 'pending',
  request_id      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  resolution_note text,
  CONSTRAINT uq_selection_request UNIQUE (request_id)
);
-- A10：pending 与 cancelled 都算未确认，同一轮只能有一个
CREATE UNIQUE INDEX IF NOT EXISTS uq_selection_single_open
  ON duty_selection (round_id)
  WHERE status IN ('pending', 'cancelled');
CREATE UNIQUE INDEX IF NOT EXISTS uq_selection_student_open
  ON duty_selection (round_id, new_student_id)
  WHERE status <> 'invalidated';

-- 抽选结果（预览即持久化，不重抽）
CREATE TABLE IF NOT EXISTS duty_selection_item (
  selection_id        uuid NOT NULL REFERENCES duty_selection ON DELETE CASCADE,
  picked_duty_term_id uuid NOT NULL REFERENCES duty_term ON DELETE RESTRICT,  -- 被退役的原管理员
  picked_student_id   uuid NOT NULL REFERENCES student ON DELETE RESTRICT,
  position            int NOT NULL,
  PRIMARY KEY (selection_id, position)
);

-- 全部卫生操作留痕（含人工纠正）
CREATE TABLE IF NOT EXISTS duty_action_log (
  action_id    bigserial PRIMARY KEY,
  round_id     uuid REFERENCES duty_round ON DELETE RESTRICT,
  duty_term_id uuid REFERENCES duty_term ON DELETE RESTRICT,
  action       text NOT NULL,                         -- mark_attended / mark_no_push / ...
  before_state jsonb,
  after_state  jsonb,
  note         text,
  request_id   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_duty_action_round
  ON duty_action_log (round_id, created_at);

-- duty_round 建在 obligation 之后，外键放在文件末尾
ALTER TABLE duty_obligation_adjust
  DROP CONSTRAINT IF EXISTS fk_obligation_round;
ALTER TABLE duty_obligation_adjust
  ADD CONSTRAINT fk_obligation_round
  FOREIGN KEY (round_id) REFERENCES duty_round (round_id) ON DELETE RESTRICT;

ALTER TABLE duty_candidate
  DROP CONSTRAINT IF EXISTS fk_candidate_selection;
ALTER TABLE duty_candidate
  ADD CONSTRAINT fk_candidate_selection
  FOREIGN KEY (consumed_by_selection_id) REFERENCES duty_selection (selection_id) ON DELETE RESTRICT;
