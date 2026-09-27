/**
 * M3 实时监控域契约（modules/M3-monitor.md §3/§4，IMPL-14 api 包）。
 *
 * 覆盖：§3.1 监控总览（MonitorOverview）、§3.2 设备工况检索（EquipmentConditionCard）、
 * §3.3 设备工况详情（EquipmentConditionDetail）、§3.5 SSE 事件形状（TelemetryStreamEvent，
 * 含 value_text 增补 R5）、§3.6 批量最新值快照（PointLatestBatch，R6）。
 * 不含：§3.4 /scenes×2（scene DDL R3 待拍板后另批落码）。
 *
 * 通道参数（platform.md §10/§12）默认值以本包常量钉死（进枚举快照测试，§6.4 同机制），
 * api 侧 env 可覆盖（config），数值调整走 platform §12 表修订。
 */
import { z } from 'zod';
import { ALARM_SEVERITIES, EquipmentTypeSchema } from './enums.js';
import { EquipmentSchema, PointListItemSchema } from './asset.js';
import { Rfc3339Schema } from './telemetry.js';
import { AlarmSeveritySchema } from './enums.js';

// ---------------------------------------------------------------------------
// SSE 通道与批量上限（platform.md §12 容量表 + §10；M3-monitor §3.5/§3.6）
// ---------------------------------------------------------------------------

export const STREAM_LIMITS = {
  /** SSE 单连接订阅点数上限（超出整单 400 stream.limit_exceeded；批量 latest 同上限）。 */
  max_point_ids_per_request: 500,
  /** SSE 每实例并发连接上限（超出 503 stream.server_busy + Retry-After）。 */
  max_connections_per_instance: 100,
  /** 节流窗口默认 2s（1–5s 可配，ADR-013 工程纪律）。 */
  throttle_window_default_ms: 2_000,
  throttle_window_min_ms: 1_000,
  throttle_window_max_ms: 5_000,
  /** 心跳 `: ping` 15s（代理空闲超时典型值之下）。 */
  heartbeat_interval_default_ms: 15_000,
} as const;

/** SSE 订阅点集请求形状（csv 解析后的 int 集）。 */
export const StreamPointIdsSchema = z.array(z.number().int().positive()).min(1);
export type StreamPointIds = z.infer<typeof StreamPointIdsSchema>;

// ---------------------------------------------------------------------------
// §3.1 监控总览
// ---------------------------------------------------------------------------

const SceneRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['3d', '2d']),
});

const OpenAlarmsSchema = z.object({
  open_total: z.number().int().nonnegative(),
  open_by_severity: z.record(z.enum(ALARM_SEVERITIES), z.number().int().nonnegative()),
});

export const MonitorOverviewSchema = z.object({
  building: z.object({ id: z.string(), name: z.string() }),
  /** 楼宇可用组态画面元数据（scene DDL R3 未落 → 恒 []，端点形状先钉死）。 */
  scenes: z.array(SceneRefSchema),
  kpi: z.object({
    /** 当日能耗（能量累计类点位当日 raw 首末差值，kWh）——无能量点位 → null（卡片「—」）。 */
    energy_today_kwh: z.number().nullable(),
    /** 当期能耗（当月累计，同数据面按月窗口差值）。 */
    energy_period_kwh: z.number().nullable(),
    /** 当期节能量：M9（M&V）交付前恒 null 占位。 */
    saving_period_kwh: z.number().nullable(),
    /** 负荷率 %：真实负荷率点位（R12 load_rate）容量加权（拍板 3）；点位在、暂无数据 → null。 */
    load_rate_pct: z.number().nullable(),
    /** false = 楼宇无该量型登记点位 → 卡片「未接入」引导态（拍板 3）。 */
    load_rate_linked: z.boolean(),
    alarms: OpenAlarmsSchema,
  }),
  gateways: z.object({
    online: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
});
export type MonitorOverview = z.infer<typeof MonitorOverviewSchema>;

// ---------------------------------------------------------------------------
// §3.2 设备工况检索
// ---------------------------------------------------------------------------

export const MONITOR_RUN_STATES = ['running', 'standby', 'fault', 'unknown'] as const;
export const MonitorRunStateSchema = z.enum(MONITOR_RUN_STATES);
export type MonitorRunState = z.infer<typeof MonitorRunStateSchema>;

/** 检索筛选白名单（§3.2 参数表；排序固定 (name,id) 不开放排序参数，API-DSN-04）。 */
export const MonitorEquipmentListQuerySchema = z.object({
  building_id: z.uuid(),
  system_id: z.uuid().optional(),
  equipment_type: EquipmentTypeSchema.optional(),
  run_state: MonitorRunStateSchema.optional(),
  keyword: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(2048).optional(),
});
export type MonitorEquipmentListQuery = z.infer<typeof MonitorEquipmentListQuerySchema>;

/** 关键点位实时值卡（latest 形状复用 M1 §3.4；无遥测行 → latest null）。 */
export const MonitorKeyPointSchema = z.object({
  point_id: z.number().int().positive(),
  display_name: z.string().nullable(),
  quantity_type: z.string().nullable(),
  unit_std: z.string().nullable(),
  latest: z
    .object({
      ts: Rfc3339Schema,
      value: z.number().nullable(),
      value_text: z.string().nullable(),
      quality: z.number().int(),
    })
    .nullable(),
});
export type MonitorKeyPoint = z.infer<typeof MonitorKeyPointSchema>;

export const EquipmentConditionCardSchema = z.object({
  equipment: EquipmentSchema,
  run_state: MonitorRunStateSchema,
  /** 该设备在用 open 告警最严重级（无 → null）。 */
  alarm_worst: AlarmSeveritySchema.nullable(),
  /** 关键点位（run_status + 首条 chw_supply_temp/power，去重 ≤5）。 */
  key_points: z.array(MonitorKeyPointSchema),
});
export type EquipmentConditionCard = z.infer<typeof EquipmentConditionCardSchema>;

export const EquipmentConditionListResponseSchema = z.object({
  items: z.array(EquipmentConditionCardSchema),
  next_cursor: z.string().nullable(),
});
export type EquipmentConditionListResponse = z.infer<typeof EquipmentConditionListResponseSchema>;

// ---------------------------------------------------------------------------
// §3.3 设备工况详情
// ---------------------------------------------------------------------------

export const EquipmentConditionDetailSchema = z.object({
  equipment: EquipmentSchema,
  run_state: MonitorRunStateSchema,
  /** = M1 §3.4 PointListItem（实时值卡 + 曲线点位选择器数据源）。 */
  points: z.array(PointListItemSchema),
  alarms: z.object({
    open_by_severity: z.record(z.enum(ALARM_SEVERITIES), z.number().int().nonnegative()),
    /** top 20 在用告警（M4 域只读聚合，R11 equipment 维度）。 */
    items: z.array(
      z.object({
        id: z.string(),
        severity: AlarmSeveritySchema,
        rule_summary: z.string(),
        opened_at: Rfc3339Schema,
      }),
    ),
  }),
  /** M6（FDD）契约引用；IMPL-16 交付前恒空集（形状先钉死）。 */
  fdd: z.object({
    open_total: z.number().int().nonnegative(),
    items: z.array(
      z.object({
        id: z.string(),
        rule: z.string(),
        severity: AlarmSeveritySchema,
        status: z.enum(['open', 'resolved', 'ignored']),
        detected_at: Rfc3339Schema,
      }),
    ),
  }),
});
export type EquipmentConditionDetail = z.infer<typeof EquipmentConditionDetailSchema>;

// ---------------------------------------------------------------------------
// §3.5 SSE 事件（含 value_text 增补 R5）
// ---------------------------------------------------------------------------

export const TelemetryStreamEventSchema = z.object({
  /** 节流窗口内该连接全部变更点的最新值快照批量（幂等最新值语义；客户端按 point_id 覆写）。 */
  points: z.array(
    z.object({
      point_id: z.number().int().positive(),
      ts: Rfc3339Schema,
      value: z.number().nullable(),
      value_text: z.string().nullable(),
      quality: z.number().int(),
    }),
  ),
});
export type TelemetryStreamEvent = z.infer<typeof TelemetryStreamEventSchema>;

// ---------------------------------------------------------------------------
// §3.6 批量最新值快照（R6）
// ---------------------------------------------------------------------------

export const PointLatestBatchSchema = z.object({
  point_id: z.number().int().positive(),
  /** 无数据点 ts/value 为 null（不 404——校准场景需要「知道没数据」而非报错）。 */
  ts: Rfc3339Schema.nullable(),
  value: z.number().nullable(),
  value_text: z.string().nullable(),
  quality: z.number().int().nullable(),
});
export type PointLatestBatch = z.infer<typeof PointLatestBatchSchema>;

export const PointLatestBatchResponseSchema = z.object({
  items: z.array(PointLatestBatchSchema),
});
export type PointLatestBatchResponse = z.infer<typeof PointLatestBatchResponseSchema>;
