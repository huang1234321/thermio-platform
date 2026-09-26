-- 0002_alarm_event_tenant_uidx.sql
-- 目的：为 alarm_event 补 UNIQUE (tenant_id, id)，作为 fdd_finding.alarm_event_id
--       复合外键的目标（P1-1 复合 FK 纪律；fdd_finding ↔ 告警联动，见 §9.2）。
-- +goose NO TRANSACTION
-- +goose Up
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS alarm_event_tenant_id_uidx
  ON alarm_event (tenant_id, id);

-- +goose Down
DROP INDEX CONCURRENTLY IF EXISTS alarm_event_tenant_id_uidx;
