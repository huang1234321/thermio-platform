-- 0009_fdd_review_ignore.sql
-- 目的：M6 抽检命中率记录入口（PRD §7 S3，modules/M6-fdd §3.3/§8）+ 发现人工忽略留档
--       （ddl.md §9.2 生命周期「ignored(人工)」的 actor/时间列，沿 alarm_event.acked_by/acked_at 同构；
--       ignore reason 走结构化日志不落列，与 M4 close 同口径）。
-- 编号说明：M6-fdd.md v1.0.1 提案原编 0005/0006（让位 M7-auth 0004 后顺延）；本仓迁移链
--       已落 0004–0008，故按链尾顺延为 0009/0010——内容 = 提案原文（M6 §3.3 R1）。
-- 纪律：只加列不改既有列（DB-SCH-05 加列即时完成）；review_* 为正交判定
--       （不进 status 状态机，modules/M6-fdd §2.2）；表已有 RLS 统一模板（0003），
--       新列自动纳入行级隔离，无需新策略。
-- +goose Up

ALTER TABLE fdd_finding
  ADD COLUMN review_result text CHECK (review_result IN ('confirmed','false_positive')),
  ADD COLUMN review_note   text,
  ADD COLUMN reviewed_by   uuid,
  ADD COLUMN reviewed_at   timestamptz,
  ADD COLUMN ignored_by    uuid,
  ADD COLUMN ignored_at    timestamptz;

ALTER TABLE fdd_finding
  ADD CONSTRAINT fdd_finding_reviewed_by_fkey
    FOREIGN KEY (tenant_id, reviewed_by) REFERENCES app_user(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT fdd_finding_ignored_by_fkey
    FOREIGN KEY (tenant_id, ignored_by) REFERENCES app_user(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- +goose Down
ALTER TABLE fdd_finding
  DROP CONSTRAINT IF EXISTS fdd_finding_ignored_by_fkey,
  DROP CONSTRAINT IF EXISTS fdd_finding_reviewed_by_fkey;
ALTER TABLE fdd_finding
  DROP COLUMN IF EXISTS ignored_at,
  DROP COLUMN IF EXISTS ignored_by,
  DROP COLUMN IF EXISTS reviewed_at,
  DROP COLUMN IF EXISTS reviewed_by,
  DROP COLUMN IF EXISTS review_note,
  DROP COLUMN IF EXISTS review_result;
