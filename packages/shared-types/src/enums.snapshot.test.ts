/**
 * 枚举快照测试（platform.md §6.4 / §8 #3 验收）：
 * 改枚举必须显式改快照——发版动作的 CI 面，评审可见。
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ALARM_CATEGORIES,
  ALARM_CLOSE_REASONS_SYSTEM,
  ALARM_EVENT_STATUSES,
  ALARM_RULE_TYPES,
  ALARM_SCOPES,
  ALARM_SEVERITIES,
  ALARM_SUPPRESSION_END_REASONS,
  BUILDING_TYPES,
  CONFIG_AUDIT_FIELDS,
  CONTROL_ACTOR_TYPES,
  CONTROL_MODES,
  CONTROL_RESULTS,
  DEPLOYMENT_MODES,
  DIRECTIONS,
  EQUIPMENT_TYPES,
  FDD_FINDING_STATUSES,
  FDD_REPORT_PERIOD_TYPES,
  MV_BASELINE_STATUSES,
  MV_METHODS,
  PROPOSAL_STATUSES,
  QUALITY_EVENTS,
  QUANTITY_TYPES,
  ROLES,
  SOURCE_TYPES,
  SYSTEM_TYPES,
  AlarmCategorySchema,
  AlarmEventStatusSchema,
  AlarmRuleTypeSchema,
  AlarmScopeSchema,
  AlarmSeveritySchema,
  BuildingTypeSchema,
  FddFindingStatusSchema,
  FddReportPeriodTypeSchema,
  ControlModeSchema,
  ProposalStatusSchema,
  QualityEventSchema,
  SourceTypeSchema,
  type AlarmCategory,
  type AlarmCloseReasonSystem,
  type AlarmEventStatus,
  type AlarmRuleType,
  type AlarmScope,
  type AlarmSeverity,
  type AlarmSuppressionEndReason,
  type BuildingType,
  type ConfigAuditField,
  type ControlActorType,
  type ControlMode,
  type ControlResult,
  type DeploymentMode,
  type Direction,
  type EquipmentType,
  type FddFindingStatus,
  type FddReportPeriodType,
  type MvBaselineStatus,
  type MvMethod,
  type ProposalStatus,
  type QualityEvent,
  type QuantityType,
  type Role,
  type SourceType,
  type SystemType,
} from './enums.js';

/** 首版枚举注册表（§6 全集）：改这里 = 发版，快照必须显式跟进。 */
const ENUM_REGISTRY = {
  // 语义枚举（开放集首版草案）
  SYSTEM_TYPES,
  EQUIPMENT_TYPES,
  QUANTITY_TYPES,
  // 闭合枚举
  SOURCE_TYPES,
  DIRECTIONS,
  CONTROL_MODES,
  DEPLOYMENT_MODES,
  ROLES,
  PROPOSAL_STATUSES,
  CONTROL_ACTOR_TYPES,
  CONTROL_RESULTS,
  CONFIG_AUDIT_FIELDS,
  MV_BASELINE_STATUSES,
  MV_METHODS,
  ALARM_SCOPES,
  ALARM_EVENT_STATUSES,
  BUILDING_TYPES,
  // M4 告警域增量（IMPL-13 / DAT-116，DAT-104 管道）
  ALARM_SEVERITIES,
  ALARM_RULE_TYPES,
  ALARM_CATEGORIES,
  ALARM_CLOSE_REASONS_SYSTEM,
  ALARM_SUPPRESSION_END_REASONS,
  QUALITY_EVENTS,
} as const;

describe('enum registry snapshot', () => {
  it('shouldRequireExplicitSnapshotUpdate_whenAnyEnumValueChanges', () => {
    expect(ENUM_REGISTRY).toMatchInlineSnapshot(`
      {
        "ALARM_CATEGORIES": [
          "point_stale",
          "gateway_offline",
          "fdd_finding",
          "control_verify_failed",
          "control_lease_rollback",
          "control_drift",
        ],
        "ALARM_CLOSE_REASONS_SYSTEM": [
          "auto_recovered",
          "root_group_cascade",
          "point_disabled",
        ],
        "ALARM_EVENT_STATUSES": [
          "open",
          "acked",
          "closed",
          "suppressed",
        ],
        "ALARM_RULE_TYPES": [
          "point_stale",
          "gateway_offline",
          "fdd_finding",
        ],
        "ALARM_SCOPES": [
          "point",
          "equipment",
          "system",
          "gateway",
        ],
        "ALARM_SEVERITIES": [
          "info",
          "warning",
          "minor",
          "major",
          "critical",
        ],
        "ALARM_SUPPRESSION_END_REASONS": [
          "expired",
          "unsuppressed",
          "alarm_closed",
          "superseded",
        ],
        "BUILDING_TYPES": [
          "office",
          "mall",
          "hospital",
          "campus",
          "gov",
        ],
        "CONFIG_AUDIT_FIELDS": [
          "control_mode",
          "is_controllable",
          "clamp_min",
          "clamp_max",
          "write_rate_limit_per_hour",
        ],
        "CONTROL_ACTOR_TYPES": [
          "algo",
          "human",
          "system",
        ],
        "CONTROL_MODES": [
          "advisory",
          "supervised",
          "auto",
        ],
        "CONTROL_RESULTS": [
          "ok",
          "verify_failed",
          "reverted",
          "rejected",
        ],
        "DEPLOYMENT_MODES": [
          "private",
          "saas",
        ],
        "DIRECTIONS": [
          "read",
          "write",
          "readwrite",
        ],
        "EQUIPMENT_TYPES": [
          "chiller",
          "chwp_pump",
          "cwp_pump",
          "cooling_tower",
          "ahu",
          "valve",
          "sensor",
          "energy_meter",
        ],
        "MV_BASELINE_STATUSES": [
          "draft",
          "active",
          "retired",
        ],
        "MV_METHODS": [
          "ipmvp_option_c",
        ],
        "PROPOSAL_STATUSES": [
          "pending",
          "approved",
          "rejected",
          "expired",
          "executed",
          "failed",
        ],
        "QUALITY_EVENTS": [
          "stale_set",
          "stale_clear",
          "ts_skew",
          "unit_unconverted",
        ],
        "QUANTITY_TYPES": [
          "chw_supply_temp",
          "power",
          "run_status",
          "energy",
          "load_rate",
        ],
        "ROLES": [
          "admin",
          "operator",
          "viewer",
        ],
        "SOURCE_TYPES": [
          "mqtt_gateway",
          "bacnet",
          "virtual",
        ],
        "SYSTEM_TYPES": [
          "chilled_water",
          "cooling_water",
          "ahu",
          "vav",
        ],
      }
    `);
  });
});

describe('enum schema/type single source (platform.md §5.3)', () => {
  // 链路：const 数组 → z.enum schema → z.infer 导出类型。
  // 断言导出类型与 const 数组字面量联合一致，任何一环被手改漂移都会在此编译报错。
  it('shouldStayAligned_whenComparingExportedTypesAgainstConstArrays', () => {
    expectTypeOf<SystemType>().toEqualTypeOf<(typeof SYSTEM_TYPES)[number]>();
    expectTypeOf<EquipmentType>().toEqualTypeOf<(typeof EQUIPMENT_TYPES)[number]>();
    expectTypeOf<QuantityType>().toEqualTypeOf<(typeof QUANTITY_TYPES)[number]>();
    expectTypeOf<SourceType>().toEqualTypeOf<(typeof SOURCE_TYPES)[number]>();
    expectTypeOf<Direction>().toEqualTypeOf<(typeof DIRECTIONS)[number]>();
    expectTypeOf<ControlMode>().toEqualTypeOf<(typeof CONTROL_MODES)[number]>();
    expectTypeOf<DeploymentMode>().toEqualTypeOf<(typeof DEPLOYMENT_MODES)[number]>();
    expectTypeOf<Role>().toEqualTypeOf<(typeof ROLES)[number]>();
    expectTypeOf<ProposalStatus>().toEqualTypeOf<(typeof PROPOSAL_STATUSES)[number]>();
    expectTypeOf<ControlActorType>().toEqualTypeOf<(typeof CONTROL_ACTOR_TYPES)[number]>();
    expectTypeOf<ControlResult>().toEqualTypeOf<(typeof CONTROL_RESULTS)[number]>();
    expectTypeOf<ConfigAuditField>().toEqualTypeOf<(typeof CONFIG_AUDIT_FIELDS)[number]>();
    expectTypeOf<FddFindingStatus>().toEqualTypeOf<(typeof FDD_FINDING_STATUSES)[number]>();
    expectTypeOf<FddReportPeriodType>().toEqualTypeOf<(typeof FDD_REPORT_PERIOD_TYPES)[number]>();
    expectTypeOf<MvBaselineStatus>().toEqualTypeOf<(typeof MV_BASELINE_STATUSES)[number]>();
    expectTypeOf<MvMethod>().toEqualTypeOf<(typeof MV_METHODS)[number]>();
    expectTypeOf<AlarmScope>().toEqualTypeOf<(typeof ALARM_SCOPES)[number]>();
    expectTypeOf<AlarmEventStatus>().toEqualTypeOf<(typeof ALARM_EVENT_STATUSES)[number]>();
    expectTypeOf<BuildingType>().toEqualTypeOf<(typeof BUILDING_TYPES)[number]>();
    expectTypeOf<AlarmSeverity>().toEqualTypeOf<(typeof ALARM_SEVERITIES)[number]>();
    expectTypeOf<AlarmRuleType>().toEqualTypeOf<(typeof ALARM_RULE_TYPES)[number]>();
    expectTypeOf<AlarmCategory>().toEqualTypeOf<(typeof ALARM_CATEGORIES)[number]>();
    expectTypeOf<AlarmCloseReasonSystem>().toEqualTypeOf<
      (typeof ALARM_CLOSE_REASONS_SYSTEM)[number]
    >();
    expectTypeOf<AlarmSuppressionEndReason>().toEqualTypeOf<
      (typeof ALARM_SUPPRESSION_END_REASONS)[number]
    >();
    expectTypeOf<QualityEvent>().toEqualTypeOf<(typeof QUALITY_EVENTS)[number]>();
  });
});

describe('closed-set enforcement (platform.md §6.4)', () => {
  it('shouldRejectRegistryValue_whenParsedValueIsOutsideTheClosedSet', () => {
    // 清单外的历史/脏值必须解析失败 → 消费方按 UNKNOWN 兜底并告警，不静默吞
    expect(ControlModeSchema.safeParse('turbo').success).toBe(false);
    expect(ProposalStatusSchema.safeParse('cancelled').success).toBe(false);
    expect(AlarmEventStatusSchema.safeParse('reopened').success).toBe(false);
    expect(SourceTypeSchema.safeParse('modbus').success).toBe(false);
    expect(BuildingTypeSchema.safeParse('school').success).toBe(false);
    // M4 告警域增量（DAT-104：闭合集拒绝随注册表同步覆盖）
    expect(AlarmSeveritySchema.safeParse('fatal').success).toBe(false);
    expect(AlarmRuleTypeSchema.safeParse('value_threshold').success).toBe(false);
    expect(AlarmCategorySchema.safeParse('infra_tsdb_down').success).toBe(false);
    expect(QualityEventSchema.safeParse('stale').success).toBe(false);
    // FDD 域（IMPL-17 并入项，DAT-104 管道同步覆盖）
    expect(FddFindingStatusSchema.safeParse('closed').success).toBe(false);
    expect(FddReportPeriodTypeSchema.safeParse('month').success).toBe(false);
  });

  it('shouldParseKnownValue_whenValueIsInTheRegistry', () => {
    expect(ControlModeSchema.safeParse('advisory').success).toBe(true);
    expect(ProposalStatusSchema.safeParse('executed').success).toBe(true);
    expect(AlarmSeveritySchema.safeParse('critical').success).toBe(true);
    expect(AlarmRuleTypeSchema.safeParse('gateway_offline').success).toBe(true);
    expect(AlarmCategorySchema.safeParse('control_drift').success).toBe(true);
    expect(AlarmScopeSchema.safeParse('gateway').success).toBe(true);
    expect(FddFindingStatusSchema.safeParse('ignored').success).toBe(true);
    expect(FddReportPeriodTypeSchema.safeParse('week').success).toBe(true);
  });
});
