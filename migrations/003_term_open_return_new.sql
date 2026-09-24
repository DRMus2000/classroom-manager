-- =====================================================================
-- 电脑室学生积分管理系统 · 迁移 003
-- 覆盖：开放学期的 BEFORE INSERT 必须 RETURN NEW
-- 依赖：001_phase1_core.sql
-- 幂等：可重复执行
--
-- 001 里的 assert_term_open() 在通过时 RETURN NULL。
-- BEFORE INSERT 返回 NULL 会丢掉这一行，开放学期的记账看起来成功，账本里却没有明细。
-- 已执行过 001 的库不会重跑该文件，所以在这里替换函数体。
-- =====================================================================

CREATE OR REPLACE FUNCTION assert_term_open() RETURNS trigger AS $$
DECLARE t term_status; tid uuid;
BEGIN
  tid := COALESCE(NEW.term_id, OLD.term_id);
  SELECT status INTO t FROM term WHERE term_id = tid;
  IF t IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'term_readonly: 学期已归档，禁止写入账本' USING ERRCODE = '55006';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
