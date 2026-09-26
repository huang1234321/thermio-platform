/**
 * 提案信封契约测试（ADR-008 结构；rationale / expected_saving_kw 必填）。
 */
import { describe, expect, it } from 'vitest';
import { ProposalEnvelopeSchema } from './proposal.js';

/** ADR-008 原文示例，逐字段。 */
const ADR_008_EXAMPLE = {
  proposal_id: 'pp_8f3k2',
  algo: 'optimizer/chiller-sequencer',
  algo_version: '1.3.2',
  target: { equipment_id: 'chiller_01', point: 'chw_supply_temp_setpoint' },
  action: { op: 'set', value: 7.5, unit: 'degC' },
  previous_value: 6.0,
  rationale: '负荷预测未来2h低于60%设计负荷，提升出水温度1.5°C',
  expected_saving_kw: 42.3,
  confidence: 0.86,
  evidence: { forecast_horizon_h: 2, load_pct: 0.58 },
  expires_at: '2026-09-26T15:30:00+08:00',
} as const;

describe('ProposalEnvelopeSchema', () => {
  it('shouldParseAValidEnvelope_whenGivenTheAdr008ExampleVerbatim', () => {
    const result = ProposalEnvelopeSchema.safeParse(ADR_008_EXAMPLE);
    expect(result.success).toBe(true);
  });

  it('shouldRejectTheEnvelope_whenRationaleIsMissing', () => {
    const { rationale: _rationale, ...withoutRationale } = ADR_008_EXAMPLE;
    const result = ProposalEnvelopeSchema.safeParse(withoutRationale);
    expect(result.success).toBe(false);
  });

  it('shouldRejectTheEnvelope_whenExpectedSavingKwIsMissing', () => {
    const { expected_saving_kw: _kw, ...withoutSaving } = ADR_008_EXAMPLE;
    const result = ProposalEnvelopeSchema.safeParse(withoutSaving);
    expect(result.success).toBe(false);
  });

  it('shouldRejectTheEnvelope_whenConfidenceIsOutsideUnitInterval', () => {
    const result = ProposalEnvelopeSchema.safeParse({
      ...ADR_008_EXAMPLE,
      confidence: 1.3,
    });
    expect(result.success).toBe(false);
  });

  it('shouldRejectTheEnvelope_whenExpiresAtLacksUtcOffset', () => {
    const result = ProposalEnvelopeSchema.safeParse({
      ...ADR_008_EXAMPLE,
      expires_at: '2026-09-26T15:30:00Z',
    });
    expect(result.success).toBe(true); // Z 也是合法 offset 表达
    const naive = ProposalEnvelopeSchema.safeParse({
      ...ADR_008_EXAMPLE,
      expires_at: '2026-09-26 15:30:00',
    });
    expect(naive.success).toBe(false);
  });
});
