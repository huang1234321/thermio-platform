/**
 * 首版枚举清单（platform.md §6，取值唯一来源 = DATA-MODEL.md v1.1 §3.1–§3.7 明示值）。
 *
 * 治理规则（DATA-MODEL §6 / platform.md §6.1）：
 * - 本文件是全系统枚举单一来源（TS 常量），DB 侧 text + 应用层校验；
 * - 新增枚举 = 发版动作，走代码评审，并同步 `enums.snapshot.test.ts` 快照与 DATA-MODEL 示例；
 * - 消费纪律（§6.4）：业务代码不硬编码枚举字符串（CODE-ST-03），一律从本包导入；
 *   清单外历史值按 UNKNOWN 兜底展示并告警，不崩不静默吞。
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// 语义枚举（开放集，首版保守草案——扩充走发版流程，platform.md §6.2）
// ---------------------------------------------------------------------------

/** 系统类型（DATA-MODEL §3.2 system_type）。消费方：资产域、FDD 规则 scope、组态模板。 */
export const SYSTEM_TYPES = ['chilled_water', 'cooling_water', 'ahu', 'vav'] as const;
export const SystemTypeSchema = z.enum(SYSTEM_TYPES);
export type SystemType = z.infer<typeof SystemTypeSchema>;

/** 设备类型（DATA-MODEL §3.2 equipment_type）。消费方：资产域、FDD、Blender 资产命名（ADR-013）。 */
export const EQUIPMENT_TYPES = [
  'chiller',
  'chwp_pump',
  'cwp_pump',
  'cooling_tower',
  'ahu',
  'valve',
  'sensor',
  'energy_meter',
] as const;
export const EquipmentTypeSchema = z.enum(EQUIPMENT_TYPES);
export type EquipmentType = z.infer<typeof EquipmentTypeSchema>;

/**
 * 量类型（DATA-MODEL §3.3 quantity_type，开放集）。消费方：FDD 规则库「设备类型 × 量类型」二维标签。
 * R12 增量（M3-monitor §11 R12，验收 v1.3 通过）：同批登记 energy（能量累计量，kWh——
 * KPI 能耗首末差值数据面）+ load_rate（负荷率 %，冷机控制器直读——验收拍板 3 接入项非派生）。
 * IMPL-19 增量（optimizer.md §6.6-1，DAT-165）：冷热源 advisory 寻优目标/判据量 7 值
 * （方向与 unit_std 约定见该表；unit_enable 建议 readwrite 以保证 previous_value）。
 * 开放集扩充 = 发版动作（platform §6.1）：DATA-MODEL §3.3 示例同步归 platform owner。
 */
export const QUANTITY_TYPES = [
  'chw_supply_temp',
  'power',
  'run_status',
  'energy',
  'load_rate',
  'chw_supply_temp_setpoint',
  'chw_return_temp',
  'chw_flow_rate',
  'unit_enable',
  'cooling_water_supply_temp',
  'cw_supply_temp_setpoint',
  'tower_fan_power',
] as const;
export const QuantityTypeSchema = z.enum(QUANTITY_TYPES);
export type QuantityType = z.infer<typeof QuantityTypeSchema>;

// ---------------------------------------------------------------------------
// 闭合枚举（DATA-MODEL 已给全集，platform.md §6.3）
// ---------------------------------------------------------------------------

/** 点位数据来源（DATA-MODEL §3.3 source_type）。 */
export const SOURCE_TYPES = ['mqtt_gateway', 'bacnet', 'virtual'] as const;
export const SourceTypeSchema = z.enum(SOURCE_TYPES);
export type SourceType = z.infer<typeof SourceTypeSchema>;

/** 点位读写方向（DATA-MODEL §3.3 direction）。 */
export const DIRECTIONS = ['read', 'write', 'readwrite'] as const;
export const DirectionSchema = z.enum(DIRECTIONS);
export type Direction = z.infer<typeof DirectionSchema>;

/** 控制模式（DATA-MODEL §3.3 control_mode，默认 advisory；状态机见 ADR-009）。 */
export const CONTROL_MODES = ['advisory', 'supervised', 'auto'] as const;
export const ControlModeSchema = z.enum(CONTROL_MODES);
export type ControlMode = z.infer<typeof ControlModeSchema>;

/** 部署密度（DATA-MODEL §3.1 deployment_mode：一套代码两种密度）。 */
export const DEPLOYMENT_MODES = ['private', 'saas'] as const;
export const DeploymentModeSchema = z.enum(DEPLOYMENT_MODES);
export type DeploymentMode = z.infer<typeof DeploymentModeSchema>;

/** 角色（DATA-MODEL §3.1 role，MVP 集）。 */
export const ROLES = ['admin', 'operator', 'viewer'] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

/** 用户状态（ddl.md §4 app_user.status CHECK）。 */
export const USER_STATUSES = ['active', 'disabled'] as const;
export const UserStatusSchema = z.enum(USER_STATUSES);
export type UserStatus = z.infer<typeof UserStatusSchema>;

/** FDD 发现状态（ddl.md §9.2 fdd_finding.status CHECK 封闭集；IMPL-17 并入项注册）。 */
export const FDD_FINDING_STATUSES = ['open', 'resolved', 'ignored'] as const;
export const FddFindingStatusSchema = z.enum(FDD_FINDING_STATUSES);
export type FddFindingStatus = (typeof FDD_FINDING_STATUSES)[number];

/** FDD 报告期型（ddl.md §9.2 fdd_report.period_type CHECK；IMPL-17 并入项注册）。 */
export const FDD_REPORT_PERIOD_TYPES = ['day', 'week'] as const;
export const FddReportPeriodTypeSchema = z.enum(FDD_REPORT_PERIOD_TYPES);
export type FddReportPeriodType = (typeof FDD_REPORT_PERIOD_TYPES)[number];

/** 提案状态机（DATA-MODEL §3.5 proposal.status）。 */
export const PROPOSAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'expired',
  'executed',
  'failed',
] as const;
export const ProposalStatusSchema = z.enum(PROPOSAL_STATUSES);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

/** 控制审计动作方（DATA-MODEL §3.5 control_audit.actor_type：算法/人工/fail-safe 系统）。 */
export const CONTROL_ACTOR_TYPES = ['algo', 'human', 'system'] as const;
export const ControlActorTypeSchema = z.enum(CONTROL_ACTOR_TYPES);
export type ControlActorType = z.infer<typeof ControlActorTypeSchema>;

/** 控制执行结果（DATA-MODEL §3.5 control_audit.result）。 */
export const CONTROL_RESULTS = ['ok', 'verify_failed', 'reverted', 'rejected'] as const;
export const ControlResultSchema = z.enum(CONTROL_RESULTS);
export type ControlResult = z.infer<typeof ControlResultSchema>;

/** config_audit 可审计字段（DATA-MODEL §3.5 config_audit.field，评审 P1-4）。 */
export const CONFIG_AUDIT_FIELDS = [
  'control_mode',
  'is_controllable',
  'clamp_min',
  'clamp_max',
  'write_rate_limit_per_hour',
] as const;
export const ConfigAuditFieldSchema = z.enum(CONFIG_AUDIT_FIELDS);
export type ConfigAuditField = z.infer<typeof ConfigAuditFieldSchema>;

/** M&V 基线状态（DATA-MODEL §3.6 mv_baseline.status）。 */
export const MV_BASELINE_STATUSES = ['draft', 'active', 'retired'] as const;
export const MvBaselineStatusSchema = z.enum(MV_BASELINE_STATUSES);
export type MvBaselineStatus = z.infer<typeof MvBaselineStatusSchema>;

/** M&V 方法（DATA-MODEL §3.6 mv_baseline.method；开放集，首版仅 IPMVP Option C）。 */
export const MV_METHODS = ['ipmvp_option_c'] as const;
export const MvMethodSchema = z.enum(MV_METHODS);
export type MvMethod = z.infer<typeof MvMethodSchema>;

/**
 * 告警规则作用域（DATA-MODEL §3.7 alarm_rule.scope）。
 * IMPL-13 增补 'gateway'（M4-alarm.md §4.1 R3：源头 ddl.md §7 差异 #7 已定
 * 「scope/source_type 增加 gateway」——网关离线告警链路）。
 */
export const ALARM_SCOPES = ['point', 'equipment', 'system', 'gateway'] as const;
export const AlarmScopeSchema = z.enum(ALARM_SCOPES);
export type AlarmScope = z.infer<typeof AlarmScopeSchema>;

/** 告警事件状态（DATA-MODEL §3.7 alarm_event.status）。 */
export const ALARM_EVENT_STATUSES = ['open', 'acked', 'closed', 'suppressed'] as const;
export const AlarmEventStatusSchema = z.enum(ALARM_EVENT_STATUSES);
export type AlarmEventStatus = z.infer<typeof AlarmEventStatusSchema>;

/** 楼宇类型（DATA-MODEL §3.2 building_type）。 */
export const BUILDING_TYPES = ['office', 'mall', 'hospital', 'campus', 'gov'] as const;
export const BuildingTypeSchema = z.enum(BUILDING_TYPES);
export type BuildingType = z.infer<typeof BuildingTypeSchema>;

// ---------------------------------------------------------------------------
// M4 告警域增量（IMPL-13 / DAT-116，M4-alarm.md §4.1 定稿；DAT-104 管道：
// ALARM_SEVERITIES 以开工时点 platform.md §6.3 与 ddl.md §4 CHECK 逐值对照，
// 零自造——2026-09-27 两源均为 info|warning|minor|major|critical）
// ---------------------------------------------------------------------------

/**
 * 告警/FDD 同源五级（platform.md §6.3 ALARM_SEVERITIES；源头 ddl.md §4
 * alarm_rule/alarm_event severity CHECK）。
 */
export const ALARM_SEVERITIES = ['info', 'warning', 'minor', 'major', 'critical'] as const;
export const AlarmSeveritySchema = z.enum(ALARM_SEVERITIES);
export type AlarmSeverity = z.infer<typeof AlarmSeveritySchema>;

/**
 * 可配置规则类型（M4-alarm.md §4.1；新增 = 发版动作，platform §6.1）。
 * 值阈值规则不建（R8：引擎不消费 raw telemetry，platform §1 边界）。
 */
export const ALARM_RULE_TYPES = ['point_stale', 'gateway_offline', 'fdd_finding'] as const;
export const AlarmRuleTypeSchema = z.enum(ALARM_RULE_TYPES);
export type AlarmRuleType = z.infer<typeof AlarmRuleTypeSchema>;

/**
 * 告警行类别（M4-alarm.md §4.1）= 规则命中类 ∪ 直写类（control-safety §5.4
 * 「不新建告警类型」= 不进规则目录，走引擎直写通道）。
 */
export const ALARM_CATEGORIES = [
  ...ALARM_RULE_TYPES,
  'control_verify_failed',
  'control_lease_rollback',
  'control_drift',
] as const;
export const AlarmCategorySchema = z.enum(ALARM_CATEGORIES);
export type AlarmCategory = z.infer<typeof AlarmCategorySchema>;

/** 系统关闭原因机器标记（M4-alarm.md §4.1；人工关闭 = 自由文本 close_reason）。 */
export const ALARM_CLOSE_REASONS_SYSTEM = [
  'auto_recovered',
  'root_group_cascade',
  'point_disabled',
] as const;
export const AlarmCloseReasonSystemSchema = z.enum(ALARM_CLOSE_REASONS_SYSTEM);
export type AlarmCloseReasonSystem = z.infer<typeof AlarmCloseReasonSystemSchema>;

/** 抑制行结束原因（M4-alarm.md §2.4 alarm_suppression.ended_reason CHECK 逐字）。 */
export const ALARM_SUPPRESSION_END_REASONS = [
  'expired',
  'unsuppressed',
  'alarm_closed',
  'superseded',
] as const;
export const AlarmSuppressionEndReasonSchema = z.enum(ALARM_SUPPRESSION_END_REASONS);
export type AlarmSuppressionEndReason = z.infer<typeof AlarmSuppressionEndReasonSchema>;

/** 抑制时长值域秒（M4-alarm.md §3.6：5min..24h 维护窗口语义）。 */
export const ALARM_SUPPRESS_DURATION_S = { min: 300, max: 86400 } as const;

/**
 * sustained_s 分级默认表（M4-alarm.md §4.1 定夺：critical 即时，warning 需持续达标；
 * severity 缺省时按此表补全落库）。
 */
export const ALARM_SUSTAINED_S_DEFAULT: Readonly<Record<AlarmSeverity, number>> = {
  critical: 0,
  major: 60,
  minor: 300,
  warning: 300,
  info: 900,
};

/** recovery_s 回稳窗默认（M4-alarm.md §4.1 表；fdd_finding 默认 0 即时）。 */
export const ALARM_RECOVERY_S_DEFAULT = {
  point_stale: 300,
  gateway_offline: 120,
  fdd_finding: 0,
} as const;

/**
 * ingest 质量事件 event 值集（M4-alarm.md §5.3/R7：随 shared-types 钉死；
 * M4 引擎仅消费 stale_set/stale_clear 边沿——ts_skew/unit_unconverted 为
 * 观测事件，告警去抖口径归 DAT-122 归属卡，v1 不建规则）。
 */
export const QUALITY_EVENTS = ['stale_set', 'stale_clear', 'ts_skew', 'unit_unconverted'] as const;
export const QualityEventSchema = z.enum(QUALITY_EVENTS);
export type QualityEvent = z.infer<typeof QualityEventSchema>;

// 导入域（M2 点表导入；platform.md §6.3 v1.1 增补，源头 = ddl.md §9.1 CHECK 集，
// 非 DATA-MODEL v1.1——DAT-104 管道：随消费方 IMPL-15 落地，对照时点 2026-09-27）
// ---------------------------------------------------------------------------

/** 导入作业状态机（ddl.md §9.1 import_job.status CHECK；六值封闭集，failed 为终态）。 */
export const IMPORT_JOB_STATUSES = [
  'parsed',
  'mapping',
  'validated',
  'applied',
  'checked',
  'failed',
] as const;
export const ImportJobStatusSchema = z.enum(IMPORT_JOB_STATUSES);
export type ImportJobStatus = z.infer<typeof ImportJobStatusSchema>;

/** 行映射来源三态（ddl.md §9.1 import_row.map_status CHECK；「已映射」判定锚 = quantity_type 非空）。 */
export const IMPORT_ROW_MAP_STATUSES = ['unmapped', 'auto', 'manual'] as const;
export const ImportRowMapStatusSchema = z.enum(IMPORT_ROW_MAP_STATUSES);
export type ImportRowMapStatus = z.infer<typeof ImportRowMapStatusSchema>;

/** dry-run 行级/作业级问题码（issues jsonb 的 code 值域，M2-import §1.6/§7；封闭集）。 */
export const IMPORT_ISSUE_CODES = [
  'row_unmapped', // 阻塞：quantity_type 为空
  'raw_name_duplicate_internal', // 阻塞：表内 raw_name 重复
  'raw_name_conflict_existing', // 阻塞：与同网关已注册点冲突（IMPORT_APPLY_CONFLICT 行面）
  'quantity_type_unknown', // 阻塞：枚举值域外（防御性，PATCH 已拦）
  'write_point_not_numeric', // 阻塞：写点量类型非数值量（P2-3）
  'unit_unsupported', // 阻塞：单位对无转换规则（UNIT_CONVERSION_UNSUPPORTED 行面）
  'unit_std_missing', // 警告：unit_raw 非空而 unit_std 空（直通语义）
  'equipment_unassigned', // 警告：已映射但未指定设备（独立测点合法）
  'write_point_clamp_pending', // 警告：写点闸门参数待 M8 配置（apply 后置动作）
  'gateway_offline', // 作业级警告：网关当前离线（apply 将被 409 拦）
  'offline_action_ref_unresolved', // 作业级警告：offline_action 引用点不可解析（M1-R10 收口）
] as const;
export const ImportIssueCodeSchema = z.enum(IMPORT_ISSUE_CODES);
export type ImportIssueCode = z.infer<typeof ImportIssueCodeSchema>;

/** 作业 failure.code 值域（failure jsonb，M2-import §1.6/§4.4；封闭集）。 */
export const IMPORT_FAILURE_CODES = [
  'template_mismatch', // parse 段：表头不符（IMPORT_TEMPLATE_MISMATCH 承载）
  'row_limit_exceeded', // parse 段：数据行超 5,000
  'sheet_corrupt', // parse 段：工作表损坏/不可读
  'gateway_ack_timeout', // apply_push 段：应答超时（重试耗尽）
  'gateway_ack_partial', // apply_push 段：部分点应答失败（失败清单入 failure.rows）
  'gateway_ack_failed', // apply_push 段：网关整体拒绝
] as const;
export const ImportFailureCodeSchema = z.enum(IMPORT_FAILURE_CODES);
export type ImportFailureCode = z.infer<typeof ImportFailureCodeSchema>;

/** 表格方向列容错映射（M2-import §1.6/§5.2；键小写化后匹配，未知值解析期从严拒绝）。 */
export const IMPORT_TOLERANT_DIRECTIONS = {
  read: 'read',
  只读: 'read',
  ro: 'read',
  write: 'write',
  写: 'write',
  wo: 'write',
  readwrite: 'readwrite',
  读写: 'readwrite',
  rw: 'readwrite',
} as const;
export type ImportTolerantDirection = keyof typeof IMPORT_TOLERANT_DIRECTIONS;
export type ImportDirection = (typeof IMPORT_TOLERANT_DIRECTIONS)[ImportTolerantDirection];

/**
 * 量类型语义分类（P2-3 写点数值量判据；随 QUANTITY_TYPES 扩充同步维护）。
 * Record 形状由 import.test.ts 钉死与 QUANTITY_TYPES 键集一致。
 */
export const QUANTITY_KINDS = {
  chw_supply_temp: 'numeric',
  power: 'numeric',
  run_status: 'enum',
  energy: 'numeric', // R12 增量（M3-monitor §11）：能量累计量 kWh，数值量
  load_rate: 'numeric', // R12 增量：负荷率 %，数值量（P2-3 写点判据同适用）
  chw_supply_temp_setpoint: 'numeric', // IMPL-19 增量：R1 目标（P2-3 写点数值量）
  chw_return_temp: 'numeric', // R1/R2 判据 ΔT
  chw_flow_rate: 'numeric', // 冷负荷实测（可缺，缺则 power proxy）
  unit_enable: 'numeric', // R2/R3 目标（0/1 数值命令；run_status 的枚态语义不适用于命令点）
  cooling_water_supply_temp: 'numeric', // R4 逼近温度
  cw_supply_temp_setpoint: 'numeric', // R4 目标
  tower_fan_power: 'numeric', // R4 风机余量判据与惩罚项
} as const satisfies Record<QuantityType, 'numeric' | 'enum'>;
export type QuantityKind = (typeof QUANTITY_KINDS)[QuantityType];
