/**
 * 全局 JWT 认证守卫（SEC-AZ-01 默认拒绝 / SEC-AZ-04 服务端可撤销）。
 *
 * 行为序：
 * 1. @Public() 路由放行（认证端点自身与 healthz/metrics 探针——豁免显式、默认保护）；
 * 2. 认证域未接线（TENANT_DB 为 null，骨架形态）→ 放行：与 kafka 未接线同形，
 *    生产部署必须配置三件套（PG_API_URL/PG_AUTH_URL/AUTH_JWT_SECRET），启动 WARN 留痕；
 * 3. Bearer 缺失/不可解析 → 401 auth.unauthenticated（草案码 UNAUTHENTICATED）；
 * 4. 会话回查（真相源 auth_session + app_user.status）：revoked → 401
 *    auth.invalid_credentials；过期 → 401 auth.token_expired；用户被停用 → 401
 *    auth.invalid_credentials——「短时效 + 可撤销」的撤销面就在这一步；
 * 5. SEC-PW-03 强制轮换未完成（mcp）：仅放行会话自管理路径，业务端点 403
 *    auth.forbidden（fail-closed：系统下发凭证未轮换前「不可使用」）。
 *
 * 每请求一次主键回查是 MVP 有意取舍（单楼量级）；横向扩展时的会话缓存边界在
 * 交付说明中声明。
 */
import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AppConfig } from '../config.js';
import { APP_CONFIG } from '../infrastructure/core.module.js';
import { TENANT_DB } from '../infrastructure/db/db.tokens.js';
import type { TenantDb } from '../infrastructure/db/tenant-db.js';
import { setAuthContext, type AuthContext } from './auth-context.js';
import { isPublicRoute } from './public.decorator.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { verifyAccessToken } from './tokens.js';

/** mcp=true 时仍放行的路径（登录后的自管理闭环：改密/登出/刷新/看自己）。 */
const MUST_CHANGE_ALLOWLIST: ReadonlySet<string> = new Set([
  '/api/v1/me',
  '/api/v1/auth/change-password',
  '/api/v1/auth/logout',
  '/api/v1/auth/refresh',
]);

interface SessionRow {
  readonly status: 'active' | 'revoked';
  readonly expired: boolean;
  readonly user_active: boolean;
  readonly role: AuthContext['role'];
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(TENANT_DB) private readonly tenantDb: TenantDb | null,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (isPublicRoute(this.reflector, context)) return true;

    // 骨架形态（认证域未接线）：与 kafka 停用同款 dev 降级，生产必须配置（启动 WARN）
    if (this.tenantDb === null || !this.config.authEnabled) return true;

    const request = context.switchToHttp().getRequest<{
      headers: Record<string, unknown>;
      path: string;
    }>();
    const authorization = firstHeaderValue(request.headers.authorization);
    if (authorization === null || !authorization.startsWith('Bearer ')) {
      throw new ReasonCodeException('auth.unauthenticated', '未认证：缺少 Bearer 令牌');
    }
    const token = authorization.slice('Bearer '.length).trim();
    const claims = await verifyAccessToken(token, this.config.AUTH_JWT_SECRET);
    if (claims === null) {
      throw new ReasonCodeException('auth.unauthenticated', '未认证：令牌无效或已过期');
    }

    const session = await this.loadSession(claims);
    if (session.status === 'revoked' || !session.user_active) {
      // 登出/停用即失效（SEC-AZ-04）；文案与登录失败同源，不细分成因
      throw new ReasonCodeException('auth.invalid_credentials', '登录凭证无效');
    }
    if (session.expired) {
      throw new ReasonCodeException('auth.token_expired', '会话已过期，请刷新');
    }

    const auth: AuthContext = {
      user_id: claims.sub,
      tenant_id: claims.tid,
      session_id: claims.sid,
      role: session.role,
      must_change_password: claims.mcp,
    };
    setAuthContext(request, auth);

    if (auth.must_change_password && !MUST_CHANGE_ALLOWLIST.has(normalize(request.path))) {
      throw new ReasonCodeException('auth.forbidden', '初始密码必须先完成轮换（SEC-PW-03）');
    }
    return true;
  }

  /** 会话回查：撤销真相源在 DB（JWT 只承载身份主张）。 */
  private async loadSession(
    claims: NonNullable<Awaited<ReturnType<typeof verifyAccessToken>>>,
  ): Promise<SessionRow> {
    if (this.tenantDb === null) throw new Error('unreachable: tenantDb checked by caller');
    return this.tenantDb.withTenant(claims.tid, async (tx) => {
      const result = await tx.query(
        `SELECT s.status,
                s.expires_at <= now() AS expired,
                (u.status = 'active') AS user_active,
                r.name AS role
         FROM auth_session s
         JOIN app_user u ON u.tenant_id = s.tenant_id AND u.id = s.user_id
         LEFT JOIN user_role ur ON ur.tenant_id = u.tenant_id AND ur.user_id = u.id
         LEFT JOIN role r ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id
         WHERE s.id = $1 AND s.tenant_id = $2`,
        [claims.sid, claims.tid],
      );
      const rows = result.rows as unknown as Array<{
        status: string;
        expired: boolean;
        user_active: boolean;
        role: string | null;
      }>;
      const row = rows[0];
      if (row === undefined) {
        // 会话行被删（运维清理）＝ 撤销
        return {
          status: 'revoked' as const,
          expired: false,
          user_active: false,
          role: 'viewer' as const,
        };
      }
      return {
        status: row.status === 'revoked' ? ('revoked' as const) : ('active' as const),
        expired: row.expired,
        user_active: row.user_active,
        role: (row.role ?? 'viewer') as AuthContext['role'],
      };
    });
  }
}

function firstHeaderValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first: unknown = value.at(0);
    return typeof first === 'string' ? first : null;
  }
  return null;
}

/** 去掉 query 尾巴并归一尾斜杠，与 ALLOWLIST 对齐。 */
function normalize(path: string): string {
  const clean = path.split('?')[0] ?? path;
  return clean.length > 1 && clean.endsWith('/') ? clean.slice(0, -1) : clean;
}
