/**
 * 认证会话服务（modules M7 API 草案全量：login/logout/refresh/change-password/
 * complete-reset + /me 会话信息）。
 *
 * 纪律落点：
 * - SEC-PW-04：登录失败一律 auth.invalid_credentials 同文案；查无账号走哑哈希等耗时；
 * - SEC-AZ-04：会话真相源 auth_session——登出 UPDATE revoked；刷新轮换 refresh hash，
 *   旧 token 复用 = 失窃信号 → 撤销整个会话（auth.refresh_revoked）；
 * - SEC-PW-03：建用户/重置后的凭证 must_change_password=true，改密完成清除并撤销其余会话；
 * - SEC-PW-05：重置令牌一次性、15min、sha256 落库（明文仅本次返回给发起管理员）；
 * - 租户上下文：登录 email 解析走 AUTH_DB_POOL（0004 internal_read 旁路，唯一无上下文
 *   读点），此后一切读写经 TenantDb.withTenant（ddl.md §5.2 每事务 SET LOCAL）。
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  PasswordSchema,
  capabilitiesForRole,
  type BuildingScope,
  type LoginResponse,
  type MeResponse,
  type Role,
  type UserProfile,
} from '@thermio/shared-types';
import type { AppConfig } from '../config.js';
import { APP_CONFIG } from '../infrastructure/core.module.js';
import { AUTH_DB_POOL, TENANT_DB } from '../infrastructure/db/db.tokens.js';
import type { TenantDb } from '../infrastructure/db/tenant-db.js';
import { LOGGER } from '../infrastructure/logger.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { hashPassword, verifyDummy, verifyPassword } from './password.js';
import { LoginRateLimiter, parseRateLimitSpec } from './login-rate-limiter.js';
import {
  generateResetToken,
  sha256Base64Url,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from './tokens.js';

/** SEC-PW-05：重置令牌 TTL（≤15min，钉死常量不走配置）。 */
const RESET_TOKEN_TTL_SECONDS = 900;

interface LoginUserRow {
  tenant_id: string;
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  status: 'active' | 'disabled';
}

interface RoleRow {
  role: Role | null;
  must_change_password: boolean;
}

@Injectable()
export class AuthService {
  private readonly logger: Logger;
  private readonly rateLimiter: LoginRateLimiter;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AUTH_DB_POOL) private readonly authPool: Pool | null,
    @Inject(TENANT_DB) private readonly tenantDb: TenantDb | null,
    @Inject(LOGGER) rootLogger: Logger,
  ) {
    this.logger = rootLogger.child({ component: 'auth' });
    this.rateLimiter = new LoginRateLimiter(parseRateLimitSpec(config.AUTH_LOGIN_RATE_LIMIT));
  }

  /** POST /auth/login（modules M7；SEC-PW-04 统一失败语义）。 */
  async login(
    email: string,
    password: string,
    clientIp: string | null,
    userAgent: string | null,
  ): Promise<LoginResponse> {
    const normalizedEmail = normalizeEmail(email);
    const rateKey = `${normalizedEmail}|${clientIp ?? 'unknown'}`;
    const verdict = this.rateLimiter.check(rateKey);
    if (!verdict.allowed) {
      throw new ReasonCodeException('common.rate_limited', '尝试过于频繁，请稍后再试', {
        retry_after_seconds: Math.ceil(verdict.retryAfterMs / 1000),
      });
    }

    const user = await this.findUserByEmail(normalizedEmail);
    if (user === null) {
      await verifyDummy(password); // 等耗时路径（SEC-PW-04）
      this.rateLimiter.recordFailure(rateKey);
      throw invalidCredentials();
    }
    const passwordOk = await verifyPassword(user.password_hash, password);
    if (!passwordOk || user.status !== 'active') {
      this.rateLimiter.recordFailure(rateKey);
      throw invalidCredentials();
    }

    const profile: UserProfile = {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
    };
    const issued = await this.issueSession(user.tenant_id, user.id, clientIp, userAgent);
    this.rateLimiter.reset(rateKey);
    this.logger.info({ msg: 'login_ok', tenant_id: user.tenant_id, user_id: user.id });
    return { ...issued, must_change_password: issued.mustChange, user: profile };
  }

  /** POST /auth/logout（会话撤销，幂等：已撤销再登出直接 204）。 */
  async logout(tenantId: string, sessionId: string): Promise<void> {
    await this.withTenantDb(tenantId, (tx) =>
      tx.query(
        `UPDATE auth_session SET status = 'revoked', revoked_at = now()
         WHERE id = $1 AND tenant_id = $2 AND status = 'active'`,
        [sessionId, tenantId],
      ),
    );
  }

  /**
   * POST /auth/refresh（轮换 refresh token；复用检测撤销会话）。
   * 复用检测的撤销必须独立事务提交——检测异常会回滚所在事务，若撤销同车则被一并
   * 回滚（实测踩坑：会话保持 active，旧 access 依旧有效）。
   */
  async refresh(refreshToken: string): Promise<LoginResponse> {
    const claims = await verifyRefreshToken(refreshToken, this.config.AUTH_JWT_SECRET);
    if (claims === null) {
      throw new ReasonCodeException('auth.refresh_revoked', '刷新凭证无效');
    }
    const db = this.requireTenantDb();
    try {
      return await this.rotateRefresh(db, claims);
    } catch (error) {
      if (error instanceof RefreshReuseDetected) {
        await db.withTenant(claims.tid, (tx) =>
          tx.query(
            `UPDATE auth_session SET status = 'revoked', revoked_at = now()
             WHERE id = $1 AND tenant_id = $2`,
            [claims.sid, claims.tid],
          ),
        );
        this.logger.warn({ msg: 'refresh_reuse_detected', session_id: claims.sid });
        throw new ReasonCodeException('auth.refresh_revoked', '刷新凭证无效');
      }
      throw error;
    }
  }

  private async rotateRefresh(
    db: TenantDb,
    claims: NonNullable<Awaited<ReturnType<typeof verifyRefreshToken>>>,
  ): Promise<LoginResponse> {
    return db.withTenant(claims.tid, async (tx) => {
      const session = await loadSessionForRefresh(tx, claims.sid, claims.tid);
      if (session === null || session.status === 'revoked' || !session.user_active) {
        throw new ReasonCodeException('auth.refresh_revoked', '刷新凭证无效');
      }
      if (session.expired) {
        throw new ReasonCodeException('auth.token_expired', '会话已过期，请重新登录');
      }
      if (session.role === null) {
        throw new ReasonCodeException('auth.invalid_credentials', '登录凭证无效');
      }
      if (session.refresh_hash !== sha256Base64Url(claims.jti)) {
        // 旧 refresh token 复用（已轮换）＝ 失窃信号 → 撤销整个会话（独立事务，见上）
        throw new RefreshReuseDetected();
      }

      const rotated = await signRefreshToken(
        { tid: claims.tid, sid: claims.sid },
        this.config.AUTH_JWT_SECRET,
        this.config.AUTH_REFRESH_TTL_SECONDS,
      );
      await tx.query(
        `UPDATE auth_session SET refresh_token_hash = $1, last_used_at = now()
         WHERE id = $2 AND tenant_id = $3`,
        [rotated.hash, claims.sid, claims.tid],
      );
      const access = await signAccessToken(
        {
          sub: session.user_id,
          tid: claims.tid,
          sid: claims.sid,
          role: session.role,
          mcp: session.must_change_password,
          typ: 'access',
        },
        this.config.AUTH_JWT_SECRET,
        this.config.AUTH_ACCESS_TTL_SECONDS,
      );
      return {
        access_token: access.token,
        refresh_token: rotated.token,
        token_type: 'Bearer' as const,
        expires_in: this.config.AUTH_ACCESS_TTL_SECONDS,
        must_change_password: session.must_change_password,
        user: session.profile,
      };
    });
  }

  /** POST /auth/change-password（SEC-PW-03 轮换闭环；撤销其余会话，返回新令牌对）。 */
  async changePassword(
    tenantId: string,
    userId: string,
    sessionId: string,
    oldPassword: string,
    newPassword: string,
  ): Promise<LoginResponse> {
    assertPasswordPolicy(newPassword);
    const db = this.requireTenantDb();
    const result = await db.withTenant(tenantId, async (tx) => {
      const current = await tx.query(
        `SELECT password_hash FROM app_user WHERE id = $1 AND tenant_id = $2`,
        [userId, tenantId],
      );
      const row = current.rows[0] as { password_hash: string } | undefined;
      if (row === undefined) throw invalidCredentials();
      const ok = await verifyPassword(row.password_hash, oldPassword);
      if (!ok) throw invalidCredentials();

      const newHash = await hashPassword(newPassword);
      await tx.query(
        `UPDATE app_user SET password_hash = $1, must_change_password = false
         WHERE id = $2 AND tenant_id = $3`,
        [newHash, userId, tenantId],
      );
      // 其余会话全部撤销（改密 = 旧会话不可信），当前会话保留
      await tx.query(
        `UPDATE auth_session SET status = 'revoked', revoked_at = now()
         WHERE tenant_id = $1 AND user_id = $2 AND id <> $3 AND status = 'active'`,
        [tenantId, userId, sessionId],
      );
      return true;
    });

    if (result) {
      return this.reissueAfterRotation(tenantId, userId, sessionId);
    }
    throw invalidCredentials();
  }

  /** POST /auth/complete-reset（消费一次性令牌设新密码；撤销该用户全部会话）。 */
  async completeReset(email: string, resetToken: string, newPassword: string): Promise<void> {
    assertPasswordPolicy(newPassword);
    const normalizedEmail = normalizeEmail(email);
    const user = await this.findUserByEmail(normalizedEmail);
    if (user === null || user.status !== 'active') {
      throw invalidCredentials();
    }
    const tokenHash = sha256Base64Url(resetToken);
    const db = this.requireTenantDb();
    await db.withTenant(user.tenant_id, async (tx) => {
      const matched = await tx.query(
        `SELECT id, user_id, used_at, expires_at
         FROM password_reset_token WHERE token_hash = $1 AND tenant_id = $2`,
        [tokenHash, user.tenant_id],
      );
      const row = matched.rows[0] as
        { id: string; user_id: string; used_at: string | null; expires_at: Date } | undefined;
      if (row === undefined || row.user_id !== user.id) throw invalidCredentials();
      if (row.used_at !== null || row.expires_at.getTime() <= Date.now()) {
        throw invalidCredentials(); // 一次性 + 短时效（SEC-PW-05）
      }
      const consumed = await tx.query(
        `UPDATE password_reset_token SET used_at = now()
         WHERE id = $1 AND used_at IS NULL`,
        [row.id],
      );
      if (consumed.rowCount !== 1) throw invalidCredentials(); // 并发消费竞态：只放行一个
      const newHash = await hashPassword(newPassword);
      await tx.query(
        `UPDATE app_user SET password_hash = $1, must_change_password = false
         WHERE id = $2 AND tenant_id = $3`,
        [newHash, user.id, user.tenant_id],
      );
      await tx.query(
        `UPDATE auth_session SET status = 'revoked', revoked_at = now()
         WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'`,
        [user.tenant_id, user.id],
      );
    });
  }

  /** GET /me 载荷（角色/楼宇授权/能力清单 UC-M7-5；守卫已确保会话与用户 active）。 */
  async me(tenantId: string, userId: string, sessionId: string): Promise<MeResponse> {
    const db = this.requireTenantDb();
    return db.withTenant(tenantId, async (tx) => {
      const userResult = await tx.query(
        `SELECT u.id, u.email, u.display_name, u.must_change_password,
                (SELECT r.name FROM user_role ur JOIN role r
                  ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id
                 WHERE ur.tenant_id = u.tenant_id AND ur.user_id = u.id
                 ORDER BY r.name LIMIT 1) AS role
         FROM app_user u WHERE u.id = $1 AND u.tenant_id = $2`,
        [userId, tenantId],
      );
      const user = userResult.rows[0] as
        | {
            id: string;
            email: string;
            display_name: string;
            must_change_password: boolean;
            role: Role | null;
          }
        | undefined;
      const session = await tx.query(
        `SELECT created_at, expires_at FROM auth_session WHERE id = $1 AND tenant_id = $2`,
        [sessionId, tenantId],
      );
      const sessionRow = session.rows[0] as { created_at: Date; expires_at: Date } | undefined;
      if (user === undefined || sessionRow === undefined || user.role === null) {
        throw invalidCredentials();
      }
      const buildings = await loadBuildingScopes(tx, tenantId, userId, user.role);
      return {
        user: { id: user.id, email: user.email, display_name: user.display_name },
        role: user.role,
        must_change_password: user.must_change_password,
        building_scopes: buildings,
        capabilities: [...capabilitiesForRole(user.role)],
        session: {
          id: sessionId,
          created_at: sessionRow.created_at.toISOString(),
          expires_at: sessionRow.expires_at.toISOString(),
        },
      };
    });
  }

  /** 管理员发起重置：作废旧令牌、签发一次性新令牌（明文仅本次返回）。 */
  async issueResetToken(
    tenantId: string,
    userId: string,
  ): Promise<{
    token: string;
    expiresAt: Date;
  }> {
    const db = this.requireTenantDb();
    return db.withTenant(tenantId, async (tx) => {
      const user = await tx.query(`SELECT id FROM app_user WHERE id = $1 AND tenant_id = $2`, [
        userId,
        tenantId,
      ]);
      if (user.rows.length !== 1) {
        throw new ReasonCodeException('user.not_found', '用户不存在');
      }
      await tx.query(
        `UPDATE password_reset_token SET used_at = now()
         WHERE tenant_id = $1 AND user_id = $2 AND used_at IS NULL`,
        [tenantId, userId],
      );
      const generated = generateResetToken();
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_SECONDS * 1000);
      await tx.query(
        `INSERT INTO password_reset_token (tenant_id, user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [tenantId, userId, generated.hash, expiresAt],
      );
      return { token: generated.token, expiresAt };
    });
  }

  /** 登录成功后的会话签发（INSERT auth_session + 双令牌；sid 由应用侧生成）。 */
  private async issueSession(
    tenantId: string,
    userId: string,
    clientIp: string | null,
    userAgent: string | null,
  ): Promise<{
    access_token: string;
    refresh_token: string;
    token_type: 'Bearer';
    expires_in: number;
    mustChange: boolean;
    role: Role;
  }> {
    const db = this.requireTenantDb();
    return db.withTenant(tenantId, async (tx) => {
      const roleRow = await loadUserRole(tx, tenantId, userId);
      if (roleRow.role === null) {
        // 无角色用户拒绝登录（fail-closed；正常流程建用户必带角色）
        this.logger.warn({ msg: 'login_denied_no_role', tenant_id: tenantId, user_id: userId });
        throw invalidCredentials();
      }
      const sessionId = randomUUID();
      const refresh = await signRefreshToken(
        { tid: tenantId, sid: sessionId },
        this.config.AUTH_JWT_SECRET,
        this.config.AUTH_REFRESH_TTL_SECONDS,
      );
      const sessionExpiry = new Date(Date.now() + this.config.AUTH_REFRESH_TTL_SECONDS * 1000);
      await tx.query(
        `INSERT INTO auth_session
           (id, tenant_id, user_id, refresh_token_hash, expires_at, user_agent, client_ip)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [sessionId, tenantId, userId, refresh.hash, sessionExpiry, userAgent, clientIp],
      );
      const access = await signAccessToken(
        {
          sub: userId,
          tid: tenantId,
          sid: sessionId,
          role: roleRow.role,
          mcp: roleRow.must_change_password,
          typ: 'access',
        },
        this.config.AUTH_JWT_SECRET,
        this.config.AUTH_ACCESS_TTL_SECONDS,
      );
      return {
        access_token: access.token,
        refresh_token: refresh.token,
        token_type: 'Bearer' as const,
        expires_in: this.config.AUTH_ACCESS_TTL_SECONDS,
        mustChange: roleRow.must_change_password,
        role: roleRow.role,
      };
    });
  }

  /** 改密完成后的当前会话重签（mcp=false 的新令牌对）。 */
  private async reissueAfterRotation(
    tenantId: string,
    userId: string,
    sessionId: string,
  ): Promise<LoginResponse> {
    const db = this.requireTenantDb();
    return db.withTenant(tenantId, async (tx) => {
      const roleRow = await loadUserRole(tx, tenantId, userId);
      const profile = await tx.query(
        `SELECT email, display_name FROM app_user WHERE id = $1 AND tenant_id = $2`,
        [userId, tenantId],
      );
      const profileRow = profile.rows[0] as { email: string; display_name: string } | undefined;
      if (roleRow.role === null || profileRow === undefined) throw invalidCredentials();
      const refresh = await signRefreshToken(
        { tid: tenantId, sid: sessionId },
        this.config.AUTH_JWT_SECRET,
        this.config.AUTH_REFRESH_TTL_SECONDS,
      );
      await tx.query(`UPDATE auth_session SET refresh_token_hash = $1 WHERE id = $2`, [
        refresh.hash,
        sessionId,
      ]);
      const access = await signAccessToken(
        {
          sub: userId,
          tid: tenantId,
          sid: sessionId,
          role: roleRow.role,
          mcp: false,
          typ: 'access',
        },
        this.config.AUTH_JWT_SECRET,
        this.config.AUTH_ACCESS_TTL_SECONDS,
      );
      return {
        access_token: access.token,
        refresh_token: refresh.token,
        token_type: 'Bearer' as const,
        expires_in: this.config.AUTH_ACCESS_TTL_SECONDS,
        must_change_password: false,
        user: { id: userId, email: profileRow.email, display_name: profileRow.display_name },
      };
    });
  }

  /**
   * email → 用户行（登录与完成重置的入口解析）。AUTH_DB_POOL 走 thermio_auth 角色
   * 的 internal_read 旁路（0004 迁移）——登录前无租户上下文，这是唯一无上下文读点。
   * 同邮箱跨租户多行时 fail-closed（MVP 单租户部署形态下不可达；SaaS 形态需登录
   * 入口带租户指示，属 ADR-011 后置范围）。
   */
  private async findUserByEmail(normalizedEmail: string): Promise<LoginUserRow | null> {
    if (this.authPool === null) {
      throw new ReasonCodeException('common.internal_error', '认证域未接线');
    }
    const result = await this.authPool.query(
      `SELECT tenant_id, id, email, display_name, password_hash, status
       FROM app_user WHERE email = $1`,
      [normalizedEmail],
    );
    if (result.rows.length === 0) return null;
    if (result.rows.length > 1) {
      this.logger.warn({
        msg: 'login_email_ambiguous',
        email_hash: sha256Base64Url(normalizedEmail),
      });
      return null;
    }
    return result.rows[0] as LoginUserRow;
  }

  private requireTenantDb(): TenantDb {
    if (this.tenantDb === null) {
      throw new ReasonCodeException('common.internal_error', '认证域未接线');
    }
    return this.tenantDb;
  }

  private withTenantDb<T>(tenantId: string, fn: (tx: PoolClient) => Promise<T>): Promise<T> {
    return this.requireTenantDb().withTenant(tenantId, fn);
  }
}

// ── 模块内小工具 ──

/** 复用检测内部信号（refresh 捕获后独立事务撤销会话再转译为 auth.refresh_revoked）。 */
class RefreshReuseDetected extends Error {}

function invalidCredentials(): ReasonCodeException {
  return new ReasonCodeException('auth.invalid_credentials', '邮箱或密码错误');
}

function assertPasswordPolicy(password: string): void {
  // SEC-PW-02（transport 层已限长度上限，此处显式策略失败码 user.password_policy_failed）
  const parsed = PasswordSchema.safeParse(password);
  if (!parsed.success) {
    throw new ReasonCodeException(
      'user.password_policy_failed',
      '密码不符合策略：长度至少 8 位且含字母与数字',
    );
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function loadUserRole(tx: PoolClient, tenantId: string, userId: string): Promise<RoleRow> {
  const result = await tx.query(
    `SELECT (SELECT r.name FROM user_role ur JOIN role r
              ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id
             WHERE ur.tenant_id = $1 AND ur.user_id = $2
             ORDER BY r.name LIMIT 1) AS role,
            (SELECT must_change_password FROM app_user WHERE tenant_id = $1 AND id = $2)
              AS must_change_password`,
    [tenantId, userId],
  );
  const row = result.rows[0] as { role: Role | null; must_change_password: boolean } | undefined;
  return { role: row?.role ?? null, must_change_password: row?.must_change_password ?? false };
}

interface RefreshSessionRow {
  status: 'active' | 'revoked';
  expired: boolean;
  user_active: boolean;
  refresh_hash: string;
  role: Role | null;
  must_change_password: boolean;
  user_id: string;
  profile: UserProfile;
}

async function loadSessionForRefresh(
  tx: PoolClient,
  sessionId: string,
  tenantId: string,
): Promise<RefreshSessionRow | null> {
  const result = await tx.query(
    `SELECT s.status, s.expires_at <= now() AS expired, s.refresh_token_hash,
            (u.status = 'active') AS user_active, u.id AS user_id,
            u.email, u.display_name, u.must_change_password,
            (SELECT r.name FROM user_role ur JOIN role r
              ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id
             WHERE ur.tenant_id = u.tenant_id AND ur.user_id = u.id
             ORDER BY r.name LIMIT 1) AS role
     FROM auth_session s
     JOIN app_user u ON u.tenant_id = s.tenant_id AND u.id = s.user_id
     WHERE s.id = $1 AND s.tenant_id = $2`,
    [sessionId, tenantId],
  );
  const row = result.rows[0] as
    | {
        status: string;
        expired: boolean;
        refresh_token_hash: string;
        user_active: boolean;
        user_id: string;
        email: string;
        display_name: string;
        must_change_password: boolean;
        role: Role | null;
      }
    | undefined;
  if (row === undefined) return null;
  return {
    status: row.status === 'revoked' ? 'revoked' : 'active',
    expired: row.expired,
    user_active: row.user_active,
    refresh_hash: row.refresh_token_hash,
    role: row.role,
    must_change_password: row.must_change_password,
    user_id: row.user_id,
    profile: { id: row.user_id, email: row.email, display_name: row.display_name },
  };
}

/** 楼宇授权：admin = 租户全部楼宇（隐式）；operator/viewer = user_building_scope。 */
async function loadBuildingScopes(
  tx: PoolClient,
  tenantId: string,
  userId: string,
  role: Role,
): Promise<BuildingScope[]> {
  const result =
    role === 'admin'
      ? await tx.query(`SELECT id, name FROM building WHERE tenant_id = $1 ORDER BY name`, [
          tenantId,
        ])
      : await tx.query(
          `SELECT b.id, b.name
           FROM user_building_scope s
           JOIN building b ON b.tenant_id = s.tenant_id AND b.id = s.building_id
           WHERE s.tenant_id = $1 AND s.user_id = $2
           ORDER BY b.name`,
          [tenantId, userId],
        );
  return result.rows as BuildingScope[];
}
