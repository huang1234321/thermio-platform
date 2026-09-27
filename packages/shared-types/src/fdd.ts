/**
 * FDD 域 wire 契约（modules/M6-fdd.md §4，algo.md §8；IMPL-17 并入项 / DAT-163）。
 *
 * 单源纪律：本文件是 internal 面（x-internal，algo 白名单）的 wire 单源——
 * admin 面（M6 端点与页面）随 IMPL-16 后续批消费同形状（DAT-133 形状复用锚点）。
 * - FddFindingListItem：列表行**不含 evidence**（大字段仅详情返回——internal 复用面
 *   保持精瘦的前提，M6 §4.2）；
 * - FddFindingsBatch：algo 提交侧 intent（api 维护字段一律不出现在报文——
 *   出现即拒 common.validation_failed，防越权写字段，M6 §3.2）；
 * - FddReportSubmission：报告 upsert（同期唯一 → 重生成天然可重跑，M6 §3.4）；
 *   summary 结构钉死（M6 §4.4，含权重常量语义与 top 10 截断）。
 * 取值零自造：severity 五级 = ALARM_SEVERITIES；状态/期型 = ddl.md §9.2 CHECK。
 */
import { z } from 'zod';
import { ALARM_SEVERITIES, FddFindingStatusSchema, FddReportPeriodTypeSchema } from './enums.js';

const LIMIT = z.coerce.number().int().min(1).max(200).default(50);
const CURSOR = z.string().min(1).max(512);
const RFC3339 = z.iso.datetime({ offset: true });

/** 证据固定骨架（algo.md §7.5：点位清单 + 窗口 + 规则自定义量化）。 */
export const FddEvidenceSchema = z.object({
  points: z.array(z.object({ point_id: z.number().int(), quantity_type: z.string() })).min(1),
  window: z.object({ from: RFC3339, to: RFC3339 }),
  detail: z.record(z.string(), z.unknown()),
});
export type FddEvidence = z.infer<typeof FddEvidenceSchema>;

/** ★DAT-133 形状复用锚点：internal 列表与 admin 列表共用此 schema（M6 §4.2）。 */
export const FddFindingListItemSchema = z.object({
  id: z.uuid(),
  building_id: z.uuid(), // 经 equipment→system 解析
  equipment: z.object({
    id: z.uuid(),
    name: z.string(),
    local_id: z.string().nullable(),
    equipment_type: z.string(),
  }),
  rule_key: z.string(),
  severity: z.enum(ALARM_SEVERITIES),
  status: FddFindingStatusSchema,
  title: z.string(),
  suggested_action: z.string().nullable(),
  algo_version: z.string(),
  first_detected_at: RFC3339,
  last_detected_at: RFC3339,
  resolved_at: RFC3339.nullable(),
  ignored_at: RFC3339.nullable(),
  // 正交判定摘要（§2.2）；列集未落（M6 §3.3 提案 0005/0006）——恒 null（字段只增不删）
  review: z.null(),
  created_at: RFC3339,
});
export type FddFindingListItem = z.infer<typeof FddFindingListItemSchema>;

export const FddFindingListSchema = z.object({
  items: z.array(FddFindingListItemSchema),
  next_cursor: z.string().nullable(),
});
export type FddFindingList = z.infer<typeof FddFindingListSchema>;

/**
 * GET /internal/fdd/findings 查询白名单（algo.md §8.3：报告聚合数据源；
 * from/to = 活跃窗口谓词，M6 §5.2 一处定义两处消费）。building_id 内部面必填
 * （租户由目标实体解析，platform §11-5）。
 */
export const InternalFddFindingsQuerySchema = z
  .object({
    building_id: z.uuid(),
    from: RFC3339.optional(),
    to: RFC3339.optional(),
    limit: LIMIT,
    cursor: CURSOR.optional(),
  })
  .strict();
export type InternalFddFindingsQuery = z.infer<typeof InternalFddFindingsQuerySchema>;

/** POST /internal/fdd/findings 载荷（批量 upsert；algo.md §8.2 wire 模型）。
 * 子对象一律 .strict()：api 维护字段（id/tenant_id/status/...）出现即拒
 * （common.validation_failed，防越权写字段，M6 §3.2）。 */
export const FddFindingHitSchema = z
  .object({
    equipment_id: z.uuid(),
    rule_key: z.string().min(1),
    severity: z.enum(ALARM_SEVERITIES),
    title: z.string().min(1),
    evidence: FddEvidenceSchema,
    suggested_action: z.string().nullable().optional(),
    first_detected_at: RFC3339,
    last_detected_at: RFC3339,
  })
  .strict();
export type FddFindingHit = z.infer<typeof FddFindingHitSchema>;

export const FddFindingClearedSchema = z
  .object({
    equipment_id: z.uuid(),
    rule_key: z.string().min(1),
    cleared_at: RFC3339,
  })
  .strict();
export type FddFindingCleared = z.infer<typeof FddFindingClearedSchema>;

export const FddFindingsBatchSchema = z
  .object({
    algo_version: z.string().min(1),
    hits: z.array(FddFindingHitSchema).max(500),
    cleared: z.array(FddFindingClearedSchema).max(500),
  })
  .strict();
export type FddFindingsBatch = z.infer<typeof FddFindingsBatchSchema>;

/** 报告期（闭开 [start,end)，YYYY-MM-DD；api 构造 daterange）。 */
export const FddPeriodSchema = z.object({
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type FddPeriod = z.infer<typeof FddPeriodSchema>;

const SeverityCounts = z.record(z.enum(ALARM_SEVERITIES), z.number().int());

/** summary 钉死形状（M6 §4.4：五键全给 0 也给，健康度 top 10）。 */
export const FddReportSummarySchema = z.object({
  counts: z.object({
    new: z.number().int(),
    resolved: z.number().int(),
    persisting: z.number().int(),
  }),
  new_by_severity: SeverityCounts,
  open_by_severity: SeverityCounts,
  health_ranking: z
    .array(
      z.object({
        equipment_id: z.uuid(),
        equipment_name: z.string(),
        equipment_type: z.string(),
        open_count: z.number().int(),
        weighted_score: z.number().int(),
      }),
    )
    .max(10),
});
export type FddReportSummary = z.infer<typeof FddReportSummarySchema>;

/** POST /internal/fdd/reports 载荷（同期唯一 → upsert，M6 §3.4）。 */
export const FddReportSubmissionSchema = z
  .object({
    building_id: z.uuid(),
    period_type: FddReportPeriodTypeSchema,
    period: FddPeriodSchema,
    summary: FddReportSummarySchema,
    algo_version: z.string().min(1),
  })
  .strict();
export type FddReportSubmission = z.infer<typeof FddReportSubmissionSchema>;

/** GET /internal/algo/asset-snapshot 响应（algo.md §6.2 wire 契约）。 */
export const AssetSnapshotQuerySchema = z
  .object({
    updated_since: RFC3339.optional(),
  })
  .strict();

export const AssetSnapshotEquipmentSchema = z.object({
  equipment_id: z.uuid(),
  equipment_type: z.string(),
  system_id: z.uuid().nullable(),
  building_id: z.uuid().nullable(),
  tenant_id: z.uuid(),
  local_id: z.string().nullable(),
  name: z.string().nullable(),
  rated_params: z.record(z.string(), z.unknown()),
});
export type AssetSnapshotEquipment = z.infer<typeof AssetSnapshotEquipmentSchema>;

export const AssetSnapshotPointSchema = z.object({
  point_id: z.number().int(),
  equipment_id: z.uuid().nullable(),
  quantity_type: z.string().nullable(),
  unit_std: z.string().nullable(),
  valid_range_min: z.number().nullable(),
  valid_range_max: z.number().nullable(),
  is_controllable: z.boolean(),
  clamp_min: z.number().nullable(),
  clamp_max: z.number().nullable(),
  control_mode: z.string(),
});
export type AssetSnapshotPoint = z.infer<typeof AssetSnapshotPointSchema>;

export const AssetSnapshotSchema = z.object({
  generated_at: RFC3339,
  equipments: z.array(AssetSnapshotEquipmentSchema),
  points: z.array(AssetSnapshotPointSchema),
});
export type AssetSnapshot = z.infer<typeof AssetSnapshotSchema>;
