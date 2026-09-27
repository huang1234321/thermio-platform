/**
 * 监控域 fixtures（**占位数据**——api 数据面未落码期间的演示种子；M3-monitor
 * §3 契约形状逐字段对齐，api 合入后整文件退役）。
 *
 * 标注纪律（交付说明要求）：
 * - 楼宇/系统/设备/点位 id 全部为 fixture 命名空间（不是真实资产档案）；
 * - KPI 数值为演示值；saving_period_kwh=null（M9 前 P1 占位，恒不造数）；
 * - 告警为 IMPL-13/DAT-116 接缝 stub（§8.4：不等待、不直连）；
 * - 场景资产指向本地 fixtures（/monitor-fixtures/*），sha256 为仓库内 GLB 实测值；
 * - 绑定/规则为 hvac-plant-v1 模板 base 变体的示范配置（对象 id = manifest assets）。
 */
import type {
  EquipmentConditionCard,
  EquipmentConditionDetail,
  MonitorOverview,
  OpenAlarm,
  PointsLatestBatch,
} from './api-contracts.js';
import type { LatestValue } from '@thermio/bind-core';
import { SceneDetailSchema } from '@thermio/scene-schema';

const now = new Date('2026-09-27T08:00:00+08:00');
const iso = (minutesAgo: number): string =>
  new Date(now.getTime() - minutesAgo * 60_000).toISOString();

const BUILDING_ID = '3fa9a86c-0000-4a1b-8d0e-000000000001';
const SYSTEM_CHW_ID = '3fa9a86c-0000-4a2c-8d0e-000000000010';
const SYSTEM_CW_ID = '3fa9a86c-0000-4a2c-8d0e-000000000020';
const SCENE_3D_ID = '3fa9a86c-0000-4a3d-8d0e-000000000100';
const SCENE_2D_ID = '3fa9a86c-0000-4a3d-8d0e-000000000200';

const equipment = (
  id: string,
  system_id: string,
  equipment_type: 'chiller' | 'chwp_pump' | 'cwp_pump' | 'cooling_tower',
  name: string,
  local_id: string,
) => ({
  id,
  system_id,
  equipment_type,
  name,
  local_id,
  vendor_model: null,
  rated_params: null,
  commission_date: null,
});

/** manifest 对象 id → 设备档案（演示映射：模板资产按 local_id 命名对齐，§2.1）。 */
export const EQUIPMENTS: EquipmentConditionCard[] = [
  {
    equipment: equipment(
      '3fa9a86c-1000-4b01-9c0e-00000000c101',
      SYSTEM_CHW_ID,
      'chiller',
      '冷水机组 1#',
      'CH-01',
    ),
    run_state: 'running',
    alarm_worst: 'major',
    key_points: [
      {
        point_id: 101,
        display_name: '运行状态',
        quantity_type: 'run_status',
        unit_std: null,
        latest: { point_id: 101, ts: iso(0.2), value: 1, value_text: '1', quality: 0 },
      },
      {
        point_id: 301,
        display_name: '机组功率',
        quantity_type: 'power',
        unit_std: 'kW',
        latest: { point_id: 301, ts: iso(0.2), value: 268.4, value_text: null, quality: 0 },
      },
      {
        point_id: 401,
        display_name: '冷冻出水温度',
        quantity_type: 'chw_supply_temp',
        unit_std: '°C',
        latest: { point_id: 401, ts: iso(0.2), value: 7.2, value_text: null, quality: 0 },
      },
    ],
  },
  {
    equipment: equipment(
      '3fa9a86c-1000-4b02-9c0e-00000000c102',
      SYSTEM_CHW_ID,
      'chiller',
      '冷水机组 2#',
      'CH-02',
    ),
    run_state: 'standby',
    alarm_worst: null,
    key_points: [
      {
        point_id: 102,
        display_name: '运行状态',
        quantity_type: 'run_status',
        unit_std: null,
        latest: { point_id: 102, ts: iso(0.3), value: 0, value_text: '0', quality: 0 },
      },
    ],
  },
  {
    equipment: equipment(
      '3fa9a86c-1000-4b11-9c0e-00000000c111',
      SYSTEM_CHW_ID,
      'chwp_pump',
      '冷冻水泵 1#',
      'CHWP-01',
    ),
    run_state: 'running',
    alarm_worst: null,
    key_points: [
      {
        point_id: 111,
        display_name: '运行状态',
        quantity_type: 'run_status',
        unit_std: null,
        latest: { point_id: 111, ts: iso(0.1), value: 1, value_text: '1', quality: 0 },
      },
      {
        point_id: 311,
        display_name: '水泵功率',
        quantity_type: 'power',
        unit_std: 'kW',
        latest: { point_id: 311, ts: iso(0.1), value: 45.2, value_text: null, quality: 0 },
      },
    ],
  },
  {
    equipment: equipment(
      '3fa9a86c-1000-4b12-9c0e-00000000c112',
      SYSTEM_CHW_ID,
      'chwp_pump',
      '冷冻水泵 2#',
      'CHWP-02',
    ),
    run_state: 'fault',
    alarm_worst: 'minor',
    key_points: [
      {
        point_id: 112,
        display_name: '运行状态',
        quantity_type: 'run_status',
        unit_std: null,
        latest: { point_id: 112, ts: iso(0.4), value: 0, value_text: '0', quality: 0 },
      },
    ],
  },
  {
    equipment: equipment(
      '3fa9a86c-1000-4b21-9c0e-00000000c121',
      SYSTEM_CW_ID,
      'cwp_pump',
      '冷却水泵 1#',
      'CWP-01',
    ),
    run_state: 'running',
    alarm_worst: null,
    key_points: [
      {
        point_id: 121,
        display_name: '运行状态',
        quantity_type: 'run_status',
        unit_std: null,
        latest: { point_id: 121, ts: iso(0.2), value: 1, value_text: '1', quality: 0 },
      },
    ],
  },
  {
    equipment: equipment(
      '3fa9a86c-1000-4b22-9c0e-00000000c122',
      SYSTEM_CW_ID,
      'cwp_pump',
      '冷却水泵 2#',
      'CWP-02',
    ),
    run_state: 'standby',
    alarm_worst: null,
    key_points: [
      {
        point_id: 122,
        display_name: '运行状态',
        quantity_type: 'run_status',
        unit_std: null,
        latest: { point_id: 122, ts: iso(0.3), value: 0, value_text: '0', quality: 0 },
      },
    ],
  },
  {
    equipment: equipment(
      '3fa9a86c-1000-4b31-9c0e-00000000c131',
      SYSTEM_CW_ID,
      'cooling_tower',
      '冷却塔 1#',
      'CT-01',
    ),
    run_state: 'running',
    alarm_worst: null,
    key_points: [
      {
        point_id: 131,
        display_name: '运行状态',
        quantity_type: 'run_status',
        unit_std: null,
        latest: { point_id: 131, ts: iso(0.2), value: 1, value_text: '1', quality: 0 },
      },
      {
        point_id: 231,
        display_name: '风机频率',
        quantity_type: null,
        unit_std: 'Hz',
        latest: { point_id: 231, ts: iso(0.2), value: 38.5, value_text: null, quality: 0 },
      },
    ],
  },
  {
    equipment: equipment(
      '3fa9a86c-1000-4b32-9c0e-00000000c132',
      SYSTEM_CW_ID,
      'cooling_tower',
      '冷却塔 2#',
      'CT-02',
    ),
    // §3.2 求值式：open 告警 + 非 running → fault（warning 级同样成立）
    run_state: 'fault',
    alarm_worst: 'warning',
    key_points: [
      {
        point_id: 132,
        display_name: '运行状态',
        quantity_type: 'run_status',
        unit_std: null,
        latest: { point_id: 132, ts: iso(0.3), value: 0, value_text: '0', quality: 0 },
      },
      {
        point_id: 232,
        display_name: '风机频率',
        quantity_type: null,
        unit_std: 'Hz',
        latest: { point_id: 232, ts: iso(0.3), value: 0, value_text: null, quality: 0 },
      },
    ],
  },
];

/** SSE / 批量 latest 的 mock 源（point_id → 最新值；推送时按 walking 抖动刷新）。 */
export const POINT_LATEST: Record<number, LatestValue> = {
  101: { value: 1, value_text: '1', ts: iso(0.2), quality: 0 },
  102: { value: 0, value_text: '0', ts: iso(0.3), quality: 0 },
  111: { value: 1, value_text: '1', ts: iso(0.1), quality: 0 },
  112: { value: 0, value_text: '0', ts: iso(0.4), quality: 0 },
  121: { value: 1, value_text: '1', ts: iso(0.2), quality: 0 },
  122: { value: 0, value_text: '0', ts: iso(0.3), quality: 0 },
  131: { value: 1, value_text: '1', ts: iso(0.2), quality: 0 },
  132: { value: 0, value_text: '0', ts: iso(0.3), quality: 0 },
  231: { value: 38.5, value_text: null, ts: iso(0.2), quality: 0 },
  232: { value: 0, value_text: null, ts: iso(0.3), quality: 0 },
  301: { value: 268.4, value_text: null, ts: iso(0.2), quality: 0 },
  401: { value: 7.2, value_text: null, ts: iso(0.2), quality: 0 },
};

/** 告警快照 stub（M4 域未合入——IMPL-13 接缝 §8.4）。object_ids = manifest 对象。 */
export const OPEN_ALARMS: OpenAlarm[] = [
  {
    id: 'al-fixture-9001',
    severity: 'major',
    rule_summary: 'CH-01 冷冻出水温度持续越上限',
    opened_at: iso(52),
    object_ids: ['CH-01'],
  },
  {
    id: 'al-fixture-9002',
    severity: 'warning',
    rule_summary: 'CT-02 风机振动趋势偏高（趋势预警）',
    opened_at: iso(31),
    object_ids: ['CT-02'],
  },
  {
    id: 'al-fixture-9003',
    severity: 'minor',
    rule_summary: 'CHWP-02 备用态通信质量降级（quality 位 6）',
    opened_at: iso(12),
    object_ids: ['CHWP-02'],
  },
];

export const MONITOR_OVERVIEW: MonitorOverview = {
  building: { id: BUILDING_ID, name: '示范楼宇 · 冷源站房' },
  scenes: [
    { id: SCENE_3D_ID, name: '能源站 3D 总览', kind: '3d' },
    { id: SCENE_2D_ID, name: '能源站原理图（2D）', kind: '2d' },
  ],
  kpi: {
    energy_today_kwh: 1_284.6,
    energy_period_kwh: 31_502.8,
    saving_period_kwh: null, // M9 前 P1 占位
    load_rate_pct: 72.4,
    load_rate_linked: true,
    alarms: {
      open_total: 3,
      open_by_severity: { info: 0, warning: 1, minor: 1, major: 1, critical: 0 },
    },
  },
  gateways: { online: 3, total: 4 },
};

const OBJECT_PARENTS: Record<string, string> = Object.fromEntries(
  (
    [
      ...['CHWP-01', 'CHWP-02', 'CWP-01', 'CWP-02', 'CH-01', 'CH-02', 'CT-01', 'CT-02'].flatMap(
        (owner): [string, string][] => [
          [`V-${owner}.suction.isolation`, owner],
          [`V-${owner}.discharge.check`, owner],
        ],
      ),
      ['V-CH-01.evaporator.outlet.valve', 'CH-01'],
      ['V-CH-01.evaporator.inlet.valve', 'CH-01'],
      ['V-CH-01.condenser.inlet.valve', 'CH-01'],
      ['V-CH-02.evaporator.outlet.valve', 'CH-02'],
      ['V-CH-02.evaporator.inlet.valve', 'CH-02'],
      ['V-CH-02.condenser.inlet.valve', 'CH-02'],
    ] as [string, string][]
  ).map(([child, parent]) => [child, parent] as const),
);

/** hvac-plant-v1 / base 的示范场景配置（SceneDetail，经 scene-schema 校验的形状）。 */

// 契约上 url = 对象存储签名 URL（绝对地址，scene-schema z.url()）。mock 用当前
// origin 拼绝对地址：浏览器里即同源 public/ fixture（换 host/端口仍成立）；
// 无 window 的测试环境回退 vite dev 缺省 origin（仅满足形状校验）。
const FIXTURE_ORIGIN =
  typeof globalThis.location !== 'undefined' ? globalThis.location.origin : 'http://localhost:5173';
const fixtureUrl = (path: string): string => new URL(path, FIXTURE_ORIGIN).toString();

export const SCENE_DETAIL = SceneDetailSchema.parse({
  id: SCENE_3D_ID,
  building_id: BUILDING_ID,
  system_id: SYSTEM_CHW_ID,
  name: '能源站 3D 总览',
  kind: '3d',
  template: { id: 'hvac-plant-v1', version: 1, variant_key: 'base' },
  assets: {
    model: {
      asset_id: 'model',
      url: fixtureUrl('/monitor-fixtures/plant.glb'),
      bytes: 1_558_636,
      // 仓库内 fixture GLB 实测 sha256（完整性校验链路演示）
      sha256: '07e62463ddabe21b7174d326fc6ef51245c968f3ec81b5a29b86fb096c3812fb',
      expires_at: '2026-12-31T23:59:59+08:00',
    },
    manifest: {
      asset_id: 'manifest',
      url: fixtureUrl('/monitor-fixtures/manifest.json'),
      expires_at: '2026-12-31T23:59:59+08:00',
    },
  },
  config: {
    bindings: [
      {
        slot: 'CH-01:run',
        point_id: 101,
        kind: 'state-run',
        enum: { '1': 'running', '0': 'standby' },
      },
      {
        slot: 'CH-02:run',
        point_id: 102,
        kind: 'state-run',
        enum: { '1': 'running', '0': 'standby' },
      },
      {
        slot: 'CHWP-01:run',
        point_id: 111,
        kind: 'state-run',
        enum: { '1': 'running', '0': 'standby' },
      },
      {
        slot: 'CHWP-02:run',
        point_id: 112,
        kind: 'state-run',
        enum: { '1': 'running', '0': 'standby' },
      },
      {
        slot: 'CWP-01:run',
        point_id: 121,
        kind: 'state-run',
        enum: { '1': 'running', '0': 'standby' },
      },
      {
        slot: 'CWP-02:run',
        point_id: 122,
        kind: 'state-run',
        enum: { '1': 'running', '0': 'standby' },
      },
      {
        slot: 'CT-01:run',
        point_id: 131,
        kind: 'state-run',
        enum: { '1': 'running', '0': 'standby' },
      },
      {
        slot: 'CT-02:run',
        point_id: 132,
        kind: 'state-run',
        enum: { '1': 'running', '0': 'standby' },
      },
      { slot: 'CT-01:fan', point_id: 231, kind: 'motion-fan', rad_s_per_hz: 0.02 },
      { slot: 'CT-02:fan', point_id: 232, kind: 'motion-fan', rad_s_per_hz: 0.02 },
      { slot: 'CH-01:power', point_id: 301, kind: 'value-text', fmt: 'int', unit: 'kW' },
      { slot: 'CH-01:chwst', point_id: 401, kind: 'value-text', fmt: '1-dec', unit: '°C' },
    ],
    highlight_rules: [
      { kind: 'threshold', slot: 'CH-01:chwst', op: '>', threshold: 7.5, level: 'warning' },
      // CT-02 故意不入规则圈：演示 ④ 告警快照直映射（warning → warning 高亮）
      { kind: 'alarm-linked', object_ids: ['CH-01', 'CHWP-02'], level: 'alarm' },
    ],
    views: [
      {
        id: 'overview',
        camera: {
          position: [24.19872, 27.50281, 32.27076],
          target: [0.19872, 0.10281, -0.42924],
          width: 32.8,
        },
      },
      { id: 'plan', camera: { position: [0, 42, 0.2], target: [0, 0.6, -0.7], width: 36 } },
    ],
  },
  created_at: '2026-09-26T00:00:00+08:00',
  updated_at: '2026-09-27T06:30:00+08:00',
});

export { BUILDING_ID, OBJECT_PARENTS };

/** 批量 latest 快照（§3.6 校准；mock 直接查表）。 */
export function pointsLatestBatch(pointIds: readonly number[]): PointsLatestBatch {
  return {
    items: pointIds.map((point_id) => {
      const base = POINT_LATEST[point_id];
      return {
        point_id,
        latest:
          base === undefined
            ? null
            : {
                point_id,
                ts: base.ts ?? '',
                value: base.value,
                value_text: base.value_text,
                quality: base.quality,
              },
      };
    }),
  };
}

export function equipmentDetail(equipmentId: string): EquipmentConditionDetail | null {
  const card = EQUIPMENTS.find((item) => item.equipment.id === equipmentId);
  if (card === undefined) return null;
  const alarmsFor = OPEN_ALARMS.filter((alarm) =>
    alarm.object_ids.includes(card.equipment.local_id ?? ''),
  );
  const openBySeverity = { info: 0, warning: 0, minor: 0, major: 0, critical: 0 };
  for (const alarm of alarmsFor) openBySeverity[alarm.severity] += 1;
  return {
    equipment: card.equipment,
    run_state: card.run_state,
    points: card.key_points.map((keyPoint) => ({
      point: {
        id: keyPoint.point_id,
        building_id: BUILDING_ID,
        equipment_id: card.equipment.id,
        source_type: 'bacnet',
        gateway_id: null,
        protocol_address: null,
        raw_name: `${card.equipment.local_id ?? card.equipment.id}.${keyPoint.quantity_type ?? 'value'}`,
        sample_interval_s: 5,
        quantity_type: keyPoint.quantity_type,
        display_name: keyPoint.display_name,
        description: null,
        unit_raw: keyPoint.unit_std,
        unit_std: keyPoint.unit_std,
        direction: 'read',
        is_controllable: false,
        clamp_min: null,
        clamp_max: null,
        write_rate_limit_per_hour: null,
        control_mode: 'advisory',
        stale_timeout_s: 30,
        valid_range_min: null,
        valid_range_max: null,
        status: 'active',
        created_at: '2026-09-20T00:00:00+08:00',
        updated_at: '2026-09-20T00:00:00+08:00',
      },
      latest: keyPoint.latest,
    })),
    alarms: {
      open_by_severity: openBySeverity,
      items: alarmsFor.map((alarm) => ({
        id: alarm.id,
        severity: alarm.severity,
        rule_summary: alarm.rule_summary,
        opened_at: alarm.opened_at,
      })),
    },
    // FDD（M6）未接入：契约形状占位 + 空态（不造数）
    fdd: { open_total: 0, items: [] },
  };
}
