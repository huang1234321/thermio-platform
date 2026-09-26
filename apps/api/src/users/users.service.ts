/**
 * 用户管理服务（modules M7：users/roles/building-scopes/reset-password，admin 专属）。
 *
 * 纪律落点：
 * - 全部读写经 TenantDb.withTenant（ddl.md §5.2）；跨租户 id 在 RLS 下不可见 →
 *   user.not_found 404 文案统一（SEC-AZ-03：不区分「不存在」与「他租户」）；
 * - 越租户/无效 building_id → user.scope_building_mismatch 404 统一文案（SEC-AZ-03）；
 * - SEC-PW-01 argon2id；SEC-PW-02 策略（user.password_policy_failed）；
 *   SEC-PW-03 建用户 must_change_password=true；
 * - email 唯一冲突（UNIQUE (tenant_id,email) 23505）→ user.email_duplicate 409。
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import {
  PasswordSchema,
  type CreateUserRequest,
  type Role,
  type UpdateUserRequest,
  type UserListItem,
  type UserListQuery,
  type UserListResponse,
} from '@thermio/shared-types';
import type { AppConfig } from '../config.js';
import { APP_CONFIG } from '../infrastructure/core.module.js';
import { TENANT_DB } from '../infrastructure/db/db.tokens.js';
import type { TenantDb } from '../infrastructure/db/tenant-db.js';
import { LOGGER } from '../infrastructure/logger.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { AuthService } from '../auth/auth.service.js';
import { hashPassword } from '../auth/password.js';
import { appendKeysetPredicate, decodeCursor, encodeCursor, rowCursor } from './cursor.js';

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  status: 'active' | 'disabled';
  must_change_password: boolean;
  created_at: Date;
  /** 微秒精度的排序键投影（keyset 游标专用，见 cursor.ts 文件头）。 */
  created_at_us: string;
  role: Role | null;
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(TENANT_DB) private readonly tenantDb: TenantDb | null,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(LOGGER) rootLogger: Logger,
  ) {
    this.logger = rootLogger.child({ component: 'users' });
  }

  private readonly logger: Logger;

  /** GET /users（?cursor&limit&role&status&keyword；keyset 降序）。 */
  async list(tenantId: string, query: UserListQuery): Promise<UserListResponse> {
    const db = this.requireDb();
    return db.withTenant(tenantId, async (tx) => {
      const where: string[] = ['u.tenant_id = $1'];
      const params: unknown[] = [tenantId];
      let next = 2;
      if (query.role !== undefined) {
        where.push(`(SELECT r.name FROM user_role ur JOIN role r
                     ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id
                    WHERE ur.tenant_id = u.tenant_id AND ur.user_id = u.id
                    ORDER BY r.name LIMIT 1) = $${String(next)}::text`);
        params.push(query.role);
        next += 1;
      }
      if (query.status !== undefined) {
        where.push(`u.status = $${String(next)}::text`);
        params.push(query.status);
        next += 1;
      }
      if (query.keyword !== undefined && query.keyword.trim().length > 0) {
        where.push(
          `(u.email ILIKE $${String(next)}::text OR u.display_name ILIKE $${String(next)}::text)`,
        );
        params.push(`%${escapeLike(query.keyword.trim())}%`);
        next += 1;
      }
      if (query.cursor !== undefined) {
        const cursor = decodeCursor(query.cursor);
        appendKeysetPredicate(where, params, next, cursor);
        next += 2;
      }
      const result = await tx.query(
        `SELECT u.id, u.email, u.display_name, u.status, u.must_change_password, u.created_at,
                ((extract(epoch FROM u.created_at) * 1000000)::bigint)::text AS created_at_us,
                (SELECT r.name FROM user_role ur JOIN role r
                  ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id
                 WHERE ur.tenant_id = u.tenant_id AND ur.user_id = u.id
                 ORDER BY r.name LIMIT 1) AS role
         FROM app_user u
         WHERE ${where.join(' AND ')}
         ORDER BY u.created_at DESC, u.id DESC
         LIMIT ${String(query.limit + 1)}`,
        params,
      );
      const rows = result.rows as unknown as UserRow[];
      // 取 limit+1 探测下一页：探测行只决定「还有没有」，游标锚定本页最后一行
      const page = rows.slice(0, query.limit);
      const hasMore = rows.length > query.limit;
      const lastRow = page.at(-1);
      const items: UserListItem[] = page.map((row) => ({
        id: row.id,
        email: row.email,
        display_name: row.display_name,
        status: row.status,
        role: row.role ?? 'viewer',
        must_change_password: row.must_change_password,
        created_at: row.created_at.toISOString(),
      }));
      return {
        items,
        next_cursor: hasMore && lastRow !== undefined ? encodeCursor(rowCursor(lastRow)) : null,
      };
    });
  }

  /** POST /users（SEC-PW-03：初始密码强制首登轮换）。 */
  async create(tenantId: string, body: CreateUserRequest): Promise<UserListItem> {
    const passwordCheck = PasswordSchema.safeParse(body.password);
    if (!passwordCheck.success) {
      throw new ReasonCodeException(
        'user.password_policy_failed',
        '密码不符合策略：长度至少 8 位且含字母与数字',
      );
    }
    const passwordHash = await hashPassword(body.password);
    const db = this.requireDb();
    return db.withTenant(tenantId, async (tx) => {
      const roleId = await resolveRoleId(tx, tenantId, body.role);
      await assertBuildingsInTenant(tx, tenantId, body.building_ids);
      let created: UserRow;
      try {
        const result = await tx.query(
          `INSERT INTO app_user (tenant_id, email, password_hash, display_name, must_change_password)
           VALUES ($1, $2, $3, $4, true)
           RETURNING id, email, display_name, status, must_change_password, created_at`,
          [tenantId, normalizeEmail(body.email), passwordHash, body.display_name],
        );
        created = result.rows[0] as UserRow;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ReasonCodeException('user.email_duplicate', '该邮箱已存在');
        }
        throw error;
      }
      await tx.query(`INSERT INTO user_role (tenant_id, user_id, role_id) VALUES ($1, $2, $3)`, [
        tenantId,
        created.id,
        roleId,
      ]);
      for (const buildingId of body.building_ids) {
        await tx.query(
          `INSERT INTO user_building_scope (tenant_id, user_id, building_id) VALUES ($1, $2, $3)`,
          [tenantId, created.id, buildingId],
        );
      }
      return toListItem(created, body.role);
    });
  }

  /** PATCH /users/{id}（display_name/status）。 */
  async update(tenantId: string, userId: string, body: UpdateUserRequest): Promise<UserListItem> {
    const db = this.requireDb();
    return db.withTenant(tenantId, async (tx) => {
      await assertUserExists(tx, tenantId, userId);
      const result = await tx.query(
        `UPDATE app_user SET display_name = COALESCE($1, display_name),
                            status = COALESCE($2, status)
         WHERE tenant_id = $3 AND id = $4
         RETURNING id, email, display_name, status, must_change_password, created_at`,
        [body.display_name ?? null, body.status ?? null, tenantId, userId],
      );
      const row = result.rows[0] as unknown as UserRow;
      const role = await singleUserRole(tx, tenantId, userId);
      return toListItem(row, role);
    });
  }

  /** PUT /users/{id}/roles（MVP 单角色：替换写）。 */
  async updateRoles(tenantId: string, userId: string, role: Role): Promise<void> {
    const db = this.requireDb();
    await db.withTenant(tenantId, async (tx) => {
      await assertUserExists(tx, tenantId, userId);
      const roleId = await resolveRoleId(tx, tenantId, role);
      await tx.query(`DELETE FROM user_role WHERE tenant_id = $1 AND user_id = $2`, [
        tenantId,
        userId,
      ]);
      await tx.query(`INSERT INTO user_role (tenant_id, user_id, role_id) VALUES ($1, $2, $3)`, [
        tenantId,
        userId,
        roleId,
      ]);
    });
  }

  /**
   * PUT /users/{id}/building-scopes。
   * operator/viewer 必填非空（common.validation_failed 字段级）；admin 隐式全楼宇，
   * 可空写（/me 对 admin 恒发全楼宇清单）。越租户/无效 id → 404 统一（SEC-AZ-03）。
   */
  async updateBuildingScopes(
    tenantId: string,
    userId: string,
    buildingIds: readonly string[],
  ): Promise<void> {
    const db = this.requireDb();
    await db.withTenant(tenantId, async (tx) => {
      await assertUserExists(tx, tenantId, userId);
      const role = await singleUserRole(tx, tenantId, userId);
      if (role !== 'admin' && buildingIds.length === 0) {
        throw new ReasonCodeException('common.validation_failed', '请求体校验失败', {
          building_ids: 'operator/viewer 至少授权一栋楼宇',
        });
      }
      await assertBuildingsInTenant(tx, tenantId, buildingIds);
      await tx.query(`DELETE FROM user_building_scope WHERE tenant_id = $1 AND user_id = $2`, [
        tenantId,
        userId,
      ]);
      for (const buildingId of buildingIds) {
        await tx.query(
          `INSERT INTO user_building_scope (tenant_id, user_id, building_id) VALUES ($1, $2, $3)`,
          [tenantId, userId, buildingId],
        );
      }
    });
  }

  /** POST /users/{id}/reset-password（一次性令牌仅本次返回；委托 AuthService）。 */
  async resetPassword(
    tenantId: string,
    userId: string,
  ): Promise<{ reset_token: string; expires_at: string }> {
    // 用户存在性先核（issueResetToken 也会核，此处先给 user.not_found 语义出口）
    const db = this.requireDb();
    await db.withTenant(tenantId, (tx) => assertUserExists(tx, tenantId, userId));
    const issued = await this.auth.issueResetToken(tenantId, userId);
    this.logger.info({ msg: 'password_reset_issued', tenant_id: tenantId, user_id: userId });
    return { reset_token: issued.token, expires_at: issued.expiresAt.toISOString() };
  }

  private requireDb(): TenantDb {
    if (this.tenantDb === null) {
      throw new ReasonCodeException('common.internal_error', '认证域未接线');
    }
    return this.tenantDb;
  }
}

// ── 模块内小工具 ──

function toListItem(row: UserRow, role: Role | null): UserListItem {
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    status: row.status,
    role: role ?? 'viewer',
    must_change_password: row.must_change_password,
    created_at: row.created_at.toISOString(),
  };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function escapeLike(value: string): string {
  return value.replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

async function assertUserExists(
  tx: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  tenantId: string,
  userId: string,
): Promise<void> {
  const result = await tx.query(`SELECT 1 FROM app_user WHERE tenant_id = $1 AND id = $2`, [
    tenantId,
    userId,
  ]);
  if (result.rows.length !== 1) {
    // 跨租户与不存在同文案（SEC-AZ-03）
    throw new ReasonCodeException('user.not_found', '用户不存在');
  }
}

async function resolveRoleId(
  tx: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  tenantId: string,
  role: Role,
): Promise<string> {
  const result = await tx.query(`SELECT id FROM role WHERE tenant_id = $1 AND name = $2`, [
    tenantId,
    role,
  ]);
  const row = result.rows[0] as { id: string } | undefined;
  if (row === undefined) {
    // 三角色种子由租户开通脚本保证；缺行 = 租户初始化异常
    throw new ReasonCodeException('role.unknown', '角色取值无效（租户角色种子缺失）');
  }
  return row.id;
}

async function singleUserRole(
  tx: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  tenantId: string,
  userId: string,
): Promise<Role | null> {
  const result = await tx.query(
    `SELECT r.name AS role FROM user_role ur
     JOIN role r ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id
     WHERE ur.tenant_id = $1 AND ur.user_id = $2 ORDER BY r.name LIMIT 1`,
    [tenantId, userId],
  );
  const row = result.rows[0] as { role: Role } | undefined;
  return row?.role ?? null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 提交的楼宇集合必须全部在本租户内可见（RLS 上下文下 SELECT 计数）。
 * 非 uuid / 缺行（他租户 / 已删）一律 404 统一文案，不区分成因（SEC-AZ-03）——
 * 先做形状校验，避免非法 uuid 打进 ANY($2::uuid[]) 变 5xx。
 */
async function assertBuildingsInTenant(
  tx: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  tenantId: string,
  buildingIds: readonly string[],
): Promise<void> {
  if (buildingIds.length === 0) return;
  const unique = [...new Set(buildingIds)];
  if (unique.some((id) => !UUID_PATTERN.test(id))) {
    throw new ReasonCodeException('user.scope_building_mismatch', '楼宇范围包含无效项');
  }
  const result = await tx.query(
    `SELECT count(*)::int AS n FROM building WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
    [tenantId, unique],
  );
  const row = result.rows[0] as { n: number };
  if (row.n !== unique.length) {
    throw new ReasonCodeException('user.scope_building_mismatch', '楼宇范围包含无效项');
  }
}
