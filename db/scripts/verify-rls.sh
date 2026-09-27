#!/usr/bin/env bash
# verify-rls.sh — ddl.md §8 用例 2–6 脚本化复跑
#   用例 2：api 角色跨租户读写隔离（WITH CHECK 挡跨租户写入）
#   用例 3：未设 app.tenant_id 时 api 角色零可见（fail-closed）
#   用例 4：ingest 角色仅可 SELECT point/gateway，其余拒绝
#   用例 5：auth 角色旁路 = 枚举的 internal_read 只读表集（面收窄纪律），其余拒绝。
#             枚举集随 /internal/* 面扩列（DAT-163/IMPL-17，迁移 0007/0008）：
#             0001 device_credential/gateway + 0005 app_user + 0007 tenant/equipment
#             + 0008 building/point/hvac_system；业务表（proposal/fdd/告警/会话）仍拒绝。
#   用例 6：owner（FORCE RLS 无策略）业务表零可见
# 前置：目标库已完成 bootstrap + goose up；本脚本经 superuser 连接（SET ROLE 切换被测角色），
#       角色策略按 current_user 生效，等价于真实登录连接。
# 连接：PG* 环境变量（默认 PGUSER=postgres / PGDATABASE=thermio，容器 socket trust 通道即可）。
# 退出：全部通过 exit 0；任一失败 exit 1（FAIL 汇总在末尾）。
#   DAT-107：末次清理退出码计入 FAIL；INT/TERM/HUP trap 兜底清夹具后以 128+信号值退出。
set -uo pipefail

PGDATABASE="${PGDATABASE:-thermio}"
export PGDATABASE
: "${PGUSER:=postgres}"
export PGUSER

SLUG_A="_rls_verify_a"
SLUG_B="_rls_verify_b"
PASS=0
FAIL=0

psql_exec() { psql -X -v ON_ERROR_STOP=1 -q "$@"; }

# 期望 sql 返回恰好一个计数，校验相等
expect_count() {
  local desc="$1" expected="$2" sql="$3" got
  got=$(psql -X -q -tAc "$sql")
  if [ "$got" = "$expected" ]; then
    echo "PASS: $desc (count=$got)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $desc — 期望 count=$expected，实际 count=$got"
    FAIL=$((FAIL + 1))
  fi
}

# 期望 sql 可执行（可读性探针：行数随夹具变化，只断言无权限错误）
expect_readable() {
  local desc="$1" sql="$2" err
  err=$(psql -X -q -tAc "$sql" 2>&1)
  if [ $? -eq 0 ]; then
    echo "PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $desc — 期望可读，实际: $(echo "$err" | tail -1)"
    FAIL=$((FAIL + 1))
  fi
}

# 期望 psql 报错且错误信息含指定子串（ON_ERROR_STOP 下非 0 退出）
expect_error() {
  local desc="$1" pattern="$2" sql="$3" err
  err=$(psql -X -q -v ON_ERROR_STOP=1 -c "$sql" 2>&1)
  if [ $? -ne 0 ] && echo "$err" | grep -q "$pattern"; then
    echo "PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $desc — 期望报错含 '$pattern'，实际: $(echo "$err" | tail -1)"
    FAIL=$((FAIL + 1))
  fi
}

# ── 夹具清理（先清后建保证可重跑；逆依赖序，RESTRICT 纪律） ──
cleanup_fixture() {
  psql_exec <<'SQL'
\set ON_ERROR_STOP on
BEGIN;
DELETE FROM building WHERE tenant_id IN (SELECT id FROM tenant WHERE slug IN ('_rls_verify_a','_rls_verify_b'));
DELETE FROM tenant WHERE slug IN ('_rls_verify_a','_rls_verify_b');
COMMIT;
SQL
}

# ── trap 兜底：中断信号先清夹具再退（正常退出路径不受影响；清理幂等可重入） ──
on_interrupt() {
  cleanup_fixture || echo "WARN: 中断兜底清理失败，夹具残留可重跑自愈" >&2
  exit $((128 + $1))
}
trap 'on_interrupt 2' INT   # 130
trap 'on_interrupt 15' TERM # 143
trap 'on_interrupt 1' HUP   # 129

cleanup_fixture

# ── 夹具：双租户 + 租户 A 一栋楼（superuser 通道） ──
psql_exec <<'SQL'
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO tenant (name, slug) VALUES ('RLS验证A', '_rls_verify_a'), ('RLS验证B', '_rls_verify_b');
INSERT INTO building (tenant_id, name)
  SELECT id, 'A楼' FROM tenant WHERE slug = '_rls_verify_a';
COMMIT;
SQL
TENANT_A=$(psql -X -q -tAc "SELECT id FROM tenant WHERE slug = '${SLUG_A}'")
TENANT_B=$(psql -X -q -tAc "SELECT id FROM tenant WHERE slug = '${SLUG_B}'")
if [ -z "$TENANT_A" ] || [ -z "$TENANT_B" ]; then
  echo "FAIL: 夹具准备失败（TENANT_A/TENANT_B 为空）"
  exit 1
fi

echo "== 用例 2：api 角色跨租户读写隔离 =="
expect_count "A 上下文只见 A 的楼" 1 \
  "SET ROLE thermio_api; BEGIN; SET LOCAL app.tenant_id = '${TENANT_A}'; SELECT count(*) FROM building WHERE tenant_id = '${TENANT_A}'::uuid; ROLLBACK;"
expect_count "B 上下文不见 A 的楼" 0 \
  "SET ROLE thermio_api; BEGIN; SET LOCAL app.tenant_id = '${TENANT_B}'; SELECT count(*) FROM building WHERE tenant_id = '${TENANT_A}'::uuid; ROLLBACK;"
expect_error "B 上下文写 A 数据被 WITH CHECK 拒绝" "row-level security" \
  "SET ROLE thermio_api; BEGIN; SET LOCAL app.tenant_id = '${TENANT_B}'; INSERT INTO building (tenant_id, name) VALUES ('${TENANT_A}'::uuid, '越权楼'); ROLLBACK;"

echo "== 用例 3：未设 app.tenant_id → api 零可见（fail-closed） =="
expect_count "无上下文 api 全表零可见" 0 \
  "SET ROLE thermio_api; SELECT count(*) FROM building;"

echo "== 用例 4：ingest 角色仅 point/gateway 只读 =="
expect_count "ingest 可 SELECT point" 0 \
  "SET ROLE thermio_ingest; SELECT count(*) FROM point;"
expect_error "ingest 读 device_credential 拒绝" "permission denied" \
  "SET ROLE thermio_ingest; SELECT count(*) FROM device_credential;"
expect_error "ingest UPDATE point 拒绝" "permission denied" \
  "SET ROLE thermio_ingest; UPDATE point SET status = 'disabled';"

echo "== 用例 5：auth 角色旁路 = 枚举 internal_read 只读集（0001/0005/0007/0008），业务表拒绝 =="
for t in gateway device_credential app_user tenant equipment building point hvac_system; do
  expect_readable "auth 可 SELECT $t（internal_read 枚举集）" \
    "SET ROLE thermio_auth; SELECT count(*) FROM $t;"
done
for t in proposal fdd_finding fdd_report alarm_event control_audit auth_session; do
  expect_error "auth 读 $t 拒绝（旁路面未失控）" "permission denied" \
    "SET ROLE thermio_auth; SELECT count(*) FROM $t;"
done

echo "== 用例 6：owner（FORCE RLS 无策略）零可见 =="
expect_count "owner 业务表零可见" 0 \
  "SET ROLE thermio_owner; SELECT count(*) FROM building;"

# ── 清理夹具（逆依赖序，RESTRICT 纪律）；末次清理退出码检查（DAT-107） ──
if ! cleanup_fixture; then
  echo "FAIL: 末次夹具清理非零退出（连接闪断/SQL 失败），残留由下次先清后建自愈"
  FAIL=$((FAIL + 1))
fi

echo "== 结果：PASS=${PASS} FAIL=${FAIL} =="
[ "$FAIL" -eq 0 ]
