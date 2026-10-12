-- 0011_mv_jobs_and_export.sql
-- M&V 任务族与共用导出承载（M9-mv-report §11 R1–R4，DAT-236 验收裁决；本卡 DAT-242 落码）。
-- 编号 0011：蓝本 ddl.md v1.6 迁移 0005（§13.2 全文）——platform 链 0005 已被
-- 0005_auth_session（DAT-113）占用，按 0009_fdd_review（DAT-212）「提案原编让位
-- 链尾顺延」同款纪律编为第 11 个。内容与蓝本逐字一致，仅两处已知差异（README 既定）：
-- DO $$ 块外包 goose StatementBegin/StatementEnd 注解（goose 按分号切分多行
-- dollar-quoted 块会截断，0001/0003 同因同解）；头注编号说明。
--   mv_baseline 增 5 列：activated_by/activated_at、retired_by/retired_at（激活/停用行内留痕，
--                        沿 mv_report.approved_by 既有风格）+ validation_result（数据窗校验与拟合快照，
--                        jsonb 形状归 M9 §3.5，draft 期随 :validate 刷新）。
--   mv_report 增 approved_at（+CHECK 与 approved_by 同空同非空）与 requested_by（发起人留痕）；
--             补 UNIQUE (tenant_id, baseline_id, report_period)——同基线同周期至多一份报告，
--             幂等/并发合并的库级兜底（M9 §4.4；daterange 等值 btree 支撑，fdd_report §9.4 同款）。
--   新表 mv_baseline_point（计量边界，M9 §2.2）/ mv_generation_job（生成任务，M9 §2.4，
--        partial UNIQUE 在飞守卫）/ export_job（M9/M11 共用导出任务，M9 §1.6/§2.5——
--        resource_type 含 fdd_report 预留值，DAT-237 对齐锚 O1）。
-- 纪律：新表初始为空 → 索引随表内联（DB-SCH-02）；FK 显式 RESTRICT（DB-SCH-01——M9 §2.2 原文
--       mv_baseline_point→mv_baseline 为 ON DELETE CASCADE，按本库零级联纪律收敛为 RESTRICT，
--       draft 基线删除走应用层同事务显式 DELETE，M12 §3.7 同款，定夺记录见蓝本 §13.1-1）；
--       新列 NULLable（DB-SCH-05），requested_by 随后 SET NOT NULL——表无运行数据即时完成，
--       存量脏行显式失败不静默回填（§13.1-2）；三新表入 RLS 统一模板 + thermio_api 授权（P1-1）。
-- 前置：0001–0010 已执行。
-- +goose Up

-- ═══ 17. M&V 域增量（ddl §4 既有两表增列 + 三新表；M9-mv-report §2） ═══

ALTER TABLE mv_baseline
  ADD COLUMN activated_by      uuid,
  ADD COLUMN activated_at      timestamptz,
  ADD COLUMN retired_by        uuid,
  ADD COLUMN retired_at        timestamptz,
  ADD COLUMN validation_result jsonb;
ALTER TABLE mv_baseline
  ADD CONSTRAINT mv_baseline_activated_fk
    FOREIGN KEY (tenant_id, activated_by) REFERENCES app_user(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT mv_baseline_retired_fk
    FOREIGN KEY (tenant_id, retired_by) REFERENCES app_user(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE mv_baseline_point (                      -- 计量边界（能量点位集），随基线版本化冻结（M9 §2.2）
  baseline_id uuid NOT NULL,
  point_id    bigint NOT NULL,
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT ON UPDATE RESTRICT,   -- 冗余租户列（复合 FK 载体）
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (baseline_id, point_id),                -- 同点位不重复入选
  FOREIGN KEY (tenant_id, baseline_id) REFERENCES mv_baseline(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (tenant_id, point_id)    REFERENCES point(tenant_id, id)        ON DELETE RESTRICT ON UPDATE RESTRICT
);
-- 注：集合非空 / energy 量型 / 属基线楼宇等业务校验在应用层（M9 §2.2，422 mv.metering_points_invalid）。

ALTER TABLE mv_report
  ADD COLUMN approved_at  timestamptz,
  ADD COLUMN requested_by uuid;
ALTER TABLE mv_report
  ADD CONSTRAINT mv_report_approver_consistency
    CHECK ((approved_by IS NOT NULL) = (approved_at IS NOT NULL)),
  ADD CONSTRAINT mv_report_tenant_baseline_period_uk
    UNIQUE (tenant_id, baseline_id, report_period),
  ADD CONSTRAINT mv_report_requested_by_fk
    FOREIGN KEY (tenant_id, requested_by) REFERENCES app_user(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE mv_report ALTER COLUMN requested_by SET NOT NULL;   -- 表无运行数据（M9 IMPL 未开），即时完成

CREATE TABLE mv_generation_job (                      -- 报告生成任务（M9 §2.4；import_job 同族异步四态）
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  baseline_id   uuid NOT NULL,
  report_period daterange NOT NULL,                   -- 生成目标期
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
  failure       jsonb,                                -- {stage, code, message, detail?}；非 failed 恒 NULL（应用层保证，M2 §4.4 同款）
  report_id     uuid,                                 -- 成功时回填产出报告
  requested_by  uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  UNIQUE (tenant_id, id),                             -- 复合 FK 目标（P1-1）
  CONSTRAINT mv_generation_job_success_report CHECK (status <> 'succeeded' OR report_id IS NOT NULL),
  FOREIGN KEY (tenant_id, baseline_id)  REFERENCES mv_baseline(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (tenant_id, report_id)    REFERENCES mv_report(tenant_id, id)   ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (tenant_id, requested_by) REFERENCES app_user(tenant_id, id)    ON DELETE RESTRICT ON UPDATE RESTRICT
);
-- 同（基线×期）在飞任务至多一个——并发合并的库级守卫（M9 §4.4；后到插入失败 → 返回既有 job）
CREATE UNIQUE INDEX mv_generation_job_inflight_uidx
  ON mv_generation_job (baseline_id, report_period) WHERE status IN ('queued','running');

CREATE TABLE export_job (                              -- M9/M11 共用导出任务（M9 §1.6/§2.5；资源无关载体）
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  resource_type   text NOT NULL CHECK (resource_type IN ('mv_report','fdd_report')),   -- fdd_report = M11 预留（DAT-237 对齐锚）
  resource_id     uuid NOT NULL,                       -- 多态引用（P1-3）：应用层按 resource_type 校验目标
  format          text NOT NULL DEFAULT 'pdf' CHECK (format IN ('pdf')),               -- V1.0 单格式
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
  failure         jsonb,
  file_object_key text,                                -- 对象存储私桶 mv-exports/（R7 部署锚，key 含 tenant/report_id/时间戳）
  file_bytes      int,
  requested_by    uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  expires_at      timestamptz,                         -- succeeded + 30 天（清理 job 按此扫，M9 §1.7）
  UNIQUE (tenant_id, id),                              -- 复合 FK 目标（P1-1）
  CONSTRAINT export_job_success_file CHECK (status <> 'succeeded' OR (file_object_key IS NOT NULL AND file_bytes IS NOT NULL)),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES app_user(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX export_job_tenant_idx ON export_job (tenant_id, created_at DESC);   -- 列表排序支撑（M9 §1.4）

-- ═══ 18. RLS：三新表入统一模板（P1-1，零子查询）与角色授权 ═══

-- +goose StatementBegin
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['mv_baseline_point','mv_generation_job','export_job'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO thermio_api
                    USING (tenant_id = app_current_tenant())
                    WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;
-- +goose StatementEnd

GRANT SELECT, INSERT, UPDATE, DELETE ON
  mv_baseline_point, mv_generation_job, export_job
  TO thermio_api;

-- +goose Down
-- 逆依赖序删除，不用 CASCADE（DB-SCH-01 精神）
DROP TABLE IF EXISTS export_job;
DROP TABLE IF EXISTS mv_generation_job;
DROP TABLE IF EXISTS mv_baseline_point;
ALTER TABLE mv_report DROP CONSTRAINT IF EXISTS mv_report_requested_by_fk;
ALTER TABLE mv_report DROP CONSTRAINT IF EXISTS mv_report_tenant_baseline_period_uk;
ALTER TABLE mv_report DROP CONSTRAINT IF EXISTS mv_report_approver_consistency;
ALTER TABLE mv_report
  DROP COLUMN IF EXISTS requested_by,
  DROP COLUMN IF EXISTS approved_at;
ALTER TABLE mv_baseline DROP CONSTRAINT IF EXISTS mv_baseline_retired_fk;
ALTER TABLE mv_baseline DROP CONSTRAINT IF EXISTS mv_baseline_activated_fk;
ALTER TABLE mv_baseline
  DROP COLUMN IF EXISTS validation_result,
  DROP COLUMN IF EXISTS retired_at,
  DROP COLUMN IF EXISTS retired_by,
  DROP COLUMN IF EXISTS activated_at,
  DROP COLUMN IF EXISTS activated_by;
