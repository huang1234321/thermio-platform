/**
 * M3 监控纯函数单测（M3-monitor §3.1/§3.2/§3.5 判定矩阵，IMPL-14）：
 * run_state 判定（running 优先 / fault=open 告警且非 running）/ key_points 选取与 ≤5 /
 * 能耗窗口差值 / 负荷率容量加权 / SSE 变更点 diff / point_ids csv 解析上限。
 */
import { describe, expect, it } from 'vitest';
import { ReasonCodeException } from '../src/infrastructure/errors/reason-code.exception.js';
import { buildWindowEndpointsQuery } from '../src/telemetry/telemetry-sql.js';
import { parsePointIdsCsv } from '../src/monitor/monitor.controller.js';
import {
  diffChangedPoints,
  evaluateRunState,
  foldOpenBySeverity,
  pickKeyPoints,
  ratedCoolingCapacityKw,
  sumEnergyDeltas,
  toSnapshotMap,
  weightedLoadRate,
  worstSeverity,
  type StreamPointSnapshot,
} from '../src/monitor/run-state.js';

const sample = (ts: string, value: number | null, value_text: string | null = null) => ({
  ts,
  value,
  value_text,
  quality: 0,
});

describe('run_state 判定（§3.2）', () => {
  it('running 优先于告警（value_text=1 恒 running）', () => {
    expect(evaluateRunState(sample('t', null, '1'), true)).toBe('running');
  });
  it('fault = 存在 open 告警且非 running', () => {
    expect(evaluateRunState(sample('t', null, '0'), true)).toBe('fault');
    expect(evaluateRunState(null, true)).toBe('fault');
  });
  it('standby = value_text=0 且无告警', () => {
    expect(evaluateRunState(sample('t', null, '0'), false)).toBe('standby');
  });
  it('unknown = 无点位/无数据且无告警', () => {
    expect(evaluateRunState(null, false)).toBe('unknown');
    expect(evaluateRunState(sample('t', null, '2'), false)).toBe('unknown');
  });
});

describe('告警聚合', () => {
  it('worstSeverity 取最严级（空集 null）', () => {
    expect(worstSeverity([])).toBeNull();
    expect(worstSeverity(['info', 'major', 'warning'])).toBe('major');
    expect(worstSeverity(['critical', 'major'])).toBe('critical');
  });
  it('foldOpenBySeverity 折叠五级计数（未知 severity 忽略不崩）', () => {
    const record = foldOpenBySeverity([
      { severity: 'major', count: 2 },
      { severity: 'major', count: 1 },
      { severity: 'critical', count: 1 },
      { severity: 'bogus', count: 9 },
    ]);
    expect(record).toEqual({ info: 0, warning: 0, minor: 0, major: 3, critical: 1 });
  });
});

describe('KPI 能耗与负荷率（§3.1 拍板 3）', () => {
  it('sumEnergyDeltas = Σ(last−first)；空集 null', () => {
    expect(sumEnergyDeltas(new Map())).toBeNull();
    const endpoints = new Map([
      [1, { first: 100, last: 150 }],
      [2, { first: 10, last: 35 }],
    ]);
    expect(sumEnergyDeltas(endpoints)).toBe(75);
  });

  it('ratedCoolingCapacityKw 匹配铭牌制冷量键（大小写/命名宽容，无则 null）', () => {
    expect(ratedCoolingCapacityKw(null)).toBeNull();
    expect(ratedCoolingCapacityKw({ vendor: 'x' })).toBeNull();
    expect(ratedCoolingCapacityKw({ rated_cooling_capacity_kw: 1200 })).toBe(1200);
    expect(ratedCoolingCapacityKw({ CoolingCapacity: 900 })).toBe(900);
    expect(ratedCoolingCapacityKw({ cooling_capacity_kwr: -1 })).toBeNull();
  });

  it('weightedLoadRate = Σ(load×cap)/Σcap；等权当 cap=1；空集 null', () => {
    expect(weightedLoadRate([])).toBeNull();
    expect(
      weightedLoadRate([
        { pct: 80, weight: 2 },
        { pct: 40, weight: 1 },
      ]),
    ).toBeCloseTo((80 * 2 + 40) / 3);
    expect(
      weightedLoadRate([
        { pct: 60, weight: 1 },
        { pct: 80, weight: 1 },
      ]),
    ).toBe(70);
  });
});

describe('key_points 选取（§3.2：run_status 全集 + 首条 temp/power，≤5）', () => {
  const point = (id: number, quantity_type: string) => ({
    point_id: id,
    display_name: `p${String(id)}`,
    quantity_type,
    unit_std: null,
  });

  it('run_status 全收 + chw_supply_temp/power 各首条', () => {
    const picked = pickKeyPoints([
      point(1, 'run_status'),
      point(2, 'power'),
      point(3, 'chw_supply_temp'),
      point(4, 'power'),
    ]);
    expect(picked.map((p) => p.point_id)).toEqual([1, 3, 2]);
  });

  it('封顶 5（run_status 优先占位）', () => {
    const picked = pickKeyPoints([
      point(1, 'run_status'),
      point(2, 'run_status'),
      point(3, 'run_status'),
      point(4, 'run_status'),
      point(5, 'chw_supply_temp'),
      point(6, 'power'),
    ]);
    expect(picked.map((p) => p.point_id)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('SSE 变更点 diff（§3.5 快照批量语义）', () => {
  const snapshot = (point_id: number, ts: string, value: number | null): StreamPointSnapshot => ({
    point_id,
    ts,
    value,
    value_text: null,
    quality: 0,
  });

  it('新见点视为变更（首帧快照）；未变点不重发', () => {
    const before = new Map([[1, snapshot(1, 't1', 7.5)]]);
    const after = new Map([
      [1, snapshot(1, 't1', 7.5)],
      [2, snapshot(2, 't2', 3)],
    ]);
    expect(diffChangedPoints(before, after)).toEqual([snapshot(2, 't2', 3)]);
  });

  it('ts/value/value_text/quality 任一变化即变更', () => {
    const before = new Map([[1, snapshot(1, 't1', 7.5)]]);
    expect(diffChangedPoints(before, new Map([[1, snapshot(1, 't2', 7.5)]]))).toHaveLength(1);
    expect(diffChangedPoints(before, new Map([[1, snapshot(1, 't1', 8.0)]]))).toHaveLength(1);
    expect(diffChangedPoints(before, new Map([[1, snapshot(1, 't1', 7.5)]]))).toHaveLength(0);
  });

  it('toSnapshotMap 丢掉无 latest 的点（不推送无数据点）', () => {
    const map = toSnapshotMap(new Map([[1, sample('t1', 1)]]));
    expect(map.size).toBe(1);
  });
});

describe('point_ids csv 解析（§3.6/SSE 上限）', () => {
  it('常规解析 + 去空白', () => {
    expect(parsePointIdsCsv(' 1, 2 ,3')).toEqual([1, 2, 3]);
  });
  it('缺失/空串 → 422', () => {
    expect(() => parsePointIdsCsv(undefined)).toThrow(ReasonCodeException);
    expect(() => parsePointIdsCsv(' ')).toThrow(ReasonCodeException);
  });
  it('非整数 → 422', () => {
    expect(() => parsePointIdsCsv('1,abc')).toThrow(ReasonCodeException);
  });
  it('>500 → 400 stream.limit_exceeded（整单拒绝）', () => {
    const csv = Array.from({ length: 501 }, (_, i) => String(i + 1)).join(',');
    try {
      parsePointIdsCsv(csv);
      expect.unreachable('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ReasonCodeException);
      expect((err as ReasonCodeException).reasonCode).toBe('stream.limit_exceeded');
    }
  });
});

describe('能量窗口首末值 SQL（§3.1 数据面）', () => {
  it('窗口 [from,to) + value 非空 + GROUP BY point_id', () => {
    const query = buildWindowEndpointsQuery([1, 2], '2026-09-27T00:00:00Z', '2026-09-28T00:00:00Z');
    expect(query.text).toContain('ts >= $2 AND ts < $3');
    expect(query.text).toContain('value IS NOT NULL');
    expect(query.text).toContain('GROUP BY point_id');
    expect(query.values).toEqual([[1, 2], '2026-09-27T00:00:00Z', '2026-09-28T00:00:00Z']);
  });
});
