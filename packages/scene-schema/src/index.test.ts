/**
 * scene-schema 契约单测：绑定 kind 收窄（superRefine）、slot 语法、config 预算、
 * SceneDetail / 签名资产、kind ↔ 设备类型映射、严重度序。
 */
import { describe, expect, it } from 'vitest';
import {
  CIRCUITS,
  CIRCUIT_KEYS,
  SceneConfigSchema,
  SceneDetailSchema,
  manifestKindToEquipmentType,
  severityRank,
  worstSeverity,
} from './index.js';

const UUID_A = '0b8f6c1e-1111-4c2a-9d3e-aaaaaaaaaaaa';
const UUID_B = '0b8f6c1e-2222-4c2a-9d3e-bbbbbbbbbbbb';

const bindingBase = {
  slot: 'CH-01:run',
  point_id: 101,
};

describe('SceneBindingSchema · kind 收窄', () => {
  it('state-run 缺 enum → 拒绝；带 enum → 通过', () => {
    expect(
      SceneConfigSchema.safeParse({
        bindings: [{ ...bindingBase, kind: 'state-run' }],
        highlight_rules: [],
        views: [],
      }).success,
    ).toBe(false);
    expect(
      SceneConfigSchema.safeParse({
        bindings: [{ ...bindingBase, kind: 'state-run', enum: { '1': 'running', '0': 'standby' } }],
        highlight_rules: [],
        views: [],
      }).success,
    ).toBe(true);
  });

  it('value-text 缺 fmt/unit → 拒绝', () => {
    expect(
      SceneConfigSchema.safeParse({
        bindings: [{ ...bindingBase, kind: 'value-text', fmt: 'int' }],
        highlight_rules: [],
        views: [],
      }).success,
    ).toBe(false);
    expect(
      SceneConfigSchema.safeParse({
        bindings: [{ ...bindingBase, kind: 'value-text', fmt: 'int', unit: 'kW' }],
        highlight_rules: [],
        views: [],
      }).success,
    ).toBe(true);
  });

  it('motion-fan 缺 rad_s_per_hz → 拒绝', () => {
    expect(
      SceneConfigSchema.safeParse({
        bindings: [{ ...bindingBase, kind: 'motion-fan' }],
        highlight_rules: [],
        views: [],
      }).success,
    ).toBe(false);
  });

  it('slot 语法 {objectId}:{semantic} 强制', () => {
    expect(
      SceneConfigSchema.safeParse({
        bindings: [{ slot: 'CH-01', point_id: 1, kind: 'state-run', enum: { '1': 'running' } }],
        highlight_rules: [],
        views: [],
      }).success,
    ).toBe(false);
  });

  it('bindings 预算 ≤500（platform §12 单连接订阅上限）', () => {
    const binding = { slot: 'CH-01:run', point_id: 1, kind: 'state-run', enum: { '1': 'running' } };
    expect(
      SceneConfigSchema.safeParse({
        bindings: Array.from({ length: 501 }, () => binding),
        highlight_rules: [],
        views: [],
      }).success,
    ).toBe(false);
    expect(
      SceneConfigSchema.safeParse({
        bindings: Array.from({ length: 500 }, () => binding),
        highlight_rules: [],
        views: [],
      }).success,
    ).toBe(true);
  });
});

describe('SceneDetailSchema', () => {
  const detail = {
    id: UUID_A,
    building_id: UUID_B,
    system_id: UUID_A,
    name: '能源站 3D 总览',
    kind: '3d',
    template: { id: 'hvac-plant-v1', version: 1, variant_key: 'base' },
    assets: {
      model: {
        asset_id: 'model',
        url: 'https://oss.example.com/plant.glb?sig=1',
        bytes: 1558636,
        sha256: '07e62463ddabe21b7174d326fc6ef51245c968f3ec81b5a29b86fb096c3812fb',
        expires_at: '2026-09-27T09:00:00+00:00',
      },
      manifest: {
        asset_id: 'manifest',
        url: 'https://oss.example.com/manifest.json?sig=1',
        expires_at: '2026-09-27T09:00:00+00:00',
      },
    },
    config: { bindings: [], highlight_rules: [], views: [] },
    created_at: '2026-09-27T08:00:00+00:00',
    updated_at: '2026-09-27T08:00:00+00:00',
  };

  it('3D 场景带签名资产通过；sha256 非 64 hex → 拒绝', () => {
    expect(SceneDetailSchema.safeParse(detail).success).toBe(true);
    const bad = structuredClone(detail);
    bad.assets.model.sha256 = 'not-hex';
    expect(SceneDetailSchema.safeParse(bad).success).toBe(false);
  });

  it('2D 模板场景 assets 可为 null', () => {
    const plan2d = { ...detail, kind: '2d', assets: null };
    expect(SceneDetailSchema.safeParse(plan2d).success).toBe(true);
  });
});

describe('常量与映射', () => {
  it('四回路（demo 同源）', () => {
    expect(CIRCUIT_KEYS).toEqual(['CHWS', 'CHWR', 'CWS', 'CWR']);
    expect(CIRCUITS.CHWS.name).toBe('冷冻供水');
  });

  it('manifest kind → EQUIPMENT_TYPES：pump 按回路分流；结构对象 → null', () => {
    expect(manifestKindToEquipmentType('chiller', 'CHW')).toBe('chiller');
    expect(manifestKindToEquipmentType('pump', 'CHW')).toBe('chwp_pump');
    expect(manifestKindToEquipmentType('pump', 'CW')).toBe('cwp_pump');
    expect(manifestKindToEquipmentType('tower', 'CW')).toBe('cooling_tower');
    expect(manifestKindToEquipmentType('valve', null)).toBe('valve');
    expect(manifestKindToEquipmentType('pipe', 'CHWS')).toBeNull();
    expect(manifestKindToEquipmentType('foundation', null)).toBeNull();
  });

  it('severityRank / worstSeverity（越大越严）', () => {
    expect(worstSeverity(['info', 'warning', 'minor'])).toBe('minor');
    expect(worstSeverity(['critical', 'info'])).toBe('critical');
    expect(worstSeverity([])).toBeNull();
    expect(severityRank('critical')).toBeGreaterThan(severityRank('warning'));
  });
});
