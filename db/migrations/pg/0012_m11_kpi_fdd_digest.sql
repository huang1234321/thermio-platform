-- 0012_m11_kpi_fdd_digest.sql
-- M11 承载三表（M11-kpi-dashboard §3.3/§10-R1，DAT-237 验收裁决；本卡 DAT-246 落码）。
-- 编号 0012：蓝本 ddl.md v1.7 迁移 0007（§14.2 全文）——platform 链编号独立于 ddl.md
-- 文档链（0011_mv_jobs_and_export 同款既定纪律：蓝本 ddl.md v1.6 迁移 0005 在本链
-- 编 0011），链尾顺延。内容与蓝本逐字一致，仅一处已知差异（README 既定）：
-- DO $$ 块外包 goose StatementBegin/StatementEnd 注解（goose 按分号切分多行
-- dollar-quoted 块会截断，0001/0003/0011 同因同解）。
--   kpi_benchmark_config：对标基准源配置（H6 可配置设计，M11 §2.5/§8）
--   fdd_digest_subscription：FDD 周报邮件订阅配置（admin 出域通道，PRD §4.2）
--   fdd_digest_delivery：订阅投递记录（期次/状态/失败原因，PRD 卡 R6）
--   （导出任务 = export_job，0011 已合入的 M9/M11 共用承载——resource_type='fdd_report'
--    预留值即本批消费入口，零 DDL 增量；消费契约见 M11 §6）
-- 纪律：沿 0003 模式——tenant_id 冗余列 + 复合 FK（P1-1）、RLS 统一模板、
--       thermio_api 授权；新表索引随表内联（初始为空，DB-SCH-02）；只加对象不改
--       既有列；FK 显式 RESTRICT（DB-SCH-01）。
-- 前置：0001–0011 已执行。
-- +goose Up

-- ═══ 21. M11 承载域（对标基准配置 + FDD 周报订阅/投递；M11-kpi-dashboard §3.3） ═══

CREATE TABLE kpi_benchmark_config (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  building_id  uuid NOT NULL,
  source       text NOT NULL CHECK (source IN ('none','fixed','previous_period','same_period_last_year','mv_baseline')),
  params       jsonb NOT NULL DEFAULT '{}',          -- source 参数（§2.5：fixed.kwh_per_day 等；api 侧按 source schema 校验）
  updated_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, building_id),                    -- 一楼一套现行配置
  FOREIGN KEY (tenant_id, building_id) REFERENCES building(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (tenant_id, updated_by) REFERENCES app_user(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE fdd_digest_subscription (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  building_id  uuid NOT NULL,
  enabled      boolean NOT NULL DEFAULT true,
  period_type  text NOT NULL CHECK (period_type IN ('week')),  -- v1 仅周投递（M6 报告期型子集；日投递随需求走修订）
  schedule     text NOT NULL DEFAULT 'monday_08:00', -- 投递时刻（本地时区 Asia/Shanghai）
  recipients   jsonb NOT NULL CHECK (jsonb_typeof(recipients) = 'array'),  -- [{email, note?}]，api 侧逐项校验邮箱格式（§5.7）
  updated_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, building_id),                    -- 一楼一份订阅
  FOREIGN KEY (tenant_id, building_id) REFERENCES building(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (tenant_id, updated_by) REFERENCES app_user(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE fdd_digest_delivery (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  subscription_id uuid NOT NULL,
  report_id       uuid,                               -- 可空：skipped_no_report 态无报告
  period_start    date NOT NULL,
  period_end      date NOT NULL,                      -- 报告期闭开 [start, end)
  status          text NOT NULL CHECK (status IN ('queued','sent','failed','skipped')),
  skip_reason     text,                               -- skipped 态：'no_report'（该期报告未生成）
  recipients_count smallint NOT NULL DEFAULT 0,
  failure_msg     text,                               -- failed 态：SMTP 错误摘要（不含收件人地址全文，PII 纪律 CODE-LOG-01）
  delivered_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, subscription_id, period_start),  -- 同订阅同期唯一（重投走状态机，不插新行）
  FOREIGN KEY (tenant_id, subscription_id) REFERENCES fdd_digest_subscription(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX fdd_digest_delivery_tenant_created_idx ON fdd_digest_delivery (tenant_id, created_at DESC);

-- ═══ 22. RLS：三新表入统一模板（P1-1，零子查询）与角色授权 ═══

-- +goose StatementBegin
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['kpi_benchmark_config','fdd_digest_subscription','fdd_digest_delivery'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO thermio_api
                    USING (tenant_id = app_current_tenant())
                    WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;
-- +goose StatementEnd

GRANT SELECT, INSERT, UPDATE, DELETE ON
  kpi_benchmark_config, fdd_digest_subscription, fdd_digest_delivery
  TO thermio_api;

-- +goose Down
-- 逆依赖序删除，不用 CASCADE（DB-SCH-01 精神）：先投递记录（引用订阅）、再订阅、再基准配置
DROP TABLE IF EXISTS fdd_digest_delivery;
DROP TABLE IF EXISTS fdd_digest_subscription;
DROP TABLE IF EXISTS kpi_benchmark_config;
