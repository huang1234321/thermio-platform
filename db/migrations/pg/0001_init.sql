-- +goose Up
-- 纪律：全部 FK 显式 RESTRICT，无 DB 级联（DB-SCH-01）；初始建表时表为空，
--       随表索引内联创建；此后新增索引一律独立 CONCURRENTLY 单文件（DB-SCH-02）。
-- 前置：db/bootstrap/pg-roles.sql 已执行。

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ── RLS 辅助函数：读取当前租户上下文（未设置返回 NULL → 所有策略判定为假） ──
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

-- ═══ 1. 租户与授权域 ═══

CREATE TABLE tenant (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  slug            text NOT NULL UNIQUE,              -- 凭证命名空间（DATA-MODEL §3.1）
  deployment_mode text NOT NULL DEFAULT 'private' CHECK (deployment_mode IN ('private','saas')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  email         text NOT NULL,
  password_hash text NOT NULL,                       -- argon2id/bcrypt（SEC-PW-01）
  display_name  text NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email),
  UNIQUE (tenant_id, id)                              -- 复合 FK 目标（P1-1）
);

CREATE TABLE role (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  name      text NOT NULL CHECK (name IN ('admin','operator','viewer')),  -- MVP 三角色
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, id)
);

CREATE TABLE user_role (
  tenant_id uuid NOT NULL,
  user_id   uuid NOT NULL,
  role_id   uuid NOT NULL,
  PRIMARY KEY (tenant_id, user_id, role_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_user(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (tenant_id, role_id) REFERENCES role(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- ═══ 2. 资产域（层级：building → hvac_system → equipment → point） ═══

CREATE TABLE building (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  name          text NOT NULL,
  address       text,
  geo_lat       numeric,
  geo_lon       numeric,
  building_type text,                                 -- 语义枚举：text + 应用层校验（§6）
  gross_area_m2 numeric,
  climate_zone  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)                              -- 复合 FK 目标（P1-1）
);
CREATE INDEX building_tenant_idx ON building (tenant_id);

CREATE TABLE user_building_scope (
  tenant_id   uuid NOT NULL,
  user_id     uuid NOT NULL,
  building_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, user_id, building_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_user(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (tenant_id, building_id) REFERENCES building(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE hvac_system (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT ON UPDATE RESTRICT,  -- 冗余租户列（P1-1）
  building_id uuid NOT NULL,
  system_type text NOT NULL,                          -- 语义枚举：text + 应用层校验（§6）
  name        text NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, building_id) REFERENCES building(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX hvac_system_tenant_building_idx ON hvac_system (tenant_id, building_id);

CREATE TABLE equipment (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT ON UPDATE RESTRICT,  -- 冗余租户列（P1-1）
  system_id      uuid NOT NULL,
  equipment_type text NOT NULL,                       -- 语义枚举：text + 应用层校验（§6）
  name           text NOT NULL,
  local_id       text,                                -- 现场编号，如 "1#冷机"
  vendor_model   text,
  rated_params   jsonb,                               -- 铭牌参数
  commission_date date,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, system_id) REFERENCES hvac_system(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX equipment_tenant_system_idx ON equipment (tenant_id, system_id);
CREATE INDEX equipment_tenant_type_idx ON equipment (tenant_id, equipment_type);

-- ═══ 3. 接入域 ═══

CREATE TABLE gateway (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  building_id     uuid NOT NULL,
  name            text NOT NULL,
  serial          text NOT NULL UNIQUE,
  vendor_model    text,
  mqtt_client_id  text NOT NULL UNIQUE,               -- EMQX clientid（emqx.md 链路锚点）
  status          text NOT NULL DEFAULT 'offline' CHECK (status IN ('online','offline')),
  last_seen_at    timestamptz,                        -- EMQX 事件维护（emqx.md）
  offline_action  jsonb,                              -- 离线联动配置
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, building_id) REFERENCES building(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX gateway_tenant_idx ON gateway (tenant_id);

CREATE TABLE device_credential (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT ON UPDATE RESTRICT,  -- 冗余租户列（P1-1 延伸）
  gateway_id       uuid NOT NULL,
  username         text NOT NULL UNIQUE,              -- 全局唯一（EMQX MQTT username）
  secret_hash      text NOT NULL,                     -- argon2id/bcrypt 自适应慢哈希（SEC-PW-01）
  cert_fingerprint text,                              -- mTLS 升级预留
  enabled          bool NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, gateway_id) REFERENCES gateway(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX device_credential_gateway_idx ON device_credential (tenant_id, gateway_id);

-- ═══ 4. 点位表（全模型中枢，DATA-MODEL §3.3） ═══

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS
$$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TABLE point (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id              uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT ON UPDATE RESTRICT,  -- 冗余租户列（P1-1）
  building_id            uuid NOT NULL,
  equipment_id           uuid,                        -- 独立测点可空
  -- ── 物理层 ──
  source_type            text NOT NULL CHECK (source_type IN ('mqtt_gateway','bacnet','virtual')),
  gateway_id             uuid,                        -- 经由哪个网关采集
  protocol_address       jsonb,                       -- {"proto":"modbus","unit":1,"fc":3,"reg":40001}
  raw_name               text NOT NULL,               -- 现场原始点名
  sample_interval_s      int,
  -- ── 语义层 ──
  quantity_type          text,                        -- 语义枚举：text + 应用层校验（§6）
  display_name           text,                        -- P2-2
  description            text,                        -- P2-2
  unit_raw               text,
  unit_std               text,
  direction              text NOT NULL DEFAULT 'read' CHECK (direction IN ('read','write','readwrite')),
  -- ── 控制安全元数据（ADR-009 闸门参数） ──
  is_controllable        bool NOT NULL DEFAULT false, -- 闸门1：受控白名单
  clamp_min              numeric,                     -- 闸门2：值域
  clamp_max              numeric,
  write_rate_limit_per_hour int,                      -- 闸门3：频率限制
  control_mode           text NOT NULL DEFAULT 'advisory' CHECK (control_mode IN ('advisory','supervised','auto')),
  -- ── 数据质量 ──
  stale_timeout_s        int NOT NULL DEFAULT 300,    -- 死值判定
  valid_range_min        numeric,                     -- 坏点判据（ingest L1b）
  valid_range_max        numeric,
  status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),  -- P1-2 停用位
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),  -- ingest 配置缓存增量游标
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, building_id) REFERENCES building(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (tenant_id, equipment_id) REFERENCES equipment(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (tenant_id, gateway_id) REFERENCES gateway(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
-- 物理身份唯一：同网关下原始点名不重复（未注册点判定依据，ingest.md §6）
CREATE UNIQUE INDEX point_gateway_raw_name_uidx ON point (gateway_id, raw_name) WHERE gateway_id IS NOT NULL;
CREATE INDEX point_tenant_building_idx ON point (tenant_id, building_id);
CREATE INDEX point_tenant_equipment_idx ON point (tenant_id, equipment_id);
CREATE INDEX point_tenant_quantity_idx ON point (tenant_id, quantity_type);
CREATE INDEX point_updated_at_idx ON point (updated_at);
CREATE TRIGGER point_touch BEFORE UPDATE ON point FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ═══ 5. 控制域（ADR-008/009） ═══

CREATE TABLE proposal (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  algo                  text NOT NULL,
  algo_version          text NOT NULL,                -- 归因锚（ADR-008）
  equipment_id          uuid NOT NULL,
  point_id              bigint NOT NULL,
  action                jsonb NOT NULL,               -- {"op":"set","value":7.5,"unit":"degC"}
  previous_value        numeric,                      -- P2-3：可写点限数值量
  rationale             text NOT NULL,                -- 必填：可解释
  expected_saving_kw    numeric,
  confidence            numeric,
  evidence              jsonb,
  expires_at            timestamptz,
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired','executed','failed')),
  decided_by            uuid,
  decided_at            timestamptz,
  executed_at           timestamptz,
  execution_result      jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, equipment_id) REFERENCES equipment(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (tenant_id, point_id) REFERENCES point(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (tenant_id, decided_by) REFERENCES app_user(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX proposal_inbox_idx ON proposal (tenant_id, status, created_at DESC);
CREATE INDEX proposal_point_idx ON proposal (tenant_id, point_id, created_at DESC);

CREATE TABLE control_lease (                           -- fail-safe 租约（ADR-009）
  point_id           bigint PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT ON UPDATE RESTRICT,  -- 冗余租户列（P1-1 延伸）
  holder             text NOT NULL,                   -- 算法服务实例标识
  value_at_takeover  numeric,                         -- 接管前原值 = 回滚值（P2-3 数值量）
  expires_at         timestamptz NOT NULL,
  last_heartbeat_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, point_id),
  FOREIGN KEY (tenant_id, point_id) REFERENCES point(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX control_lease_expiry_idx ON control_lease (expires_at);

CREATE TABLE control_audit (                           -- 全链路写值审计
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  point_id    bigint NOT NULL,
  proposal_id uuid,
  old_value   numeric,
  new_value   numeric,
  actor_type  text NOT NULL CHECK (actor_type IN ('algo','human','system')),
  actor_ref   text,
  result      text NOT NULL CHECK (result IN ('ok','verify_failed','reverted','rejected')),
  reason      text,
  at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, point_id) REFERENCES point(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (tenant_id, proposal_id) REFERENCES proposal(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX control_audit_tenant_point_idx ON control_audit (tenant_id, point_id, at DESC);

CREATE TABLE config_audit (                            -- 闸门参数/模式变更审计（P1-4）
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  point_id   bigint NOT NULL,
  field      text NOT NULL CHECK (field IN ('control_mode','is_controllable','clamp_min','clamp_max','write_rate_limit_per_hour')),
  old_value  jsonb,
  new_value  jsonb,
  actor_type text NOT NULL CHECK (actor_type IN ('human','system')),
  actor_ref  text,
  reason     text,
  at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, point_id) REFERENCES point(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX config_audit_tenant_point_idx ON config_audit (tenant_id, point_id, at DESC);

-- ═══ 6. M&V 域（红线：第一版就有） ═══

CREATE TABLE mv_baseline (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  building_id    uuid,
  system_id      uuid,
  method         text NOT NULL,                       -- ipmvp_option_c | ...
  baseline_period daterange NOT NULL,
  model_type     text NOT NULL,
  model_params   jsonb,
  weather_source text,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','retired')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, building_id) REFERENCES building(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (tenant_id, system_id) REFERENCES hvac_system(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- 同租户不允许两条 active 基线在时间上重叠（M&V 口径唯一性）
  CONSTRAINT mv_baseline_no_active_overlap
    EXCLUDE USING gist (tenant_id WITH =, baseline_period WITH &&) WHERE (status = 'active')
);
CREATE INDEX mv_baseline_tenant_idx ON mv_baseline (tenant_id, status);

CREATE TABLE mv_report (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT ON UPDATE RESTRICT,  -- 冗余租户列（P1-1 延伸）
  baseline_id                 uuid NOT NULL,
  report_period               daterange NOT NULL,
  baseline_energy_kwh         numeric NOT NULL,
  actual_energy_kwh           numeric NOT NULL,
  weather_adjusted_saving_kwh numeric,
  confidence_interval         jsonb,
  generated_at                timestamptz NOT NULL DEFAULT now(),
  approved_by                 uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, baseline_id) REFERENCES mv_baseline(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (tenant_id, approved_by) REFERENCES app_user(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX mv_report_tenant_period_idx ON mv_report (tenant_id, generated_at DESC);

-- ═══ 7. 告警域（ADR-014 风暴聚合） ═══

CREATE TABLE alarm_rule (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  scope        text NOT NULL CHECK (scope IN ('point','equipment','system','gateway')),
  scope_id     text NOT NULL,                         -- 多态引用（P1-3）：应用层按 scope 校验类型
  rule_type    text NOT NULL,
  params       jsonb NOT NULL DEFAULT '{}',
  severity     text NOT NULL CHECK (severity IN ('info','warning','minor','major','critical')),
  sustained_s  int NOT NULL DEFAULT 0,                -- 持续门槛（防抖）
  enabled      bool NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX alarm_rule_lookup_idx ON alarm_rule (tenant_id, scope, scope_id) WHERE enabled;

CREATE TABLE alarm_event (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  rule_id       uuid,
  source_type   text CHECK (source_type IN ('point','equipment','system','gateway')),
  source_id     text NOT NULL,                        -- 多态引用（P1-3）
  severity      text NOT NULL CHECK (severity IN ('info','warning','minor','major','critical')),
  message       text NOT NULL,
  root_group_id uuid,                                 -- 聚合锚：同根因合并
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acked','closed','suppressed')),
  acked_by      uuid,
  acked_at      timestamptz,
  opened_at     timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz,
  FOREIGN KEY (tenant_id, rule_id) REFERENCES alarm_rule(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (tenant_id, acked_by) REFERENCES app_user(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX alarm_event_open_idx ON alarm_event (tenant_id, status, opened_at DESC);
CREATE INDEX alarm_event_root_idx ON alarm_event (root_group_id) WHERE root_group_id IS NOT NULL;
CREATE INDEX alarm_event_rule_idx ON alarm_event (tenant_id, rule_id);

-- ═══ 8. RLS 策略（ADR-011 / P1-1：全表统一模板，零子查询） ═══

-- +goose StatementBegin
DO $$
DECLARE t text;
BEGIN
  -- tenant 表本位：策略键是 id
  EXECUTE 'ALTER TABLE tenant ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE tenant FORCE ROW LEVEL SECURITY';
  EXECUTE 'CREATE POLICY tenant_isolation ON tenant FOR ALL TO thermio_api
           USING (id = app_current_tenant())
           WITH CHECK (id = app_current_tenant())';
  -- 其余业务表统一模板（P1-1：零子查询）
  FOREACH t IN ARRAY ARRAY[
    'app_user','role','user_role','user_building_scope',
    'building','hvac_system','equipment','point','gateway','device_credential',
    'proposal','control_lease','control_audit','config_audit',
    'mv_baseline','mv_report','alarm_rule','alarm_event'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO thermio_api
                    USING (tenant_id = app_current_tenant())
                    WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;
-- +goose StatementEnd

-- ingest 旁路只读（P1-1：显式角色定向策略，不依赖 OWNER 绕过；仅 point/gateway）
CREATE POLICY ingest_read ON point   FOR SELECT TO thermio_ingest USING (true);
CREATE POLICY ingest_read ON gateway FOR SELECT TO thermio_ingest USING (true);
-- EMQX 认证/事件内部端点旁路只读（emqx.md：仅 device_credential/gateway）
CREATE POLICY internal_read ON device_credential FOR SELECT TO thermio_auth USING (true);
CREATE POLICY internal_read ON gateway           FOR SELECT TO thermio_auth USING (true);

-- ═══ 9. 角色授权 ═══

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO thermio_api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO thermio_api;
GRANT SELECT ON public.point, public.gateway TO thermio_ingest;
GRANT SELECT ON public.device_credential, public.gateway TO thermio_auth;

ALTER DEFAULT PRIVILEGES FOR ROLE thermio_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO thermio_api;
ALTER DEFAULT PRIVILEGES FOR ROLE thermio_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO thermio_api;

-- +goose Down
-- 逆依赖序删除，不用 CASCADE（DB-SCH-01 精神）
DROP TABLE IF EXISTS alarm_event;
DROP TABLE IF EXISTS alarm_rule;
DROP TABLE IF EXISTS mv_report;
DROP TABLE IF EXISTS mv_baseline;
DROP TABLE IF EXISTS config_audit;
DROP TABLE IF EXISTS control_audit;
DROP TABLE IF EXISTS control_lease;
DROP TABLE IF EXISTS proposal;
DROP TABLE IF EXISTS point;
DROP TABLE IF EXISTS device_credential;
DROP TABLE IF EXISTS gateway;
DROP TABLE IF EXISTS equipment;
DROP TABLE IF EXISTS hvac_system;
DROP TABLE IF EXISTS user_building_scope;
DROP TABLE IF EXISTS building;
DROP TABLE IF EXISTS user_role;
DROP TABLE IF EXISTS role;
DROP TABLE IF EXISTS app_user;
DROP TABLE IF EXISTS tenant;
DROP FUNCTION IF EXISTS set_updated_at();
DROP FUNCTION IF EXISTS app_current_tenant();
DROP EXTENSION IF EXISTS btree_gist;
