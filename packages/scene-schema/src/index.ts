/**
 * @thermio/scene-schema —— 组态场景配置类型（ADR-013：场景存 PG，schema 在此定义）。
 *
 * 契约来源（IMPL-14 / DAT-117 前置详设，逐字段对齐）：
 * - M3-monitor.md §2.2 SceneDetail / §2.2.1 绑定契约（slot 语法）/ §6.3 高亮规则；
 * - ui/viz-3d.md §3.3：demo plant.js 的 CIRCUITS / KIND_NAMES 迁移为 2D/3D 共用常量；
 * - M3-monitor.md §2.1：manifest kind ↔ EQUIPMENT_TYPES 映射（资产命名对齐语义枚举）。
 *
 * 边界注记（挂账，不私改 shared-types——DAT-104 口径）：
 * - ALARM_SEVERITIES / RUN_STATES 属 M4 / 跨域枚举，首版在本包局部定义；
 *   shared-types 收口（DAT-104 发版）后迁入并改导出别名，消费方不动。
 * - MonitorOverview / EquipmentCondition 等 API 面类型在 admin 侧镜像
 *   （apps/admin/src/pages/monitor/api-contracts.ts），随 api 落码一并上移。
 */
import { z } from 'zod';

/** 场景种类（M3-monitor §2.2：3D 主视图；2D P&ID 辅助，同表共存）。 */
export const SCENE_KINDS = ['3d', '2d'] as const;
export const SceneKindSchema = z.enum(SCENE_KINDS);
export type SceneKind = z.infer<typeof SceneKindSchema>;

// ---------------------------------------------------------------------------
// 绑定契约（M3-monitor §2.2.1：3D slot = `{manifest.assets[].id}:{semantic}`）
// ---------------------------------------------------------------------------

/** 绑定种类（MVP = 三类直接绑定；threshold/quality/visibility 属性规则见 HighlightRule）。 */
export const BINDING_KINDS = ['state-run', 'value-text', 'motion-fan'] as const;
export const BindingKindSchema = z.enum(BINDING_KINDS);
export type BindingKind = z.infer<typeof BindingKindSchema>;

/** value-text 格式词表（schematic §2.2 同构子集；1-dec = 一位小数）。 */
export const VALUE_TEXT_FMTS = ['int', '1-dec'] as const;
export const ValueTextFmtSchema = z.enum(VALUE_TEXT_FMTS);
export type ValueTextFmt = z.infer<typeof ValueTextFmtSchema>;

const SLOT_PATTERN = /^[A-Za-z0-9_-]+:[a-z0-9_-]+$/;

/**
 * 单条绑定。字段随 kind 收窄（superRefine）：
 * - state-run 必带 enum 映射（如 {"1":"running","0":"standby"}，键为 value_text）；
 * - value-text 必带 fmt + unit；
 * - motion-fan 必带 rad_s_per_hz（rad/s per Hz，默认视觉 0.02 由求值方兜底）。
 */
export const SceneBindingSchema = z
  .object({
    slot: z.string().regex(SLOT_PATTERN, 'slot 须为 `{对象id}:{语义}` 形态'),
    point_id: z.number().int().positive(),
    kind: BindingKindSchema,
    enum: z.record(z.string().min(1), z.enum(['running', 'standby'])).optional(),
    fmt: ValueTextFmtSchema.optional(),
    unit: z.string().max(16).optional(),
    rad_s_per_hz: z.number().positive().max(10).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'state-run' && value.enum === undefined) {
      ctx.addIssue({ code: 'custom', path: ['enum'], message: 'state-run 绑定必带 enum 映射' });
    }
    if (value.kind === 'value-text' && (value.fmt === undefined || value.unit === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['fmt'], message: 'value-text 绑定必带 fmt 与 unit' });
    }
    if (value.kind === 'motion-fan' && value.rad_s_per_hz === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['rad_s_per_hz'],
        message: 'motion-fan 绑定必带 rad_s_per_hz',
      });
    }
  });
export type SceneBinding = z.infer<typeof SceneBindingSchema>;

// ---------------------------------------------------------------------------
// 高亮规则（M3-monitor §6.3，与 schematic §5 同构的 3D MVP 子集）
// ---------------------------------------------------------------------------

export const HIGHLIGHT_LEVELS = ['warning', 'alarm'] as const;
export const HighlightLevelSchema = z.enum(HIGHLIGHT_LEVELS);
export type HighlightLevel = z.infer<typeof HighlightLevelSchema>;

/** threshold：绑定槽最新值越限 → 状态（进入/退出滞回由求值方承担）。 */
export const ThresholdHighlightRuleSchema = z.object({
  kind: z.literal('threshold'),
  slot: z.string().regex(SLOT_PATTERN),
  op: z.enum(['>', '>=', '<', '<=']),
  threshold: z.number(),
  level: HighlightLevelSchema,
});

/** alarm-linked：对象关联点位/设备存在 open 告警 → 状态升级（告警源快照由页面喂入）。 */
export const AlarmLinkedHighlightRuleSchema = z.object({
  kind: z.literal('alarm-linked'),
  object_ids: z.array(z.string().min(1)).min(1),
  level: HighlightLevelSchema,
});

export const HighlightRuleSchema = z.discriminatedUnion('kind', [
  ThresholdHighlightRuleSchema,
  AlarmLinkedHighlightRuleSchema,
]);
export type HighlightRule = z.infer<typeof HighlightRuleSchema>;

/** 相机预设（M3-monitor §2.2 views；overview/plan 两档，demo manifest camera 正式化）。 */
export const CameraViewSchema = z.object({
  id: z.enum(['overview', 'plan']),
  camera: z.object({
    position: z.tuple([z.number(), z.number(), z.number()]),
    target: z.tuple([z.number(), z.number(), z.number()]),
    width: z.number().positive(),
  }),
});
export type CameraView = z.infer<typeof CameraViewSchema>;

/**
 * 场景配置（scene.config jsonb 的形状）。绑定数预算 ≤500（platform §12 单连接订阅上限，
 * M3-monitor §2.2.1——超限种子脚本保存时拒绝）。
 */
export const SceneConfigSchema = z.object({
  bindings: z.array(SceneBindingSchema).max(500),
  highlight_rules: z.array(HighlightRuleSchema).max(200),
  views: z.array(CameraViewSchema).max(8),
});
export type SceneConfig = z.infer<typeof SceneConfigSchema>;

// ---------------------------------------------------------------------------
// 场景资源（GET /scenes 族响应，M3-monitor §2.2 / §3.4）
// ---------------------------------------------------------------------------

/** 楼宇可用组态画面元数据（列表项；不含 config 与资产 URL）。 */
export const SceneSummarySchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(128),
  kind: SceneKindSchema,
  template: z.object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    variant_key: z.string().min(1),
  }),
  system_id: z.uuid(),
  updated_at: z.iso.datetime({ offset: true }),
});
export type SceneSummary = z.infer<typeof SceneSummarySchema>;

export const SceneListResponseSchema = z.object({
  items: z.array(SceneSummarySchema),
  next_cursor: z.string().nullable(),
});
export type SceneListResponse = z.infer<typeof SceneListResponseSchema>;

/** 签名资产描述符（url = 对象存储签名 URL，默认 60min 时效；sha256 为交付校验锚）。 */
const SignedAssetSchema = z.object({
  asset_id: z.string().min(1),
  url: z.url(),
  bytes: z.number().int().positive().optional(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  expires_at: z.iso.datetime({ offset: true }),
});

/** GET /scenes/{id} 200 响应（SceneDetail；kind='3d' 必有 assets——2D 模板在 monorepo）。 */
export const SceneDetailSchema = z.object({
  id: z.uuid(),
  building_id: z.uuid(),
  system_id: z.uuid(),
  name: z.string().min(1).max(128),
  kind: SceneKindSchema,
  template: z.object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    variant_key: z.string().min(1),
  }),
  assets: z
    .object({
      model: SignedAssetSchema,
      manifest: SignedAssetSchema,
    })
    .nullable(),
  config: SceneConfigSchema,
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
});
export type SceneDetail = z.infer<typeof SceneDetailSchema>;

// ---------------------------------------------------------------------------
// 回路 / 设备类型常量（ui/viz-3d.md §3.3：demo plant.js 迁移，2D/3D 共用）
// ---------------------------------------------------------------------------

/** 四回路（demo CIRCUITS 同源；演示温度值按 M3-monitor §5.8 删除，色为图例色板非材质）。 */
export const CIRCUITS = {
  CHWS: { name: '冷冻供水', color: '#42b7f1', description: '蒸发器出口 → 建筑末端' },
  CHWR: { name: '冷冻回水', color: '#83dce2', description: '建筑末端 → 冷冻水泵 → 蒸发器' },
  CWS: { name: '冷却供水', color: '#e7bb70', description: '冷却塔集水盘 → 冷却水泵 → 冷凝器' },
  CWR: { name: '冷却回水', color: '#e68358', description: '冷凝器出口 → 冷却塔' },
} as const;
export type CircuitKey = keyof typeof CIRCUITS;
export const CIRCUIT_KEYS = Object.keys(CIRCUITS) as readonly CircuitKey[];

/** manifest 对象 kind → 中文名（demo KIND_NAMES 同源 + 结构对象）。 */
export const MANIFEST_KIND_NAMES = {
  chiller: '冷水机组',
  pump: '循环水泵',
  tower: '冷却塔',
  load: '建筑末端',
  valve: '阀门',
  pipe: '管路',
  foundation: '基础',
  fittings: '管件',
  supports: '支吊架',
} as const;
export type ManifestKind = keyof typeof MANIFEST_KIND_NAMES;

/**
 * manifest kind ↔ EQUIPMENT_TYPES（M3-monitor §2.1 命名规范）：
 * pump 按回路分流（CHW→冷冻泵 / CW→冷却泵）；结构对象无设备实体 → null。
 */
export function manifestKindToEquipmentType(
  kind: string,
  circuit: string | null,
): 'chiller' | 'chwp_pump' | 'cwp_pump' | 'cooling_tower' | 'valve' | null {
  if (kind === 'chiller') return 'chiller';
  if (kind === 'pump') return circuit === 'CW' ? 'cwp_pump' : 'chwp_pump';
  if (kind === 'tower') return 'cooling_tower';
  if (kind === 'valve') return 'valve';
  return null;
}

// ---------------------------------------------------------------------------
// 挂账枚举（局部定义，shared-types 收口后迁入——见文件头注记）
// ---------------------------------------------------------------------------

/** 告警级别（M3-monitor §3.1 kpi.open_by_severity；M4 域枚举，挂账 shared-types）。 */
export const ALARM_SEVERITIES = ['info', 'warning', 'minor', 'major', 'critical'] as const;
export const AlarmSeveritySchema = z.enum(ALARM_SEVERITIES);
export type AlarmSeverity = z.infer<typeof AlarmSeveritySchema>;

/** 级别严重度序（越大越严；alarm_worst / 高亮取最严用）。 */
export function severityRank(severity: AlarmSeverity): number {
  return ALARM_SEVERITIES.indexOf(severity);
}

export function worstSeverity(list: readonly AlarmSeverity[]): AlarmSeverity | null {
  let worst: AlarmSeverity | null = null;
  for (const item of list) {
    if (worst === null || severityRank(item) > severityRank(worst)) worst = item;
  }
  return worst;
}

/** 设备运行状态（M3-monitor §3.2 run_state；挂账 shared-types）。 */
export const RUN_STATES = ['running', 'standby', 'fault', 'unknown'] as const;
export const RunStateSchema = z.enum(RUN_STATES);
export type RunState = z.infer<typeof RunStateSchema>;
