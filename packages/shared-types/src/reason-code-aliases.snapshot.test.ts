/**
 * 设计期语义清单码 → 落码映射的闭集快照与定档断言（DAT-92 评审建议 1/2 收口，DAT-102）：
 * - 全量快照：改任何一条映射 = 发版动作，快照必须显式跟进（与 reason-codes.snapshot.test.ts
 *   同款治理，本文件管 OVERVIEW_DESIGN_CODE_ALIASES 这张表）；
 * - 双名收口：与 seed 同义异名的清单码以 seed 为准，机械直译码全表禁绝；
 * - 域归属定档：评审点名过的未定档码（QUANTITY_TYPE_UNKNOWN / CREDENTIAL_LIMIT_EXCEEDED /
 *   GATEWAY_NOT_FOUND 等）逐条钉死；
 * - 闭集不变量：目标码要么是已注册种子码（注册表可查），要么是形状合规的草案码
 *   （不在 REASON_CODES 内，注册前服务端不得发出）。
 */
import { describe, expect, it } from 'vitest';
import {
  OVERVIEW_DESIGN_CODE_ALIASES,
  REASON_CODE_REGISTRY,
  ReasonCodeSchema,
  isReasonCode,
} from './reason-codes.js';

/** §5.2 命名规则：`<domain>.<cause>` 全小写蛇形。 */
const LOWER_SNAKE_DOMAIN_CAUSE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/**
 * 审计基线（2026-09-26，DAT-102）：伞仓 main 的 overview.md / flows.md / ddl.md /
 * platform.md 全文反引号大写码逐条对照后的 reason_code 清单共 65 条，本表须逐一覆盖、
 * 零自造（表内每键都能在蓝本找到出处；蓝本外排除项见 PR 描述）。
 */
const AUDITED_DESIGN_CODE_COUNT = 65;

describe('OVERVIEW_DESIGN_CODE_ALIASES closed-set snapshot', () => {
  it('shouldRequireExplicitSnapshotUpdate_whenAnyMappingChanges', () => {
    expect(OVERVIEW_DESIGN_CODE_ALIASES).toMatchInlineSnapshot(`
      {
        "ALARM_NOT_FOUND": "alarm.not_found",
        "ALARM_RULE_NOT_FOUND": "alarm.rule_not_found",
        "ALARM_RULE_PARAMS_INVALID": "alarm.rule_params_invalid",
        "ALARM_RULE_SCOPE_INVALID": "alarm.rule_scope_invalid",
        "ALARM_STATE_INVALID": "alarm.state_invalid",
        "BUILDING_NAME_REQUIRED": "common.validation_failed",
        "BUILDING_NOT_FOUND": "asset.not_found",
        "CONFLICT": "common.version_conflict",
        "CONTROL_MODE_POINT_NOT_CONTROLLABLE": "point.control_mode_point_not_controllable",
        "CONTROL_MODE_SAME": "point.control_mode_same",
        "CONTROL_MODE_TRANSITION_INVALID": "point.control_mode_transition_invalid",
        "CREDENTIAL_LIMIT_EXCEEDED": "credential.limit_exceeded",
        "CREDENTIAL_NOT_FOUND": "credential.not_found",
        "EQUIPMENT_LOCAL_ID_DUPLICATE": "asset.local_id_duplicate",
        "EQUIPMENT_TYPE_UNKNOWN": "equipment_type.unknown",
        "FDD_FINDING_NOT_FOUND": "fdd.finding_not_found",
        "FDD_REPORT_NOT_FOUND": "fdd.report_not_found",
        "FORBIDDEN": "auth.forbidden",
        "GATEWAY_NOT_FOUND": "gateway.not_found",
        "GATEWAY_SERIAL_DUPLICATE": "gateway.serial_duplicate",
        "GATE_CLAMP_RANGE_INVALID": "point.gate_clamp_range_invalid",
        "GATE_CONTROLLABLE_REQUIRES_CLAMP": "point.gate_controllable_requires_clamp",
        "GATE_RATE_INVALID": "point.gate_rate_invalid",
        "GATE_REASON_REQUIRED": "point.gate_reason_required",
        "IMPORT_APPLY_CONFLICT": "import.apply_conflict",
        "IMPORT_FILE_INVALID": "import.file_invalid",
        "IMPORT_NOT_FOUND": "import.not_found",
        "IMPORT_STATE_INVALID": "import.state_invalid",
        "IMPORT_TEMPLATE_MISMATCH": "import.template_mismatch",
        "INTERNAL_ERROR": "common.internal_error",
        "LOGIN_FAILED": "auth.invalid_credentials",
        "NOT_FOUND": "asset.not_found",
        "PASSWORD_POLICY_FAILED": "user.password_policy_failed",
        "POINT_FIELD_NOT_ALLOWED": "point.field_not_allowed",
        "POINT_INACTIVE": "point.inactive",
        "POINT_NOT_FOUND": "asset.not_found",
        "POINT_NO_DATA": "point.no_data",
        "PROPOSAL_EXPIRED": "proposal.expired",
        "PROPOSAL_GATE_CONFLICT_QUEUED": "proposal.gate_conflict",
        "PROPOSAL_GATE_RATE_LIMITED": "proposal.gate_rate_limited",
        "PROPOSAL_GATE_SYSTEM_FUSED": "proposal.gate_circuit_open",
        "PROPOSAL_GATE_WHITELIST_DENIED": "proposal.gate_not_whitelisted",
        "PROPOSAL_NOT_FOUND": "proposal.not_found",
        "PROPOSAL_PAYLOAD_INVALID": "proposal.payload_invalid",
        "PROPOSAL_STATE_INVALID": "proposal.state_invalid",
        "PROPOSAL_VERIFY_FAILED": "proposal.verify_failed",
        "QUANTITY_TYPE_UNKNOWN": "quantity_type.unknown",
        "RATE_LIMITED": "common.rate_limited",
        "REFRESH_REVOKED": "auth.refresh_revoked",
        "ROLE_UNKNOWN": "role.unknown",
        "SCENE_NOT_FOUND": "scene.not_found",
        "SCOPE_BUILDING_MISMATCH": "user.scope_building_mismatch",
        "SELFCHECK_NOT_READY": "import.selfcheck_not_ready",
        "SERVICE_UNAUTHORIZED": "auth.service_unauthorized",
        "STREAM_LIMIT_EXCEEDED": "stream.limit_exceeded",
        "SUPPRESS_DURATION_INVALID": "alarm.suppress_duration_invalid",
        "SYSTEM_NOT_FOUND": "asset.not_found",
        "SYSTEM_TYPE_UNKNOWN": "system_type.unknown",
        "TELEMETRY_RANGE_INVALID": "telemetry.range_invalid",
        "TOKEN_EXPIRED": "auth.token_expired",
        "UNAUTHENTICATED": "auth.unauthenticated",
        "UNIT_CONVERSION_UNSUPPORTED": "import.unit_conversion_unsupported",
        "USER_EMAIL_DUPLICATE": "user.email_duplicate",
        "USER_NOT_FOUND": "user.not_found",
        "VALIDATION_FAILED": "common.validation_failed",
      }
    `);
  });

  it('shouldCoverTheAuditedDesignCodeInventory_exactly', () => {
    expect(Object.keys(OVERVIEW_DESIGN_CODE_ALIASES)).toHaveLength(AUDITED_DESIGN_CODE_COUNT);
  });
});

describe('双名收口（DAT-92 评审建议 1：同义异名以 seed 为准）', () => {
  it('shouldMapGate5ToTheSeedPinnedCode_notTheMechanicalTransliteration', () => {
    // ddl.md §9.3 / flows.md §2 的清单码 PROPOSAL_GATE_SYSTEM_FUSED 与 seed
    // proposal.gate_circuit_open 同义：映射以 seed 钉死的码为准。
    expect(OVERVIEW_DESIGN_CODE_ALIASES['PROPOSAL_GATE_SYSTEM_FUSED']).toBe(
      'proposal.gate_circuit_open',
    );
  });

  it('shouldOutlawTheSynonymousTwin_acrossTheWholeTable', () => {
    // 机械直译产物 proposal.gate_system_fused 是非法码：不入种子表、schema 拒解析、
    // 且不得作为任何清单码的映射目标出现（同义双码 = API-ERR-01 稳定性事故）。
    const mechanicalTwin = 'proposal.gate_system_fused';
    expect(isReasonCode(mechanicalTwin)).toBe(false);
    expect(ReasonCodeSchema.safeParse(mechanicalTwin).success).toBe(false);
    expect(Object.values(OVERVIEW_DESIGN_CODE_ALIASES)).not.toContain(mechanicalTwin);
  });
});

describe('域归属定档（DAT-92 评审建议 2：未定档码逐条钉死）', () => {
  it('shouldPinTheThreeReviewNamedCodes_toTheirDecidedDomains', () => {
    expect(OVERVIEW_DESIGN_CODE_ALIASES['QUANTITY_TYPE_UNKNOWN']).toBe('quantity_type.unknown');
    expect(OVERVIEW_DESIGN_CODE_ALIASES['CREDENTIAL_LIMIT_EXCEEDED']).toBe(
      'credential.limit_exceeded',
    );
    expect(OVERVIEW_DESIGN_CODE_ALIASES['GATEWAY_NOT_FOUND']).toBe('gateway.not_found');
  });

  it('shouldPinTheEnumValidationFamily_eachEnumAsItsOwnDomain', () => {
    // 枚举取值校验类逐条定档：各枚举独立域 `<枚举名小写>.unknown`，不并入 asset.*/user.*。
    expect(OVERVIEW_DESIGN_CODE_ALIASES['SYSTEM_TYPE_UNKNOWN']).toBe('system_type.unknown');
    expect(OVERVIEW_DESIGN_CODE_ALIASES['EQUIPMENT_TYPE_UNKNOWN']).toBe('equipment_type.unknown');
    expect(OVERVIEW_DESIGN_CODE_ALIASES['ROLE_UNKNOWN']).toBe('role.unknown');
  });

  it('shouldPinTheGenericTableCodes_toCommonDomainDrafts', () => {
    // overview §2 通用表（无业务域）→ common.*；两码为本批（DAT-102）补齐的缺项：
    // CONFLICT 语义是乐观并发（版本不符）→ 宁具体勿泛化取 version_conflict；
    // RATE_LIMITED 目标码是 platform.md §6 限流节明示的骨架码原字。
    expect(OVERVIEW_DESIGN_CODE_ALIASES['CONFLICT']).toBe('common.version_conflict');
    expect(OVERVIEW_DESIGN_CODE_ALIASES['RATE_LIMITED']).toBe('common.rate_limited');
  });
});

describe('闭集不变量（映射规式的机械校验面）', () => {
  const entries = Object.entries(OVERVIEW_DESIGN_CODE_ALIASES);

  it('shouldKeepBothSidesInTheirCanonicalShapes', () => {
    for (const [designCode, canonical] of entries) {
      expect(designCode, designCode).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(canonical, designCode).toMatch(LOWER_SNAKE_DOMAIN_CAUSE);
    }
  });

  it('shouldPartitionEveryTarget_intoRegisteredSeedOrDraft', () => {
    // 目标码二分：已注册（isReasonCode 且注册表可查）或草案（不在 REASON_CODES 内）。
    // 草案→注册的每次转正都会改变本分区快照 = 显式发版动作，评审可见。
    const registered: string[] = [];
    const draft: string[] = [];
    for (const [designCode, canonical] of entries) {
      if (isReasonCode(canonical)) {
        // isReasonCode 的类型谓词已把 canonical 收窄到 ReasonCode（种子码键）。
        expect(REASON_CODE_REGISTRY[canonical], designCode).toBeDefined();
        registered.push(designCode);
      } else {
        draft.push(designCode);
      }
    }
    expect({ registered: registered.sort(), draft: draft.sort() }).toMatchInlineSnapshot(`
      {
        "draft": [
          "ALARM_NOT_FOUND",
          "ALARM_RULE_PARAMS_INVALID",
          "ALARM_RULE_SCOPE_INVALID",
          "ALARM_STATE_INVALID",
          "CONFLICT",
          "CONTROL_MODE_POINT_NOT_CONTROLLABLE",
          "CONTROL_MODE_SAME",
          "CONTROL_MODE_TRANSITION_INVALID",
          "CREDENTIAL_LIMIT_EXCEEDED",
          "CREDENTIAL_NOT_FOUND",
          "EQUIPMENT_LOCAL_ID_DUPLICATE",
          "EQUIPMENT_TYPE_UNKNOWN",
          "FDD_FINDING_NOT_FOUND",
          "FDD_REPORT_NOT_FOUND",
          "GATEWAY_NOT_FOUND",
          "GATEWAY_SERIAL_DUPLICATE",
          "GATE_CLAMP_RANGE_INVALID",
          "GATE_CONTROLLABLE_REQUIRES_CLAMP",
          "GATE_RATE_INVALID",
          "GATE_REASON_REQUIRED",
          "IMPORT_APPLY_CONFLICT",
          "IMPORT_FILE_INVALID",
          "IMPORT_NOT_FOUND",
          "IMPORT_STATE_INVALID",
          "IMPORT_TEMPLATE_MISMATCH",
          "POINT_FIELD_NOT_ALLOWED",
          "POINT_INACTIVE",
          "PROPOSAL_EXPIRED",
          "PROPOSAL_NOT_FOUND",
          "PROPOSAL_PAYLOAD_INVALID",
          "PROPOSAL_STATE_INVALID",
          "PROPOSAL_VERIFY_FAILED",
          "QUANTITY_TYPE_UNKNOWN",
          "SCENE_NOT_FOUND",
          "SELFCHECK_NOT_READY",
          "STREAM_LIMIT_EXCEEDED",
          "SUPPRESS_DURATION_INVALID",
          "SYSTEM_TYPE_UNKNOWN",
          "UNIT_CONVERSION_UNSUPPORTED",
        ],
        "registered": [
          "ALARM_RULE_NOT_FOUND",
          "BUILDING_NAME_REQUIRED",
          "BUILDING_NOT_FOUND",
          "FORBIDDEN",
          "INTERNAL_ERROR",
          "LOGIN_FAILED",
          "NOT_FOUND",
          "PASSWORD_POLICY_FAILED",
          "POINT_NOT_FOUND",
          "POINT_NO_DATA",
          "PROPOSAL_GATE_CONFLICT_QUEUED",
          "PROPOSAL_GATE_RATE_LIMITED",
          "PROPOSAL_GATE_SYSTEM_FUSED",
          "PROPOSAL_GATE_WHITELIST_DENIED",
          "RATE_LIMITED",
          "REFRESH_REVOKED",
          "ROLE_UNKNOWN",
          "SCOPE_BUILDING_MISMATCH",
          "SERVICE_UNAUTHORIZED",
          "SYSTEM_NOT_FOUND",
          "TELEMETRY_RANGE_INVALID",
          "TOKEN_EXPIRED",
          "UNAUTHENTICATED",
          "USER_EMAIL_DUPLICATE",
          "USER_NOT_FOUND",
          "VALIDATION_FAILED",
        ],
      }
    `);
  });
});
