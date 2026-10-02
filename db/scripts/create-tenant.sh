#!/usr/bin/env bash
# create-tenant.sh — 租户开通运维脚本（ddl.md §5.3）
# 首个 tenant 行无法经 RLS api 角色插入（鸡生蛋），开通走 superuser 运维通道，
# 属平台开通流程，不是运行时 API。
#
# 动作（单事务，全部幂等可重跑——重跑零副作用，tenant_id 不变）：
#   1. INSERT tenant（slug 命名空间唯一，ON CONFLICT DO NOTHING）
#   2. 三角色种子：admin / operator / viewer（ddl.md §4 role.name CHECK）
#   3. 初始 admin 用户 + user_role 授 admin
#
# 密码哈希由调用方（平台/运维）按 SEC-PW-01（argon2id/bcrypt）计算后传入，本脚本不生成明文哈希逻辑。
#
# 用法：
#   create-tenant.sh --slug <slug> --name <名称> --admin-email <邮箱> \
#                    --admin-password-hash '<argon2id/bcrypt 串>' [--admin-display-name <显示名>] [--deployment-mode private|saas]
# 连接：PG* 环境变量（须 superuser 通道；默认 PGUSER=postgres / PGDATABASE=thermio）。
# 输出：末行 `tenant_id=<uuid>`（机器可读）；失败非 0 退出。
set -euo pipefail

PGDATABASE="${PGDATABASE:-thermio}"
export PGDATABASE
: "${PGUSER:=postgres}"
export PGUSER

# usage 不依赖 $0：README/CI 均按 `bash -s < create-tenant.sh` 管道模式执行，
# 该模式下 $0 是 shell 名而非脚本路径（grep 无从取文件）；文本内嵌，两条路径同源。
usage() {
  cat <<'USAGE'
create-tenant.sh — 租户开通运维脚本（ddl.md §5.3）
首个 tenant 行无法经 RLS api 角色插入（鸡生蛋），开通走 superuser 运维通道，
属平台开通流程，不是运行时 API。

动作（单事务，全部幂等可重跑——重跑零副作用，tenant_id 不变）：
  1. INSERT tenant（slug 命名空间唯一，ON CONFLICT DO NOTHING）
  2. 三角色种子：admin / operator / viewer（ddl.md §4 role.name CHECK）
  3. 初始 admin 用户 + user_role 授 admin

密码哈希由调用方（平台/运维）按 SEC-PW-01（argon2id/bcrypt）计算后传入，本脚本不生成明文哈希逻辑。

用法：
  create-tenant.sh --slug <slug> --name <名称> --admin-email <邮箱> \
                   --admin-password-hash '<argon2id/bcrypt 串>' [--admin-display-name <显示名>] [--deployment-mode private|saas]
连接：PG* 环境变量（须 superuser 通道；默认 PGUSER=postgres / PGDATABASE=thermio）。
输出：末行 `tenant_id=<uuid>`（机器可读）；失败非 0 退出。
USAGE
  exit 1
}

TENANT_SLUG="" TENANT_NAME="" ADMIN_EMAIL="" ADMIN_PASSWORD_HASH=""
ADMIN_DISPLAY_NAME="Admin" DEPLOYMENT_MODE="private"

while [ $# -gt 0 ]; do
  case "$1" in
    --slug)                 TENANT_SLUG="${2:?}"; shift 2 ;;
    --name)                 TENANT_NAME="${2:?}"; shift 2 ;;
    --admin-email)          ADMIN_EMAIL="${2:?}"; shift 2 ;;
    --admin-password-hash)  ADMIN_PASSWORD_HASH="${2:?}"; shift 2 ;;
    --admin-display-name)   ADMIN_DISPLAY_NAME="${2:?}"; shift 2 ;;
    --deployment-mode)      DEPLOYMENT_MODE="${2:?}"; shift 2 ;;
    -h|--help)              usage ;;
    *)                      echo "未知参数: $1" >&2; usage ;;
  esac
done

[ -n "$TENANT_SLUG" ] && [ -n "$TENANT_NAME" ] && [ -n "$ADMIN_EMAIL" ] && [ -n "$ADMIN_PASSWORD_HASH" ] \
  || { echo "缺少必填参数（--slug/--name/--admin-email/--admin-password-hash）" >&2; usage; }

# slug 是凭证命名空间（DATA-MODEL §3.1），限小写字母数字连字符
echo "$TENANT_SLUG" | grep -Eq '^[a-z0-9][a-z0-9-]{0,62}$' \
  || { echo "slug 非法：限 1-63 位小写字母/数字/连字符，且以字母数字开头：$TENANT_SLUG" >&2; exit 1; }
case "$DEPLOYMENT_MODE" in private|saas) ;; *) echo "--deployment-mode 仅支持 private|saas" >&2; exit 1 ;; esac

psql -X -v ON_ERROR_STOP=1 \
  -v tenant_slug="$TENANT_SLUG" \
  -v tenant_name="$TENANT_NAME" \
  -v deployment_mode="$DEPLOYMENT_MODE" \
  -v admin_email="$ADMIN_EMAIL" \
  -v admin_password_hash="$ADMIN_PASSWORD_HASH" \
  -v admin_display_name="$ADMIN_DISPLAY_NAME" \
  <<'SQL'
\set ON_ERROR_STOP on
BEGIN;

-- 1) 租户（幂等：slug 已存在则跳过）
INSERT INTO tenant (name, slug, deployment_mode)
VALUES (:'tenant_name', :'tenant_slug', :'deployment_mode')
ON CONFLICT (slug) DO NOTHING;

SELECT id AS tenant_id FROM tenant WHERE slug = :'tenant_slug' \gset

-- 2) 三角色种子（幂等）
INSERT INTO role (tenant_id, name)
SELECT :'tenant_id'::uuid, n FROM unnest(ARRAY['admin','operator','viewer']) AS n
ON CONFLICT (tenant_id, name) DO NOTHING;

-- 3) 初始 admin 用户 + 授 admin（幂等）
INSERT INTO app_user (tenant_id, email, password_hash, display_name)
VALUES (:'tenant_id'::uuid, :'admin_email', :'admin_password_hash', :'admin_display_name')
ON CONFLICT (tenant_id, email) DO NOTHING;

INSERT INTO user_role (tenant_id, user_id, role_id)
SELECT u.tenant_id, u.id, r.id
FROM app_user u
JOIN role r ON r.tenant_id = u.tenant_id AND r.name = 'admin'
WHERE u.tenant_id = :'tenant_id'::uuid AND u.email = :'admin_email'
ON CONFLICT DO NOTHING;

COMMIT;

SELECT 'tenant_id=' || :'tenant_id';
SQL
