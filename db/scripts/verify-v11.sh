#!/usr/bin/env bash
# verify-v11.sh — ddl.md §9.6 用例 2–9 脚本化复跑（v1.1 增量：0002/0003 六新表）
#   用例 2：api 角色六表完整 DML（作业状态机 parsed→…→checked、行三态映射、
#           FDD 发现/报告插入、熔断触发/解除一轮 state + 2 events）
#   用例 3：状态机封闭集（import_job.status='warp'、control_fuse.status='half_open' 被 CHECK 拒绝）
#   用例 4：活跃发现唯一（同设备同规则第二条 open 被 fdd_finding_active_uidx 拒绝）
#   用例 5：FK RESTRICT（删被 fdd_finding.alarm_event_id 引用的 alarm_event、
#           被 import_job 链引用的 building 均被拒）
#   用例 6：RLS 隔离（B 上下文零可见 / B 写 A 被拒 / 未设上下文 fail-closed）
#   用例 7：角色最小权（thermio_ingest 读 import_job 拒、读 gateway 正常——无回归）
#   用例 8：0002 索引 alarm_event_tenant_id_uidx indisvalid + indisunique
#   用例 9：fdd_report 同期唯一（同期拒、相邻期过）+ import_row / control_fuse touch 触发器
#   用例 1（全链 Up 25 表）与用例 10（Down 往返）由 CI 的 goose 步骤覆盖，不在本脚本。
# 前置：目标库已完成 bootstrap + goose up（0001–0004）；本脚本经 superuser 连接
#       （SET ROLE 切换被测角色），角色策略按 current_user 生效，等价于真实登录连接。
# 连接：PG* 环境变量（默认 PGUSER=postgres / PGDATABASE=thermio，容器 socket trust 通道即可）。
# 退出：全部通过 exit 0；任一失败 exit 1（FAIL 汇总在末尾）。
#   DAT-107：末次清理退出码计入 FAIL；INT/TERM/HUP trap 兜底清夹具后以 128+信号值退出。
set -uo pipefail

PGDATABASE="${PGDATABASE:-thermio}"
export PGDATABASE
: "${PGUSER:=postgres}"
export PGUSER

SLUG_A="_v11_a"
SLUG_B="_v11_b"
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
DELETE FROM control_fuse_event WHERE tenant_id IN (SELECT id FROM tenant WHERE slug IN ('_v11_a','_v11_b'));
DELETE FROM control_fuse      WHERE tenant_id IN (SELECT id FROM tenant WHERE slug IN ('_v11_a','_v11_b'));
DELETE FROM fdd_finding       WHERE tenant_id IN (SELECT id FROM tenant WHERE slug IN ('_v11_a','_v11_b'));
DELETE FROM fdd_report        WHERE tenant_id IN (SELECT id FROM tenant WHERE slug IN ('_v11_a','_v11_b'));
DELETE FROM import_row        WHERE tenant_id IN (SELECT id FROM tenant WHERE slug IN ('_v11_a','_v11_b'));
DELETE FROM import_job        WHERE tenant_id IN (SELECT id FROM tenant WHERE slug IN ('_v11_a','_v11_b'));
DELETE FROM alarm_event       WHERE tenant_id IN (SELECT id FROM tenant WHERE slug IN ('_v11_a','_v11_b'));
DELETE FROM gateway           WHERE tenant_id IN (SELECT id FROM tenant WHERE slug IN ('_v11_a','_v11_b'));
DELETE FROM equipment         WHERE tenant_id IN (SELECT id FROM tenant WHERE slug IN ('_v11_a','_v11_b'));
DELETE FROM hvac_system       WHERE tenant_id IN (SELECT id FROM tenant WHERE slug IN ('_v11_a','_v11_b'));
DELETE FROM building          WHERE tenant_id IN (SELECT id FROM tenant WHERE slug IN ('_v11_a','_v11_b'));
DELETE FROM app_user          WHERE tenant_id IN (SELECT id FROM tenant WHERE slug IN ('_v11_a','_v11_b'));
DELETE FROM tenant WHERE slug IN ('_v11_a','_v11_b');
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

# ── 夹具：双租户 + 租户 A 资产链（tenant→building→hvac_system→equipment、gateway、app_user、alarm_event） ──
psql_exec <<'SQL'
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO tenant (name, slug) VALUES ('V11验证A', '_v11_a'), ('V11验证B', '_v11_b');
SELECT id AS t FROM tenant WHERE slug = '_v11_a' \gset
INSERT INTO app_user (tenant_id, email, password_hash, display_name)
  VALUES (:'t', 'admin@v11.local', '(argon2id 占位)', 'V11管理员');
INSERT INTO building (tenant_id, name) VALUES (:'t', 'V11楼');
INSERT INTO hvac_system (tenant_id, building_id, system_type, name)
  SELECT :'t', id, 'chiller_plant', 'V11冷热源' FROM building WHERE tenant_id = :'t';
INSERT INTO equipment (tenant_id, system_id, equipment_type, name)
  SELECT :'t', id, 'chiller', '1#冷机' FROM hvac_system WHERE tenant_id = :'t';
INSERT INTO gateway (tenant_id, building_id, name, serial, mqtt_client_id)
  SELECT :'t', id, 'V11网关', 'V11-GW-001', 'v11-gw-001' FROM building WHERE tenant_id = :'t';
INSERT INTO alarm_event (tenant_id, source_type, source_id, severity, message)
  VALUES (:'t', 'equipment', 'V11-EQ-001', 'major', 'V11联动告警');
COMMIT;
SQL
TENANT_A=$(psql -X -q -tAc "SELECT id FROM tenant WHERE slug = '${SLUG_A}'")
TENANT_B=$(psql -X -q -tAc "SELECT id FROM tenant WHERE slug = '${SLUG_B}'")
BUILDING_A=$(psql -X -q -tAc "SELECT id FROM building WHERE tenant_id = '${TENANT_A}'::uuid AND name = 'V11楼'")
SYSTEM_A=$(psql -X -q -tAc "SELECT id FROM hvac_system WHERE tenant_id = '${TENANT_A}'::uuid")
EQUIP_A=$(psql -X -q -tAc "SELECT id FROM equipment WHERE tenant_id = '${TENANT_A}'::uuid")
GATEWAY_A=$(psql -X -q -tAc "SELECT id FROM gateway WHERE tenant_id = '${TENANT_A}'::uuid")
ADMIN_A=$(psql -X -q -tAc "SELECT id FROM app_user WHERE tenant_id = '${TENANT_A}'::uuid")
ALARM_A=$(psql -X -q -tAc "SELECT id FROM alarm_event WHERE tenant_id = '${TENANT_A}'::uuid")
if [ -z "$TENANT_A" ] || [ -z "$TENANT_B" ] || [ -z "$BUILDING_A" ] || [ -z "$SYSTEM_A" ] \
  || [ -z "$EQUIP_A" ] || [ -z "$GATEWAY_A" ] || [ -z "$ADMIN_A" ] || [ -z "$ALARM_A" ]; then
  echo "FAIL: 夹具准备失败（存在空 ID）"
  exit 1
fi

echo "== 用例 2：api 角色六表完整 DML（A 上下文） =="
psql -X -v ON_ERROR_STOP=1 -q \
  -v tenant_a="$TENANT_A" -v building="$BUILDING_A" -v gateway="$GATEWAY_A" \
  -v admin="$ADMIN_A" -v system="$SYSTEM_A" -v equipment="$EQUIP_A" <<'SQL' \
&& echo "PASS: DML 全链 exit 0" && PASS=$((PASS + 1)) \
|| { echo "FAIL: DML 全链非 0 退出"; FAIL=$((FAIL + 1)); }
\set ON_ERROR_STOP on
SET ROLE thermio_api;
BEGIN;
SET LOCAL app.tenant_id = :'tenant_a';

-- 作业状态机：parsed（默认）→ mapping → validated → applied → checked
INSERT INTO import_job (tenant_id, building_id, gateway_id, file_name, row_count, created_by)
VALUES (:'tenant_a'::uuid, :'building'::uuid, :'gateway'::uuid, 'V11点表.xlsx', 1, :'admin'::uuid);
SELECT id AS job FROM import_job WHERE tenant_id = :'tenant_a'::uuid \gset
UPDATE import_job SET status = 'mapping',   mapped_count = 1 WHERE id = :'job';
UPDATE import_job SET status = 'validated', issue_count  = 0 WHERE id = :'job';
UPDATE import_job SET status = 'applied',   applied_at   = now() WHERE id = :'job';
UPDATE import_job SET status = 'checked',   checked_at   = now(), hit_rate = 0.5 WHERE id = :'job';

-- 行三态映射：unmapped（默认）→ auto → manual
INSERT INTO import_row (tenant_id, job_id, row_no, raw_name, raw_description, unit_raw)
VALUES (:'tenant_a'::uuid, :'job'::uuid, 1, 'CHWS_T_001', '冷冻水供温', 'degC');
SELECT id AS irow FROM import_row WHERE job_id = :'job'::uuid \gset
UPDATE import_row SET map_status = 'auto', quantity_type = 'chws_temp', unit_std = 'degC', mapped_at = now()
WHERE id = :'irow';
UPDATE import_row SET map_status = 'manual', equipment_id = :'equipment'::uuid, mapped_by = :'admin'::uuid
WHERE id = :'irow';

-- FDD 发现（open）+ 周期报告
INSERT INTO fdd_finding (tenant_id, equipment_id, rule_key, algo_version, severity, title,
                         first_detected_at, last_detected_at)
VALUES (:'tenant_a'::uuid, :'equipment'::uuid, 'chiller_low_cop', 'algo-fdd-0.1.0', 'major',
        '1#冷机COP持续偏低', now() - interval '1 hour', now());
INSERT INTO fdd_report (tenant_id, building_id, period_type, period, summary, algo_version)
VALUES (:'tenant_a'::uuid, :'building'::uuid, 'day', daterange(current_date - 1, current_date),
        '{"new":1,"ongoing":0,"resolved":0}'::jsonb, 'algo-fdd-0.1.0');

-- 熔断一轮：closed → open（触发留痕）→ closed（人工解除留痕）
INSERT INTO control_fuse (system_id, tenant_id) VALUES (:'system'::uuid, :'tenant_a'::uuid);
UPDATE control_fuse SET status = 'open', triggered_at = now(),
  trigger_detail = '{"window":"15m","err_rate":0.4,"consecutive_fail":4}'::jsonb
WHERE system_id = :'system'::uuid;
INSERT INTO control_fuse_event (tenant_id, system_id, event_type, actor_type, detail)
VALUES (:'tenant_a'::uuid, :'system'::uuid, 'tripped', 'system', '{"err_rate":0.4}'::jsonb);
INSERT INTO control_fuse_event (tenant_id, system_id, event_type, actor_type, actor_ref, reason, detail)
VALUES (:'tenant_a'::uuid, :'system'::uuid, 'released', 'human', :'admin'::text,
        '检修完成，人工解除', '{"err_rate":0.02,"hold":"30m"}'::jsonb);
UPDATE control_fuse SET status = 'closed', released_at = now() WHERE system_id = :'system'::uuid;

COMMIT;
RESET ROLE;
SQL

expect_count "A 上下文 import_job=1（状态机走到 checked）" 1 \
  "SET ROLE thermio_api; BEGIN; SET LOCAL app.tenant_id = '${TENANT_A}'; SELECT count(*) FROM import_job WHERE status = 'checked'; ROLLBACK;"
expect_count "A 上下文 import_row=1（manual 态）" 1 \
  "SET ROLE thermio_api; BEGIN; SET LOCAL app.tenant_id = '${TENANT_A}'; SELECT count(*) FROM import_row WHERE map_status = 'manual'; ROLLBACK;"
expect_count "A 上下文 fdd_finding=1（open）" 1 \
  "SET ROLE thermio_api; BEGIN; SET LOCAL app.tenant_id = '${TENANT_A}'; SELECT count(*) FROM fdd_finding WHERE status = 'open'; ROLLBACK;"
expect_count "A 上下文 fdd_report=1" 1 \
  "SET ROLE thermio_api; BEGIN; SET LOCAL app.tenant_id = '${TENANT_A}'; SELECT count(*) FROM fdd_report; ROLLBACK;"
expect_count "A 上下文 control_fuse=1（closed）" 1 \
  "SET ROLE thermio_api; BEGIN; SET LOCAL app.tenant_id = '${TENANT_A}'; SELECT count(*) FROM control_fuse WHERE status = 'closed'; ROLLBACK;"
expect_count "A 上下文 control_fuse_event=2（tripped+released）" 2 \
  "SET ROLE thermio_api; BEGIN; SET LOCAL app.tenant_id = '${TENANT_A}'; SELECT count(*) FROM control_fuse_event; ROLLBACK;"

echo "== 用例 3：状态机封闭集（CHECK 拒绝） =="
expect_error "import_job.status='warp' 被 CHECK 拒绝" "check constraint" \
  "SET ROLE thermio_api; BEGIN; SET LOCAL app.tenant_id = '${TENANT_A}'; UPDATE import_job SET status = 'warp'; ROLLBACK;"
expect_error "control_fuse.status='half_open' 被 CHECK 拒绝（无半开态）" "check constraint" \
  "SET ROLE thermio_api; BEGIN; SET LOCAL app.tenant_id = '${TENANT_A}'; UPDATE control_fuse SET status = 'half_open'; ROLLBACK;"

echo "== 用例 4：活跃发现唯一（风暴抑制） =="
expect_error "同设备同规则第二条 open 被 fdd_finding_active_uidx 拒绝" "fdd_finding_active_uidx" \
  "SET ROLE thermio_api; BEGIN; SET LOCAL app.tenant_id = '${TENANT_A}'; INSERT INTO fdd_finding (tenant_id, equipment_id, rule_key, algo_version, severity, title, first_detected_at, last_detected_at) VALUES ('${TENANT_A}'::uuid, '${EQUIP_A}'::uuid, 'chiller_low_cop', 'algo-fdd-0.1.0', 'major', '重复发现', now(), now()); ROLLBACK;"

echo "== 用例 5：FK RESTRICT =="
# 先回填联动告警（§9.2 联动语义），再验证被引用行不可删
psql_exec -c "UPDATE fdd_finding SET alarm_event_id = ${ALARM_A}::bigint WHERE tenant_id = '${TENANT_A}'::uuid" \
  || { echo "FAIL: 联动告警回填失败"; FAIL=$((FAIL + 1)); }
expect_error "删被 fdd_finding.alarm_event_id 引用的 alarm_event 被拒" "foreign key" \
  "DELETE FROM alarm_event WHERE id = ${ALARM_A};"
expect_error "删被 import_job 链引用的 building 被拒" "foreign key" \
  "DELETE FROM building WHERE id = '${BUILDING_A}'::uuid;"

echo "== 用例 6：RLS 隔离 =="
expect_count "B 上下文 count(import_job)=0" 0 \
  "SET ROLE thermio_api; BEGIN; SET LOCAL app.tenant_id = '${TENANT_B}'; SELECT count(*) FROM import_job; ROLLBACK;"
expect_error "B 上下文写 A 租户行被 WITH CHECK 拒绝" "row-level security" \
  "SET ROLE thermio_api; BEGIN; SET LOCAL app.tenant_id = '${TENANT_B}'; INSERT INTO import_job (tenant_id, building_id, gateway_id, file_name, created_by) VALUES ('${TENANT_A}'::uuid, '${BUILDING_A}'::uuid, '${GATEWAY_A}'::uuid, '越权.xlsx', '${ADMIN_A}'::uuid); ROLLBACK;"
expect_count "未设上下文 count(fdd_finding)=0（fail-closed）" 0 \
  "SET ROLE thermio_api; SELECT count(*) FROM fdd_finding;"

echo "== 用例 7：角色最小权（无回归） =="
expect_error "thermio_ingest 读 import_job 拒绝（不扩权）" "permission denied" \
  "SET ROLE thermio_ingest; SELECT count(*) FROM import_job;"
expect_count "thermio_ingest 读 gateway 正常" 1 \
  "SET ROLE thermio_ingest; SELECT count(*) FROM gateway WHERE tenant_id = '${TENANT_A}'::uuid;"

echo "== 用例 8：0002 复合唯一索引 =="
expect_count "alarm_event_tenant_id_uidx 存在且 indisvalid + indisunique" 1 \
  "SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'alarm_event_tenant_id_uidx' AND i.indisvalid AND i.indisunique;"

echo "== 用例 9：fdd_report 同期唯一 + touch 触发器 =="
expect_error "fdd_report 同期重复插入被 UNIQUE 拒绝" "duplicate key" \
  "SET ROLE thermio_api; BEGIN; SET LOCAL app.tenant_id = '${TENANT_A}'; INSERT INTO fdd_report (tenant_id, building_id, period_type, period, summary) VALUES ('${TENANT_A}'::uuid, '${BUILDING_A}'::uuid, 'day', daterange(current_date - 1, current_date), '{}'); ROLLBACK;"
expect_count "相邻期报告插入成功（同期唯一不误伤）" 1 \
  "SET ROLE thermio_api; BEGIN; SET LOCAL app.tenant_id = '${TENANT_A}'; WITH ins AS (INSERT INTO fdd_report (tenant_id, building_id, period_type, period, summary) VALUES ('${TENANT_A}'::uuid, '${BUILDING_A}'::uuid, 'day', daterange(current_date - 2, current_date - 1), '{}') RETURNING 1) SELECT count(*) FROM ins; ROLLBACK;"
# 把 updated_at 拨回 1 小时前（superuser），api 再 UPDATE —— 触发器应把它推回当前时刻
psql_exec -c "UPDATE import_row SET updated_at = now() - interval '1 hour' WHERE tenant_id = '${TENANT_A}'::uuid" \
  || { echo "FAIL: updated_at 拨回失败"; FAIL=$((FAIL + 1)); }
expect_count "import_row touch 触发器推进 updated_at" 1 \
  "SET ROLE thermio_api; BEGIN; SET LOCAL app.tenant_id = '${TENANT_A}'; WITH upd AS (UPDATE import_row SET raw_description = 'V11复核' WHERE tenant_id = '${TENANT_A}'::uuid RETURNING updated_at) SELECT count(*) FROM upd WHERE updated_at > now() - interval '1 minute'; ROLLBACK;"
# control_fuse touch（0004，DAT-102）：同款拨回验证——api 角色只 UPDATE 语义列（模拟
# 评估任务/人工解除路径不带 updated_at），触发器应把行维护时间戳推回当前时刻
psql_exec -c "UPDATE control_fuse SET updated_at = now() - interval '1 hour' WHERE tenant_id = '${TENANT_A}'::uuid" \
  || { echo "FAIL: control_fuse updated_at 拨回失败"; FAIL=$((FAIL + 1)); }
expect_count "control_fuse touch 触发器推进 updated_at（0004）" 1 \
  "SET ROLE thermio_api; BEGIN; SET LOCAL app.tenant_id = '${TENANT_A}'; WITH upd AS (UPDATE control_fuse SET trigger_detail = '{\"window\":\"15m\",\"recheck\":true}'::jsonb WHERE tenant_id = '${TENANT_A}'::uuid RETURNING updated_at) SELECT count(*) FROM upd WHERE updated_at > now() - interval '1 minute'; ROLLBACK;"

# ── 清理夹具（逆依赖序，RESTRICT 纪律）；末次清理退出码检查（DAT-107） ──
if ! cleanup_fixture; then
  echo "FAIL: 末次夹具清理非零退出（连接闪断/SQL 失败），残留由下次先清后建自愈"
  FAIL=$((FAIL + 1))
fi

echo "== 结果：PASS=${PASS} FAIL=${FAIL} =="
[ "$FAIL" -eq 0 ]
