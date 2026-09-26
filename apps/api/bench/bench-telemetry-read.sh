#!/usr/bin/env bash
# bench-telemetry-read.sh — IMPL-12 验收要点 3：大跨度查询基准（验证不影响写路径，单楼量级）。
#
# 形态：一次性 TimescaleDB 容器（thermio-bench-tsdb，独立容器/卷/端口，环境隔离纪律——
# 不连宿主既有服务、不连 dev compose 栈），跑完即毁；TSDB DDL 取自 thermio-ingest
# 迁移链（唯一蓝本，不复制 SQL 文本）。密码现场生成，不落库不落盘。
# psql 一律走容器内（宿主免装）。
#
# 用法（repo 根执行）：
#   apps/api/bench/bench-telemetry-read.sh [SEED_POINTS]
#   SEED_POINTS 默认 5000（单楼点位上界，ADR-014）；快速冒烟可传 500。
#   迁移目录可用 THERMIO_TSDB_MIGRATIONS_DIR 覆盖（默认兄弟 checkout
#   ../thermio-ingest/db/migrations/tsdb）。
#
# 场景（与 api 实际下发的 SQL 同形，telemetry-sql.ts 为准）：
#   Q1 latest          单点最新一行（ORDER BY ts DESC LIMIT 1）
#   Q2 raw 31d         原始层跨度上限窗（limit 201 = API 上限 200 + 探测位）
#   Q3 5min 730d       5min cagg 跨度上限窗
#   Q4 1h 3650d        1h cagg 跨度上限窗（数据 730d，验索引范围扫描行为）
#   W  写路径          ingest 形态批量 upsert（100 点 × 最新分钟，ON CONFLICT DO UPDATE）
# 基准 = 服务器端执行时间（EXPLAIN ANALYZE, TIMING OFF 的 Execution Time），
# 连接/docker exec 噪声不计；W 分别在空载与 Q3 读并发下各测一轮，对比 p50/p95。
set -euo pipefail

SEED_POINTS="${1:-5000}"
BENCH_POINT=9900001                 # 长历史点（730d raw）
TSDB_CONTAINER=thermio-bench-tsdb
TSDB_PORT=55433
TSDB_IMAGE=timescale/timescaledb:2.17.2-pg16   # 与伞仓 deploy compose 同版本
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
MIGRATIONS_DIR="${THERMIO_TSDB_MIGRATIONS_DIR:-${REPO_ROOT}/../thermio-ingest/db/migrations/tsdb}"
[ -d "$MIGRATIONS_DIR" ] || { echo "缺少 TSDB 迁移目录: $MIGRATIONS_DIR（clone thermio-ingest 或设 THERMIO_TSDB_MIGRATIONS_DIR）" >&2; exit 1; }

ADMIN_PW="$(openssl rand -hex 16)"
API_PW="$(openssl rand -hex 16)"
INGEST_PW="$(openssl rand -hex 16)"

# 容器内 psql：sql 走 stdin（psqlc <user> <password> [psql 参数…]）
psqlc() {
  local user="$1" pw="$2"; shift 2
  docker exec -i -e PGPASSWORD="$pw" "$TSDB_CONTAINER" psql -X -U "$user" -d thermio_ts "$@"
}

cleanup() { docker rm -f "$TSDB_CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

echo "==> 起 TSDB 容器 ${TSDB_CONTAINER}（${TSDB_IMAGE}，127.0.0.1:${TSDB_PORT}，一次性）"
docker run -d --name "$TSDB_CONTAINER" -e POSTGRES_PASSWORD="$ADMIN_PW" -e POSTGRES_DB=thermio_ts \
  -p 127.0.0.1:"$TSDB_PORT":5432 "$TSDB_IMAGE" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$TSDB_CONTAINER" pg_isready -U postgres -d thermio_ts >/dev/null 2>&1 && break
  sleep 1
done

echo "==> bootstrap 角色（ddl.md §10：先角色后迁移）+ 迁移链（${MIGRATIONS_DIR}）"
docker exec -i -e PGPASSWORD="$ADMIN_PW" "$TSDB_CONTAINER" psql -X -U postgres -d thermio_ts \
  -v ingest_password="$INGEST_PW" -v api_password="$API_PW" -v algo_password="$(openssl rand -hex 16)" \
  < "$MIGRATIONS_DIR/../../bootstrap/tsdb-roles.sql" >/dev/null
for f in "$MIGRATIONS_DIR"/[0-9]*.sql; do
  # goose 注解为注释；psql 直跑只取 Up 段（ddl.md §8 注）
  awk '/^-- \+goose Up/{flag=1;next} /^-- \+goose Down/{flag=0} flag' "$f" \
    | psqlc postgres "$ADMIN_PW" -v ON_ERROR_STOP=1 >/dev/null
done
psqlc postgres "$ADMIN_PW" -c "SELECT count(*) AS caggs FROM timescaledb_information.continuous_aggregates" | tail -3

echo "==> 灌数：单楼 ${SEED_POINTS} 点 × 24h × 1min + 长历史点 ${BENCH_POINT} × 730d × 1min"
psqlc postgres "$ADMIN_PW" -v ON_ERROR_STOP=1 <<SQL | grep -E '^INSERT' | tail -2
-- 单楼一天（点 9000001..9000000+N，值随点/分钟确定性变化，防常量折叠）
INSERT INTO telemetry (point_id, ts, value, value_text, quality)
SELECT 9000000 + p,
       date_trunc('minute', now()) - make_interval(mins => m),
       7 + ((p * 60 + m) % 100)::float8 / 10,
       NULL, 0
FROM generate_series(1, ${SEED_POINTS}) AS p, generate_series(1, 1440) AS m;
-- 长历史 730d（bench 点，含 quality≠0 与 value_text 混合行）
INSERT INTO telemetry (point_id, ts, value, value_text, quality)
SELECT ${BENCH_POINT},
       date_trunc('minute', now()) - make_interval(mins => m),
       7 + (m % 50)::float8 / 10,
       CASE WHEN m % 1000 = 0 THEN 'running' ELSE NULL END,
       CASE WHEN m % 500 = 0 THEN 4 ELSE 0 END
FROM generate_series(1, 60 * 24 * 730) AS m;
ANALYZE telemetry;
SQL

echo "==> 物化 cagg（策略 job 的 start_offset 5d 盖不住历史窗，手动全量刷新一次）"
psqlc postgres "$ADMIN_PW" -v ON_ERROR_STOP=1 -c \
  "CALL refresh_continuous_aggregate('telemetry_5min', NULL, NULL)" >/dev/null
psqlc postgres "$ADMIN_PW" -v ON_ERROR_STOP=1 -c \
  "CALL refresh_continuous_aggregate('telemetry_1h', NULL, NULL)" >/dev/null

# ── 查询集（与 telemetry-sql.ts 同形；游标位以首页 NULL 字面量代入）──────────
RAW_Q="SELECT ts, value, value_text, quality FROM telemetry
WHERE point_id = ${BENCH_POINT} AND ts >= now() - interval '31 days' AND ts < now()
  AND (NULL::timestamptz IS NULL OR ts > NULL::timestamptz) ORDER BY ts ASC LIMIT 201"
AGG5_Q="SELECT bucket, avg, min, max, last, stddev, sample_count, bad_count, quality_mask
FROM telemetry_5min WHERE point_id = ${BENCH_POINT}
  AND bucket >= now() - interval '730 days' AND bucket < now() ORDER BY bucket ASC LIMIT 201"
AGG1H_Q="SELECT bucket, avg, min, max, last, stddev, sample_count, bad_count, quality_mask
FROM telemetry_1h WHERE point_id = ${BENCH_POINT}
  AND bucket >= now() - interval '3650 days' AND bucket < now() ORDER BY bucket ASC LIMIT 201"
LATEST_Q="SELECT ts, value, value_text, quality FROM telemetry
WHERE point_id = ${BENCH_POINT} ORDER BY ts DESC LIMIT 1"
UPSERT_BATCH="INSERT INTO telemetry (point_id, ts, value, value_text, quality)
SELECT 9000000 + p, date_trunc('minute', now()), ((p * 7) % 100)::float8 / 10, NULL, 0
FROM generate_series(1, 100) AS p
ON CONFLICT (point_id, ts) DO UPDATE SET value = EXCLUDED.value, quality = EXCLUDED.quality"

stats() { sort -n | awk '{a[NR]=$1} END {printf "p50=%.1fms p95=%.1fms n=%d", a[int(NR*0.5)], a[int((NR*0.95)+0.999)], NR}'; }

run_ms() {  # run_ms <label> <repeats> <role: api|ingest> <sql>
  local label="$1" repeats="$2" role="$3" sql="$4" f pw user
  user="tsdb_${role}"
  pw="$([ "$role" = api ] && echo "$API_PW" || echo "$INGEST_PW")"
  f="$(mktemp)"
  for _ in $(seq 1 "$repeats"); do
    printf 'EXPLAIN (ANALYZE, TIMING OFF, COSTS OFF, SUMMARY ON) %s;' "$sql" \
      | psqlc "$user" "$pw" 2>/dev/null \
      | grep 'Execution Time' | grep -oE '[0-9]+\.[0-9]+' >> "$f" || echo 0 >> "$f"
  done
  echo "$label: $(stats <"$f")"
  rm -f "$f"
}

echo "==> 读基准（tsdb_api 角色，含只读授权验证）"
run_ms "Q1 latest            " 20 api "$LATEST_Q"
run_ms "Q2 raw 31d           " 20 api "$RAW_Q"
run_ms "Q3 5min 730d         " 20 api "$AGG5_Q"
run_ms "Q4 1h 3650d(730d数据)" 20 api "$AGG1H_Q"

echo "==> 写路径基线（tsdb_ingest，无读并发）：批量 upsert 100 点/批 × 60"
run_ms "W  baseline          " 60 ingest "$UPSERT_BATCH"

echo "==> 写路径 × 读并发：writer 60 批 与 Q3 读循环（各 60 次）并行"
wf="$(mktemp)"; rf="$(mktemp)"
( for _ in $(seq 1 60); do
    printf 'EXPLAIN (ANALYZE, TIMING OFF, COSTS OFF, SUMMARY ON) %s;' "$UPSERT_BATCH" \
      | psqlc tsdb_ingest "$INGEST_PW" 2>/dev/null \
      | grep 'Execution Time' | grep -oE '[0-9]+\.[0-9]+' >> "$wf" || echo 0 >> "$wf"
  done ) &
WRITER_PID=$!
for _ in $(seq 1 60); do
  printf 'EXPLAIN (ANALYZE, TIMING OFF, COSTS OFF, SUMMARY ON) %s;' "$AGG5_Q" \
    | psqlc tsdb_api "$API_PW" 2>/dev/null \
    | grep 'Execution Time' | grep -oE '[0-9]+\.[0-9]+' >> "$rf" || echo 0 >> "$rf"
done
wait "$WRITER_PID"
echo "W  under read-load:   $(stats <"$wf")"
echo "Q3 under write-load:  $(stats <"$rf")"
rm -f "$wf" "$rf"

echo "==> 执行计划留档（形状：raw 走 hypertable、5min 走 cagg）"
printf 'EXPLAIN (COSTS OFF) %s;' "$RAW_Q" | psqlc tsdb_api "$API_PW" | sed -n '3,5p'
printf 'EXPLAIN (COSTS OFF) %s;' "$AGG5_Q" | psqlc tsdb_api "$API_PW" | sed -n '3,5p'

echo "==> 完成，容器已清理（trap）"
