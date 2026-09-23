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
DO $$ BEGIN
  CREATE TYPE seat_direction AS ENUM ('toward_front','toward_back');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE seat_facing AS ENUM ('left','right');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE student_status AS ENUM ('active','left','anonymized');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE left_reason AS ENUM ('transfer','suspension','mistake','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE entry_status AS ENUM ('effective','reversed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE term_status AS ENUM ('open','closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE rollcall_status AS ENUM ('open','closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

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
CREATE OR REPLACE FUNCTION assert_four_columns() RETURNS trigger AS $$
BEGIN
  IF (SELECT count(*) FROM room_column) > 4 THEN
    RAISE EXCEPTION 'layout_column_limit: 系统固定为 4 列' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
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

CREATE OR REPLACE FUNCTION assert_no_polarity_flip() RETURNS trigger AS $$
DECLARE p smallint;
BEGIN
  SELECT polarity INTO p FROM reason_template WHERE template_id = NEW.template_id;
  IF p IS NOT NULL AND NEW.default_delta IS NOT NULL AND sign(NEW.default_delta) <> p THEN
    RAISE EXCEPTION 'polarity_flip: 不允许反转模板正负方向（模板 %）', NEW.template_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
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
CREATE OR REPLACE FUNCTION assert_term_open() RETURNS trigger AS $$
DECLARE t term_status; tid uuid;
BEGIN
  tid := COALESCE(NEW.term_id, OLD.term_id);
  SELECT status INTO t FROM term WHERE term_id = tid;
  IF t IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'term_readonly: 学期已归档，禁止写入账本' USING ERRCODE = '55006';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
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
