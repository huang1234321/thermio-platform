/**
 * 令牌签发/校验单测（SEC-AZ-04：typ 区分 + 签名防篡改 + 过期）。
 */
import { describe, expect, it } from 'vitest';
import {
  generateResetToken,
  sha256Base64Url,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from './tokens.js';

const SECRET = 'unit-test-secret-0123456789abcdef-0123456789abcdef';
const OTHER_SECRET = 'other-secret-9876543210fedcba-9876543210fedcba';

describe('access token', () => {
  it('shouldRoundtripClaims_signThenVerify', async () => {
    const { token } = await signAccessToken(
      { sub: 'u1', tid: 't1', sid: 's1', role: 'admin', mcp: false, typ: 'access' },
      SECRET,
      900,
    );
    const claims = await verifyAccessToken(token, SECRET);
    expect(claims?.sub).toBe('u1');
    expect(claims?.tid).toBe('t1');
    expect(claims?.sid).toBe('s1');
    expect(claims?.role).toBe('admin');
    expect(claims?.mcp).toBe(false);
  });

  it('shouldRejectTokensSignedWithADifferentKey', async () => {
    const { token } = await signAccessToken(
      { sub: 'u1', tid: 't1', sid: 's1', role: 'viewer', mcp: false, typ: 'access' },
      SECRET,
      900,
    );
    expect(await verifyAccessToken(token, OTHER_SECRET)).toBeNull();
  });

  it('shouldRejectExpiredTokens', async () => {
    const past = new Date(Date.now() - 3600_000);
    const { token } = await signAccessToken(
      { sub: 'u1', tid: 't1', sid: 's1', role: 'viewer', mcp: false, typ: 'access' },
      SECRET,
      900,
      past,
    );
    expect(await verifyAccessToken(token, SECRET)).toBeNull();
  });

  it('shouldRefuseRefreshTokensOnTheAccessPath_typConfusion', async () => {
    const { token } = await signRefreshToken({ tid: 't1', sid: 's1' }, SECRET, 604_800);
    expect(await verifyAccessToken(token, SECRET)).toBeNull();
  });
});

describe('refresh token', () => {
  it('shouldCarryRotationMaterial_jtiHashPair', async () => {
    const { token, jti, hash } = await signRefreshToken({ tid: 't1', sid: 's1' }, SECRET, 604_800);
    const claims = await verifyRefreshToken(token, SECRET);
    expect(claims?.jti).toBe(jti);
    expect(sha256Base64Url(claims?.jti ?? '')).toBe(hash);
    expect(claims?.tid).toBe('t1');
  });

  it('shouldRefuseAccessTokensOnTheRefreshPath_typConfusion', async () => {
    const { token } = await signAccessToken(
      { sub: 'u1', tid: 't1', sid: 's1', role: 'viewer', mcp: false, typ: 'access' },
      SECRET,
      900,
    );
    expect(await verifyRefreshToken(token, SECRET)).toBeNull();
  });
});

describe('reset token（SEC-PW-05）', () => {
  it('shouldGenerateHighEntropyOneShotPairs', () => {
    const a = generateResetToken();
    const b = generateResetToken();
    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url
    expect(a.hash).toBe(sha256Base64Url(a.token));
  });
});
