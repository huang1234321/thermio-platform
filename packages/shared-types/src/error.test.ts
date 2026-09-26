/**
 * 错误信封契约测试（platform.md §5.1 示例逐字段）。
 */
import { describe, expect, it } from 'vitest';
import { ApiErrorEnvelopeSchema } from './error.js';

const PLATFORM_MD_S5_1_EXAMPLE = {
  error: {
    reason_code: 'proposal.gate_rate_limited',
    message: '该点位写入频率已达上限（闸门 3：频率限制）',
    request_id: 'req_01J8ZABCDEFGH',
    details: { point_id: 1024, limit_per_hour: 6 },
  },
} as const;

describe('ApiErrorEnvelopeSchema', () => {
  it('shouldParseAValidEnvelope_whenGivenThePlatformMdExampleVerbatim', () => {
    const result = ApiErrorEnvelopeSchema.safeParse(PLATFORM_MD_S5_1_EXAMPLE);
    expect(result.success).toBe(true);
  });

  it('shouldParseSuccessfully_whenDetailsFieldIsAbsent', () => {
    const { details: _details, ...errorWithoutDetails } = PLATFORM_MD_S5_1_EXAMPLE.error;
    const result = ApiErrorEnvelopeSchema.safeParse({ error: errorWithoutDetails });
    expect(result.success).toBe(true);
  });

  it('shouldRejectTheEnvelope_whenRequestIdIsMissing', () => {
    const { request_id: _rid, ...errorWithoutRequestId } = PLATFORM_MD_S5_1_EXAMPLE.error;
    const result = ApiErrorEnvelopeSchema.safeParse({ error: errorWithoutRequestId });
    expect(result.success).toBe(false);
  });

  it('shouldRejectTheEnvelope_whenReasonCodeIsMissing', () => {
    const { reason_code: _rc, ...errorWithoutReasonCode } = PLATFORM_MD_S5_1_EXAMPLE.error;
    const result = ApiErrorEnvelopeSchema.safeParse({ error: errorWithoutReasonCode });
    expect(result.success).toBe(false);
  });
});
