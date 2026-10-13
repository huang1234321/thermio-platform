/**
 * M11 能耗与 KPI 看板域 wire 契约与容量参数（modules/M11-kpi-dashboard.md §4/§5，
 * IMPL-22 / DAT-246）。
 *
 * 单源纪律：
 * - 枚举三组在 enums.ts（platform.md §6.3 v1.8）；容量参数不新立——任务面并发/
 *   留存/下载沿 M9 §1.7（MV_EXPORT_* 常量，mv.ts），本文件只钉 M11 增量维度
 *   （platform.md §12 v1.8 增补三行：渲染并发 1 / 楼宇每小时导出 ≤20 / 收件人 ≤20）；
 * - jsonb 形状（recipients 等）以 zod schema 单源，PG 侧直传；
 * - export_job 消费面（§4.6）不另立 zod 双源：形状本体 = M9 MvExportJob（mv.ts），
 *   本域列表/详情恒 resource_type='fdd_report'。
 */
import { z } from 'zod';
import {
  FDD_DIGEST_DELIVERY_STATUSES,
  KPI_BENCHMARK_SOURCES,
  KPI_BUCKET_STATUSES,
} from './enums.js';

// ---------------------------------------------------------------------------
// 容量参数（platform.md §12 v1.8 增补；M11 §10-R3）
// ---------------------------------------------------------------------------

/** 时间窗跨度硬上限（天，M11 §2.3：对齐 M1 §3.7 深区间上限）。 */
export const KPI_SPAN_MAX_DAYS = 731;
/** 趋势桶数上限（schema 钉死：731 天 + 边界余量，§4.3 .max(732)）。 */
export const KPI_TREND_MAX_BUCKETS = 732;
/** fdd_report 渲染并发（每 api 实例）：puppeteer 单渲染槽（M11 §6.1 裁决）。 */
export const FDD_EXPORT_RENDER_CONCURRENCY = 1;
/** 导出请求限速（每楼宇每小时）：超出 429 common.rate_limited（M11 §5.4）。 */
export const FDD_EXPORT_PER_BUILDING_HOURLY = 20;
/** 订阅收件人上限（每订阅）：超出 422 digest.recipient_invalid（M11 §5.8）。 */
export const FDD_DIGEST_RECIPIENTS_MAX = 20;
/** 订阅投递时刻（v1 仅周投递，M11 §3.3 CHECK 集；本地时区 Asia/Shanghai）。 */
export const FDD_DIGEST_SCHEDULE = 'monday_08:00';

const LIMIT = z.coerce.number().int().min(1).max(200).default(50);
const CURSOR = z.string().min(1).max(512);
const RFC3339 = z.iso.datetime({ offset: true });

// ---------------------------------------------------------------------------
// §4.2 KpiOverview（GET /kpi/overview 响应，§5.1）
// ---------------------------------------------------------------------------

/** 对标基准状态：ok=有可比基准 / missing=未配置 / unlinked=源待接入（§2.5）。 */
export const KpiBenchmarkStatusSchema = z.enum(['ok', 'missing', 'unlinked']);
export type KpiBenchmarkStatus = z.infer<typeof KpiBenchmarkStatusSchema>;

export const KpiBenchmarkSchema = z.object({
  status: KpiBenchmarkStatusSchema,
  source: z.enum(KPI_BENCHMARK_SOURCES), // missing 时 = 'none'
  /** ok 时页面口径来源标签（AC-8 后半句）。 */
  source_label: z.string().nullable(),
  baseline_kwh: z.number().nullable(),
  /** (实际−基准)÷基准；基准 0/缺失 = null。 */
  deviation_pct: z.number().nullable(),
  /** unlinked 时：'mv_baseline_pending' 等。 */
  unlinked_reason: z.string().nullable(),
});
export type KpiBenchmark = z.infer<typeof KpiBenchmarkSchema>;

export const KpiOverviewSchema = z.object({
  building_id: z.uuid().nullable(), // 缺省合并聚合 = null
  window: z.object({ from: RFC3339, to: RFC3339 }),
  energy: z.object({
    /** 窗口能耗（§2.2）；无点位/无数据 = null（空态）。 */
    total_kwh: z.number().nullable(),
    /** (ok+uncertain) ÷ 应有桶数。 */
    coverage: z.number().min(0).max(1),
    /** ÷ gross_area_m2；面积缺失 = null → 卡不渲染（§2.6）。 */
    eui_kwh_m2: z.number().nullable(),
    /** false = 能耗点位集为空（量型未登记/表未接入，§2.1）。 */
    linked: z.boolean(),
  }),
  benchmark: KpiBenchmarkSchema,
  proposal_acceptance: z.object({
    /** S1 逐字（PRD §7）：approved(含 executed/failed) ÷ (approved+rejected)。 */
    rate: z.number().min(0).max(1).nullable(),
    decided: z.number().int(),
    approved: z.number().int(),
    /** 单独观测不入分母。 */
    expired: z.number().int(),
    /** 统计源异常 → 卡「暂不可用」（PRD 卡 R5）。 */
    unavailable: z.boolean(),
  }),
  fdd_hit_rate: z.object({
    /** S3 抽检口径 = M6 §4.5 同式（7×24h 滚动）；reviewed=0 → null。 */
    hit_rate: z.number().min(0).max(1).nullable(),
    reviewed: z.number().int(),
    confirmed: z.number().int(),
  }),
  /** M9 前 linked=false（§2.6 占位纪律）。 */
  saving: z.object({ kwh: z.number().nullable(), linked: z.boolean() }),
  freshness: z.object({
    includes_realtime: z.boolean(),
    data_as_of: RFC3339,
  }),
});
export type KpiOverview = z.infer<typeof KpiOverviewSchema>;

export const KpiOverviewQuerySchema = z
  .object({
    building_id: z.uuid().optional(),
    from: RFC3339.optional(),
    to: RFC3339.optional(),
  })
  .strict();
export type KpiOverviewQuery = z.infer<typeof KpiOverviewQuerySchema>;

// ---------------------------------------------------------------------------
// §4.3 KpiEnergyTrend（GET /kpi/energy/trend 响应，§5.2）
// ---------------------------------------------------------------------------

export const KpiTrendBucketSchema = z.object({
  /** 桶起点（hour|day 由 interval 定）。 */
  bucket: RFC3339,
  /** gap 桶 null（不插值）。 */
  total_kwh: z.number().nullable(),
  status: z.enum(KPI_BUCKET_STATUSES),
  /** 进行中小时/当日（§2.2）。 */
  partial: z.boolean(),
  /** group_by=none 时空数组。 */
  groups: z.array(z.object({ key: z.string(), kwh: z.number().nullable() })),
});
export type KpiTrendBucket = z.infer<typeof KpiTrendBucketSchema>;

export const KpiEnergyTrendSchema = z.object({
  interval: z.enum(['hour', 'day']),
  group_by: z.enum(['none', 'system_type', 'equipment_type']),
  buckets: z.array(KpiTrendBucketSchema).max(KPI_TREND_MAX_BUCKETS),
  coverage: z.number().min(0).max(1),
  benchmark: KpiBenchmarkSchema,
  /** 仅 status='ok' 且源为序列型时非空；fixed 源不给序列（§5.2，避免伪造数据点）。 */
  benchmark_series: z
    .array(z.object({ bucket: RFC3339, value_kwh: z.number().nullable() }))
    .nullable(),
});
export type KpiEnergyTrend = z.infer<typeof KpiEnergyTrendSchema>;

/**
 * interval/group_by 收宽松 string、服务端白名单校验后抛 422 kpi.range_invalid
 * （details 字段定位，§5.9 用例 4——zod enum 拒绝只会给 common.validation_failed，
 * 无字段定位；与 §4.8 码表语义对齐）。
 */
export const KpiTrendQuerySchema = z
  .object({
    building_id: z.uuid().optional(),
    from: RFC3339,
    to: RFC3339,
    interval: z.string().max(8).optional(),
    group_by: z.string().max(20).optional(),
  })
  .strict();
export type KpiTrendQuery = z.infer<typeof KpiTrendQuerySchema>;

// ---------------------------------------------------------------------------
// §4.4 KpiEnergyStructure（GET /kpi/energy/structure 响应，§5.3）
// ---------------------------------------------------------------------------

export const KpiEnergyStructureSchema = z.object({
  group_by: z.enum(['system_type', 'equipment_type']),
  window: z.object({ from: RFC3339, to: RFC3339 }),
  total_kwh: z.number().nullable(),
  coverage: z.number().min(0).max(1),
  items: z
    .array(
      z.object({
        /** system_type/equipment_type 值或 'unclassified'（恒末位）。 */
        key: z.string(),
        kwh: z.number().nullable(),
        /** total 为 0/null 时 null。 */
        share_pct: z.number().min(0).max(100).nullable(),
      }),
    )
    .max(12),
});
export type KpiEnergyStructure = z.infer<typeof KpiEnergyStructureSchema>;

export const KpiStructureQuerySchema = z
  .object({
    building_id: z.uuid().optional(),
    from: RFC3339,
    to: RFC3339,
    group_by: z.enum(['system_type', 'equipment_type']).optional(),
  })
  .strict();
export type KpiStructureQuery = z.infer<typeof KpiStructureQuerySchema>;

// ---------------------------------------------------------------------------
// §4.5 KpiBenchmarkConfig（GET/PUT /kpi/benchmark-config，§5.5）
// ---------------------------------------------------------------------------

export const KpiBenchmarkConfigSchema = z.object({
  building_id: z.uuid(),
  source: z.enum(KPI_BENCHMARK_SOURCES),
  /** 仅 source='fixed' 必填（服务端按 source 校验，§5.5）。 */
  params: z.object({ kwh_per_day: z.number().positive().optional() }),
  updated_by_name: z.string().nullable(),
  updated_at: RFC3339.nullable(),
});
export type KpiBenchmarkConfig = z.infer<typeof KpiBenchmarkConfigSchema>;

export const KpiBenchmarkConfigQuerySchema = z.object({ building_id: z.uuid() }).strict();
export type KpiBenchmarkConfigQuery = z.infer<typeof KpiBenchmarkConfigQuerySchema>;

/** PUT body = KpiBenchmarkConfig 去审计字段（§5.5；全量替换幂等）。 */
export const KpiBenchmarkConfigPutSchema = z
  .object({
    source: z.enum(KPI_BENCHMARK_SOURCES),
    params: z.object({ kwh_per_day: z.number().positive().optional() }),
  })
  .strict();
export type KpiBenchmarkConfigPut = z.infer<typeof KpiBenchmarkConfigPutSchema>;

// ---------------------------------------------------------------------------
// §4.6 export_job fdd 消费面（GET /kpi/export-jobs*，§5.6/§5.7）
// ---------------------------------------------------------------------------

/**
 * 形状本体 = M9 MvExportJob（共用载体单源，防双源漂移——§4.6 注记）；本域查询
 * 白名单与 M9 §7 逐字一致，列表恒 resource_type='fdd_report'（服务端钉死）。
 */
export const FddExportJobsQuerySchema = z
  .object({
    status: z.enum(['queued', 'running', 'succeeded', 'failed']).optional(),
    resource_id: z.uuid().optional(),
    limit: LIMIT,
    cursor: CURSOR.optional(),
  })
  .strict();
export type FddExportJobsQuery = z.infer<typeof FddExportJobsQuerySchema>;

// ---------------------------------------------------------------------------
// §4.7 FddDigestConfig / FddDigestDelivery（GET/PUT /fdd/digest*，§5.8）
// ---------------------------------------------------------------------------

export const FddDigestRecipientSchema = z.object({
  email: z.email().max(320),
  note: z.string().max(50).optional(),
});
export type FddDigestRecipient = z.infer<typeof FddDigestRecipientSchema>;

export const FddDigestConfigSchema = z.object({
  building: z.object({ id: z.uuid(), name: z.string() }),
  enabled: z.boolean(),
  period_type: z.literal('week'),
  schedule: z.literal(FDD_DIGEST_SCHEDULE),
  recipients: z.array(FddDigestRecipientSchema).max(FDD_DIGEST_RECIPIENTS_MAX),
  updated_by_name: z.string().nullable(),
  updated_at: RFC3339.nullable(),
});
export type FddDigestConfig = z.infer<typeof FddDigestConfigSchema>;

export const FddDigestQuerySchema = z.object({ building_id: z.uuid() }).strict();
export type FddDigestQuery = z.infer<typeof FddDigestQuerySchema>;

/**
 * PUT body（§5.8；全量替换幂等）。recipients 收宽松 string——逐项邮箱格式 + ≤20 上限
 * 在服务端校验后抛 422 digest.recipient_invalid（details 指明序号，§5.9 用例 11；
 * zod enum 拒绝只会给 common.validation_failed，无序号定位）。
 */
export const FddDigestPutSchema = z
  .object({
    enabled: z.boolean(),
    recipients: z
      .array(
        z.object({
          email: z.string().min(3).max(320),
          note: z.string().max(50).optional(),
        }),
      )
      .max(64),
  })
  .strict();
export type FddDigestPut = z.infer<typeof FddDigestPutSchema>;

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ISO 日期（YYYY-MM-DD）');

export const FddDigestDeliveryItemSchema = z.object({
  id: z.uuid(),
  building: z.object({ id: z.uuid(), name: z.string() }),
  period: z.object({ start: ISO_DATE, end: ISO_DATE }),
  /** 可空：skipped_no_report 态无报告。 */
  report_id: z.uuid().nullable(),
  status: z.enum(FDD_DIGEST_DELIVERY_STATUSES),
  skip_reason: z.string().nullable(),
  recipients_count: z.number().int(),
  /** failed 态：SMTP 错误摘要（不含收件人地址全文，PII 纪律）。 */
  failure_msg: z.string().nullable(),
  delivered_at: RFC3339.nullable(),
  created_at: RFC3339,
});
export type FddDigestDeliveryItem = z.infer<typeof FddDigestDeliveryItemSchema>;

export const FddDigestDeliveryListSchema = z.object({
  items: z.array(FddDigestDeliveryItemSchema),
  next_cursor: z.string().nullable(),
});
export type FddDigestDeliveryList = z.infer<typeof FddDigestDeliveryListSchema>;

export const FddDigestDeliveriesQuerySchema = z
  .object({
    building_id: z.uuid().optional(),
    from: RFC3339.optional(),
    to: RFC3339.optional(),
    limit: LIMIT,
    cursor: CURSOR.optional(),
  })
  .strict();
export type FddDigestDeliveriesQuery = z.infer<typeof FddDigestDeliveriesQuerySchema>;
