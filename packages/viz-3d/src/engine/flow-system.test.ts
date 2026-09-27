/**
 * 引擎纯逻辑单测（ui/viz-3d.md §8）：路线采样数学 / 状态→材质映射 /
 * manifest schema 收窄。WebGL 依赖路径不在 jsdom 测试（无 GPU 上下文），
 * 降级链以 degrade 测试锚 webgl_unavailable。
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildRoute, sampleRoute } from './FlowSystem.js';
import { STATUS_COLORS, statusColorOf } from './materials.js';
import { SceneManifestSchema } from '../schema.js';

const straight = {
  id: 'PIPE-01',
  owner: null,
  circuit: 'CHWS',
  radius: 0.09,
  points: [new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 0, 0)],
};

describe('buildRoute', () => {
  it('累计长度与标记数（demo 间距 2.1，向上取整至少 1）', () => {
    const route = buildRoute(straight);
    expect(route.length).toBe(10);
    expect(route.lengths).toEqual([0, 10]);
    expect(route.count).toBe(Math.max(1, Math.floor(10 / 2.1)));
  });

  it('短于间距的路径保底 1 枚标记', () => {
    const route = buildRoute({
      ...straight,
      points: [new THREE.Vector3(), new THREE.Vector3(1, 0, 0)],
    });
    expect(route.count).toBe(1);
  });
});

describe('sampleRoute', () => {
  it('距离落在段内按比例插值，且不越界（取模回绕）', () => {
    const route = buildRoute(straight);
    const { position } = sampleRoute(route, 4.2);
    expect(position.x).toBeCloseTo(4.2);
    // y 抬升 = radius + 0.028（demo 同式：标记浮于管顶）
    expect(position.y).toBeCloseTo(0.09 + 0.028);
    const wrapped = sampleRoute(route, 12.3);
    expect(wrapped.position.x).toBeCloseTo(12.3 - 10);
  });

  it('竖直段标记横向偏移避免穿管（|dir.y| > 0.8 → x += radius + 0.018）', () => {
    const vertical = buildRoute({
      ...straight,
      points: [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 6, 0)],
    });
    const { position } = sampleRoute(vertical, 3);
    expect(position.x).toBeCloseTo(0.09 + 0.018);
    expect(position.y).toBeCloseTo(3 + 0.09 + 0.028);
  });
});

describe('statusColorOf', () => {
  it('运行亮绿 / 备用灰（demo 确认稿值）', () => {
    expect(statusColorOf('running')).toBe(STATUS_COLORS.running);
    expect(statusColorOf('standby')).toBe(STATUS_COLORS.standby);
  });
});

describe('SceneManifestSchema', () => {
  it('接受 demo 形状的清单并剥离 demo 专有键', () => {
    const parsed = SceneManifestSchema.parse({
      title: '暖通能源站',
      demo: true,
      source: 'Approved Blender concept 01',
      assets: [
        {
          id: 'CH-01',
          kind: 'chiller',
          name: '冷水机组',
          circuit: 'CHW',
          center: [0, 0, 0],
          size: [4, 2, 3],
          anchor: [0, 0, 3.2],
        },
      ],
      flowPaths: [
        {
          id: 'PIPE-01',
          owner: 'CH-01',
          circuit: 'CHWS',
          radius: 0.09,
          points: [
            [0, 0, 0],
            [1, 0, 0],
          ],
        },
      ],
      camera: { position: [24, 28, 32], target: [0, 0.6, -0.7], width: 32.8 },
    });
    expect(parsed.assets).toHaveLength(1);
    expect('demo' in parsed).toBe(false);
    expect(parsed.assets[0]?.circuit).toBe('CHW');
  });

  it('畸形清单被拒绝（引擎走 manifest_invalid 降级）', () => {
    expect(
      SceneManifestSchema.safeParse({
        assets: [],
        flowPaths: [],
        camera: { position: [0, 0, 0], target: [0, 0, 0], width: -1 },
      }).success,
    ).toBe(false);
    expect(
      SceneManifestSchema.safeParse({
        assets: 'nope',
        flowPaths: [],
        camera: { position: [0, 0, 0], target: [0, 0, 0], width: 1 },
      }).success,
    ).toBe(false);
  });
});
