/**
 * M&V 域 wire 契约与计算参数常量（modules/M9-mv-report.md §1.7/§2/§3/§6，
 * IMPL-21 / DAT-242）。
 *
 * 单源纪律：
 * - §3.1 参数常量（默认值）在此钉死，api 与 admin 同源消费——改值 = 发版动作
 *   （快照测试钉住，platform §12 同机制）；
 * - jsonb 形状（§2.3/§3.4/§3.5/§3.6）以 zod schema 单源，PG 侧 jsonb 直传
 *   （DDL 列名 = API 字段名，snake_case 直传）；
 * - 日期 daterange 一律 {start, end}（ISO 日期，[start, end) 半开——DDL daterange
 *   语义直传）；筛选白名单外参数 → 422（strict zod，API-DSN-04）。
 */
import { z } from 'zod';
import {
  MV_BASELINE_STATUSES,
  MV_EXPORT_FORMATS,
  MV_EXPORT_RESOURCE_TYPES,
  MV_JOB_STATUSES,
  MV_METHODS,
  MV_MODEL_TYPES,
} from './enums.js';

// ---------------------------------------------------------------------------
// §3.1 计算参数（默认值进常量；快照测试钉死）
// ---------------------------------------------------------------------------

export const MV_MIN_BASELINE_DAYS = 90;
export const MV_MAX_BASELINE_DAYS = 731;
/** 日完整判定：该点当日 24/24 个 1h 桶全有值（不做小时插补）。 */
export const MV_DAY_HOURS_MIN = 24;
/** 当点当日 bad_count/sample_count > 5% → 该日不完整。 */
export const MV_DAY_BAD_RATIO_MAX = 0.05;
/** 激活完整率门槛：完整日/基线期总日 ≥ 90%。 */
export const MV_WINDOW_COVERAGE_MIN = 0.9;
/** 天气日完整小时数：当日 ≥20 个整点有观测。 */
export const MV_WEATHER_HOURS_MIN = 20;
/** 报告期天气覆盖率门槛：< 95% → 降级（不拒绝）。 */
export const MV_PERIOD_WEATHER_MIN = 0.95;
/** 报告期能量完整率门槛：< 90% → 拒绝 mv.period_data_insufficient。 */
export const MV_PERIOD_ENERGY_MIN = 0.9;
/** 制冷/制热平衡点（GB 节能设计惯例值；人工显式参数，非自动搜索）。 */
export const MV_T_COOL_C = 26;
export const MV_T_HEAT_C = 18;
export const MV_WEEKEND_DUMMY = true;
/** 拟合合格线（ASHRAE Guideline 14 日常模型常用合格线）。 */
export const MV_FIT_CVRMSE_MAX = 30;
export const MV_FIT_NMBE_MAX = 10;
/** 置信水平：IPMVP 惯例 68%（≈1σ）。 */
export const MV_CI_LEVEL = 0.68;
/** 不确定性警示线：half_width > 0.5×|saving| → uncertainty_high（警示不阻断）。 */
export const MV_UNCERTAINTY_RATIO_MAX = 0.5;
/** 补传缓冲期（ADR-003 网关断网缓存 + cagg start_offset 对齐）。 */
export const MV_LATE_BUFFER_DAYS = 5;

// ---------------------------------------------------------------------------
// §1.7 容量参数
// ---------------------------------------------------------------------------

/** 生成任务并发（每租户）：超出 429 common.rate_limited。 */
export const MV_GENERATION_CONCURRENCY = 2;
/** 导出任务并发（每租户）：超出 429。 */
export const MV_EXPORT_CONCURRENCY = 2;
/** 导出件保留天数（到期清理，下载 → 409 mv.export_file_expired）。 */
export const MV_EXPORT_RETENTION_DAYS = 30;
/** 报告期长度上下限（天）。 */
export const MV_REPORT_PERIOD_MIN_DAYS = 1;
export const MV_REPORT_PERIOD_MAX_DAYS = 731;
/** 签名下载 URL 有效期（分钟，M3 §2.3 同款 60min）。 */
export const MV_DOWNLOAD_URL_TTL_MINUTES = 60;

// ---------------------------------------------------------------------------
// 基础形状
// ---------------------------------------------------------------------------

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ISO 日期（YYYY-MM-DD）');
const LIMIT = z.coerce.number().int().min(1).max(200).default(50);
const CURSOR = z.string().min(1).max(512);
const RFC3339 = z.iso.datetime({ offset: true });

/** daterange 半开区间 [start, end)（DDL daterange 语义直传）。 */
export const DateRangeSchema = z
  .object({ start: ISO_DATE, end: ISO_DATE })
  .refine((v) => v.start < v.end, '期起必须早于期止');
export type DateRange = z.infer<typeof DateRangeSchema>;

/** 异步任务失败形状（M2 §4.4 同族：{stage, code, message, detail?}）。 */
export const MvJobFailureSchema = z.object({
  stage: z.string().min(1),
  code: z.string().min(1),
  message: z.string().min(1),
  detail: z.unknown().optional(),
});
export type MvJobFailure = z.infer<typeof MvJobFailureSchema>;

// ---------------------------------------------------------------------------
// §3.4 model_params jsonb 形状（active 起冻结）
// ---------------------------------------------------------------------------

/** 平衡点与周末哑变量（人工显式参数；§3.4 spec）。 */
export const MvModelSpecSchema = z.object({
  t_cool_c: z.number().min(-40).max(60),
  t_heat_c: z.number().min(-40).max(60),
  weekend_dummy: z.boolean(),
});
export type MvModelSpec = z.infer<typeof MvModelSpecSchema>;

/**
 * model_params jsonb：拟合成功时系数/度量/(X'X)⁻¹/日均锚齐全（§3.4 示例全集）；
 * 拟合不可行（n_obs 不足）时拟合族字段为 null、spec 仍持久（编辑表单回显依赖）。
 * (X'X)⁻¹ 与 sigma 随本形状冻结——报告期换设计矩阵即可复算置信区间（§3.6-5）。
 */
export const MvModelParamsSchema = z.object({
  model_type: z.enum(MV_MODEL_TYPES),
  model_version: z.literal(1),
  spec: MvModelSpecSchema,
  coefficients: z
    .object({ b0: z.number(), b1: z.number(), b2: z.number(), b3: z.number().nullable() })
    .nullable(),
  stderrs: z
    .object({ b0: z.number(), b1: z.number(), b2: z.number(), b3: z.number().nullable() })
    .nullable(),
  sigma_kwh: z.number().nullable(),
  n_obs: z.number().int().min(0),
  metrics: z
    .object({
      r2: z.number(),
      adj_r2: z.number(),
      rmse_kwh: z.number(),
      cvrmse_pct: z.number(),
      nmbe_pct: z.number(),
    })
    .nullable(),
  /** (X'X)⁻¹（p×p，行主序；CI 复算冻结载体）。weekend_dummy 关闭时 3×3。 */
  xtx_inv: z.array(z.array(z.number())).nullable(),
  /** 基线拟合样本日均能耗（Ē_fit，口径 A 基线参照的复得锚，§3.6-3）。 */
  fit_daily_mean_kwh: z.number().nullable(),
  /** 拟合样本均值设计行（报告期缺天气日回退 Ē_fit 的方差贡献行，§3.6-4）。 */
  fit_mean_row: z.array(z.number()).nullable(),
  fitted_days: z.number().int().min(0),
  season_coverage: z.enum(['full', 'partial']),
  fit_run_at: RFC3339.nullable(),
});
export type MvModelParams = z.infer<typeof MvModelParamsSchema>;

// ---------------------------------------------------------------------------
// §3.5 validation_result jsonb 形状（激活门槛载体）
// ---------------------------------------------------------------------------

export const MvWindowGapSchema = z.object({
  from: ISO_DATE,
  to: ISO_DATE,
  days: z.number().int().min(1),
  points_affected: z.array(z.string().min(1)),
  cause: z.enum(['reset', 'hours', 'bad_ratio']),
});
export type MvWindowGap = z.infer<typeof MvWindowGapSchema>;

export const MvValidationResultSchema = z.object({
  validated_at: RFC3339,
  window: z.object({
    period_days: z.number().int().min(0),
    complete_days: z.number().int().min(0),
    coverage: z.number().min(0).max(1),
    required: z.object({ min_days: z.number().int(), min_coverage: z.number() }),
    gaps: z.array(MvWindowGapSchema),
  }),
  fit: z
    .object({
      n_obs: z.number().int().min(0),
      coefficients: MvModelParamsSchema.shape.coefficients,
      metrics: MvModelParamsSchema.shape.metrics,
      qualified: z.boolean(),
      thresholds: z.object({ cvrmse_max_pct: z.number(), nmbe_max_pct: z.number() }),
    })
    .nullable(),
  weather: z.object({
    station_id: z.string().min(1),
    valid_days: z.number().int().min(0),
    coverage: z.number().min(0).max(1),
  }),
});
export type MvValidationResult = z.infer<typeof MvValidationResultSchema>;

// ---------------------------------------------------------------------------
// §3.6 confidence_interval jsonb 形状（降级时 NULL）
// ---------------------------------------------------------------------------

export const MvConfidenceIntervalSchema = z.object({
  level: z.literal(MV_CI_LEVEL),
  half_width_kwh: z.number(),
  lower_kwh: z.number(),
  upper_kwh: z.number(),
  sigma_kwh: z.number(),
  cvrmse_pct: z.number(),
  n_obs: z.number().int().min(1),
  weather_coverage_pct: z.number().min(0).max(1),
  uncertainty_high: z.boolean(),
  imputed_days: z.number().int().min(0),
});
export type MvConfidenceInterval = z.infer<typeof MvConfidenceIntervalSchema>;

// ---------------------------------------------------------------------------
// 基线资源（§2.1/§6.1/§6.4）
// ---------------------------------------------------------------------------

export const MvBaselineSummarySchema = z.object({
  id: z.uuid(),
  building_id: z.uuid(),
  method: z.enum(MV_METHODS),
  baseline_period: DateRangeSchema,
  status: z.enum(MV_BASELINE_STATUSES),
  weather_source: z.string().min(1),
  model_type: z.enum(MV_MODEL_TYPES),
  season_coverage: z.enum(['full', 'partial']).nullable(),
  activated_at: RFC3339.nullable(),
  created_at: RFC3339,
});
export type MvBaselineSummary = z.infer<typeof MvBaselineSummarySchema>;

/** 计量边界点位摘要（point 表联查，§6.4 GET 详情）。 */
export const MvMeteringPointSchema = z.object({
  point_id: z.number().int(),
  name: z.string(),
  local_id: z.string().nullable(),
  unit: z.string().nullable(),
});
export type MvMeteringPoint = z.infer<typeof MvMeteringPointSchema>;

export const MvBaselineDetailSchema = MvBaselineSummarySchema.extend({
  model_params: MvModelParamsSchema.nullable(),
  validation_result: MvValidationResultSchema.nullable(),
  metering_points: z.array(MvMeteringPointSchema),
  report_count: z.number().int().min(0),
  activated_by: z.uuid().nullable(),
  retired_by: z.uuid().nullable(),
  retired_at: RFC3339.nullable(),
});
export type MvBaselineDetail = z.infer<typeof MvBaselineDetailSchema>;

export const MvBaselineListSchema = z.object({
  items: z.array(MvBaselineSummarySchema),
  next_cursor: z.string().nullable(),
});
export type MvBaselineList = z.infer<typeof MvBaselineListSchema>;

export const MvBaselinesQuerySchema = z
  .object({
    building_id: z.uuid().optional(),
    status: z.enum(MV_BASELINE_STATUSES).optional(),
    limit: LIMIT,
    cursor: CURSOR.optional(),
  })
  .strict();
export type MvBaselinesQuery = z.infer<typeof MvBaselinesQuerySchema>;

export const MvBaselineCreateSchema = z
  .object({
    building_id: z.uuid(),
    method: z.enum(MV_METHODS).default('ipmvp_option_c'),
    baseline_period: DateRangeSchema,
    model_type: z.enum(MV_MODEL_TYPES).default('ols_daily_cdd_hdd'),
    model_spec: MvModelSpecSchema.partial().default({}),
    metering_point_ids: z.array(z.number().int().positive()).min(1).max(200),
    weather_source: z.string().min(1).max(64),
  })
  .strict();
export type MvBaselineCreate = z.infer<typeof MvBaselineCreateSchema>;

/** §4.1 不可变纪律：PATCH 仅 draft 且只开口径四项（期/模型参数/计量边界/天气站点）。 */
export const MvBaselinePatchSchema = z
  .object({
    baseline_period: DateRangeSchema.optional(),
    model_spec: MvModelSpecSchema.partial().optional(),
    metering_point_ids: z.array(z.number().int().positive()).min(1).max(200).optional(),
    weather_source: z.string().min(1).max(64).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, '至少提供一个字段');
export type MvBaselinePatch = z.infer<typeof MvBaselinePatchSchema>;

export const MvBaselineActivateSchema = z.object({ supersede: z.uuid().optional() }).strict();
export type MvBaselineActivate = z.infer<typeof MvBaselineActivateSchema>;

export const MvBaselineActivateResponseSchema = z.object({
  id: z.uuid(),
  status: z.literal('active'),
  superseded: z.array(z.uuid()),
});
export type MvBaselineActivateResponse = z.infer<typeof MvBaselineActivateResponseSchema>;

// ---------------------------------------------------------------------------
// 报告资源（§2.3/§6.8/§6.9）
// ---------------------------------------------------------------------------

export const MvReportStatusSchema = z.enum(['pending_approval', 'approved']);
export type MvReportStatus = z.infer<typeof MvReportStatusSchema>;

export const MvReportSummarySchema = z.object({
  id: z.uuid(),
  baseline_id: z.uuid(),
  report_period: DateRangeSchema,
  status: MvReportStatusSchema,
  degraded: z.boolean(),
  weather_adjusted_saving_kwh: z.number().nullable(),
  raw_saving_kwh: z.number(),
  generated_at: RFC3339,
  approved_at: RFC3339.nullable(),
});
export type MvReportSummary = z.infer<typeof MvReportSummarySchema>;

export const MvReportSeriesPointSchema = z.object({
  date: ISO_DATE,
  /** 口径 B 逐日基线预测 Ŝ_d（天气无效日/降级报告为 null）。 */
  baseline_pred_kwh: z.number().nullable(),
  /** 实测日能耗（缺口日为插补值 Ê_d；§3.6-2）。 */
  actual_kwh: z.number().nullable(),
});
export type MvReportSeriesPoint = z.infer<typeof MvReportSeriesPointSchema>;

export const MvReportDetailSchema = MvReportSummarySchema.extend({
  baseline_energy_kwh: z.number(),
  actual_energy_kwh: z.number(),
  confidence_interval: MvConfidenceIntervalSchema.nullable(),
  imputed_days: z.number().int().min(0),
  late_buffer: z.boolean(),
  requested_by: z.uuid(),
  approved_by: z.uuid().nullable(),
  /** §3.6 编号：MV-{building_code}-{start}-{end}-{short(report_id)}。 */
  report_no: z.string().min(1),
  series: z.array(MvReportSeriesPointSchema),
  calib: z.object({
    model_params: MvModelParamsSchema.nullable(),
    validation: MvValidationResultSchema.nullable(),
  }),
});
export type MvReportDetail = z.infer<typeof MvReportDetailSchema>;

export const MvReportListSchema = z.object({
  items: z.array(MvReportSummarySchema),
  next_cursor: z.string().nullable(),
});
export type MvReportList = z.infer<typeof MvReportListSchema>;

export const MvReportsQuerySchema = z
  .object({
    building_id: z.uuid().optional(),
    baseline_id: z.uuid().optional(),
    approved: z.coerce.boolean().optional(),
    degraded: z.coerce.boolean().optional(),
    limit: LIMIT,
    cursor: CURSOR.optional(),
  })
  .strict();
export type MvReportsQuery = z.infer<typeof MvReportsQuerySchema>;

export const MvReportApproveResponseSchema = z.object({
  id: z.uuid(),
  status: z.literal('approved'),
  approved_by: z.uuid(),
  approved_at: RFC3339,
});
export type MvReportApproveResponse = z.infer<typeof MvReportApproveResponseSchema>;

// ---------------------------------------------------------------------------
// 生成任务（§2.4/§6.2/§6.3）
// ---------------------------------------------------------------------------

export const MvGenerateRequestSchema = z
  .object({
    baseline_id: z.uuid(),
    period: DateRangeSchema,
  })
  .strict();
export type MvGenerateRequest = z.infer<typeof MvGenerateRequestSchema>;

export const MvGenerateResponseSchema = z.object({
  job_id: z.uuid(),
  report_id: z.uuid().nullable(),
  status: z.enum(MV_JOB_STATUSES),
});
export type MvGenerateResponse = z.infer<typeof MvGenerateResponseSchema>;

export const MvGenerationJobSchema = z.object({
  id: z.uuid(),
  baseline_id: z.uuid(),
  report_period: DateRangeSchema,
  status: z.enum(MV_JOB_STATUSES),
  failure: MvJobFailureSchema.nullable(),
  report_id: z.uuid().nullable(),
  created_at: RFC3339,
  started_at: RFC3339.nullable(),
  finished_at: RFC3339.nullable(),
});
export type MvGenerationJob = z.infer<typeof MvGenerationJobSchema>;

// ---------------------------------------------------------------------------
// 导出任务（§2.5/§6.12/§6.13；M11 共用锚）
// ---------------------------------------------------------------------------

export const MvExportJobSchema = z.object({
  id: z.uuid(),
  resource_type: z.enum(MV_EXPORT_RESOURCE_TYPES),
  resource_id: z.uuid(),
  format: z.enum(MV_EXPORT_FORMATS),
  status: z.enum(MV_JOB_STATUSES),
  failure: MvJobFailureSchema.nullable(),
  file_bytes: z.number().int().nullable(),
  created_at: RFC3339,
  started_at: RFC3339.nullable(),
  finished_at: RFC3339.nullable(),
  expires_at: RFC3339.nullable(),
});
export type MvExportJob = z.infer<typeof MvExportJobSchema>;

export const MvExportJobListSchema = z.object({
  items: z.array(MvExportJobSchema),
  next_cursor: z.string().nullable(),
});
export type MvExportJobList = z.infer<typeof MvExportJobListSchema>;

export const MvExportJobsQuerySchema = z
  .object({
    status: z.enum(MV_JOB_STATUSES).optional(),
    resource_id: z.uuid().optional(),
    limit: LIMIT,
    cursor: CURSOR.optional(),
  })
  .strict();
export type MvExportJobsQuery = z.infer<typeof MvExportJobsQuerySchema>;

export const MvExportCreateResponseSchema = z.object({
  export_job_id: z.uuid(),
  status: z.enum(MV_JOB_STATUSES),
});
export type MvExportCreateResponse = z.infer<typeof MvExportCreateResponseSchema>;

// ---------------------------------------------------------------------------
// 天气站点（§6.14）
// ---------------------------------------------------------------------------

export const MvWeatherStationSchema = z.object({
  station_id: z.string().min(1),
  source: z.string().min(1),
  last_obs_at: RFC3339,
  /** 近 90 天日覆盖率（有效日/90，站点选择器即体检）。 */
  coverage_90d: z.number().min(0).max(1),
});
export type MvWeatherStation = z.infer<typeof MvWeatherStationSchema>;

export const MvWeatherStationsResponseSchema = z.object({
  items: z.array(MvWeatherStationSchema),
});
export type MvWeatherStationsResponse = z.infer<typeof MvWeatherStationsResponseSchema>;
