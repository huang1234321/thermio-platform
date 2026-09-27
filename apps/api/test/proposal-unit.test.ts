/**
 * 建议域单元测试（无 DB）：游标编解码 + internal 限速窗口 + algo 服务凭证守卫 +
 * 能力矩阵增量（IMPL-17 / DAT-163）。DB 路径（状态机/信封校验/闭环）在
 * proposal.e2e.test.ts（PG 门控）。
 */
import { describe, expect, it } from 'vitest';
import { capabilitiesForRole } from '@thermio/shared-types';
import { decodeProposalCursor, encodeProposalCursor } from '../src/proposal/proposal-cursor.js';
import { ReasonCodeException } from '../src/infrastructure/errors/reason-code.exception.js';
import { AlgoServiceAuthGuard } from '../src/internal-algo/algo-service.guard.js';
import { InternalRateLimiter } from '../src/internal-algo/internal-rate-limit.js';
import type { AppConfig } from '../src/config.js';

describe('proposal 游标（M5 §1.4：created_at DESC, id DESC）', () => {
  it('shouldRoundTripCursorPayload', () => {
    const encoded = encodeProposalCursor({
      k: ['1730000000000123'],
      id: '0192a7f0-1234-7abc-9def-0123456789ab',
    });
    const decoded = decodeProposalCursor(encoded, 1);
    expect(decoded.k).toEqual(['1730000000000123']);
    expect(decoded.id).toBe('0192a7f0-1234-7abc-9def-0123456789ab');
  });

  it('shouldRejectMalformedCursor_422ValidationFailedDetailsFieldCursor', () => {
    for (const bad of ['!!!', 'e30=', 'bk1udWxs']) {
      // base64url('{"k":null,"id":1}') 等畸形形状
      let caught: unknown;
      try {
        decodeProposalCursor(bad, 1);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ReasonCodeException);
      const exception = caught as ReasonCodeException;
      expect(exception.reasonCode).toBe('common.validation_failed');
      expect(exception.reasonDetails).toMatchObject({ field: 'cursor' });
    }
  });
});

describe('internal 提交限速（platform §12：60/min）', () => {
  const config = {
    INTERNAL_SUBMIT_RATE_LIMIT: '3/60',
  } as unknown as AppConfig;

  it('shouldAllowWithinWindowAnd429Beyond', () => {
    const limiter = new InternalRateLimiter(config);
    const key = 'internal:proposals';
    expect(() => {
      limiter.consume(key, 1_000);
    }).not.toThrow();
    expect(() => {
      limiter.consume(key, 2_000);
    }).not.toThrow();
    expect(() => {
      limiter.consume(key, 3_000);
    }).not.toThrow();
    try {
      limiter.consume(key, 4_000);
      expect.unreachable('第 4 次（>3/60s）应 429');
    } catch (error) {
      expect(error).toBeInstanceOf(ReasonCodeException);
      const exception = error as ReasonCodeException;
      expect(exception.reasonCode).toBe('common.rate_limited');
      expect((exception.reasonDetails as { retry_after_s: number }).retry_after_s).toBeGreaterThan(
        0,
      );
    }
  });

  it('shouldResetAfterWindowElapses', () => {
    const limiter = new InternalRateLimiter(config);
    const key = 'internal:findings';
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i += 1) limiter.consume(key, t0 + i);
    // 窗口外（60s+）重新计数
    expect(() => {
      limiter.consume(key, t0 + 61_000);
    }).not.toThrow();
  });
});

describe('algo 服务凭证守卫（platform §11：fail-closed + 单一出口文案）', () => {
  const config = {
    SVC_TOKEN_ALGO: 'secret-token-0123456789abcdef-0123456789abcdef',
    SVC_TOKEN_ALGO_PREVIOUS: '',
  } as unknown as AppConfig;

  function runGuard(headers: Record<string, string>): unknown {
    const guard = new AlgoServiceAuthGuard(config);
    const req = { headers };
    return guard.canActivate({
      switchToHttp: () => ({ getRequest: () => req }),
    } as Parameters<typeof guard.canActivate>[0]);
  }

  it('shouldAcceptValidBearer', () => {
    expect(
      runGuard({ authorization: 'Bearer secret-token-0123456789abcdef-0123456789abcdef' }),
    ).toBe(true);
  });

  it('shouldFailClosedOnMissingOrWrongToken_401ServiceUnauthorized', () => {
    for (const headers of [
      {},
      { authorization: 'Basic abc' },
      { authorization: 'Bearer wrong-token' },
    ]) {
      let caught: unknown;
      try {
        runGuard(headers);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ReasonCodeException);
      const exception = caught as ReasonCodeException;
      expect(exception.reasonCode).toBe('auth.service_unauthorized');
      expect(exception.meta.http).toBe(401);
    }
  });

  it('shouldFailClosedWhenTokenUnconfigured', () => {
    const guard = new AlgoServiceAuthGuard({
      SVC_TOKEN_ALGO: '',
      SVC_TOKEN_ALGO_PREVIOUS: '',
    } as unknown as AppConfig);
    expect(() =>
      guard.canActivate({
        switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: 'Bearer x' } }) }),
      } as Parameters<typeof guard.canActivate>[0]),
    ).toThrow(ReasonCodeException);
  });
});

describe('能力矩阵增量（M5 §1.5：proposals.decide.write → operator+）', () => {
  it('shouldGrantDecideWriteToOperatorAndAdmin_only', () => {
    expect(capabilitiesForRole('viewer')).not.toContain('proposals.decide.write');
    expect(capabilitiesForRole('operator')).toContain('proposals.decide.write');
    expect(capabilitiesForRole('admin')).toContain('proposals.decide.write');
    // 浏览面三角色均有（列表/详情/执行详情/审计）
    for (const role of ['viewer', 'operator', 'admin'] as const) {
      expect(capabilitiesForRole(role)).toContain('proposals.read');
    }
  });
});
