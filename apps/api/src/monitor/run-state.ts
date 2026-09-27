/**
 * M3 监控求值纯函数（M3-monitor §3.1/§3.2/§3.5，IMPL-14）：
 * run_state 判定 / 告警最严重级 / KPI 能耗与负荷率聚合 / SSE 变更点 diff。
 *
 * 纯函数不触 Nest DI（telemetry-sql 同款纪律）：单测直接覆盖判定矩阵，
 * 服务层只做编排（PG 资产 + TSDB latest 批量 + 告警计数）。
 */
import type {
  AlarmSeverity,
  MonitorKeyPoint,
  MonitorRunState,
  TelemetryRawSample,
} from '@thermio/shared-types';
import { ALARM_SEVERITIES } from '@thermio/shared-types';

/** severity 严重度序（大 = 严；alarm_worst / 排序用）。 */
const SEVERITY_RANK: Readonly<Record<AlarmSeverity, number>> = {
  info: 1,
  warning: 2,
  minor: 3,
  major: 4,
  critical: 5,
};

/** 空的 open_by_severity 骨架（五级全零——响应形状稳定，UI 不做缺键推断）。 */
export function emptyOpenBySeverity(): Record<AlarmSeverity, number> {
  return { info: 0, warning: 0, minor: 0, major: 0, critical: 0 };
}

/** 计数折叠（severity → count 行集 → 五级 record）。 */
export function foldOpenBySeverity(
  rows: ReadonlyArray<{ severity: string; count: number }>,
): Record<AlarmSeverity, number> {
  const record = emptyOpenBySeverity();
  for (const row of rows) {
    if ((ALARM_SEVERITIES as readonly string[]).includes(row.severity)) {
      record[row.severity as AlarmSeverity] += row.count;
    }
  }
  return record;
}

/** 告警最严重级（空集 → null）。 */
export function worstSeverity(severities: readonly string[]): AlarmSeverity | null {
  let worst: AlarmSeverity | null = null;
  for (const severity of severities) {
    if (
      (ALARM_SEVERITIES as readonly string[]).includes(severity) &&
      (worst === null || SEVERITY_RANK[severity as AlarmSeverity] > SEVERITY_RANK[worst])
    ) {
      worst = severity as AlarmSeverity;
    }
  }
  return worst;
}

/**
 * run_state 判定（§3.2：running = run_status 最新值 value_text='1'；
 * fault = 存在 open 告警且非 running——running 优先；standby = '0'；其余 unknown）。
 */
export function evaluateRunState(
  latest: TelemetryRawSample | null,
  hasOpenAlarm: boolean,
): MonitorRunState {
  if (latest?.value_text === '1') return 'running';
  if (hasOpenAlarm) return 'fault';
  if (latest?.value_text === '0') return 'standby';
  return 'unknown';
}

/**
 * KPI 能耗聚合（§3.1：能量累计类点位窗口 raw 首末差值，Σ(last−first)）。
 * 空集/无数据 → null（卡片「—」）。表计翻转（last<first）按字面差值计入——
 * 翻转保护属 P1 数据治理，边界在交付说明注记。
 */
export function sumEnergyDeltas(
  endpoints: ReadonlyMap<number, { first: number; last: number }>,
): number | null {
  if (endpoints.size === 0) return null;
  let sum = 0;
  for (const { first, last } of endpoints.values()) {
    sum += last - first;
  }
  return sum;
}

/** 铭牌制冷量权重（拍板 3：cap 取 rated_params 制冷量；无铭牌容量 → null（等权由调用方兜底））。 */
export function ratedCoolingCapacityKw(ratedParams: Record<string, unknown> | null): number | null {
  if (ratedParams === null) return null;
  for (const [key, value] of Object.entries(ratedParams)) {
    // 键名随厂商（rated_params 自由结构）：归一化小写去分隔符后含 coolingcap 即认（cooling_capacity_kw/CoolingCapacity/…）
    const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
    if (
      normalized.includes('coolingcap') &&
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value > 0
    ) {
      return value;
    }
  }
  return null;
}

/**
 * 负荷率容量加权（§3.1 拍板 3：Σ(loadᵢ×capᵢ)/Σcapᵢ，仅运行机组；等权当 cap=1）。
 * 无参与机组 → null（点位在但暂无数据 =「—」；点位不在 = load_rate_linked=false）。
 */
export function weightedLoadRate(
  units: ReadonlyArray<{ pct: number; weight: number }>,
): number | null {
  if (units.length === 0) return null;
  let weighted = 0;
  let weights = 0;
  for (const unit of units) {
    const weight = unit.weight > 0 ? unit.weight : 1;
    weighted += unit.pct * weight;
    weights += weight;
  }
  return weights > 0 ? weighted / weights : null;
}

/** key_points 装配（§3.2：run_status 全集 + 首条 chw_supply_temp + 首条 power，去重 ≤5）。 */
export function pickKeyPoints(
  points: ReadonlyArray<{
    point_id: number;
    display_name: string | null;
    quantity_type: string | null;
    unit_std: string | null;
  }>,
): Array<{
  point_id: number;
  display_name: string | null;
  quantity_type: string | null;
  unit_std: string | null;
}> {
  const picked: (typeof points)[number][] = [];
  const seen = new Set<number>();
  const take = (
    quantityType: 'run_status' | 'chw_supply_temp' | 'power',
    firstOnly: boolean,
  ): void => {
    for (const point of points) {
      if (picked.length >= 5) return;
      if (point.quantity_type !== quantityType || seen.has(point.point_id)) continue;
      picked.push(point);
      seen.add(point.point_id);
      if (firstOnly) return;
    }
  };
  take('run_status', false);
  take('chw_supply_temp', true);
  take('power', true);
  return picked.slice(0, 5);
}

/** SSE 推送载荷点（value/value_text/quality 快照 + ts）。 */
export interface StreamPointSnapshot {
  readonly point_id: number;
  readonly ts: string;
  readonly value: number | null;
  readonly value_text: string | null;
  readonly quality: number;
}

/**
 * 节流窗口变更点 diff（§3.5：窗口内全部变更点的最新值快照批量）。
 * 变更判据 = (ts, value, value_text, quality) 任一不同；新见点视为变更（首帧即快照）。
 */
export function diffChangedPoints(
  previous: ReadonlyMap<number, StreamPointSnapshot>,
  current: ReadonlyMap<number, StreamPointSnapshot>,
): StreamPointSnapshot[] {
  const changed: StreamPointSnapshot[] = [];
  for (const [pointId, snapshot] of current) {
    const before = previous.get(pointId);
    if (
      before === undefined ||
      before.ts !== snapshot.ts ||
      before.value !== snapshot.value ||
      before.value_text !== snapshot.value_text ||
      before.quality !== snapshot.quality
    ) {
      changed.push(snapshot);
    }
  }
  return changed;
}

/** latest 批量映射 → SSE 快照集（无数据点不推送——latest 值语义）。 */
export function toSnapshotMap(
  latest: ReadonlyMap<number, TelemetryRawSample>,
): Map<number, StreamPointSnapshot> {
  const snapshots = new Map<number, StreamPointSnapshot>();
  for (const [pointId, sample] of latest) {
    snapshots.set(pointId, {
      point_id: pointId,
      ts: sample.ts,
      value: sample.value,
      value_text: sample.value_text,
      quality: sample.quality,
    });
  }
  return snapshots;
}

/** key_points 装配终态（latest 批量映射 → MonitorKeyPoint；无数据 latest=null）。 */
export function withKeyPointLatest(
  points: ReadonlyArray<{
    point_id: number;
    display_name: string | null;
    quantity_type: string | null;
    unit_std: string | null;
  }>,
  latest: ReadonlyMap<number, TelemetryRawSample>,
): MonitorKeyPoint[] {
  return points.map((point) => {
    const sample = latest.get(point.point_id);
    return {
      ...point,
      latest:
        sample === undefined
          ? null
          : {
              ts: sample.ts,
              value: sample.value,
              value_text: sample.value_text,
              quality: sample.quality,
            },
    };
  });
}
