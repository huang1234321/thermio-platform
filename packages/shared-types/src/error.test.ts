/**
 * 错误信封契约测试（platform.md §5.1 示例逐字段；§5.4 畸形响应 + API-ERR-02 兜底）。
 */
import { describe, expect, it } from 'vitest';
import { ApiErrorEnvelopeSchema, GENERIC_FALLBACK_MESSAGE, parseApiError } from './error.js';

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

describe('parseApiError（客户端兜底，API-ERR-02 / §5.4）', () => {
  it('shouldExtractEveryField_whenEnvelopeIsWellFormedAndCodeIsSeeded', () => {
    const parsed = parseApiError(PLATFORM_MD_S5_1_EXAMPLE);
    expect(parsed).toEqual({
      reason_code: 'proposal.gate_rate_limited',
      message: '该点位写入频率已达上限（闸门 3：频率限制）',
      request_id: 'req_01J8ZABCDEFGH',
      details: { point_id: 1024, limit_per_hour: 6 },
      known: true,
    });
  });

  it('shouldFallBackGenericallyWithoutCrashing_whenReasonCodeIsUnknownToTheCatalog', () => {
    // API-ERR-02：未知 code 走通用兜底，不白屏不崩溃；code 原样保留供上报。
    const parsed = parseApiError({
      error: {
        reason_code: 'somefuture.domain_cause',
        message: '服务端新增的错误',
        request_id: 'req_unknown_code',
      },
    });
    expect(parsed.known).toBe(false);
    expect(parsed.reason_code).toBe('somefuture.domain_cause');
    expect(parsed.message).toBe('服务端新增的错误');
  });

  it('shouldFallBackWithoutCrashing_whenTheResponseIsMalformed', () => {
    // §5.4 畸形响应矩阵：缺字段 / 错类型 / 非对象——safeParse 必须走兜底而非崩溃。
    const malformedBodies: unknown[] = [
      null,
      'internal error',
      42,
      [],
      {},
      { error: {} },
      { error: null },
      { error: { reason_code: 'auth.forbidden', message: 123, request_id: 'req_1' } },
      { error: { reason_code: 'auth.forbidden' } },
      { error: { message: '缺 reason_code', request_id: 'req_2' } },
      { error: { reason_code: 'auth.forbidden', message: 'ok', request_id: '' } },
      { no_error_key: true },
    ];
    for (const body of malformedBodies) {
      const parsed = parseApiError(body);
      expect(parsed.known).toBe(false);
      expect(parsed.request_id).toBeNull();
      expect(parsed.message).toBe(GENERIC_FALLBACK_MESSAGE);
    }
  });

  it('shouldPreserveTheRawReasonCode_whenMalformedButCodeIsAReadableString', () => {
    const parsed = parseApiError({ error: { reason_code: 'asset.not_found', message: 42 } });
    expect(parsed.known).toBe(false);
    expect(parsed.reason_code).toBe('asset.not_found');
  });
});
