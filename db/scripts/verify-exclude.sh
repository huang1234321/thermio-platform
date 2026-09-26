#!/usr/bin/env bash
# verify-exclude.sh — ddl.md §9.6 用例 11 脚本化复跑（0001 §4 EXCLUDE 拒绝语义，DAT-106 补录）
#   约束：CONSTRAINT mv_baseline_no_active_overlap
#         EXCLUDE USING gist (tenant_id WITH =, baseline_period WITH &&) WHERE (status = 'active')
#   六断言（DAT-105 验收探针 qa-exclude-probe.sh 改写为 PG* 纯 psql 模型，语义不缩水）：
#     P1 首条 active 基线经 api 角色通道放行
#     P2 同租户重叠 active 被拒绝（conflicting key value violates exclusion constraint）
#     P3 相邻不重叠 active 放行（[Jan) 与 [Feb) 半开区间不相交）
#     P4 重叠但 draft 放行（WHERE status='active' 限定，不误伤草稿）
#     P5 同期跨租户 active 放行（tenant_id WITH = 维度隔离）
#     P6 原 active 全部 retired 后重叠期再 active 放行（换代语义）
#   运行模型注意：断言链有状态依赖（P1 落库 → P2 才有可拒对象 → P6 换代），成功插入
#   用会话级 SET app.tenant_id + 单条 -c 隐式事务落库，不包 BEGIN/ROLLBACK（区别于
#   verify-rls / verify-v11 的无状态断言）；夹具 slug 前缀 _exc_，先清后建、跑完即清，
#   可重跑，与 verify-rls.sh / verify-v11.sh 交叉执行顺序无关。
# 前置：目标库已完成 bootstrap + goose up（0001–0003）；本脚本经 superuser 连接
#       （SET ROLE 切换被测角色），角色策略按 current_user 生效，等价于真实登录连接。
# 连接：PG* 环境变量（默认 PGUSER=postgres / PGDATABASE=thermio，容器 socket trust 通道即可）。
# 退出：全部通过 exit 0；任一失败 exit 1（FAIL 汇总在末尾）。
#   DAT-107：末次清理退出码计入 FAIL；INT/TERM/HUP trap 兜底清夹具后以 128+信号值退出。
set -uo pipefail

PGDATABASE="${PGDATABASE:-thermio}"
export PGDATABASE
: "${PGUSER:=postgres}"
export PGUSER

SLUG_A="_exc_a"
SLUG_B="_exc_b"
PASS=0
FAIL=0

psql_exec() { psql -X -v ON_ERROR_STOP=1 -q "$@"; }

# 期望 sql 返回恰好一个计数，校验相等
expect_count() {
  local desc="$1" expected="$2" sql="$3" got
  got=$(psql -X -q -tAc "$sql")
  if [ "$got" = "$expected" ]; then
    echo "PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $desc — 期望 count=$expected，实际 count=$got"
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

# ── 夹具清理（先清后建保证可重跑；mv_baseline 先于 tenant，逆依赖序 RESTRICT 纪律） ──
cleanup_fixture() {
  psql_exec <<'SQL'
\set ON_ERROR_STOP on
BEGIN;
DELETE FROM mv_baseline WHERE tenant_id IN (SELECT id FROM tenant WHERE slug IN ('_exc_a','_exc_b'));
DELETE FROM tenant WHERE slug IN ('_exc_a','_exc_b');
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

# ── 夹具：双租户（mv_baseline 的 building_id/system_id 可空，无需资产链） ──
psql_exec <<'SQL'
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO tenant (name, slug) VALUES ('EXC验证A', '_exc_a'), ('EXC验证B', '_exc_b');
COMMIT;
SQL
TENANT_A=$(psql -X -q -tAc "SELECT id FROM tenant WHERE slug = '${SLUG_A}'")
TENANT_B=$(psql -X -q -tAc "SELECT id FROM tenant WHERE slug = '${SLUG_B}'")
if [ -z "$TENANT_A" ] || [ -z "$TENANT_B" ]; then
  echo "FAIL: 夹具准备失败（TENANT_A/TENANT_B 为空）"
  exit 1
fi

echo "== EXCLUDE 拒绝语义：mv_baseline_no_active_overlap =="

echo "-- P1：首条 active 放行 --"
expect_count "P1 首条 active 基线 [Jan) api 通道放行" 1 \
  "SET ROLE thermio_api; SET app.tenant_id = '${TENANT_A}'; WITH ins AS (INSERT INTO mv_baseline (tenant_id, method, baseline_period, model_type, status) VALUES ('${TENANT_A}'::uuid, 'ipmvp_option_c', daterange('2026-01-01','2026-02-01'), 'regression', 'active') RETURNING 1) SELECT count(*) FROM ins;"

echo "-- P2：同租户重叠 active 拒绝 --"
expect_error "P2 同租户重叠 active [Jan15,Feb15) 被 EXCLUDE 拒绝" "mv_baseline_no_active_overlap" \
  "SET ROLE thermio_api; SET app.tenant_id = '${TENANT_A}'; INSERT INTO mv_baseline (tenant_id, method, baseline_period, model_type, status) VALUES ('${TENANT_A}'::uuid, 'ipmvp_option_c', daterange('2026-01-15','2026-02-15'), 'regression', 'active');"

echo "-- P3：相邻不重叠 active 放行 --"
expect_count "P3 相邻 active [Feb) 放行（半开区间不交）" 1 \
  "SET ROLE thermio_api; SET app.tenant_id = '${TENANT_A}'; WITH ins AS (INSERT INTO mv_baseline (tenant_id, method, baseline_period, model_type, status) VALUES ('${TENANT_A}'::uuid, 'ipmvp_option_c', daterange('2026-02-01','2026-03-01'), 'regression', 'active') RETURNING 1) SELECT count(*) FROM ins;"

echo "-- P4：重叠但 draft 放行 --"
expect_count "P4 重叠 draft [Jan15,Feb15) 放行（WHERE 限定不误伤草稿）" 1 \
  "SET ROLE thermio_api; SET app.tenant_id = '${TENANT_A}'; WITH ins AS (INSERT INTO mv_baseline (tenant_id, method, baseline_period, model_type, status) VALUES ('${TENANT_A}'::uuid, 'ipmvp_option_c', daterange('2026-01-15','2026-02-15'), 'regression', 'draft') RETURNING 1) SELECT count(*) FROM ins;"

echo "-- P5：同期跨租户放行 --"
expect_count "P5 同期跨租户 active [Jan) 放行（tenant_id WITH = 维度）" 1 \
  "SET ROLE thermio_api; SET app.tenant_id = '${TENANT_B}'; WITH ins AS (INSERT INTO mv_baseline (tenant_id, method, baseline_period, model_type, status) VALUES ('${TENANT_B}'::uuid, 'ipmvp_option_c', daterange('2026-01-01','2026-02-01'), 'regression', 'active') RETURNING 1) SELECT count(*) FROM ins;"

echo "-- P6：retired 换代后重叠 active 放行 --"
expect_count "P6 原 active 全部 retired 后重叠 active [Jan15,Feb15) 放行（换代）" 1 \
  "SET ROLE thermio_api; SET app.tenant_id = '${TENANT_A}'; UPDATE mv_baseline SET status = 'retired' WHERE tenant_id = '${TENANT_A}'::uuid AND status = 'active'; WITH ins AS (INSERT INTO mv_baseline (tenant_id, method, baseline_period, model_type, status) VALUES ('${TENANT_A}'::uuid, 'ipmvp_option_c', daterange('2026-01-15','2026-02-15'), 'regression', 'active') RETURNING 1) SELECT count(*) FROM ins;"

# ── 清理夹具（逆依赖序，RESTRICT 纪律）；末次清理退出码检查（DAT-107） ──
if ! cleanup_fixture; then
  echo "FAIL: 末次夹具清理非零退出（连接闪断/SQL 失败），残留由下次先清后建自愈"
  FAIL=$((FAIL + 1))
fi

echo "== 结果：PASS=${PASS} FAIL=${FAIL} =="
[ "$FAIL" -eq 0 ]
