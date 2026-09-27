/**
 * 监控数据接缝（mock ⇄ real 单点开关）。
 *
 * M3-monitor api 数据面（/monitor/*、/scenes/*、/streams/telemetry、批量
 * /points/latest）在 api 侧尚未落码——本卡 UI 侧先行，接缝纪律（IMPL-13
 * 同款）：**stub 开发，不等待、不直连**。契约 schema 见 api-contracts.ts，
 * mock 数据见 monitor-fixtures.ts；api 合入后仅本文件切换实现，页面零改动。
 *
 * 开关：`VITE_MONITOR_MOCK=0` 显式关闭 mock（默认开——演示/走查模式，页面
 * 挂「演示数据」角标显式声明）；trend 直连真实端点 GET /points/{id}/telemetry
 * （M1 已上线，不建双入口，§3.3）。
 */
import { apiFetch } from '../../app/api-client.js';
import {
  openTelemetryStream,
  type StreamPoint,
  type TelemetryStreamCallbacks,
  type TelemetryStreamHandle,
} from '../../app/telemetry-stream.js';
import { SceneDetailSchema, type SceneDetail } from '@thermio/scene-schema';
import { SystemListResponseSchema } from '@thermio/shared-types';
import {
  EquipmentConditionDetailSchema,
  EquipmentConditionListSchema,
  MonitorOverviewSchema,
  PointsLatestBatchSchema,
  type EquipmentConditionCard,
  type MonitorOverview,
  type OpenAlarm,
} from './api-contracts.js';
import {
  EQUIPMENTS,
  MONITOR_OVERVIEW,
  MONITOR_SYSTEMS,
  OPEN_ALARMS,
  POINT_LATEST,
  SCENE_DETAIL,
  equipmentDetail,
  pointsLatestBatch,
} from './monitor-fixtures.js';

export const MONITOR_MOCK = import.meta.env.VITE_MONITOR_MOCK !== '0';

export async function fetchMonitorOverview(): Promise<MonitorOverview> {
  if (MONITOR_MOCK) return structuredClone(MONITOR_OVERVIEW);
  return apiFetch('/monitor/overview', MonitorOverviewSchema);
}

export interface EquipmentQuery {
  readonly systemId?: string;
  readonly equipmentType?: string;
  readonly runState?: string;
  readonly keyword?: string;
}

export async function fetchEquipmentConditions(
  query: EquipmentQuery = {},
): Promise<{ items: readonly EquipmentConditionCard[]; nextCursor: string | null }> {
  if (MONITOR_MOCK) {
    const keyword = query.keyword?.toLowerCase();
    const items = EQUIPMENTS.filter((card) => {
      // 空串 = 未选（页面 Select 清空即 ''），与 undefined 同视，不参与过滤
      if (
        query.systemId !== undefined &&
        query.systemId !== '' &&
        card.equipment.system_id !== query.systemId
      )
        return false;
      if (
        query.equipmentType !== undefined &&
        query.equipmentType !== '' &&
        card.equipment.equipment_type !== query.equipmentType
      )
        return false;
      if (
        query.runState !== undefined &&
        query.runState !== '' &&
        card.run_state !== query.runState
      )
        return false;
      if (
        keyword !== undefined &&
        keyword !== '' &&
        !card.equipment.name.toLowerCase().includes(keyword) &&
        !(card.equipment.local_id ?? '').toLowerCase().includes(keyword)
      )
        return false;
      return true;
    });
    return { items, nextCursor: null };
  }
  const params = new URLSearchParams();
  if (query.systemId !== undefined && query.systemId !== '')
    params.set('system_id', query.systemId);
  if (query.equipmentType !== undefined && query.equipmentType !== '')
    params.set('equipment_type', query.equipmentType);
  if (query.runState !== undefined && query.runState !== '')
    params.set('run_state', query.runState);
  if (query.keyword !== undefined && query.keyword !== '') params.set('keyword', query.keyword);
  const page = await apiFetch(
    `/monitor/equipments?${params.toString()}`,
    EquipmentConditionListSchema,
  );
  return { items: page.items, nextCursor: page.next_cursor };
}

export async function fetchEquipmentConditionDetail(equipmentId: string) {
  if (MONITOR_MOCK) return equipmentDetail(equipmentId);
  return apiFetch(`/monitor/equipments/${equipmentId}`, EquipmentConditionDetailSchema);
}

/**
 * 系统清单（§3.2 筛选白名单首项）。real 走 M1 `GET /buildings/{id}/systems`
 * （assets.read）；纯监控角色无该能力时调用方 catch → 空清单（筛选器隐藏，
 * 不阻塞列表）。buildingId 由调用方从 overview 取。
 */
export async function fetchMonitorSystems(
  buildingId: string | null,
): Promise<readonly { id: string; name: string }[]> {
  if (MONITOR_MOCK) return MONITOR_SYSTEMS;
  if (buildingId === null) return [];
  const page = await apiFetch(`/buildings/${buildingId}/systems`, SystemListResponseSchema);
  return page.items.map((system) => ({ id: system.id, name: system.name }));
}

export async function fetchSceneDetail(sceneId: string): Promise<SceneDetail> {
  if (MONITOR_MOCK) return structuredClone(SCENE_DETAIL);
  return apiFetch(`/scenes/${sceneId}`, SceneDetailSchema);
}

/**
 * 告警快照（接缝：M4 GET /alarms?status=open，IMPL-13/DAT-116 在途）。
 * mock → fixtures stub；real 路径在 M4 合入前显式不可用（不直连、不臆造
 * 响应形状——告警 ↔ 3D 对象的语义映射本就是接缝待定项）。
 */
export function fetchOpenAlarms(): Promise<readonly OpenAlarm[]> {
  if (MONITOR_MOCK) return Promise.resolve(OPEN_ALARMS);
  return Promise.reject(new Error('告警快照通道待 M4（IMPL-13）合入后接线'));
}

export async function fetchPointsLatestBatch(pointIds: readonly number[]) {
  if (MONITOR_MOCK) return pointsLatestBatch(pointIds);
  return apiFetch(`/points/latest?point_ids=${pointIds.join(',')}`, PointsLatestBatchSchema);
}

/**
 * 点位值展示文本：value_text 契约 = 枚举键（run_status 为 '1'/'0'，bind-core
 * DEFAULT_RUN_ENUM 同源）——人读文案只在展示层映射，不回写数据面。
 * value_text 缺失（如聚合路径 last 只有数值）时按数值回退映射，两条取数路径
 * 渲染一致（视觉门 r1 页4-3：同一卡片一处「运行」一处「1」）。
 */
export function displayPointValue(
  quantityType: string | null,
  latest: { value_text: string | null; value: number | null } | null,
): string {
  if (latest === null) return '—';
  if (quantityType === 'run_status') {
    const raw = latest.value_text ?? (latest.value !== null ? String(latest.value) : null);
    if (raw === '1') return '运行';
    if (raw === '0') return '停机';
    if (raw !== null) return raw; // 开放枚举不臆译
  }
  return latest.value_text ?? (latest.value !== null ? String(latest.value) : '—');
}

/**
 * 故障态运行状态词汇（视觉门 r1 页3-5）：run_state=fault 卡的 run_status 值
 * 与备用卡同为「停机」，文本层不可区分——故障卡显式带因。
 */
export function statusDisplayText(
  quantityType: string | null,
  latest: { value_text: string | null; value: number | null } | null,
  runState: string | null,
): string {
  const base = displayPointValue(quantityType, latest);
  if (runState === 'fault' && base === '停机') return '停机（故障）';
  return base;
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** baseline §2.2 时间格式（中文单语）：YYYY-MM-DD HH:mm:ss，不吃运行环境 locale。 */
export function formatStamp(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return (
    `${String(at.getFullYear())}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ` +
    `${pad2(at.getHours())}:${pad2(at.getMinutes())}:${pad2(at.getSeconds())}`
  );
}

/** 曲线 x 轴刻度：窗口 ≤1 天恒 HH:mm（本地时区）。 */
export function formatTick(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
}

/** quality 位掩码友好标签（视觉门 r1 页4-建议）：0 = 良好，非 0 保留码值。 */
export function qualityLabel(quality: number): string {
  return quality === 0 ? '良好' : `q${String(quality)}`;
}

// ---------------------------------------------------------------------------
// Mock 遥测流（接口与 openTelemetryStream 同构：2s 节流推送 + walking 抖动）
// ---------------------------------------------------------------------------

const PUSH_MS = 2000;

class MockTelemetryStream implements TelemetryStreamHandle {
  private timer: ReturnType<typeof setInterval> | null = null;
  private phase = 0;

  constructor(
    private readonly pointIds: readonly number[],
    private readonly callbacks: TelemetryStreamCallbacks,
  ) {
    this.callbacks.onStatus('open');
    // 首帧立即推快照（等价 §3.6 校准），之后 2s walking
    this.push(0);
    this.timer = setInterval(() => {
      this.phase += 1;
      this.push(this.phase);
    }, PUSH_MS);
  }

  private push(phase: number): void {
    const now = new Date().toISOString();
    const points: StreamPoint[] = [];
    for (const pointId of this.pointIds) {
      const base = POINT_LATEST[pointId];
      if (base === undefined || base.value === null) continue;
      if (base.value_text !== null) {
        points.push({
          point_id: pointId,
          ts: now,
          value: base.value,
          value_text: base.value_text,
          quality: 0,
        });
        continue;
      }
      // 数值量小幅走动（功率/频率/温度），run_status 量保持稳定
      const wobble = Math.sin(phase / 6 + pointId) * (base.value * 0.012);
      points.push({
        point_id: pointId,
        ts: now,
        value: Math.round((base.value + wobble) * 100) / 100,
        value_text: null,
        quality: 0,
      });
    }
    this.callbacks.onPoints(points);
  }

  close(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.callbacks.onStatus('closed');
  }
}

export function createTelemetryStream(
  pointIds: readonly number[],
  callbacks: TelemetryStreamCallbacks,
): TelemetryStreamHandle {
  if (MONITOR_MOCK) return new MockTelemetryStream(pointIds, callbacks);
  return openTelemetryStream(pointIds, callbacks);
}
