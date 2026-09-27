/**
 * 监控接缝一致性测试（mirror 钉子，两枚）：
 * ① bind-core 镜像形状 ⊇ scene-schema SceneConfig——scene-schema 校验通过的
 *   fixtures 配置必须可直接喂 evaluateScene（结构兼容，包间无 import）；
 * ② fixtures run_state 与 bind-core resolveEquipmentRunState 求值式一致
 *   （M3-monitor §3.2：fault = open 告警 + 非 running）；
 * ③ SSE 客户端纯函数（退避序列 / 帧解析 / 遥测 data 解析）。
 */
import { describe, expect, it } from 'vitest';
import { evaluateScene, resolveEquipmentRunState, type SceneConfigInput } from '@thermio/bind-core';
import { SceneConfigSchema } from '@thermio/scene-schema';
import {
  EQUIPMENTS,
  MONITOR_SYSTEMS,
  OPEN_ALARMS,
  POINT_LATEST,
  SCENE_DETAIL,
} from './monitor-fixtures.js';
import { backoffDelayMs, parseSseFrames, parseTelemetryData } from '../../app/telemetry-stream.js';
import { displayPointValue, formatStamp, qualityLabel, statusDisplayText } from './monitor-data.js';

describe('镜像一致性（bind-core ⇄ scene-schema ⇄ fixtures）', () => {
  it('fixtures 场景配置过 SceneConfigSchema 且可直接喂 evaluateScene', () => {
    const parsed = SceneConfigSchema.safeParse(SCENE_DETAIL.config);
    expect(parsed.success).toBe(true);
    // 结构兼容：不经过 as 断言直接传参（编译期钉住镜像，运行期跑通）
    const config: SceneConfigInput = SCENE_DETAIL.config;
    const store = new Map(Object.entries(POINT_LATEST).map(([id, value]) => [Number(id), value]));
    const result = evaluateScene(
      config,
      store,
      OPEN_ALARMS.map((alarm) => ({
        id: alarm.id,
        severity: alarm.severity,
        object_ids: alarm.object_ids,
      })),
      { nowMs: Date.parse('2026-09-27T08:00:00+08:00'), staleTimeoutS: 30 },
    );
    expect(result.states['CH-01']).toBe('running');
    expect(result.states['CT-02']).toBe('standby');
    // 高亮：CH-01/CHWP-02 命中 alarm-linked 规则 → alarm；CT-02 走 ④ 告警快照
    // 直映射（warning → warning）。两路径都钉住（bind-core 取最严：warning < alarm）。
    expect(result.highlights['CH-01']).toBe('alarm');
    expect(result.highlights['CHWP-02']).toBe('alarm');
    expect(result.highlights['CT-02']).toBe('warning');
    expect(result.fanSpeeds['CT-01']).toBeCloseTo(38.5 * 0.02);
    expect(result.values['CH-01:power']?.unit).toBe('kW');
  });

  it('fixtures run_state 符合 §3.2 求值式（fault = open 告警 + 非 running）', () => {
    const alarmsByObject = new Map<string, boolean>();
    for (const alarm of OPEN_ALARMS) {
      for (const objectId of alarm.object_ids) alarmsByObject.set(objectId, true);
    }
    for (const card of EQUIPMENTS) {
      const localId = card.equipment.local_id ?? '';
      const runPoint = card.key_points.find((point) => point.quantity_type === 'run_status');
      const raw = runPoint?.latest?.value_text ?? null;
      const expected = resolveEquipmentRunState({ raw, hasOpenAlarm: alarmsByObject.has(localId) });
      expect(expected, `${localId} run_state`).toBe(card.run_state);
    }
  });
});

describe('telemetry-stream 纯函数（M3-monitor §4.3）', () => {
  it('退避 1→2→5→10→20→30s 上限，±20% 抖动', () => {
    const fixed = (fraction: number) => () => fraction;
    expect(backoffDelayMs(0, fixed(0.5))).toBe(1000);
    expect(backoffDelayMs(1, fixed(0.5))).toBe(2000);
    expect(backoffDelayMs(2, fixed(0.5))).toBe(5000);
    expect(backoffDelayMs(3, fixed(0.5))).toBe(10000);
    expect(backoffDelayMs(4, fixed(0.5))).toBe(20000); // 阶梯后 ×2 续涨
    expect(backoffDelayMs(5, fixed(0.5))).toBe(30000); // 顶格
    expect(backoffDelayMs(9, fixed(0.5))).toBe(30000);
    expect(backoffDelayMs(0, fixed(1.0))).toBe(1200); // +20%
    expect(backoffDelayMs(0, fixed(0.0))).toBe(800); // −20%
  });

  it('SSE 帧解析：telemetry 事件抽取、心跳注释行忽略、半帧缓冲', () => {
    const first = parseSseFrames(
      ': ping\n\nevent: telemetry\ndata: {"points":[{"point_id":101,"ts":"2026-09-27T00:00:00Z","value":1,"value_text":null,"quality":0}]}\n\n',
    );
    expect(first.events).toHaveLength(1);
    expect(first.events[0]?.event).toBe('telemetry');
    expect(parseTelemetryData(first.events[0]?.data ?? '')).toEqual([
      { point_id: 101, ts: '2026-09-27T00:00:00Z', value: 1, value_text: null, quality: 0 },
    ]);
    expect(first.rest).toBe('');
    // 半帧留在缓冲
    const partial = parseSseFrames('event: telemetry\ndata: {"points":[]}');
    expect(partial.events).toHaveLength(0);
    const complete = parseSseFrames(`${partial.rest}\n\n`);
    expect(complete.events).toHaveLength(1);
  });

  it('枚态量展示文本：run_status raw → 运行/停机，其余原样（展示层映射）', () => {
    expect(displayPointValue('run_status', { value_text: '1', value: 1 })).toBe('运行');
    expect(displayPointValue('run_status', { value_text: '0', value: 0 })).toBe('停机');
    expect(displayPointValue('run_status', { value_text: '9', value: 9 })).toBe('9'); // 开放枚举不臆译
    expect(displayPointValue('power', { value_text: null, value: 268.4 })).toBe('268.4');
    expect(displayPointValue('power', null)).toBe('—');
    // 视觉门 r1 页4-3：value_text 缺失（聚合 last 只有数值）按数值回退，两取数路径渲染一致
    expect(displayPointValue('run_status', { value_text: null, value: 1 })).toBe('运行');
    expect(displayPointValue('run_status', { value_text: null, value: 0 })).toBe('停机');
    expect(displayPointValue('run_status', { value_text: null, value: null })).toBe('—');
  });

  it('故障卡运行状态词汇（页3-5）：fault + 停机 → 停机（故障）', () => {
    const stopped = { value_text: '0', value: 0 };
    expect(statusDisplayText('run_status', stopped, 'fault')).toBe('停机（故障）');
    expect(statusDisplayText('run_status', stopped, 'standby')).toBe('停机');
    expect(statusDisplayText('power', { value_text: null, value: 0 }, 'fault')).toBe('0');
  });

  it('时间/质量位格式（页4-6·建议）：YYYY-MM-DD HH:mm:ss 中文单语 + quality 友好标签', () => {
    expect(formatStamp('2026-09-27T08:00:00+08:00')).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    );
    expect(formatStamp('not-a-date')).toBe('not-a-date'); // 畸形输入原样透传不抛
    expect(qualityLabel(0)).toBe('良好');
    expect(qualityLabel(6)).toBe('q6');
  });

  it('fixtures 同型设备关键点位集一致（页3-1）：同型卡点位名序列相同', () => {
    const pointNames = (localId: string): string[] => {
      const card = EQUIPMENTS.find((item) => item.equipment.local_id === localId);
      if (card === undefined) throw new Error(`fixture 缺设备 ${localId}`);
      return card.key_points.map((point) => point.display_name ?? String(point.point_id));
    };
    expect(pointNames('CH-01')).toEqual(pointNames('CH-02'));
    expect(pointNames('CHWP-01')).toEqual(pointNames('CHWP-02'));
    expect(pointNames('CWP-01')).toEqual(pointNames('CWP-02'));
    expect(pointNames('CT-01')).toEqual(pointNames('CT-02'));
    // 全部卡非空（渲染层仍保留空数组「—」占位兜底，见页面实现）
    for (const card of EQUIPMENTS) expect(card.key_points.length).toBeGreaterThan(0);
    // 系统筛选种子与设备 system_id 闭合
    const systemIds = new Set(EQUIPMENTS.map((card) => card.equipment.system_id));
    for (const system of MONITOR_SYSTEMS) expect(systemIds.has(system.id)).toBe(true);
  });

  it('畸形 telemetry data 跳过不抛', () => {
    expect(parseTelemetryData('not-json')).toEqual([]);
    expect(parseTelemetryData('{"nope":1}')).toEqual([]);
  });
});
