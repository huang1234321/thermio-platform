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

/** 量类型（DATA-MODEL §3.3 quantity_type）。消费方：FDD 规则库「设备类型 × 量类型」二维标签。 */
export const QUANTITY_TYPES = ['chw_supply_temp', 'power', 'run_status'] as const;
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

/** 告警规则作用域（DATA-MODEL §3.7 alarm_rule.scope）。 */
export const ALARM_SCOPES = ['point', 'equipment', 'system'] as const;
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
