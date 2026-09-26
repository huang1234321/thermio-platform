/**
 * 登录限速单测（SEC-PW-04；platform.md §12：429 common.rate_limited）。
 */
import { describe, expect, it } from 'vitest';
import { LoginRateLimiter, parseRateLimitSpec } from './login-rate-limiter.js';

describe('parseRateLimitSpec', () => {
  it('shouldParseCountOverWindowSeconds', () => {
    expect(parseRateLimitSpec('5/60')).toEqual({ max: 5, windowMs: 60_000 });
  });

  it('shouldFallBackToDefault_onMalformedSpec', () => {
    expect(parseRateLimitSpec('abc').max).toBe(10);
    expect(parseRateLimitSpec('abc').windowMs).toBe(300_000);
  });
});

describe('LoginRateLimiter', () => {
  it('shouldBlockAfterMaxFailuresWithinTheWindow', () => {
    const limiter = new LoginRateLimiter({ max: 3, windowMs: 1000 });
    const key = 'a@b.c|1.2.3.4';
    const now = 1_000_000;
    for (let i = 0; i < 3; i += 1) {
      expect(limiter.check(key, now).allowed).toBe(true);
      limiter.recordFailure(key, now);
    }
    const blocked = limiter.check(key, now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it('shouldReallowAfterTheWindowSlides', () => {
    const limiter = new LoginRateLimiter({ max: 2, windowMs: 1000 });
    const key = 'x|y';
    const now = 5_000_000;
    limiter.recordFailure(key, now);
    limiter.recordFailure(key, now);
    expect(limiter.check(key, now).allowed).toBe(false);
    expect(limiter.check(key, now + 1001).allowed).toBe(true);
  });

  it('shouldResetOnSuccess_withoutAffectingOtherKeys', () => {
    const limiter = new LoginRateLimiter({ max: 1, windowMs: 10_000 });
    const keyA = 'a|1';
    const keyB = 'b|1';
    limiter.recordFailure(keyA, 100);
    expect(limiter.check(keyA, 200).allowed).toBe(false);
    expect(limiter.check(keyB, 200).allowed).toBe(true); // 键隔离
    limiter.reset(keyA);
    expect(limiter.check(keyA, 200).allowed).toBe(true);
  });
});
