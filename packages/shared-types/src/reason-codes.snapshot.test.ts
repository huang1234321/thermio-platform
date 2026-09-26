/**
 * reason_code 种子表快照测试（platform.md §5.2 / §6.4 同款治理）：
 * 改种子表必须显式改快照——发版动作的 CI 面，评审可见。
 */
import { describe, expect, it } from 'vitest';
import { GATE_CAUSES, PROPOSAL_GATE_REASON_CODES, REASON_CODE_REGISTRY } from './reason-codes.js';

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
        "alarm.rule_not_found": {
          "http": 404,
        },
        "asset.duplicate_raw_name": {
          "http": 409,
        },
        "asset.not_found": {
          "http": 404,
        },
        "auth.forbidden": {
          "http": 403,
        },
        "auth.invalid_credentials": {
          "http": 401,
        },
        "auth.token_expired": {
          "http": 401,
        },
        "common.internal_error": {
          "http": 500,
        },
        "common.validation_failed": {
          "http": 422,
        },
        "mv.baseline_not_active": {
          "http": 409,
        },
        "mv.period_invalid": {
          "http": 422,
        },
        "point.no_data": {
          "http": 404,
        },
        "point.not_controllable": {
          "http": 409,
        },
        "point.write_not_numeric": {
          "http": 422,
        },
        "proposal.gate_circuit_open": {
          "gate": "gate_circuit_open",
          "http": 503,
        },
        "proposal.gate_clamped": {
          "gate": "gate_clamped",
          "http": 200,
        },
        "proposal.gate_conflict": {
          "gate": "gate_conflict",
          "http": 409,
        },
        "proposal.gate_not_whitelisted": {
          "gate": "gate_not_whitelisted",
          "http": 409,
        },
        "proposal.gate_rate_limited": {
          "gate": "gate_rate_limited",
          "http": 429,
        },
        "telemetry.range_invalid": {
          "http": 422,
        },
        "telemetry.store_unavailable": {
          "http": 503,
        },
      }
    `);
  });

  it('shouldKeepGateCausesAsTheSingleSource_whenDerivingGateCodesAndMetricLabels', () => {
    // §5.2「与 ADR-017 的咬合」：五闸门 code 与指标 label 一次定义两处消费。
    expect([...PROPOSAL_GATE_REASON_CODES]).toEqual(
      GATE_CAUSES.map((cause) => `proposal.${cause}`),
    );
    const gateMeta = Object.values(REASON_CODE_REGISTRY)
      .filter((meta) => meta.gate !== undefined)
      .map((meta) => meta.gate);
    expect(gateMeta).toEqual([...GATE_CAUSES]);
  });
});
