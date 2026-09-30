-- 0010_fdd_finding_first_detected_idx.sql
-- 目的：M6 抽检采样与 S3 统计的主查询路径——「按首次发现时间圈定周新增」
--       （PRD S3 抽检口径；既有索引 fdd_finding_tenant_status_idx 以 last_detected_at
--       为序，不覆盖 first_detected_at 区间扫描）。
-- 编号说明：M6-fdd.md v1.0.1 提案原编 0006，按链尾顺延为 0010（见 0009 头注）；
--       CONCURRENTLY + NO TRANSACTION + 单语句单文件，沿 0002 模式（DB-SCH-02/03）。
-- +goose NO TRANSACTION
-- +goose Up
CREATE INDEX CONCURRENTLY IF NOT EXISTS fdd_finding_tenant_first_detected_idx
  ON fdd_finding (tenant_id, first_detected_at DESC);

-- +goose Down
DROP INDEX CONCURRENTLY IF EXISTS fdd_finding_tenant_first_detected_idx;
