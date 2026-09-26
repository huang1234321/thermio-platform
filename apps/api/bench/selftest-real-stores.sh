#!/usr/bin/env bash
# selftest-real-stores.sh — IMPL-12 关键路径自测：真实 PG + TSDB + 编译产物 api 全链路。
#
# 一次性容器（thermio-selftest-pg :55432 / thermio-selftest-tsdb :55433，独立容器/卷，
# 环境隔离纪律，跑完即毁）；PG 链 = 本仓 db/，TSDB 链 = 兄弟 checkout thermio-ingest。
# psql 一律容器内执行（宿主免装）。密码现场生成。
#
# 验证面（IMPL-12 端点契约的正/负路径，跑真实 SQL 而非 fake）：
#   1) latest 200（value/quality/ts 齐）                2) telemetry 5min 200（cagg 桶形）
#   3) telemetry raw 200 + 游标翻页                      4) 跨度超限 422 telemetry.range_invalid
#   5) 未登记点 404 asset.not_found（PG 判别）            6) 登记无数据 404 point.no_data
#   7) PG 侧 RLS 生效面：api 连接走 thermio_api + 事务内 SET app.tenant_id（ddl.md §5.2）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
PG_MIGRATIONS="${REPO_ROOT}/db/migrations/pg"
TSDB_MIGRATIONS="${THERMIO_TSDB_MIGRATIONS_DIR:-${REPO_ROOT}/../thermio-ingest/db/migrations/tsdb}"
[ -d "$TSDB_MIGRATIONS" ] || { echo "缺少 TSDB 迁移目录: $TSDB_MIGRATIONS" >&2; exit 1; }
[ -f "${REPO_ROOT}/apps/api/dist/main.js" ] || {
  echo "先构建：pnpm --filter @thermio/api build" >&2; exit 1; }

PG_C=thermio-selftest-pg; TS_C=thermio-selftest-tsdb
PG_PORT=55432; TS_PORT=55433; API_PORT=18080
PG_IMAGE=postgres:16.4-alpine; TS_IMAGE=timescale/timescaledb:2.17.2-pg16
PG_SU_PW="$(openssl rand -hex 16)"; TS_SU_PW="$(openssl rand -hex 16)"
PG_API_PW="$(openssl rand -hex 16)"; TS_API_PW="$(openssl rand -hex 16)"

pg()  { docker exec -i -e PGPASSWORD="$1" "$PG_C"  psql -X -q -U "$2" -d thermio     "${@:3}"; }
ts()  { docker exec -i -e PGPASSWORD="$1" "$TS_C"  psql -X -q -U "$2" -d thermio_ts  "${@:3}"; }

cleanup() {
  [ -n "${API_PID:-}" ] && kill "$API_PID" 2>/dev/null || true
  docker rm -f "$PG_C" "$TS_C" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

echo "==> 起一次性 PG(${PG_PORT}) + TSDB(${TS_PORT})"
docker run -d --name "$PG_C" -e POSTGRES_PASSWORD="$PG_SU_PW" -e POSTGRES_DB=thermio \
  -p 127.0.0.1:"$PG_PORT":5432 "$PG_IMAGE" >/dev/null
docker run -d --name "$TS_C" -e POSTGRES_PASSWORD="$TS_SU_PW" -e POSTGRES_DB=thermio_ts \
  -p 127.0.0.1:"$TS_PORT":5432 "$TS_IMAGE" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$PG_C" pg_isready -U postgres >/dev/null 2>&1 && \
  docker exec "$TS_C" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done

echo "==> PG：bootstrap 角色 + 迁移链 0001–0003 + 租户/楼栋/点位 fixture（superuser 通道）"
docker exec -i -e PGPASSWORD="$PG_SU_PW" "$PG_C" psql -X -U postgres -d thermio \
  -v api_password="$PG_API_PW" -v ingest_password="$(openssl rand -hex 16)" \
  -v auth_password="$(openssl rand -hex 16)" < "${REPO_ROOT}/db/bootstrap/pg-roles.sql" >/dev/null
for f in "$PG_MIGRATIONS"/[0-9]*.sql; do
  awk '/^-- \+goose Up/{flag=1;next} /^-- \+goose Down/{flag=0} flag' "$f" \
    | pg "$PG_SU_PW" postgres -v ON_ERROR_STOP=1 >/dev/null
done
TENANT_ID="$(pg "$PG_SU_PW" postgres -v ON_ERROR_STOP=1 -At <<'SQL'
INSERT INTO tenant (name, slug, deployment_mode) VALUES ('自测租户', 'selftest', 'private');
SELECT id FROM tenant WHERE slug='selftest';
SQL
)"
pg "$PG_SU_PW" postgres -v ON_ERROR_STOP=1 -v tenant_id="$TENANT_ID" -At <<'SQL' >/dev/null
INSERT INTO building (tenant_id, name, address)
VALUES (:'tenant_id'::uuid, '自测楼', '自测地址');
SQL
POINT_ID="$(pg "$PG_SU_PW" postgres -v ON_ERROR_STOP=1 -v tenant_id="$TENANT_ID" -At <<'SQL'
WITH b AS (SELECT id FROM building WHERE tenant_id = :'tenant_id'::uuid LIMIT 1)
INSERT INTO point (tenant_id, building_id, source_type, raw_name, quantity_type, unit_std)
SELECT :'tenant_id'::uuid, b.id, 'virtual', 'SELFTEST_TEMP_1', 'chw_supply_temp', 'degC' FROM b
RETURNING id;
SQL
)"
NO_DATA_ID="$(pg "$PG_SU_PW" postgres -v ON_ERROR_STOP=1 -v tenant_id="$TENANT_ID" -At <<'SQL'
WITH b AS (SELECT id FROM building WHERE tenant_id = :'tenant_id'::uuid LIMIT 1)
INSERT INTO point (tenant_id, building_id, source_type, raw_name, quantity_type, unit_std)
SELECT :'tenant_id'::uuid, b.id, 'virtual', 'SELFTEST_NODATA_1', 'power', 'kW' FROM b
RETURNING id;
SQL
)"
echo "    tenant=${TENANT_ID} point=${POINT_ID} no_data_point=${NO_DATA_ID}"

echo "==> TSDB：bootstrap 角色 + 迁移链 + 灌 3 天 × 1min（点 ${POINT_ID}）+ 物化 cagg"
docker exec -i -e PGPASSWORD="$TS_SU_PW" "$TS_C" psql -X -U postgres -d thermio_ts \
  -v ingest_password="$(openssl rand -hex 16)" -v api_password="$TS_API_PW" \
  -v algo_password="$(openssl rand -hex 16)" < "$TSDB_MIGRATIONS/../../bootstrap/tsdb-roles.sql" >/dev/null
for f in "$TSDB_MIGRATIONS"/[0-9]*.sql; do
  awk '/^-- \+goose Up/{flag=1;next} /^-- \+goose Down/{flag=0} flag' "$f" \
    | ts "$TS_SU_PW" postgres -v ON_ERROR_STOP=1 >/dev/null
done
ts "$TS_SU_PW" postgres -v ON_ERROR_STOP=1 -v point_id="$POINT_ID" <<'SQL' >/dev/null
INSERT INTO telemetry (point_id, ts, value, value_text, quality)
SELECT :'point_id'::bigint,
       date_trunc('minute', now()) - make_interval(mins => m),
       7 + (m % 50)::float8 / 10,
       CASE WHEN m % 700 = 0 THEN 'running' ELSE NULL END,
       CASE WHEN m % 300 = 0 THEN 4 ELSE 0 END
FROM generate_series(1, 60 * 24 * 3) AS m;
ANALYZE telemetry;
SQL
ts "$TS_SU_PW" postgres -v ON_ERROR_STOP=1 -c \
  "CALL refresh_continuous_aggregate('telemetry_5min', now() - interval '4 days', now())" >/dev/null
ts "$TS_SU_PW" postgres -v ON_ERROR_STOP=1 -c \
  "CALL refresh_continuous_aggregate('telemetry_1h', now() - interval '4 days', now())" >/dev/null

echo "==> 起 api（dist 产物，只读连接串指向两个一次性容器）"
KAFKA_BROKERS='' LOG_LEVEL=info PORT="$API_PORT" \
TSDB_READ_URL="postgres://tsdb_api:${TS_API_PW}@127.0.0.1:${TS_PORT}/thermio_ts?sslmode=disable" \
PG_URL="postgres://thermio_api:${PG_API_PW}@127.0.0.1:${PG_PORT}/thermio?sslmode=disable" \
PG_TENANT_ID="$TENANT_ID" \
  node "${REPO_ROOT}/apps/api/dist/main.js" > /tmp/thermio-selftest-api.log 2>&1 &
API_PID=$!
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:${API_PORT}/healthz" >/dev/null 2>&1 && break
  sleep 0.2
done

B="http://127.0.0.1:${API_PORT}/api/v1"
FROM=$(date -u -v-2d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '2 days ago' +%Y-%m-%dT%H:%M:%SZ)
TO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
pass=0; fail=0
check() {  # check <期望状态码> <name> <url> [grep 断言…]
  local expect="$1" name="$2" url="$3"; shift 3
  local body code
  body="$(curl -s -o /tmp/st-body -w '%{http_code}' "$url")"; code="$body"; body="$(cat /tmp/st-body)"
  if [ "$code" != "$expect" ]; then
    echo "FAIL ${name}: HTTP ${code} ≠ ${expect} — ${body}"; fail=$((fail+1)); return
  fi
  for pat in "$@"; do
    echo "$body" | grep -q "$pat" || { echo "FAIL ${name}: body 缺 ${pat} — ${body}"; fail=$((fail+1)); return; }
  done
  echo "ok   ${name} (HTTP ${code})"
  pass=$((pass+1))
}

check 200 "latest 正路径"                    "$B/points/${POINT_ID}/latest" "\"point_id\":${POINT_ID}" '"quality":' '"ts":'
check 200 "telemetry 5min 走 cagg 桶形"      "$B/points/${POINT_ID}/telemetry?interval=5min&from=${FROM}&to=${TO}&limit=5" '"bucket":' '"sample_count":' '"next_cursor":'
check 200 "telemetry raw 样本形"             "$B/points/${POINT_ID}/telemetry?interval=raw&from=${FROM}&to=${TO}&limit=3"  '"ts":' '"value":'
check 200 "telemetry 1h 桶形"                "$B/points/${POINT_ID}/telemetry?interval=1h&from=${FROM}&to=${TO}&limit=3"  '"bucket":'
check 422 "跨度超限 → telemetry.range_invalid" "$B/points/${POINT_ID}/telemetry?from=2026-01-01T00:00:00Z&to=${TO}&interval=raw" 'telemetry.range_invalid' '"max_span_days":31'
check 404 "未登记点 → asset.not_found"       "$B/points/999999/latest" 'asset.not_found'
check 404 "登记无数据 → point.no_data"       "$B/points/${NO_DATA_ID}/latest" 'point.no_data'
check 422 "畸形 interval → validation_failed" "$B/points/${POINT_ID}/telemetry?interval=15min" 'common.validation_failed'

echo
echo "==> 结果：${pass} ok / ${fail} fail（api 日志 /tmp/thermio-selftest-api.log）"
[ "$fail" -eq 0 ]
