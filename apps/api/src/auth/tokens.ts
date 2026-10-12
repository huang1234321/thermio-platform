/**
 * 令牌签发与校验（SEC-AZ-04：短时效 + 服务端可撤销）。
 *
 * 形状（typ 区分，防令牌用途混淆：refresh 不能进 Authorization，access 不能走 /refresh）：
 * - access JWT：HS256，claims { sub, tid, sid, role, mcp, typ:'access' }，短时效
 *   （AUTH_ACCESS_TTL_SECONDS，默认 900s）；每请求由守卫按 sid 回查会话状态——
 *   撤销真相源在 auth_session 表，JWT 只承载身份主张；校验时「签名有效但 exp
 *   已过」单列为可刷新失败（DAT-206），与「令牌不可用」区分开；
 * - refresh JWT：HS256，claims { tid, sid, jti, typ:'refresh' }，同签名钥；
 *   值本身不落库，落库的是 sha256(jti 域随机数)；每次刷新轮换（旧 jti 作废），
 *   旧 token 复用 = 失窃信号 → 服务端撤销整个会话。
 */
import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, errors, jwtVerify } from 'jose';
import type { Role } from '@thermio/shared-types';

const TYP_ACCESS = 'access';
const TYP_REFRESH = 'refresh';

export interface AccessTokenClaims {
  sub: string;
  tid: string;
  sid: string;
  role: Role;
  mcp: boolean;
  typ: 'access';
}

export interface RefreshTokenClaims {
  tid: string;
  sid: string;
  /** 随机数标识；sha256 后与 auth_session.refresh_token_hash 比对。 */
  jti: string;
  typ: 'refresh';
}

/** 内部校验结果（不签名，只收窄类型）。 */
export type VerifiedAccess = AccessTokenClaims & { exp: number };
export type VerifiedRefresh = RefreshTokenClaims & { exp: number };

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signAccessToken(
  claims: AccessTokenClaims,
  secret: string,
  ttlSeconds: number,
  issuedAt: Date = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const expiresAt = new Date(issuedAt.getTime() + ttlSeconds * 1000);
  const token = await new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(Math.floor(issuedAt.getTime() / 1000))
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(secretKey(secret));
  return { token, expiresAt };
}

export async function signRefreshToken(
  claims: { tid: string; sid: string },
  secret: string,
  ttlSeconds: number,
  issuedAt: Date = new Date(),
): Promise<{ token: string; jti: string; hash: string; expiresAt: Date }> {
  const jti = randomBytes(32).toString('base64url');
  const expiresAt = new Date(issuedAt.getTime() + ttlSeconds * 1000);
  const token = await new SignJWT({ tid: claims.tid, sid: claims.sid, jti, typ: TYP_REFRESH })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(Math.floor(issuedAt.getTime() / 1000))
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(secretKey(secret));
  return { token, jti, hash: sha256Base64Url(jti), expiresAt };
}

/**
 * access 校验的过期单列（DAT-206 现象 2）：expired = 签名有效但 exp 已过——
 * 服务端可刷新的失败，守卫据此发 auth.token_expired（客户端静默续期链只认它）；
 * 其余失败（无签名/错钥/typ 混用/格式坏）仍为 null → auth.unauthenticated。
 */
export interface AccessTokenExpired {
  readonly expired: true;
}

/** 校验 access JWT（签名 + typ + 过期）；过期单列、其余失败返回 null（守卫按 401 语义细分）。 */
export async function verifyAccessToken(
  token: string,
  secret: string,
): Promise<VerifiedAccess | AccessTokenExpired | null> {
  try {
    const claims = await verifyByTyp(token, secret, TYP_ACCESS);
    if (claims === null || typeof claims.sub !== 'string') return null;
    return claims as unknown as VerifiedAccess;
  } catch (error) {
    if (error instanceof errors.JWTExpired) return { expired: true };
    return null;
  }
}

export async function verifyRefreshToken(
  token: string,
  secret: string,
): Promise<VerifiedRefresh | null> {
  try {
    const claims = await verifyByTyp(token, secret, TYP_REFRESH);
    if (claims === null || typeof claims.jti !== 'string') return null;
    return claims as unknown as VerifiedRefresh;
  } catch {
    // 含 JWT 过期：refresh 侧过期与撤销/不匹配同面 auth.refresh_revoked，不细分
    return null;
  }
}

async function verifyByTyp(
  token: string,
  secret: string,
  typ: string,
): Promise<Record<string, unknown> | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(secret), { algorithms: ['HS256'] });
    if (payload.typ !== typ) return null;
    return payload;
  } catch (error) {
    // 过期单列上抛供 access 路径细分（DAT-206）；其余（签名/格式/typ）照旧归 null
    if (error instanceof errors.JWTExpired) throw error;
    return null;
  }
}

/** 生成一次性重置令牌（SEC-PW-05：sha256 落库，仅本次返回明文）。 */
export function generateResetToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256Base64Url(token) };
}

export function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}
