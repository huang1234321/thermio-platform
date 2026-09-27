/**
 * 点表导入域契约（modules M2-import.md §2/§3/§6.5/§9；IMPL-15 / DAT-118）。
 *
 * - ImportJob/ImportRow = ddl.md §9.4 两表暴露列的 API 形状（DDL 列名 snake_case 直传，
 *   tenant_id 不暴露；import_row.id bigint → API integer，同 M1 §2.4 point 注记）；
 * - 单位转换表 UNIT_CONVERSION_TABLE_V1 为 TS/Go 双栈共享契约（M2-import §6.5）：
 *   内容源 = ingest.md §5 单位族清单，本表只落 canonical 形状；变更走 PR + 双侧快照测试；
 * - 容量常量：5 MB/5,000 行取自 platform §12；自检窗/回看窗/分批/推送超时/幂等窗为
 *   M2-import §1.6 本篇定夺（挂 R11 建议入容量表），此处钉默认值、env 可覆盖。
 */
import { z } from 'zod';
import {
  IMPORT_FAILURE_CODES,
  IMPORT_ISSUE_CODES,
  IMPORT_JOB_STATUSES,
  IMPORT_ROW_MAP_STATUSES,
  ImportFailureCodeSchema,
  ImportIssueCodeSchema,
  ImportJobStatusSchema,
  ImportRowMapStatusSchema,
} from './enums.js';

// ---------------------------------------------------------------------------
// 资源形状 schema（M2-import §3；类型经 z.infer 派生——exactOptionalPropertyTypes 自洽）
// ---------------------------------------------------------------------------

/** dry-run 行级/作业级问题（issues jsonb 元素形状；作业级同形，不入行）。 */
export const ImportIssueSchema = z.object({
  code: ImportIssueCodeSchema,
  blocking: z.boolean(),
  detail: z.record(z.string(), z.unknown()),
});

/** 读侧建议（不落库，仅 unmapped 行惰性计算；M2-import §6.2）。 */
export const RowSuggestionSchema = z.object({
  equipment_id: z.string().nullable(),
  quantity_type: z.string().nullable(),
  unit_std: z.string().nullable(),
  source: z.enum(['history_exact', 'history_similar']),
  score: z.number(),
});

/** 作业失败载荷（failed 态非空；形状 §4.4）。 */
export const ImportFailureSchema = z.object({
  stage: z.enum(['parse', 'apply_push']),
  code: ImportFailureCodeSchema,
  /** 人读文案（i18n）。 */
  message: z.string(),
  /** gateway_ack_partial 的失败行清单。 */
  rows: z
    .array(z.object({ row_no: z.number(), raw_name: z.string(), reason: z.string() }))
    .optional(),
  /** 结构化补充（如表头快照）。 */
  detail: z.record(z.string(), z.unknown()).optional(),
});

export const ImportJobSchema = z.object({
  id: z.string(),
  building_id: z.string(),
  gateway_id: z.string(),
  file_name: z.string(),
  row_count: z.number(),
  status: ImportJobStatusSchema,
  mapped_count: z.number(),
  issue_count: z.number(),
  /** 0–1 小数（UI 显示百分比）；null = 未自检。 */
  hit_rate: z.number().nullable(),
  failure: ImportFailureSchema.nullable(),
  created_by: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  applied_at: z.string().nullable(),
  checked_at: z.string().nullable(),
});

export const ImportRowSchema = z.object({
  id: z.number(),
  job_id: z.string(),
  /** 数据行序号（1 起，不含表头）；Excel 展示行号 = row_no + 1。 */
  row_no: z.number(),
  raw_name: z.string(),
  raw_description: z.string().nullable(),
  unit_raw: z.string().nullable(),
  is_write: z.boolean(),
  equipment_id: z.string().nullable(),
  quantity_type: z.string().nullable(),
  unit_std: z.string().nullable(),
  map_status: ImportRowMapStatusSchema,
  issues: z.array(ImportIssueSchema),
  suggestions: z.array(RowSuggestionSchema),
  mapped_at: z.string().nullable(),
  mapped_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

/** dry-run 同步报告（M2-import §3.7；行级明细走 GET rows?issue=*）。 */
export const DryRunReportSchema = z.object({
  passed: z.boolean(),
  blocking_count: z.number(),
  warning_count: z.number(),
  job_issues: z.array(ImportIssueSchema),
  row_ref: z.object({ filter: z.literal('issue=*') }),
});

/** 自检报告（GET 实时计算口径，M2-import §3.10/§9.3）。 */
export const SelfCheckReportSchema = z.object({
  job_id: z.string(),
  checked_at: z.string(),
  hit_rate: z.number(),
  hit_count: z.number(),
  total_count: z.number(),
  window: z.object({ lookback_s: z.number(), as_of: z.string() }),
  missed: z.array(z.object({ row_no: z.number(), raw_name: z.string(), point_id: z.number() })),
});

export type ImportIssue = z.infer<typeof ImportIssueSchema>;
export type RowSuggestion = z.infer<typeof RowSuggestionSchema>;
export type ImportFailure = z.infer<typeof ImportFailureSchema>;
export type ImportJob = z.infer<typeof ImportJobSchema>;
export type ImportRow = z.infer<typeof ImportRowSchema>;
export type DryRunReport = z.infer<typeof DryRunReportSchema>;
export type SelfCheckReport = z.infer<typeof SelfCheckReportSchema>;

export const ImportJobListResponseSchema = z.object({
  items: z.array(ImportJobSchema),
  next_cursor: z.string().nullable(),
});

export const ImportRowListResponseSchema = z.object({
  items: z.array(ImportRowSchema),
  next_cursor: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// 请求/查询 schema（M2-import §3；multipart 部件在 api 侧装配后走同一 schema）
// ---------------------------------------------------------------------------

export const ImportJobListQuerySchema = z.object({
  building_id: z.uuid().optional(),
  status: ImportJobStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
});
export type ImportJobListQuery = z.infer<typeof ImportJobListQuerySchema>;

/** GET rows 白名单参数（mapped/issue 过滤；M2-import §3.4）。 */
export const ImportRowsQuerySchema = z.object({
  mapped: z.enum(['true', 'false']).optional(),
  issue: z.enum(['*', ...(IMPORT_ISSUE_CODES as readonly [string, ...string[]])]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
});
export type ImportRowsQuery = z.infer<typeof ImportRowsQuerySchema>;

/** POST /imports 部件（multipart file 由 api 侧单独承载，此表管字符串部件）。 */
export const ImportCreateSchema = z.object({
  building_id: z.uuid(),
  gateway_id: z.uuid(),
});
export type ImportCreate = z.infer<typeof ImportCreateSchema>;

/**
 * PATCH rows 映射三字段任意子集（≥1 项；全量置 null = 清除映射）。
 * 刻意不 strict（同 M1 PointSemanticsPatch 口径）：白名单外键由控制器守卫拦截
 * （→ 422 common.validation_failed，details 列白名单）；quantity_type 服务层判
 * 值域发 point.quantity_type_unknown（M1 同族注记）。
 */
export const ImportRowPatchSchema = z
  .object({
    equipment_id: z.uuid().nullable().optional(),
    quantity_type: z.string().max(32).nullable().optional(),
    unit_std: z.string().max(32).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: '至少提供一个映射字段',
  });
export type ImportRowPatch = z.infer<typeof ImportRowPatchSchema>;

/** PATCH 白名单（物理层字段 raw_name/unit_raw/is_write 不可改）。 */
export const IMPORT_ROW_PATCH_FIELDS = ['equipment_id', 'quantity_type', 'unit_std'] as const;

// ---------------------------------------------------------------------------
// 单位转换表 v1（canonical 对 + scale/offset；M2-import §6.5，双栈共享契约）
// ---------------------------------------------------------------------------

export interface UnitConversionEntry {
  /** 原始单位（canonical 小写）。 */
  from: string;
  /** 归一目标单位。 */
  to: string;
  kind: 'identity' | 'linear' | 'affine';
  scale: number;
  offset: number;
}

/**
 * 单位族清单（ingest.md §5 为内容源；本表 = canonical 形状）：
 * - 温度族为 affine（degF→degC 含偏移，预览必须展示公式而非单因子）；
 * - identity = scale 1 / offset 0 的直通对（供确认页展示「不换算」语义）；
 * - 任一侧为空 = 直通语义（不查本表，ingest 视为已归一）。
 */
export const UNIT_CONVERSION_TABLE_V1 = [
  // 温度（affine）
  { from: 'degf', to: 'degc', kind: 'affine', scale: 5 / 9, offset: (-32 * 5) / 9 },
  { from: '°f', to: 'degc', kind: 'affine', scale: 5 / 9, offset: (-32 * 5) / 9 },
  { from: 'k', to: 'degc', kind: 'affine', scale: 1, offset: -273.15 },
  // 温度（identity）
  { from: 'degc', to: 'degc', kind: 'identity', scale: 1, offset: 0 },
  { from: '℃', to: 'degc', kind: 'identity', scale: 1, offset: 0 },
  { from: '°c', to: 'degc', kind: 'identity', scale: 1, offset: 0 },
  { from: 'c', to: 'degc', kind: 'identity', scale: 1, offset: 0 },
  // 功率（identity / linear）
  { from: 'kw', to: 'kw', kind: 'identity', scale: 1, offset: 0 },
  { from: 'w', to: 'kw', kind: 'linear', scale: 0.001, offset: 0 },
  { from: 'mw', to: 'kw', kind: 'linear', scale: 1000, offset: 0 },
  // 压力（linear）
  { from: 'kpa', to: 'kpa', kind: 'identity', scale: 1, offset: 0 },
  { from: 'mpa', to: 'kpa', kind: 'linear', scale: 1000, offset: 0 },
  { from: 'bar', to: 'kpa', kind: 'linear', scale: 100, offset: 0 },
  // 流量（linear）
  { from: 'm3/h', to: 'm3/h', kind: 'identity', scale: 1, offset: 0 },
  { from: 'l/s', to: 'm3/h', kind: 'linear', scale: 3.6, offset: 0 },
  // 能量（linear）
  { from: 'kwh', to: 'kwh', kind: 'identity', scale: 1, offset: 0 },
  // 频率（identity）
  { from: 'hz', to: 'hz', kind: 'identity', scale: 1, offset: 0 },
] as const satisfies readonly UnitConversionEntry[];

/** 查转换对（from/to 大小写不敏感；未命中 → null = 不支持）。 */
export function findUnitConversion(unitRaw: string, unitStd: string): UnitConversionEntry | null {
  const from = unitRaw.trim().toLowerCase();
  const to = unitStd.trim().toLowerCase();
  for (const entry of UNIT_CONVERSION_TABLE_V1) {
    if (entry.from === from && entry.to === to) return entry;
  }
  return null;
}

/** 换算样例（预览契约 §6.5：raw 1 → std X；affine 展示公式）。 */
export function convertSample(value: number, entry: UnitConversionEntry): number {
  return value * entry.scale + entry.offset;
}

// ---------------------------------------------------------------------------
// 运行常量（M2-import §1.6；5 MB/5,000 行 = platform §12 逐字，其余本篇定夺挂 R11）
// ---------------------------------------------------------------------------

/** 上传大小上限（platform §12）。 */
export const IMPORT_FILE_MAX_BYTES = 5 * 1024 * 1024;
/** 数据行上限（platform §12；超出 → parse 段 row_limit_exceeded）。 */
export const IMPORT_ROW_LIMIT = 5_000;
/** 自检采集窗（秒）：读指令下发后等待上报的窗口。 */
export const IMPORT_SELFCHECK_WINDOW_S = 90;
/** 自检命中判定回看窗（秒，平台常量 W）：[checked_at − W, checked_at] 内有 ≥1 行即命中。 */
export const IMPORT_SELFCHECK_LOOKBACK_S = 15 * 60;
/** 自检读指令分批（点/条，批间 100ms 防冲）。 */
export const IMPORT_SELFCHECK_READ_BATCH = 500;
/** 配置推送应答超时（秒）× 重试次数（M2-import §8.4）。 */
export const IMPORT_CONFIG_PUSH_TIMEOUT_S = 30;
export const IMPORT_CONFIG_PUSH_RETRIES = 3;
/** apply 幂等键窗口（小时，键作用域 = (tenant, job_id, key)）。 */
export const IMPORT_APPLY_IDEMPOTENCY_WINDOW_H = 24;

// ---------------------------------------------------------------------------
// 网关配置产物契约（M2-import §8.4；IMPL-8 对接面）
// ---------------------------------------------------------------------------

export const IMPORT_CONFIG_SCHEMA_VERSION = 1;

export interface GatewayConfigArtifact {
  schema_version: number;
  job_id: string;
  generated_at: string;
  /** 本网关全量已注册点快照（全量替换语义）。 */
  points: Array<{
    raw_name: string;
    ref: string;
    unit_raw: string | null;
    unit_std: string | null;
  }>;
  /** gateway 行 offline_action 原样透传（M1 §3.8 loose schema）。 */
  offline_action: object | null;
}

/** 网关应答（up/config/ack payload，M2-import §8.4）。 */
export const GatewayConfigAckSchema = z.object({
  job_id: z.string().min(1),
  ok_count: z.number().int().min(0),
  failed: z.array(z.object({ raw_name: z.string().min(1), reason: z.string() })).default([]),
});
export type GatewayConfigAck = z.infer<typeof GatewayConfigAckSchema>;

/** 自检读指令 payload（M2-import §9.2）。 */
export interface GatewayReadCommand {
  job_id: string;
  req_id: string;
  points: string[];
}

/** MQTT 下行 topic 工具（emqx.md §4；retained 仅 down/config）。 */
export function gatewayDownTopic(kind: 'config' | 'read', mqttClientId: string): string {
  return `thermio/gw/${mqttClientId}/down/${kind}`;
}

/** api 内部账号共享订阅 filter（emqx.md §4 R6）。 */
export const CONFIG_ACK_SUBSCRIBE_FILTER = '$share/api/thermio/gw/+/up/config/ack';

// ---------------------------------------------------------------------------
// 复导出（枚举消费方面，CODE-ST-03 单一来源）
// ---------------------------------------------------------------------------

export {
  IMPORT_FAILURE_CODES,
  IMPORT_ISSUE_CODES,
  IMPORT_JOB_STATUSES,
  IMPORT_ROW_MAP_STATUSES,
  ImportFailureCodeSchema,
  ImportIssueCodeSchema,
  ImportJobStatusSchema,
  ImportRowMapStatusSchema,
};
