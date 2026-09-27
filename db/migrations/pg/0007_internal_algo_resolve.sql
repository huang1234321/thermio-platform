-- 0007_internal_algo_resolve.sql
-- 目的：/internal/* 服务间端点的「租户由目标实体解析」前置能力（platform.md §11-5，
--       M5-proposal.md §3.8-1 / IMPL-17）。RLS FORCE 下 thermio_api 无租户上下文
--       零可见（fail-closed），algo 提交不带租户头——落库前必须先按 equipment_id
--       全局定位租户，再回 SET LOCAL app.tenant_id 纪律（ddl.md §5.2）；
--       expiry-sweeper 系统任务无会话租户，需跨租户枚举。
-- 形态：沿 0005「登录 email 解析旁路」同构——thermio_auth 定向只读策略 internal_read
--       （与 0001 device_credential/gateway、0005 app_user 一脉）：豁免仅 SELECT、
--       仅本文件两张定位表（tenant / equipment），业务读写一律回到 withTenant 正常路径。
-- 纪律：零业务列变更（M5-proposal §0「不新增迁移」针对 proposal 表缺口 §9-R1/R2，
--       本迁移是 §11-5 既定行为的使能件，交付说明显式登记）；FK/索引无涉。
-- +goose Up
CREATE POLICY internal_read ON tenant FOR SELECT TO thermio_auth USING (true);
CREATE POLICY internal_read ON equipment FOR SELECT TO thermio_auth USING (true);

GRANT SELECT ON public.tenant TO thermio_auth;
GRANT SELECT ON public.equipment TO thermio_auth;

-- +goose Down
DROP POLICY IF EXISTS internal_read ON equipment;
DROP POLICY IF EXISTS internal_read ON tenant;
REVOKE SELECT ON public.equipment FROM thermio_auth;
REVOKE SELECT ON public.tenant FROM thermio_auth;
