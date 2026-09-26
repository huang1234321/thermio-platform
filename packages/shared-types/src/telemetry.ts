/**
 * 遥测查询契约（modules/overview M1 端点表 / IMPL-12，DAT-115）。
 *
 * 端点（蓝本 implementation-plan IMPL-12）：
 * - GET /points/{id}/latest —— 最新遥测值 + quality + ts；
 * - GET /points/{id}/telemetry?from&to&interval=raw|5min|1h&limit&cursor —— 时序数据，
 *   聚合查询走 cagg（telemetry_5min/telemetry_1h）不扫原始，raw 才扫 hypertable
 *   （ddl.md §11），跨度上限 + 游标分页（API-DSN-03）。
 *
 * 数值治理（platform.md §12 纪律）：分页与跨度上限默认值钉死在本包常量
 * （env 可覆盖，调整走表修订 PR，不散落代码常量 CODE-ST-03）。
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// interval 路由（闭合枚举）
// ---------------------------------------------------------------------------

/** 查询粒度：raw=原始 hypertable；5min/1h=双 continuous aggregate（ddl.md §11.2）。 */
export const TELEMETRY_INTERVALS = ['raw', '5min', '1h'] as const;
export const TelemetryIntervalSchema = z.enum(TELEMETRY_INTERVALS);
export type TelemetryInterval = z.infer<typeof TelemetryIntervalSchema>;

/** 聚合粒度（interval 中走 cagg 的子集）。 */
export const TELEMETRY_AGGREGATE_INTERVALS = ['5min', '1h'] as const;
export const TelemetryAggregateIntervalSchema = z.enum(TELEMETRY_AGGREGATE_INTERVALS);
export type TelemetryAggregateInterval = z.infer<typeof TelemetryAggregateIntervalSchema>;

// ---------------------------------------------------------------------------
// 上限参数（platform.md §12 同款治理：默认值钉死于此，env 可覆盖）
// ---------------------------------------------------------------------------

/**
 * 跨度上限（天），按 interval 分档——阶梯对齐 ADR-005 保留策略：
 * raw 31d（近期排障窗；~1min 采样 × 31d ≈ 4.5 万样本，深历史走聚合档）；
 * 5min 730d（cagg 保留 5 年内的实用趋势窗，M&V 跨季对标量级）；
 * 1h 3650d（cagg 永久保留的实用查询上界，对标报告/KPI 层）。
 * 超限 → 422 telemetry.range_invalid（overview M1 端点表 TELEMETRY_RANGE_INVALID）。
 */
export const TELEMETRY_SPAN_LIMIT_DAYS = {
  raw: 31,
  '5min': 730,
  '1h': 3650,
} as const satisfies Readonly<Record<TelemetryInterval, number>>;

/** 游标分页（API-DSN-03 / platform.md §12：默认 50，上限 200）。 */
export const TELEMETRY_PAGE_LIMIT_DEFAULT = 50;
export const TELEMETRY_PAGE_LIMIT_MAX = 200;

/** from/to 缺省窗（小时）：to 缺省 now，from 缺省 to-24h（趋势图默认窗量级）。 */
export const TELEMETRY_DEFAULT_WINDOW_HOURS = 24;

// ---------------------------------------------------------------------------
// 请求 / 响应 schema（zod 单源，类型 z.infer 推导，platform.md §5.3）
// ---------------------------------------------------------------------------

/** RFC3339 时间戳（允许 Z 或 ±hh:mm 偏移；pg timestamptz 序列化为 ISO Z 形）。 */
export const Rfc3339Schema = z.iso.datetime({ offset: true });
export type Rfc3339 = z.infer<typeof Rfc3339Schema>;

export const PointIdParamSchema = z.coerce.number().int().positive();
export type PointIdParam = z.infer<typeof PointIdParamSchema>;

/** GET /points/{id}/telemetry 查询串（api 入参校验；from/to/limit/cursor 可缺省）。 */
export const TelemetryQuerySchema = z.object({
  from: Rfc3339Schema.optional(),
  to: Rfc3339Schema.optional(),
  interval: TelemetryIntervalSchema.default('raw'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(TELEMETRY_PAGE_LIMIT_MAX)
    .default(TELEMETRY_PAGE_LIMIT_DEFAULT),
  cursor: z.string().min(1).max(512).optional(),
});
export type TelemetryQueryInput = z.input<typeof TelemetryQuerySchema>;
export type TelemetryQuery = z.output<typeof TelemetryQuerySchema>;

/** GET /points/{id}/latest 200 响应：最新一行遥测（value/value_text 互斥可空）。 */
export const PointLatestSchema = z.object({
  point_id: z.number().int().positive(),
  ts: Rfc3339Schema,
  value: z.number().nullable(),
  value_text: z.string().nullable(),
  /** quality 位掩码 smallint（0=good，位表 ingest.md §4 v1 冻结，透传不解释）。 */
  quality: z.number().int(),
});
export type PointLatest = z.infer<typeof PointLatestSchema>;

/** raw 样本（hypertable 行，ddl.md §11.1）。 */
export const TelemetryRawSampleSchema = z.object({
  ts: Rfc3339Schema,
  value: z.number().nullable(),
  value_text: z.string().nullable(),
  quality: z.number().int(),
});
export type TelemetryRawSample = z.infer<typeof TelemetryRawSampleSchema>;

/** 5min/1h 聚合桶（cagg 行，ddl.md §11.2 列名原样）。 */
export const TelemetryAggregateSampleSchema = z.object({
  bucket: Rfc3339Schema,
  avg: z.number().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  last: z.number().nullable(),
  stddev: z.number().nullable(),
  sample_count: z.number().int().nonnegative(),
  bad_count: z.number().int().nonnegative(),
  quality_mask: z.number().int(),
});
export type TelemetryAggregateSample = z.infer<typeof TelemetryAggregateSampleSchema>;

/** 游标分页响应统一形状（API-DSN-03：{ items, next_cursor }）。 */
const TelemetryPageBase = {
  point_id: z.number().int().positive(),
  from: Rfc3339Schema,
  to: Rfc3339Schema,
  next_cursor: z.string().nullable(),
} as const;

export const RawTelemetryPageSchema = z.object({
  ...TelemetryPageBase,
  interval: z.literal('raw'),
  items: z.array(TelemetryRawSampleSchema),
});
export type RawTelemetryPage = z.infer<typeof RawTelemetryPageSchema>;

export const AggregateTelemetryPageSchema = z.object({
  ...TelemetryPageBase,
  interval: TelemetryAggregateIntervalSchema,
  items: z.array(TelemetryAggregateSampleSchema),
});
export type AggregateTelemetryPage = z.infer<typeof AggregateTelemetryPageSchema>;

/** telemetry 端点 200 响应（raw 与聚合两形，按 interval 判别）。 */
export const TelemetryPageSchema = z.union([RawTelemetryPageSchema, AggregateTelemetryPageSchema]);
export type TelemetryPage = z.infer<typeof TelemetryPageSchema>;
