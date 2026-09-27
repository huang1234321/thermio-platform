/**
 * 绑定求值引擎单测（M3-monitor §6 / ui/viz-3d.md §8 求值矩阵）：
 * 三类直接绑定、threshold / alarm-linked 规则、告警直映射、parent 链传播、
 * stale / unknown、run_state 求值式（fault = open 告警且非 running）。
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateScene,
  maxHighlightLevel,
  resolveEquipmentRunState,
  type AlarmEntry,
  type LatestValue,
  type SceneConfigInput,
} from './index.js';

const NOW = Date.parse('2026-09-27T08:00:00Z');

function latest(overrides: Partial<LatestValue> = {}): LatestValue {
  return {
    value: 1,
    value_text: null,
    ts: new Date(NOW - 1000).toISOString(),
    quality: 0,
    ...overrides,
  };
}

function store(entries: Record<number, LatestValue>): Map<number, LatestValue> {
  return new Map(Object.entries(entries).map(([id, value]) => [Number(id), value]));
}

describe('evaluateScene · 直接绑定', () => {
  const config: SceneConfigInput = {
    bindings: [
      { slot: 'CH-01:run', point_id: 101, kind: 'state-run' },
      { slot: 'CT-02:fan', point_id: 201, kind: 'motion-fan', rad_s_per_hz: 0.02 },
      { slot: 'CH-01:power', point_id: 301, kind: 'value-text', fmt: 'int', unit: 'kW' },
    ],
    highlight_rules: [],
  };

  it('state-run 默认枚举映射 + motion-fan 换算 + value-text 格式化', () => {
    const result = evaluateScene(
      config,
      store({
        101: latest({ value: null, value_text: '1' }),
        201: latest({ value: 12.5, value_text: null }),
        301: latest({ value: 236.4 }),
      }),
      [],
      { nowMs: NOW, staleTimeoutS: 30 },
    );
    expect(result.states['CH-01']).toBe('running');
    expect(result.fanSpeeds['CT-02']).toBeCloseTo(0.25);
    expect(result.values['CH-01:power']).toMatchObject({
      text: '236',
      unit: 'kW',
      stale: false,
      unknown: false,
    });
  });

  it('缺值不阻塞其余绑定：state-run 缺 → 对象无条目（引擎 standby 兜底）；value-text → unknown', () => {
    const result = evaluateScene(config, store({}), [], { nowMs: NOW, staleTimeoutS: 30 });
    expect('CH-01' in result.states).toBe(false);
    expect('CT-02' in result.fanSpeeds).toBe(false);
    expect(result.values['CH-01:power']).toMatchObject({ text: null, unknown: true });
  });

  it('超 stale_timeout → stale（quality 判定独立）', () => {
    const result = evaluateScene(
      config,
      store({ 301: latest({ value: 100, ts: new Date(NOW - 61_000).toISOString() }) }),
      [],
      { nowMs: NOW, staleTimeoutS: 30 },
    );
    expect(result.values['CH-01:power']).toMatchObject({ stale: true, text: '100' });
  });
});

describe('evaluateScene · 高亮规则', () => {
  it('threshold 越限命中（value-text 槽直判）', () => {
    const config: SceneConfigInput = {
      bindings: [
        { slot: 'CH-01:power', point_id: 301, kind: 'value-text', fmt: 'int', unit: 'kW' },
      ],
      highlight_rules: [
        { kind: 'threshold', slot: 'CH-01:power', op: '>', threshold: 250, level: 'warning' },
      ],
    };
    const hot = evaluateScene(config, store({ 301: latest({ value: 260 }) }), [], {
      nowMs: NOW,
      staleTimeoutS: 30,
    });
    expect(hot.highlights['CH-01']).toBe('warning');
    const cold = evaluateScene(config, store({ 301: latest({ value: 200 }) }), [], {
      nowMs: NOW,
      staleTimeoutS: 30,
    });
    expect('CH-01' in cold.highlights).toBe(false);
  });

  it('多规则取最严：threshold warning + alarm-linked alarm → alarm', () => {
    const config: SceneConfigInput = {
      bindings: [{ slot: 'CH-01:power', point_id: 301, kind: 'value-text', fmt: 'int' }],
      highlight_rules: [
        { kind: 'threshold', slot: 'CH-01:power', op: '>', threshold: 250, level: 'warning' },
        { kind: 'alarm-linked', object_ids: ['CH-01'], level: 'alarm' },
      ],
    };
    const alarms: AlarmEntry[] = [{ id: 'AL-1', severity: 'major', object_ids: ['CH-01'] }];
    const result = evaluateScene(config, store({ 301: latest({ value: 300 }) }), alarms, {
      nowMs: NOW,
      staleTimeoutS: 30,
    });
    expect(result.highlights['CH-01']).toBe('alarm');
  });

  it('告警直映射：info/warning → warning；minor/major/critical → alarm', () => {
    const alarms: AlarmEntry[] = [
      { id: 'AL-1', severity: 'warning', object_ids: ['CT-01'] },
      { id: 'AL-2', severity: 'critical', object_ids: ['CT-02'] },
    ];
    const result = evaluateScene({ bindings: [], highlight_rules: [] }, store({}), alarms, {
      nowMs: NOW,
      staleTimeoutS: 30,
    });
    expect(result.highlights['CT-01']).toBe('warning');
    expect(result.highlights['CT-02']).toBe('alarm');
  });

  it('parent 链向上传播（阀门 → 泵 → …），guard 防环', () => {
    const alarms: AlarmEntry[] = [{ id: 'AL-1', severity: 'minor', object_ids: ['V-CHWP-01'] }];
    const result = evaluateScene({ bindings: [], highlight_rules: [] }, store({}), alarms, {
      nowMs: NOW,
      staleTimeoutS: 30,
      parents: { 'V-CHWP-01': 'CHWP-01', CHWP01: 'PLANT', 'CHWP-01': 'PLANT' },
    });
    expect(result.highlights['CHWP-01']).toBe('alarm');
    expect(result.highlights['PLANT']).toBe('alarm');
  });
});

describe('resolveEquipmentRunState（M3-monitor §3.2）', () => {
  it('fault = 存在 open 告警且非 running', () => {
    expect(resolveEquipmentRunState({ raw: '1', hasOpenAlarm: true })).toBe('running');
    expect(resolveEquipmentRunState({ raw: '0', hasOpenAlarm: true })).toBe('fault');
    expect(resolveEquipmentRunState({ raw: '0', hasOpenAlarm: false })).toBe('standby');
    expect(resolveEquipmentRunState({ raw: null, hasOpenAlarm: true })).toBe('unknown');
  });
});

describe('maxHighlightLevel', () => {
  it('空集 → null；多源取最严', () => {
    expect(maxHighlightLevel([])).toBeNull();
    expect(maxHighlightLevel(['warning', 'warning'])).toBe('warning');
    expect(maxHighlightLevel(['warning', 'alarm'])).toBe('alarm');
  });
});
