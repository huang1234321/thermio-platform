-- +goose Up
-- IMPL-10（DAT-113）：认证会话与租户上下文。
-- 编号 0005：0004 已被 0004_control_fuse_touch（DAT-102）占用，rebase 让号。
-- 纪律对齐 0001 §8 模板：全表 tenant_id + RLS tenant_isolation（零子查询）；
-- FK 显式 RESTRICT（DB-SCH-01）；表初建，索引自带（DB-SCH-02 后续索引走 CONCURRENTLY 单文件）。
--
-- 承载：
-- 1. auth_session —— JWT 短时效 + 服务端可撤销（SEC-AZ-04）的撤销真相源：
--    access JWT 每（认证）请求按 sid 回查 status，登出即 UPDATE revoked；
--    refresh 为不透明随机数，sha256 落库、每次刷新轮换。
-- 2. password_reset_token —— 一次性重置令牌（SEC-PW-05：≤15min、单用途、sha256 落库）。
-- 3. app_user.must_change_password —— SEC-PW-03：系统下发/重置后的初始凭证首登强制轮换。
-- 4. 登录 email→租户解析通道：thermio_auth 定向旁路 internal_read 仅开 app_user
--    （与 0001 的 device_credential/gateway 旁路同构，ddl.md §5.1「中台内部端点」角色；
--    登录前无租户上下文，RLS fail-closed 下这是唯一的鸡生蛋出口，面收窄到单表 SELECT）。

CREATE TABLE auth_session (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  user_id             uuid NOT NULL,
  refresh_token_hash  text NOT NULL,                     -- sha256(refresh token)，轮换即覆写
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  last_used_at        timestamptz,
  revoked_at          timestamptz,
  user_agent          text,
  client_ip           text,
  UNIQUE (tenant_id, id),                                 -- 复合 FK 目标（P1-1）
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_user(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX auth_session_tenant_user_idx ON auth_session (tenant_id, user_id);
CREATE INDEX auth_session_refresh_hash_idx ON auth_session (refresh_token_hash);

CREATE TABLE password_reset_token (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  user_id     uuid NOT NULL,
  token_hash  text NOT NULL,                              -- sha256(一次性令牌)
  expires_at  timestamptz NOT NULL,                       -- ≤15min（SEC-PW-05）
  used_at     timestamptz,                                -- 单用途：消费即烙印
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_user(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX password_reset_token_user_idx ON password_reset_token (tenant_id, user_id);

ALTER TABLE app_user ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;

-- +goose StatementBegin
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['auth_session','password_reset_token'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO thermio_api
                    USING (tenant_id = app_current_tenant())
                    WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;
-- +goose StatementEnd

-- 登录 email 解析旁路（thermio_auth 定向只读；与 0001 internal_read 同构）
CREATE POLICY internal_read ON app_user FOR SELECT TO thermio_auth USING (true);

-- 授权：thermio_api 对新表的全 DML 由 0001 §9 的 ALTER DEFAULT PRIVILEGES（owner）覆盖；
-- 显式重申一次，避免默认权限链被断（如手工以其他角色补跑迁移的偏差）。
GRANT SELECT, INSERT, UPDATE, DELETE ON public.auth_session, public.password_reset_token TO thermio_api;
GRANT SELECT ON public.app_user TO thermio_auth;

-- +goose Down
DROP POLICY IF EXISTS internal_read ON app_user;
REVOKE SELECT ON public.app_user FROM thermio_auth;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.auth_session, public.password_reset_token FROM thermio_api;
DROP TABLE IF EXISTS password_reset_token;
DROP TABLE IF EXISTS auth_session;
ALTER TABLE app_user DROP COLUMN IF EXISTS must_change_password;
