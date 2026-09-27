-- 0006_alarm_lifecycle.sql
-- M4 告警生命周期承载（modules M4-alarm.md §2.2/§2.4 R1 提案落地，IMPL-13 / DAT-116）：
--   alarm_event 增 closed_by / close_reason / category（+CHECK closed ⇒ close_reason NOT NULL）；
--   新表 alarm_suppression（抑制留痕与到期恢复的唯一承载，ended_reason CHECK + active partial 索引）。
-- 纪律：增量文件、无级联、RLS 策略同步补（DB-SCH-02/03）；全部 FK 显式 RESTRICT（DB-SCH-01）。
-- 前提：alarm_event 仅由告警引擎写入（引擎随本迁移同批落码），存量为空——
--       category NOT NULL 无 DEFAULT 建立在空表前提上（R1 定夺零默认，非自造）。
-- 旁路：thermio_auth 对 alarm_suppression 的定向 internal_read（§4.3 到期 sweep 与引擎重启
--       重建需跨租户扫描生效中抑制行；沿 0001 gateway/device_credential、0005 app_user 先例）。
-- +goose Up

-- ═══ 14. alarm_event 生命周期增列（M4-alarm.md §2.2） ═══

ALTER TABLE alarm_event ADD COLUMN closed_by uuid;
ALTER TABLE alarm_event ADD COLUMN close_reason text;
ALTER TABLE alarm_event ADD COLUMN category  text NOT NULL;
ALTER TABLE alarm_event
  ADD CONSTRAINT alarm_event_closed_by_fkey
  FOREIGN KEY (tenant_id, closed_by) REFERENCES app_user(tenant_id, id)
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- 人工关闭 reason 必填 / 系统关闭机器标记（§4.2 留痕表）；closed 行必须能解释关闭原因
ALTER TABLE alarm_event
  ADD CONSTRAINT alarm_event_close_reason_check
  CHECK (status <> 'closed' OR close_reason IS NOT NULL);

-- ═══ 15. alarm_suppression（M4-alarm.md §2.4，本篇提案新表） ═══

CREATE TABLE alarm_suppression (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  alarm_event_id bigint NOT NULL,
  suppressed_by  uuid NOT NULL,
  reason         text NOT NULL,
  started_at     timestamptz NOT NULL DEFAULT now(),
  until_at       timestamptz NOT NULL,
  ended_at       timestamptz,
  ended_reason   text CHECK (ended_reason IN ('expired','unsuppressed','alarm_closed','superseded')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, alarm_event_id) REFERENCES alarm_event(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (tenant_id, suppressed_by)  REFERENCES app_user(tenant_id, id)  ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK (until_at > started_at)
);
CREATE INDEX alarm_suppression_active_idx ON alarm_suppression (tenant_id, until_at) WHERE ended_at IS NULL;

-- ═══ 16. RLS 策略（P1-1 统一模板，零子查询）与角色授权 ═══

-- +goose StatementBegin
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['alarm_suppression'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO thermio_api
                    USING (tenant_id = app_current_tenant())
                    WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;
-- +goose StatementEnd

GRANT SELECT, INSERT, UPDATE, DELETE ON alarm_suppression TO thermio_api;

-- 引擎 sweep 通道旁路（同 0001/0005 internal_read 先例：定向表、只读、USING(true)）
CREATE POLICY internal_read ON alarm_suppression FOR SELECT TO thermio_auth USING (true);
GRANT SELECT ON alarm_suppression TO thermio_auth;

-- +goose Down
-- 逆依赖序回滚，不用 CASCADE（DB-SCH-01 精神）
DROP POLICY IF EXISTS internal_read ON alarm_suppression;
DROP TABLE IF EXISTS alarm_suppression;
ALTER TABLE alarm_event DROP CONSTRAINT IF EXISTS alarm_event_close_reason_check;
ALTER TABLE alarm_event DROP CONSTRAINT IF EXISTS alarm_event_closed_by_fkey;
ALTER TABLE alarm_event DROP COLUMN IF EXISTS category;
ALTER TABLE alarm_event DROP COLUMN IF EXISTS close_reason;
ALTER TABLE alarm_event DROP COLUMN IF EXISTS closed_by;
