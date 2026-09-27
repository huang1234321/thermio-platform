-- 0008_internal_algo_fdd_read.sql
-- 目的：/internal/* algo 面 FDD 端点的跨租户定位与快照读前置能力（platform.md §11
--       端点族增量之二/之三，algo.md §15-1；IMPL-17 并入项 / DAT-163）：
--       - building：fdd report 提交的租户解析（building_id → tenant）；
--       - point + hvac_system：asset-snapshot 跨租户投影读（algo.md §6：对 PG 零直连
--         的必然后果，映射只能从中台 HTTP 拉——快照带 tenant_id 冗余列，§6.3；
--         hvac_system 供 equipment→building 投影）。
-- 形态：沿 0005/0007 internal_read 定向只读旁路同构（豁免仅 SELECT、仅本文件两张表）。
-- 纪律：零业务列变更；equipment 侧旁路由 0007 提供；业务读写一律 withTenant 正常路径。
-- 附带缺口收口（沿 0005「显式重申」先例）：0003 建的 fdd_finding/fdd_report 对
-- thermio_api 的 DML 授权缺失（0001 §9 默认权限链未覆盖到——internal 写通道
-- 首次触达即暴露）；internal 面落库需要，显式 GRANT。
-- +goose Up
CREATE POLICY internal_read ON building FOR SELECT TO thermio_auth USING (true);
CREATE POLICY internal_read ON point FOR SELECT TO thermio_auth USING (true);
CREATE POLICY internal_read ON hvac_system FOR SELECT TO thermio_auth USING (true);

GRANT SELECT ON public.building TO thermio_auth;
GRANT SELECT ON public.point TO thermio_auth;
GRANT SELECT ON public.hvac_system TO thermio_auth;

GRANT SELECT, INSERT, UPDATE ON public.fdd_finding TO thermio_api;
GRANT SELECT, INSERT, UPDATE ON public.fdd_report TO thermio_api;

-- +goose Down
REVOKE SELECT, INSERT, UPDATE ON public.fdd_report FROM thermio_api;
REVOKE SELECT, INSERT, UPDATE ON public.fdd_finding FROM thermio_api;
DROP POLICY IF EXISTS internal_read ON hvac_system;
DROP POLICY IF EXISTS internal_read ON point;
DROP POLICY IF EXISTS internal_read ON building;
REVOKE SELECT ON public.hvac_system FROM thermio_auth;
REVOKE SELECT ON public.point FROM thermio_auth;
REVOKE SELECT ON public.building FROM thermio_auth;
