/**
 * M3 监控域 API 契约（admin 侧镜像；M3-monitor §3.1/§3.2/§3.3 逐字段）。
 *
 * 挂账注记（DAT-104 口径，不私改 shared-types）：monitor 域响应 schema 的
 * 正式归宿是 shared-types（api 落码时单源化）；api 端点未落码前（IMPL-14
 * 数据面在途）先镜像于此，字段注释与 M3-monitor 对齐——api 合入后本文件
 * 改为 re-export 即可，页面零改动。
 *
 * 复用声明：Equipment / Point / PointLatest 形状直接引用 @thermio/shared-types
 * （M1 §2.3/§3.4「资源形状不重复定义」），不在此重写。
 */
import { z } from 'zod';
import {
  EquipmentSchema,
  PointSchema,
  PointLatestSchema,
  QuantityTypeSchema,
} from '@thermio/shared-types';
import { AlarmSeveritySchema, RunStateSchema, SceneKindSchema } from '@thermio/scene-schema';

/** GET /monitor/overview（§3.1：3D 全屏 + KPI 悬浮层数据面；60s 轮询）。 */
export const MonitorOverviewSchema = z.object({
  building: z.object({ id: z.uuid(), name: z.string().min(1) }),
  scenes: z.array(z.object({ id: z.uuid(), name: z.string().min(1), kind: SceneKindSchema })),
  kpi: z.object({
    energy_today_kwh: z.number().nullable(),
    energy_period_kwh: z.number().nullable(),
    saving_period_kwh: z.number().nullable(),
    load_rate_pct: z.number().nullable(),
    load_rate_linked: z.boolean(),
    alarms: z.object({
      open_total: z.number().int().nonnegative(),
      open_by_severity: z.record(AlarmSeveritySchema, z.number().int().nonnegative()),
    }),
  }),
  gateways: z.object({
    online: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
});
export type MonitorOverview = z.infer<typeof MonitorOverviewSchema>;

/** 关键点位实时值（§3.2 PointLatest 复用形状：M1 §3.4 latest + 展示元数据）。 */
export const MonitorPointLatestSchema = z.object({
  point_id: z.number().int().positive(),
  display_name: z.string().max(128).nullable(),
  quantity_type: QuantityTypeSchema.nullable(),
  unit_std: z.string().max(32).nullable(),
  latest: PointLatestSchema.nullable(),
});
export type MonitorPointLatest = z.infer<typeof MonitorPointLatestSchema>;

/** GET /monitor/equipments 列表项（§3.2 EquipmentConditionCard）。 */
export const EquipmentConditionCardSchema = z.object({
  equipment: EquipmentSchema,
  run_state: RunStateSchema,
  alarm_worst: AlarmSeveritySchema.nullable(),
  key_points: z.array(MonitorPointLatestSchema),
});
export type EquipmentConditionCard = z.infer<typeof EquipmentConditionCardSchema>;

export const EquipmentConditionListSchema = z.object({
  items: z.array(EquipmentConditionCardSchema),
  next_cursor: z.string().nullable(),
});
export type EquipmentConditionList = z.infer<typeof EquipmentConditionListSchema>;

/** GET /monitor/equipments/{id}（§3.3 EquipmentConditionDetail）。 */
export const EquipmentConditionDetailSchema = z.object({
  equipment: EquipmentSchema,
  run_state: RunStateSchema,
  points: z.array(
    z.object({
      point: PointSchema,
      latest: PointLatestSchema.nullable(),
    }),
  ),
  alarms: z.object({
    open_by_severity: z.record(AlarmSeveritySchema, z.number().int().nonnegative()),
    items: z.array(
      z.object({
        id: z.string().min(1),
        severity: AlarmSeveritySchema,
        rule_summary: z.string().min(1),
        opened_at: z.string(),
      }),
    ),
  }),
  fdd: z.object({
    open_total: z.number().int().nonnegative(),
    items: z.array(
      z.object({
        id: z.string().min(1),
        rule: z.string().min(1),
        severity: AlarmSeveritySchema,
        status: z.enum(['open', 'resolved', 'ignored']),
        detected_at: z.string(),
      }),
    ),
  }),
});
export type EquipmentConditionDetail = z.infer<typeof EquipmentConditionDetailSchema>;

/** 告警快照条目（页面聚合 GET /alarms?status=open 的消费形状；M3 §6.3 接缝）。 */
export const OpenAlarmSchema = z.object({
  id: z.string().min(1),
  severity: AlarmSeveritySchema,
  rule_summary: z.string().min(1),
  opened_at: z.string(),
  object_ids: z.array(z.string().min(1)),
});
export type OpenAlarm = z.infer<typeof OpenAlarmSchema>;

/** GET /points/latest?point_ids= 批量快照（§3.6：SSE 重连校准 / 首屏初值）。 */
export const PointsLatestBatchSchema = z.object({
  items: z.array(
    z.object({
      point_id: z.number().int().positive(),
      latest: PointLatestSchema.nullable(),
    }),
  ),
});
export type PointsLatestBatch = z.infer<typeof PointsLatestBatchSchema>;
