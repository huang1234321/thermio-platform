-- 0003_import_fdd_fuse.sql
-- 三项承载定夺的落地（overview §8 #4/#5/#8 收口）：
--   import 域：import_job（作业状态机）+ import_row（逐行映射记录）——ADR-015
--   FDD 域：fdd_finding（发现，独立表定夺）+ fdd_report（周期报告）
--   熔断域：control_fuse（系统级当前态）+ control_fuse_event（触发/解除留痕）——ADR-009 闸门 5
-- 纪律：新表初始为空 → 索引随表内联（DB-SCH-02 对初始建表的既定解释）；
--       全部 FK 显式 RESTRICT（DB-SCH-01）；新表全带 tenant_id 冗余列 + 复合外键 +
--       RLS 统一模板 + thermio_api 授权（P1-1）。前置：0001、0002 已执行。
-- +goose Up

-- ═══ 10. 导入域（ADR-015；overview §4 M2；状态机见 §9.1） ═══

CREATE TABLE import_job (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  building_id  uuid NOT NULL,
  gateway_id   uuid NOT NULL,
  file_name    text NOT NULL,
  row_count    int  NOT NULL DEFAULT 0,             -- 解析后总行数
  status       text NOT NULL DEFAULT 'parsed'
               CHECK (status IN ('parsed','mapping','validated','applied','checked','failed')),
  mapped_count int  NOT NULL DEFAULT 0,             -- 摘要：已映射行数（服务端维护）
  issue_count  int  NOT NULL DEFAULT 0,             -- 摘要：dry-run 告警项数（服务端维护）
  hit_rate     numeric CHECK (hit_rate >= 0 AND hit_rate <= 1),   -- 自检命中率（0–1）
  failure      jsonb,                               -- failed 原因 + 失败清单（apply 应答失败等）
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  applied_at   timestamptz,
  checked_at   timestamptz,
  UNIQUE (tenant_id, id),                           -- 复合 FK 目标（P1-1）
  FOREIGN KEY (tenant_id, building_id) REFERENCES building(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (tenant_id, gateway_id)  REFERENCES gateway(tenant_id, id)  ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (tenant_id, created_by)  REFERENCES app_user(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
  -- 注：job.building 与 gateway.building 的一致性为应用层校验（沿 0001 中 point.gateway 的既定口径）
);
CREATE INDEX import_job_tenant_building_idx ON import_job (tenant_id, building_id, created_at DESC);
CREATE INDEX import_job_tenant_status_idx   ON import_job (tenant_id, status);

CREATE TABLE import_row (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  job_id          uuid NOT NULL,
  row_no          int  NOT NULL,                    -- Excel 行号（1 起，跳表头）
  -- ── 解析出的原始行 ──
  raw_name        text NOT NULL,                    -- 现场原始点名
  raw_description text,                             -- 点表「描述」列
  unit_raw        text,
  is_write        bool NOT NULL DEFAULT false,      -- 点表「读写方向」列（write/readwrite=true）
  -- ── 语义映射结果 ──
  equipment_id    uuid,                             -- 人工/自动指定的设备归属
  quantity_type   text,                             -- 语义枚举：text + 应用层校验（§6 治理）
  unit_std        text,                             -- 归一目标单位（换算由 ingest 内置表按 raw→std 执行，不存因子）
  map_status      text NOT NULL DEFAULT 'unmapped' CHECK (map_status IN ('unmapped','auto','manual')),
  issues          jsonb NOT NULL DEFAULT '[]',      -- dry-run 校验问题 [{code, blocking, detail}]
  mapped_at       timestamptz,
  mapped_by       uuid,                             -- 人工映射者；auto 映射为 NULL
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, job_id, row_no),
  FOREIGN KEY (tenant_id, job_id)       REFERENCES import_job(tenant_id, id)   ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (tenant_id, equipment_id) REFERENCES equipment(tenant_id, id)    ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (tenant_id, mapped_by)    REFERENCES app_user(tenant_id, id)     ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX import_row_job_idx ON import_row (tenant_id, job_id);

CREATE TRIGGER import_job_touch BEFORE UPDATE ON import_job FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER import_row_touch BEFORE UPDATE ON import_row FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ═══ 11. FDD 域（独立表定夺，§9.2；overview §8 #4 收口） ═══

CREATE TABLE fdd_finding (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  equipment_id     uuid NOT NULL,
  rule_key         text NOT NULL,                   -- FDD 规则库 key（设备类型×量类型，ADR-006/008）
  algo_version     text NOT NULL,                   -- 归因锚（ADR-008：所有输出带版本）
  severity         text NOT NULL CHECK (severity IN ('info','warning','minor','major','critical')),  -- 与告警同源五级
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','ignored')),
  title            text NOT NULL,                   -- 一句话发现（列表主文案）
  evidence         jsonb,                           -- 证据点位清单 + 时段（供前端拉曲线）
  suggested_action text,                            -- 建议动作
  alarm_event_id   bigint,                          -- 联动告警（可选）：发现触发告警引擎后回填
  first_detected_at timestamptz NOT NULL,
  last_detected_at  timestamptz NOT NULL,           -- 持续命中刷新（活跃去重键的 upsert 语义）
  resolved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, equipment_id)   REFERENCES equipment(tenant_id, id)    ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (tenant_id, alarm_event_id) REFERENCES alarm_event(tenant_id, id)  ON DELETE RESTRICT ON UPDATE RESTRICT
);
-- 活跃发现唯一：同设备同规则只允许一条 open（风暴抑制；持续命中 = 刷新 last_detected_at）
CREATE UNIQUE INDEX fdd_finding_active_uidx ON fdd_finding (tenant_id, equipment_id, rule_key) WHERE status = 'open';
CREATE INDEX fdd_finding_tenant_status_idx  ON fdd_finding (tenant_id, status, last_detected_at DESC);
CREATE INDEX fdd_finding_tenant_equipment_idx ON fdd_finding (tenant_id, equipment_id);

CREATE TABLE fdd_report (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  building_id  uuid NOT NULL,
  period_type  text NOT NULL CHECK (period_type IN ('day','week')),
  period       daterange NOT NULL,                  -- 报告期（闭开区间）
  summary      jsonb NOT NULL,                      -- 新增/消除/持续计数、健康度排名等聚合快照
  generated_at timestamptz NOT NULL DEFAULT now(),
  algo_version text,                                -- 生成时的算法版本（报告归因）
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, building_id, period_type, period),   -- 同期幂等：重生成走 upsert
  FOREIGN KEY (tenant_id, building_id) REFERENCES building(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX fdd_report_tenant_generated_idx ON fdd_report (tenant_id, generated_at DESC);

CREATE TRIGGER fdd_finding_touch BEFORE UPDATE ON fdd_finding FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ═══ 12. 系统级熔断域（ADR-009 闸门 5；overview §8 #5 收口；状态机见 §9.3） ═══

CREATE TABLE control_fuse (                         -- 每系统一行：当前熔断态（沿 control_lease 主键风格）
  system_id     uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  status        text NOT NULL DEFAULT 'closed' CHECK (status IN ('closed','open')),
  triggered_at  timestamptz,                        -- 最近一次触发时刻（open 态必填，应用层保证）
  trigger_detail jsonb,                             -- 触发时指标快照（窗口/异常率/连续失败数）
  released_at   timestamptz,                        -- 最近一次解除时刻（closed 态最近一次）
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, system_id),                    -- 复合 FK 目标（P1-1）
  FOREIGN KEY (tenant_id, system_id) REFERENCES hvac_system(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX control_fuse_tenant_status_idx ON control_fuse (tenant_id, status);

CREATE TABLE control_fuse_event (                   -- 触发/解除历史（M8 熔断状态页「最近触发/恢复记录」）
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  system_id  uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('tripped','released')),
  actor_type text NOT NULL CHECK (actor_type IN ('system','human')),   -- 手动解除=human；触发/自动恢复=system
  actor_ref  text,                                  -- human: 用户 id；system: 评估任务标识
  reason     text,                                  -- human 解除必填（应用层强制）
  detail     jsonb,                                 -- tripped: 指标快照；released: 恢复判据
  at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, system_id) REFERENCES hvac_system(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX control_fuse_event_tenant_system_idx ON control_fuse_event (tenant_id, system_id, at DESC);

-- ═══ 13. RLS 策略（P1-1 统一模板，零子查询）与角色授权 ═══

-- +goose StatementBegin
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['import_job','import_row','fdd_finding','fdd_report','control_fuse','control_fuse_event'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO thermio_api
                    USING (tenant_id = app_current_tenant())
                    WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;
-- +goose StatementEnd

GRANT SELECT, INSERT, UPDATE, DELETE ON
  import_job, import_row, fdd_finding, fdd_report, control_fuse, control_fuse_event
  TO thermio_api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO thermio_api;

-- +goose Down
-- 逆依赖序删除，不用 CASCADE（DB-SCH-01 精神）
DROP TABLE IF EXISTS control_fuse_event;
DROP TABLE IF EXISTS control_fuse;
DROP TABLE IF EXISTS fdd_report;
DROP TABLE IF EXISTS fdd_finding;
DROP TABLE IF EXISTS import_row;
DROP TABLE IF EXISTS import_job;
