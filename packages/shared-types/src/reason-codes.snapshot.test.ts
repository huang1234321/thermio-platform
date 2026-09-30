/**
 * reason_code 种子表快照测试（platform.md §5.2 / §6.4 同款治理）：
 * 改种子表必须显式改快照——发版动作的 CI 面，评审可见。
 */
import { describe, expect, it } from 'vitest';
import {
  GATE_CAUSES,
  GATE_CAUSE_LABELS,
  PROPOSAL_GATE_REASON_CODES,
  REASON_CODE_REGISTRY,
} from './reason-codes.js';

describe('reason_code registry snapshot', () => {
  it('shouldRequireExplicitSnapshotUpdate_whenAnySeedEntryChanges', () => {
    // 只取 {code → http/gate} 骨架做快照；description 文案不进快照（非契约面）。
    const skeleton = Object.fromEntries(
      Object.entries(REASON_CODE_REGISTRY).map(([code, meta]) => [
        code,
        { http: meta.http, ...(meta.gate ? { gate: meta.gate } : {}) },
      ]),
    );
    expect(skeleton).toMatchInlineSnapshot(`
      {
        "alarm.not_found": {
          "http": 404,
        },
        "alarm.rule_in_use": {
          "http": 409,
        },
        "alarm.rule_not_found": {
          "http": 404,
        },
        "alarm.rule_params_invalid": {
          "http": 422,
        },
        "alarm.rule_scope_invalid": {
          "http": 422,
        },
        "alarm.rule_type_unknown": {
          "http": 422,
        },
        "alarm.severity_unknown": {
          "http": 422,
        },
        "alarm.state_invalid": {
          "http": 409,
        },
        "alarm.suppress_duration_invalid": {
          "http": 422,
        },
        "asset.building_type_unknown": {
          "http": 422,
        },
        "asset.duplicate_raw_name": {
          "http": 409,
        },
        "asset.equipment_type_unknown": {
          "http": 422,
        },
        "asset.local_id_duplicate": {
          "http": 409,
        },
        "asset.not_found": {
          "http": 404,
        },
        "asset.system_type_unknown": {
          "http": 422,
        },
        "auth.forbidden": {
          "http": 403,
        },
        "auth.invalid_credentials": {
          "http": 401,
        },
        "auth.refresh_revoked": {
          "http": 401,
        },
        "auth.service_unauthorized": {
          "http": 401,
        },
        "auth.token_expired": {
          "http": 401,
        },
        "auth.unauthenticated": {
          "http": 401,
        },
        "common.conflict": {
          "http": 409,
        },
        "common.internal_error": {
          "http": 500,
        },
        "common.not_found": {
          "http": 404,
        },
        "common.rate_limited": {
          "http": 429,
        },
        "common.validation_failed": {
          "http": 422,
        },
        "credential.limit_exceeded": {
          "http": 409,
        },
        "credential.not_found": {
          "http": 404,
        },
        "fdd.finding_not_found": {
          "http": 404,
        },
        "fdd.report_not_found": {
          "http": 404,
        },
        "fdd.state_invalid": {
          "http": 409,
        },
        "gateway.not_found": {
          "http": 404,
        },
        "gateway.serial_duplicate": {
          "http": 409,
        },
        "import.apply_conflict": {
          "http": 409,
        },
        "import.building_mismatch": {
          "http": 422,
        },
        "import.file_invalid": {
          "http": 422,
        },
        "import.gateway_offline": {
          "http": 409,
        },
        "import.not_found": {
          "http": 404,
        },
        "import.selfcheck_not_ready": {
          "http": 404,
        },
        "import.state_invalid": {
          "http": 409,
        },
        "import.unit_conversion_unsupported": {
          "http": 422,
        },
        "mv.baseline_not_active": {
          "http": 409,
        },
        "mv.period_invalid": {
          "http": 422,
        },
        "point.control_mode_point_not_controllable": {
          "http": 409,
        },
        "point.control_mode_same": {
          "http": 409,
        },
        "point.control_mode_transition_invalid": {
          "http": 409,
        },
        "point.field_not_allowed": {
          "http": 400,
        },
        "point.gate_clamp_range_invalid": {
          "http": 422,
        },
        "point.gate_controllable_requires_clamp": {
          "http": 422,
        },
        "point.gate_rate_invalid": {
          "http": 422,
        },
        "point.gate_reason_required": {
          "http": 422,
        },
        "point.no_data": {
          "http": 404,
        },
        "point.not_controllable": {
          "http": 409,
        },
        "point.not_found": {
          "http": 400,
        },
        "point.quantity_type_unknown": {
          "http": 422,
        },
        "point.write_not_numeric": {
          "http": 422,
        },
        "proposal.client_ref_duplicate": {
          "http": 409,
        },
        "proposal.expired": {
          "http": 409,
        },
        "proposal.gate_clamped": {
          "gate": "clamp",
          "http": 200,
        },
        "proposal.gate_conflict_overflow": {
          "gate": "conflict",
          "http": 409,
        },
        "proposal.gate_conflict_queued": {
          "gate": "conflict",
          "http": 409,
        },
        "proposal.gate_conflict_timeout": {
          "gate": "conflict",
          "http": 409,
        },
        "proposal.gate_rate_limited": {
          "gate": "rate",
          "http": 429,
        },
        "proposal.gate_system_fused": {
          "gate": "fuse",
          "http": 503,
        },
        "proposal.gate_whitelist_denied": {
          "gate": "whitelist",
          "http": 409,
        },
        "proposal.not_found": {
          "http": 404,
        },
        "proposal.payload_invalid": {
          "http": 422,
        },
        "proposal.reason_required": {
          "http": 422,
        },
        "proposal.state_invalid": {
          "http": 409,
        },
        "role.unknown": {
          "http": 422,
        },
        "stream.limit_exceeded": {
          "http": 400,
        },
        "stream.server_busy": {
          "http": 503,
        },
        "telemetry.range_invalid": {
          "http": 422,
        },
        "telemetry.store_unavailable": {
          "http": 503,
        },
        "user.email_duplicate": {
          "http": 409,
        },
        "user.not_found": {
          "http": 404,
        },
        "user.password_policy_failed": {
          "http": 422,
        },
        "user.scope_building_mismatch": {
          "http": 404,
        },
      }
    `);
  });

  it('shouldKeepGateCausesAsTheSingleSource_whenDerivingGateCodesAndMetricLabels', () => {
    // §5.2「与 ADR-017 的咬合」（v1.5〔R1，DAT-132〕）：七 cause → label 机械映射，
    // 闸门 4 三码同 conflict label——code 与指标 label 一次定义两处消费。
    expect([...PROPOSAL_GATE_REASON_CODES]).toEqual(
      GATE_CAUSES.map((cause) => `proposal.${cause}`),
    );
    const gateMeta = Object.values(REASON_CODE_REGISTRY)
      .filter((meta) => meta.gate !== undefined)
      .map((meta) => meta.gate);
    expect(gateMeta).toEqual(GATE_CAUSES.map((cause) => GATE_CAUSE_LABELS[cause]));
    // label 值域封闭：whitelist/rate/conflict/fuse 拒绝 + clamp 独立计数
    expect(new Set(gateMeta)).toEqual(new Set(['whitelist', 'clamp', 'rate', 'conflict', 'fuse']));
  });
});
