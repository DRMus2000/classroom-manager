# 数据模型与 DDL

本文是设计交付件里的目标库结构，与 `migrations/001_phase1_core.sql`、`migrations/002_phase2_duty_marks.sql` 保持一致。数据库是 PostgreSQL 16。业务表的主键除审计、登录尝试、卫生操作日志和积分明细序号外，都是 `uuid`，默认 `gen_random_uuid()`。时间列是 `timestamptz`，由数据库 `now()` 写入。

座位编号 `seat_number` 允许为空，只在 `renumerate()` 的事务中间态出现。对外引用使用 `seat_id`。积分历史另存 `seat_number_snapshot`，重排不回溯。

关系图见 `docs/DESIGN.md` §5。

## 索引策略

| 目的 | 做法 |
|---|---|
| 身份与座次不重复 | 部分唯一索引：在班学号、未归档班名、未归档标记名、当前学期、开放学期、未结束卫生轮次、未确认抽选、进行中点名 |
| 编号可重排 | `room_slot.seat_number` 的唯一索引带 `WHERE seat_number IS NOT NULL` |
| 一人一座 | `seat_assignment` 主键 `(class_id, seat_id)`，另有唯一 `(class_id, student_id)` |
| 账本只追加、不可二次冲销 | `point_entry` 上 `reverses_entry_id`、`reversed_by_entry_id` 两个部分唯一索引。批次与幂等表用 `request_id` 唯一 |
| 榜单 | `point_balance (term_id, balance DESC, last_change_seq, student_id)`。`last_change_seq` 是批次级回放事件序号 |
| 时间线与回放 | `point_entry` 按 `term_id, seq` 和 `class_id_snapshot, seq`。`event_log` 对 `replay_relevant` 建部分索引。检查点按 `(class_id, term_id, upto_event_seq DESC)` |
| 卫生不放回 | `duty_candidate.consumed_by_selection_id` 部分唯一，并外键到 `duty_selection`。`pending` 与 `cancelled` 共用“一轮一个未确认抽选”的部分唯一索引 |
| 审计与备份 | 按实体加时间、按 `request_id`、按备份开始时间倒序 |
| 登录限流 | `login_attempt (username, attempted_at DESC)` |

删除策略：账号会话用 `ON DELETE CASCADE`。学生、学期、机位、积分使用 `RESTRICT`，避免把历史账本级联删掉。机位删除前由服务扫描全部班级的 `seat_assignment`。匿名登记故意不加学生外键，这样旧备份恢复后仍能按 `student_id` 补做匿名化。

触发器是约束的一部分：最多 4 列、禁止反转模板方向、旧学期禁止写入账本。

## DDL

下面是第一阶段与第二阶段的完整建表语句。

```sql
-- =====================================================================
-- 电脑室学生积分管理系统 · 迁移 001 · 第一阶段核心
-- 覆盖：登录 / 班级与学期 / 名单与座次 / 全局布局 / 积分账本 / 撤销 /
--       时间线 / 审计 / 备份记录 / SSE 事件流 / 幂等 / 回放检查点
-- 依赖：PostgreSQL 16+
-- 幂等：可重复执行（IF NOT EXISTS / DROP TRIGGER IF EXISTS）
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------
-- 枚举（重复执行安全）
-- ---------------------------------------------------------------------
DO $ BEGIN
  CREATE TYPE seat_direction AS ENUM ('toward_front','toward_back');
EXCEPTION WHEN duplicate_object THEN NULL; END $;

DO $ BEGIN
  CREATE TYPE seat_facing AS ENUM ('left','right');
EXCEPTION WHEN duplicate_object THEN NULL; END $;

DO $ BEGIN
  CREATE TYPE student_status AS ENUM ('active','left','anonymized');
EXCEPTION WHEN duplicate_object THEN NULL; END $;

DO $ BEGIN
  CREATE TYPE left_reason AS ENUM ('transfer','suspension','mistake','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $;

DO $ BEGIN
  CREATE TYPE entry_status AS ENUM ('effective','reversed');
EXCEPTION WHEN duplicate_object THEN NULL; END $;

DO $ BEGIN
  CREATE TYPE term_status AS ENUM ('open','closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $;

DO $ BEGIN
  CREATE TYPE rollcall_status AS ENUM ('open','closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $;

-- =====================================================================
-- 1. 账号与会话
-- =====================================================================
CREATE TABLE IF NOT EXISTS teacher (
  teacher_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username            text NOT NULL UNIQUE,
  password_hash       text NOT NULL,                  -- Argon2id
  token_version       int  NOT NULL DEFAULT 1,        -- +1 = 踢出其他设备
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session (
  session_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id    uuid NOT NULL REFERENCES teacher ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,                 -- 只存哈希，不存明文
  token_version int  NOT NULL,
  user_agent    text,
  last_seen_ip  inet,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);
CREATE INDEX IF NOT EXISTS idx_session_teacher_active
  ON session (teacher_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS login_attempt (
  id           bigserial PRIMARY KEY,
  username     text NOT NULL,
  ip           inet,
  success      boolean NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_attempt_window
  ON login_attempt (username, attempted_at DESC);

-- =====================================================================
-- 2. 班级与学期
-- =====================================================================
CREATE TABLE IF NOT EXISTS class (
  class_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  archived_at  timestamptz,                           -- 归档 = 退出日常管理
  seat_version int NOT NULL DEFAULT 1,                -- 乐观锁（座次/导入）
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_class_name_active
  ON class (lower(name)) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS term (
  term_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  status     term_status NOT NULL DEFAULT 'open',
  is_current boolean NOT NULL DEFAULT false,
  started_at timestamptz NOT NULL DEFAULT now(),
  closed_at  timestamptz
);
-- 全局唯一当前学期；全局唯一 open 学期（一次性全局切换）
CREATE UNIQUE INDEX IF NOT EXISTS uq_term_current     ON term (is_current) WHERE is_current;
CREATE UNIQUE INDEX IF NOT EXISTS uq_term_single_open ON term (status) WHERE status = 'open';
CREATE INDEX        IF NOT EXISTS idx_term_started    ON term (started_at);

-- =====================================================================
-- 3. 机房布局（全局唯一一套，跨班共享）
-- =====================================================================
CREATE TABLE IF NOT EXISTS room_column (
  column_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          char(1) NOT NULL UNIQUE,              -- '4','3','2','1'
  display_order int NOT NULL UNIQUE,                  -- 1=屏幕最左(④) … 4=屏幕最右(①)
  direction     seat_direction NOT NULL,              -- 持久化属性，不由位置推导
  facing        seat_facing    NOT NULL,              -- 列级统一：①③=right ②④=left
  label         text NOT NULL
);

CREATE TABLE IF NOT EXISTS room_slot (
  seat_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  column_id      uuid NOT NULL REFERENCES room_column ON DELETE RESTRICT,
  sort_in_column int  NOT NULL,                       -- 1 起，列内物理顺序（稳定，不参与重排）
  seat_number    int,                                 -- 显示编号，由 renumerate() 生成
  label          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_room_slot_pos UNIQUE (column_id, sort_in_column)
);
-- 编号唯一；允许临时 NULL 作为 renumerate() 事务中间态
CREATE UNIQUE INDEX IF NOT EXISTS uq_room_slot_number
  ON room_slot (seat_number) WHERE seat_number IS NOT NULL;

-- 系统固定 4 列
CREATE OR REPLACE FUNCTION assert_four_columns() RETURNS trigger AS $
BEGIN
  IF (SELECT count(*) FROM room_column) > 4 THEN
    RAISE EXCEPTION 'layout_column_limit: 系统固定为 4 列' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_four_columns ON room_column;
CREATE CONSTRAINT TRIGGER trg_four_columns
  AFTER INSERT OR UPDATE ON room_column
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_four_columns();

CREATE TABLE IF NOT EXISTS layout_change (
  change_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN
                     ('insert_slot','move_slot','delete_slot','change_column','renumber')),
  payload          jsonb NOT NULL,
  affected_classes jsonb NOT NULL DEFAULT '[]',
  renumber_diff    jsonb NOT NULL DEFAULT '[]',       -- [{seat_id, old, new}]
  request_id       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- 4. 学生与当前座次
-- =====================================================================
CREATE TABLE IF NOT EXISTS student (
  student_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 内部不可变 ID
  class_id    uuid NOT NULL REFERENCES class ON DELETE RESTRICT,
  student_no  text NOT NULL,
  name        text NOT NULL,
  remark      text,
  status      student_status NOT NULL DEFAULT 'active',
  left_reason left_reason,
  left_note   text,
  left_at     timestamptz,
  anon_code   text,
  anon_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_left_reason_note CHECK (left_reason <> 'other' OR left_note IS NOT NULL),
  CONSTRAINT ck_left_at          CHECK (status <> 'left' OR left_at IS NOT NULL),
  CONSTRAINT ck_anon_shape       CHECK (
    status <> 'anonymized' OR (anon_code IS NOT NULL AND name = '' AND student_no = ''))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_student_no_active
  ON student (class_id, student_no) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_student_class_status ON student (class_id, status);
CREATE INDEX IF NOT EXISTS idx_student_name         ON student (class_id, name);

CREATE TABLE IF NOT EXISTS seat_assignment (
  class_id   uuid NOT NULL REFERENCES class     ON DELETE CASCADE,
  seat_id    uuid NOT NULL REFERENCES room_slot ON DELETE RESTRICT,
  student_id uuid NOT NULL REFERENCES student   ON DELETE RESTRICT,
  term_id    uuid NOT NULL REFERENCES term,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (class_id, seat_id)
);
-- 一学生在班内最多占一座
CREATE UNIQUE INDEX IF NOT EXISTS uq_seat_assign_student ON seat_assignment (class_id, student_id);
CREATE INDEX        IF NOT EXISTS idx_seat_assign_seat   ON seat_assignment (seat_id);

-- =====================================================================
-- 5. 积分账本（只追加，永不改写）
-- =====================================================================
CREATE TABLE IF NOT EXISTS reason_template (
  template_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  polarity          smallint NOT NULL CHECK (polarity IN (-1, 1)),  -- 永不可改
  default_delta     int NOT NULL,
  hidden_by_default boolean NOT NULL DEFAULT false,
  sort_order        int NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_template_delta_nonzero CHECK (default_delta <> 0),
  CONSTRAINT ck_template_delta_sign    CHECK (sign(default_delta) = polarity)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_template_name ON reason_template (lower(name));

-- 班级覆盖 = 字段级叠加层：只能改名 / 改默认值 / 隐藏，不能反转方向
CREATE TABLE IF NOT EXISTS class_template_override (
  class_id       uuid NOT NULL REFERENCES class           ON DELETE CASCADE,
  template_id    uuid NOT NULL REFERENCES reason_template ON DELETE CASCADE,
  name           text,
  default_delta  int,
  hidden         boolean,
  added_in_class boolean NOT NULL DEFAULT false,       -- true = 班级私有新增
  PRIMARY KEY (class_id, template_id),
  CONSTRAINT ck_override_delta_nonzero CHECK (default_delta IS NULL OR default_delta <> 0)
);

CREATE OR REPLACE FUNCTION assert_no_polarity_flip() RETURNS trigger AS $
DECLARE p smallint;
BEGIN
  SELECT polarity INTO p FROM reason_template WHERE template_id = NEW.template_id;
  IF p IS NOT NULL AND NEW.default_delta IS NOT NULL AND sign(NEW.default_delta) <> p THEN
    RAISE EXCEPTION 'polarity_flip: 不允许反转模板正负方向（模板 %）', NEW.template_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_no_polarity_flip ON class_template_override;
CREATE TRIGGER trg_no_polarity_flip
  BEFORE INSERT OR UPDATE ON class_template_override
  FOR EACH ROW EXECUTE FUNCTION assert_no_polarity_flip();

CREATE TABLE IF NOT EXISTS point_batch (
  batch_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  term_id           uuid NOT NULL REFERENCES term  ON DELETE RESTRICT,
  class_id          uuid NOT NULL REFERENCES class ON DELETE RESTRICT,
  template_id       uuid REFERENCES reason_template ON DELETE RESTRICT,
  reason_snapshot   jsonb,                             -- {name, polarity, source}
  delta_value       int  NOT NULL,
  member_count      int  NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('score','reversal')),
  reverses_batch_id uuid REFERENCES point_batch ON DELETE RESTRICT,
  partial_reversed  boolean NOT NULL DEFAULT false,
  occurred_at       timestamptz NOT NULL DEFAULT now(),  -- 同批次共享同一时间
  teacher_id        uuid REFERENCES teacher,
  request_id        uuid NOT NULL,
  CONSTRAINT ck_batch_delta_nonzero  CHECK (delta_value <> 0),
  CONSTRAINT ck_batch_member_count   CHECK (member_count > 0),
  CONSTRAINT ck_batch_reversal_shape CHECK (kind <> 'reversal' OR reverses_batch_id IS NOT NULL),
  CONSTRAINT uq_batch_request        UNIQUE (request_id)   -- 幂等
);
CREATE INDEX IF NOT EXISTS idx_batch_term_time  ON point_batch (term_id, occurred_at, batch_id);
CREATE INDEX IF NOT EXISTS idx_batch_class_time ON point_batch (class_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_batch_reverses   ON point_batch (reverses_batch_id)
  WHERE reverses_batch_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS point_entry (
  entry_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id             uuid NOT NULL REFERENCES point_batch ON DELETE RESTRICT,
  student_id           uuid NOT NULL REFERENCES student     ON DELETE RESTRICT,
  term_id              uuid NOT NULL REFERENCES term        ON DELETE RESTRICT,
  class_id_snapshot    uuid NOT NULL,                  -- 防班级归属随学生漂移
  delta                int  NOT NULL,
  balance_after        int  NOT NULL,
  seat_id              uuid REFERENCES room_slot ON DELETE SET NULL,
  seat_number_snapshot int,                            -- 操作当时座位号（永不回溯）
  reason_snapshot      jsonb,
  status               entry_status NOT NULL DEFAULT 'effective',
  reverses_entry_id    uuid REFERENCES point_entry ON DELETE RESTRICT,
  reversed_by_entry_id uuid REFERENCES point_entry ON DELETE RESTRICT,
  occurred_at          timestamptz NOT NULL,
  seq                  bigserial NOT NULL,
  CONSTRAINT ck_entry_delta_nonzero  CHECK (delta <> 0),
  CONSTRAINT ck_entry_reversed_shape
    CHECK (status = 'effective' OR reversed_by_entry_id IS NOT NULL)
);
-- 一条明细最多被冲销一次；一条明细最多产生一条反向记录（物理层防重复冲销）
CREATE UNIQUE INDEX IF NOT EXISTS uq_entry_reversed_once
  ON point_entry (reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_entry_reversed_by_once
  ON point_entry (reversed_by_entry_id) WHERE reversed_by_entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entry_student_seq ON point_entry (student_id, seq);
CREATE INDEX IF NOT EXISTS idx_entry_term_seq    ON point_entry (term_id, seq);
CREATE INDEX IF NOT EXISTS idx_entry_batch       ON point_entry (batch_id);
CREATE INDEX IF NOT EXISTS idx_entry_class_seq   ON point_entry (class_id_snapshot, seq);

-- 余额缓存：与账本同事务维护。
-- last_change_seq 存的是该批次的回放事件序号 event_log.event_seq，
-- 不是 point_entry.seq。同一批次的学生共用这个序号来破并列。
CREATE TABLE IF NOT EXISTS point_balance (
  term_id         uuid NOT NULL REFERENCES term    ON DELETE RESTRICT,
  student_id      uuid NOT NULL REFERENCES student ON DELETE RESTRICT,
  balance         int NOT NULL DEFAULT 0,
  last_change_seq bigint NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (term_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_balance_rank
  ON point_balance (term_id, balance DESC, last_change_seq, student_id);

-- 旧学期只读（DB 层兜底，应用层绕过亦无效）
CREATE OR REPLACE FUNCTION assert_term_open() RETURNS trigger AS $
DECLARE t term_status; tid uuid;
BEGIN
  tid := COALESCE(NEW.term_id, OLD.term_id);
  SELECT status INTO t FROM term WHERE term_id = tid;
  IF t IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'term_readonly: 学期已归档，禁止写入账本' USING ERRCODE = '55006';
  END IF;
  RETURN NEW;
END $ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_entry_term_open ON point_entry;
CREATE TRIGGER trg_entry_term_open BEFORE INSERT ON point_entry
  FOR EACH ROW EXECUTE FUNCTION assert_term_open();
DROP TRIGGER IF EXISTS trg_batch_term_open ON point_batch;
CREATE TRIGGER trg_batch_term_open BEFORE INSERT ON point_batch
  FOR EACH ROW EXECUTE FUNCTION assert_term_open();

-- =====================================================================
-- 6. 课堂工具
-- =====================================================================
CREATE TABLE IF NOT EXISTS rollcall_round (
  rollcall_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id     uuid NOT NULL REFERENCES class ON DELETE CASCADE,
  scope_desc   jsonb NOT NULL,
  exclude_list jsonb NOT NULL DEFAULT '[]',
  picked_ids   jsonb NOT NULL DEFAULT '[]',
  status       rollcall_status NOT NULL DEFAULT 'open',
  created_at   timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rollcall_open
  ON rollcall_round (class_id) WHERE status = 'open';

-- 倒计时：服务端保存状态并跨端同步（只同步 开始/暂停/继续/重置 + 绝对截止时间）
CREATE TABLE IF NOT EXISTS countdown_state (
  countdown_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id      uuid NOT NULL REFERENCES class ON DELETE CASCADE,
  duration_sec  int NOT NULL CHECK (duration_sec > 0),
  status        text NOT NULL CHECK (status IN ('running','paused','reset','finished')),
  deadline_at   timestamptz,
  remaining_sec int,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES teacher
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_countdown_class ON countdown_state (class_id);

-- =====================================================================
-- 7. 事件流 / 检查点 / 审计 / 幂等
-- =====================================================================

-- replay_relevant=true 的事件计入检查点触发（每 N 个触发一次）
CREATE TABLE IF NOT EXISTS event_log (
  event_seq       bigserial PRIMARY KEY,
  class_id        uuid,
  kind            text NOT NULL,
  payload         jsonb NOT NULL,
  replay_relevant boolean NOT NULL DEFAULT false,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_class_seq  ON event_log (class_id, event_seq);
CREATE INDEX IF NOT EXISTS idx_event_kind_time  ON event_log (kind, occurred_at);
CREATE INDEX IF NOT EXISTS idx_event_replay_seq ON event_log (event_seq) WHERE replay_relevant;

-- 回放检查点：每 N 个回放事件触发 + 每日兜底；后台异步生成，不阻塞加减分。
-- 最新检查点之后的事件按需补算；当前排行榜直接查 point_balance，不等检查点。
CREATE TABLE IF NOT EXISTS replay_checkpoint (
  checkpoint_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id       uuid NOT NULL REFERENCES class ON DELETE CASCADE,
  term_id        uuid NOT NULL REFERENCES term  ON DELETE RESTRICT,
  upto_event_seq bigint NOT NULL,                     -- 覆盖到的最大事件序号
  state          jsonb NOT NULL,                      -- {student_id: {balance, class_id}}
  trigger_reason text NOT NULL CHECK (trigger_reason IN ('event_threshold','daily','manual')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_checkpoint_seq UNIQUE (class_id, term_id, upto_event_seq)
);
CREATE INDEX IF NOT EXISTS idx_checkpoint_lookup
  ON replay_checkpoint (class_id, term_id, upto_event_seq DESC);

-- 可调参数（阈值是初始参数，不是业务限制）
CREATE TABLE IF NOT EXISTS job_config (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO job_config (key, value) VALUES
  ('replay_checkpoint_event_threshold', '200'::jsonb),
  ('replay_checkpoint_daily_cron',      '"07 3 * * *"'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- 审计：与业务变更同事务写入，不依赖前端收到通知
CREATE TABLE IF NOT EXISTS audit_log (
  audit_id   bigserial PRIMARY KEY,
  actor      uuid REFERENCES teacher,
  entity     text NOT NULL,
  entity_id  text,
  action     text NOT NULL,
  before     jsonb,
  after      jsonb,
  request_id uuid,
  ip         inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_entity  ON audit_log (entity, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_time    ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_request ON audit_log (request_id);

CREATE TABLE IF NOT EXISTS idempotency (
  request_id    uuid PRIMARY KEY,
  endpoint      text NOT NULL,
  request_hash  text NOT NULL,                        -- 同键不同体 → 409
  status_code   int,
  response_body jsonb,
  state         text NOT NULL DEFAULT 'in_flight' CHECK (state IN ('in_flight','done')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency (created_at);

-- =====================================================================
-- 8. 备份记录
-- =====================================================================
CREATE TABLE IF NOT EXISTS backup_record (
  backup_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name       text NOT NULL,
  size_bytes      bigint,
  disk_free_bytes bigint,                             -- 磁盘容量监测
  status          text NOT NULL CHECK (status IN ('running','success','failed')),
  error           text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_backup_started ON backup_record (started_at DESC);

-- =====================================================================
-- 9. 匿名化登记
-- 只存内部学生 ID / 匿名化时间 / 处理版本 —— 刻意不存原始姓名与学号。
-- 外部 append-only 账本见 002 迁移说明与 scripts/anon-ledger.ts
-- =====================================================================
CREATE TABLE IF NOT EXISTS anon_registry (
  anon_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id      uuid NOT NULL,                      -- 不加 FK：恢复旧备份后仍可用
  class_id        uuid NOT NULL,
  anon_code       text NOT NULL,
  processed_at    timestamptz NOT NULL DEFAULT now(),
  process_version int NOT NULL,                       -- 追加递增
  ledger_entry_id uuid,                               -- 外部账本条目 id
  CONSTRAINT uq_anon_student_version UNIQUE (student_id, process_version)
);
CREATE INDEX IF NOT EXISTS idx_anon_student ON anon_registry (student_id);
CREATE INDEX IF NOT EXISTS idx_anon_class   ON anon_registry (class_id);
CREATE INDEX IF NOT EXISTS idx_anon_version ON anon_registry (process_version);

-- 外部账本导出状态（失败告警 + 重试）
CREATE TABLE IF NOT EXISTS anon_ledger_export (
  anon_id     uuid PRIMARY KEY REFERENCES anon_registry ON DELETE RESTRICT,
  state       text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','exported','failed')),
  attempts    int  NOT NULL DEFAULT 0,
  last_error  text,
  exported_at timestamptz,
  ledger_path text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_anon_export_pending ON anon_ledger_export (state, updated_at)
  WHERE state <> 'exported';

-- =====================================================================
-- 10. 初始数据：4 列 + 54 机位
-- 几何以 docs/DESIGN.md §3.1 为准。本段只插入列与槽位，不写 seat_number。
-- sort_in_column：1 = 讲台端，递增指向后墙。
-- direction：toward_back = 编号沿 sort 升序（讲台→后墙）；
--            toward_front = 编号沿 sort 降序（后墙→讲台）。
-- facing：right = 学生朝机房屏幕左侧（①③）；left = 朝屏幕右侧（②④）。
-- 列遍历编号顺序是 ①→②→③→④，不是 display_order 升序。
-- 种子 direction / facing 与下表一致；编号要等符合规范的 renumerate() 回填：
--   ① toward_back  facing=right  14 座 →  1..14
--   ② toward_front facing=left   14 座 → 15..28
--   ③ toward_back  facing=right  13 座 → 29..41
--   ④ toward_front facing=left   13 座 → 42..54
-- =====================================================================
INSERT INTO room_column (code, display_order, direction, facing, label) VALUES
  ('4', 1, 'toward_front', 'left',  '④列（屏幕最左）'),
  ('3', 2, 'toward_back',  'right', '③列'),
  ('2', 3, 'toward_front', 'left',  '②列'),
  ('1', 4, 'toward_back',  'right', '①列（屏幕最右）')
ON CONFLICT (code) DO NOTHING;

INSERT INTO room_slot (column_id, sort_in_column)
SELECT c.column_id, g.n
FROM room_column c
CROSS JOIN LATERAL generate_series(
  1,
  CASE c.code WHEN '4' THEN 13 WHEN '3' THEN 13 WHEN '2' THEN 14 WHEN '1' THEN 14 ELSE 0 END
) AS g(n)
ON CONFLICT (column_id, sort_in_column) DO NOTHING;

-- =====================================================================
-- 电脑室学生积分管理系统 · 迁移 002 · 第二阶段
-- 覆盖：普通标记 / 卫生管理员（轮次状态机 + 冻结候选 + 不放回随机）
-- 依赖：001_phase1_core.sql
-- 幂等：可重复执行
-- =====================================================================

-- ---------------------------------------------------------------------
-- 枚举（重复执行安全）
-- ---------------------------------------------------------------------
DO $ BEGIN
  CREATE TYPE round_status AS ENUM ('in_progress','closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $;

DO $ BEGIN
  CREATE TYPE selection_status AS ENUM ('pending','confirmed','cancelled','invalidated');
EXCEPTION WHEN duplicate_object THEN NULL; END $;

DO $ BEGIN
  CREATE TYPE duty_term_status AS ENUM ('active','retired','released');
EXCEPTION WHEN duplicate_object THEN NULL; END $;

-- =====================================================================
-- 1. 普通标记（与卫生管理员完全分离，不能通过打标记改变任职状态）
-- =====================================================================
CREATE TABLE IF NOT EXISTS mark_def (
  mark_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  icon        text NOT NULL,
  color       text NOT NULL CHECK (color ~ '^#[0-9a-fA-F]{6}),
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
```
