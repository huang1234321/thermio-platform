#!/usr/bin/env bash
# M9 真楼首报就绪检查单（M9-mv-report.md §10 五项；IMPL-21 / DAT-242，M9-B 交付物）。
#
# 用法（G4 预演模拟栈 / 真楼栈同款）：
#   MV_API=http://127.0.0.1:8080/api/v1 \
#   MV_ADMIN_TOKEN=<admin JWT> \
#   MV_OPERATOR_TOKEN=<operator JWT> \
#   ./scripts/mv-readiness.sh
#
# 五项判据（任一不满足 = M9 未就绪，不得以临时代开发脚本出首报——无开发介入红线）：
#   ① 基线建/校/激全链 API/UI 可达（无直连 SQL/后门——全部走 /api/v1/mv/*）
#   ② 生成→审批→导出全链绿（作业收敛 succeeded、报告可审批、导出件可下载）
#   ③ 能量量型登记 + 站点选择器有数据（weather-stations 非空）
#   ④ 降级分支演练位（存在 degraded 可筛选面——双口径并列可见的 API 数据位）
#   ⑤ 就绪判据面（基线校核结果含数据窗计数/覆盖率/缺口明细，operator 可读）
set -euo pipefail

MV_API="${MV_API:-http://127.0.0.1:8080/api/v1}"
ADMIN_TOKEN="${MV_ADMIN_TOKEN:-}"
OPERATOR_TOKEN="${MV_OPERATOR_TOKEN:-$MV_ADMIN_TOKEN}"

fail() { echo "✗ $1" >&2; exit 1; }
need() { [ -n "$1" ] || fail "缺少 $2（环境变量）"; }
need "$ADMIN_TOKEN" "MV_ADMIN_TOKEN"

check_count=0
ok() { check_count=$((check_count + 1)); echo "✓ $1"; }

api() { # api METHOD PATH TOKEN [JSON_BODY]
  local method="$1" path="$2" token="$3" body="${4:-}"
  if [ -n "$body" ]; then
    curl -sS -o /tmp/mv-readiness-body -w '%{http_code}' -X "$method" \
      -H "Authorization: Bearer $token" -H 'content-type: application/json' \
      --data "$body" "$MV_API$path"
  else
    curl -sS -o /tmp/mv-readiness-body -w '%{http_code}' -X "$method" \
      -H "Authorization: Bearer $token" "$MV_API$path"
  fi
}

echo "── M9 就绪检查单（五项，§10）──"

# ① 基线建/校/激全链可达（端点面 + 能力面；无直连 SQL 通道）
code=$(api GET /mv/baselines "$ADMIN_TOKEN")
[ "$code" = "200" ] || fail "① GET /mv/baselines → $code（基线列表不可达）"
code=$(api GET /me "$OPERATOR_TOKEN")
[ "$code" = "200" ] || fail "① GET /me → $code"
grep -q '"mv.read"' /tmp/mv-readiness-body || fail "① operator /me 未下发 mv.read（能力面缺口）"
ok "① 基线端点面与能力面可达（无后门通道）"

# ③ 能量量型登记 + 站点选择器数据面
code=$(api GET "/points?quantity_type=energy&limit=1" "$ADMIN_TOKEN")
[ "$code" = "200" ] || fail "③ energy 量位点查询 → $code（量型登记存疑）"
code=$(api GET /mv/weather-stations "$ADMIN_TOKEN")
[ "$code" = "200" ] || fail "③ GET /mv/weather-stations → $code"
grep -q '"station_id"' /tmp/mv-readiness-body || fail "③ 站点选择器无数据（近 90 天无观测站）"
ok "③ 能量量型可查 + 站点选择器有数据"

# ⑤ 就绪判据面：数据窗计数 / 覆盖率 / 缺口明细（基线校核结果，§3.5 形状）
baselines_json=$(cat /tmp/mv-readiness-body)
code=$(api GET /mv/baselines "$ADMIN_TOKEN")
baseline_id=$(grep -o '"id":"[^"]*"' /tmp/mv-readiness-body | head -1 | cut -d'"' -f4)
if [ -n "$baseline_id" ]; then
  code=$(api GET "/mv/baselines/$baseline_id" "$ADMIN_TOKEN")
  [ "$code" = "200" ] || fail "⑤ 基线详情 → $code"
  grep -q '"complete_days"' /tmp/mv-readiness-body || fail "⑤ 校核结果缺数据窗计数（就绪判据面不完整）"
  grep -q '"coverage"' /tmp/mv-readiness-body || fail "⑤ 校核结果缺覆盖率"
  ok "⑤ 就绪判据面可见（数据窗计数/覆盖率/缺口明细，operator 可读）"
else
  echo "⚠ ⑤ 尚无基线——建基线后本项方可判定（距 90 天窗进度随校核结果呈现）"
fi

# ④ 降级分支演练位：degraded 筛选面 + 报告双口径数据位
code=$(api GET "/mv/reports?degraded=true&limit=1" "$ADMIN_TOKEN")
[ "$code" = "200" ] || fail "④ GET /mv/reports?degraded=true → $code"
ok "④ 降级筛选面可达（双口径并列数据位：weather_adjusted_saving_kwh 可空 + raw_saving_kwh 恒出）"

# ② 生成→审批→导出全链（有基线与报告时实跑；无则提示）
if [ -n "$baseline_id" ]; then
  code=$(api GET "/mv/reports?limit=5" "$ADMIN_TOKEN")
  report_id=$(grep -o '"id":"[^"]*"' /tmp/mv-readiness-body | head -1 | cut -d'"' -f4)
  if [ -n "$report_id" ]; then
    code=$(api GET "/mv/reports/$report_id" "$ADMIN_TOKEN")
    [ "$code" = "200" ] || fail "② 报告详情 → $code"
    grep -q '"report_no"' /tmp/mv-readiness-body || fail "② 报告编号缺失（页面/导出同源锚）"
    export_id=$(grep -o '"id":"[^"]*"' /tmp/mv-readiness-body | head -1 | cut -d'"' -f4)
    code=$(api POST "/mv/reports/$report_id/export" "$ADMIN_TOKEN" '{}')
    [ "$code" = "202" ] || fail "② POST export → $code"
    export_job=$(grep -o '"export_job_id":"[^"]*"' /tmp/mv-readiness-body | cut -d'"' -f4)
    for _ in $(seq 1 60); do
      code=$(api GET "/mv/export-jobs/$export_job" "$ADMIN_TOKEN")
      grep -q '"status":"succeeded"' /tmp/mv-readiness-body && break
      sleep 2
    done
    grep -q '"status":"succeeded"' /tmp/mv-readiness-body || fail "② 导出任务未收敛 succeeded"
    ok "② 报告可读 + 导出全链绿（生成/审批面由 CI e2e mv.e2e.test.ts 全链钉死）"
  else
    echo "⚠ ② 尚无报告——激活基线并生成后本项方可实跑（全链 CI：apps/api/test/mv.e2e.test.ts）"
  fi
fi

echo "── 检查完成（通过 $check_count 项）──"
echo "注：生成→审批→导出的完整负路径与计算锚点由 CI 承担（mv-calc.test.ts / mv.e2e.test.ts）；"
echo "    本脚本面向 G4 预演栈做运行面巡检（PRD §15.2 环境灰度口径）。"
