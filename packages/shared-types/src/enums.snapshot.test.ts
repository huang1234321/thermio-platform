/**
 * 枚举快照测试（platform.md §6.4 / §8 #3 验收）：
 * 改枚举必须显式改快照——发版动作的 CI 面，评审可见。
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ALARM_EVENT_STATUSES,
  ALARM_SCOPES,
  BUILDING_TYPES,
  CONFIG_AUDIT_FIELDS,
  CONTROL_ACTOR_TYPES,
  CONTROL_MODES,
  CONTROL_RESULTS,
  DEPLOYMENT_MODES,
  DIRECTIONS,
  EQUIPMENT_TYPES,
  MV_BASELINE_STATUSES,
  MV_METHODS,
  PROPOSAL_STATUSES,
  QUANTITY_TYPES,
  ROLES,
  SOURCE_TYPES,
  SYSTEM_TYPES,
  AlarmEventStatusSchema,
  BuildingTypeSchema,
  ControlModeSchema,
  ProposalStatusSchema,
  SourceTypeSchema,
  type AlarmEventStatus,
  type AlarmScope,
  type BuildingType,
  type ConfigAuditField,
  type ControlActorType,
  type ControlMode,
  type ControlResult,
  type DeploymentMode,
  type Direction,
  type EquipmentType,
  type MvBaselineStatus,
  type MvMethod,
  type ProposalStatus,
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
} as const;

describe('enum registry snapshot', () => {
  it('shouldRequireExplicitSnapshotUpdate_whenAnyEnumValueChanges', () => {
    expect(ENUM_REGISTRY).toMatchInlineSnapshot(`
      {
        "ALARM_EVENT_STATUSES": [
          "open",
          "acked",
          "closed",
          "suppressed",
        ],
        "ALARM_SCOPES": [
          "point",
          "equipment",
          "system",
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
        "QUANTITY_TYPES": [
          "chw_supply_temp",
          "power",
          "run_status",
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
    expectTypeOf<MvBaselineStatus>().toEqualTypeOf<(typeof MV_BASELINE_STATUSES)[number]>();
    expectTypeOf<MvMethod>().toEqualTypeOf<(typeof MV_METHODS)[number]>();
    expectTypeOf<AlarmScope>().toEqualTypeOf<(typeof ALARM_SCOPES)[number]>();
    expectTypeOf<AlarmEventStatus>().toEqualTypeOf<(typeof ALARM_EVENT_STATUSES)[number]>();
    expectTypeOf<BuildingType>().toEqualTypeOf<(typeof BUILDING_TYPES)[number]>();
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
  });

  it('shouldParseKnownValue_whenValueIsInTheRegistry', () => {
    expect(ControlModeSchema.safeParse('advisory').success).toBe(true);
    expect(ProposalStatusSchema.safeParse('executed').success).toBe(true);
  });
});
