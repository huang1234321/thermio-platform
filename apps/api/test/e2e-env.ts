/**
 * 认证 e2e 的环境门与种子（IMPL-10 验收要点载体）。
 *
 * 门（skip 条件）：三个 DSN 缺一即整组跳过（本地无库时保持骨架形态可跑），
 * CI 在 api-e2e 工作流里注入（一次性容器，环境隔离纪律）。
 *
 * 种子走 superuser 运维通道（ddl.md §5.3：首个租户行无法经 RLS api 角色插入）：
 * 双租户 + 三角色 + 三用户 + 双楼宇 + 楼宇授权，覆盖越租户/越楼宇/能力矩阵用例。
 */
import pg from 'pg';
import { hashPassword } from '../src/auth/password.js';

export const E2E_ADMIN_URL = process.env['PG_E2E_ADMIN_URL'] ?? '';
export const E2E_API_URL = process.env['PG_E2E_API_URL'] ?? '';
export const E2E_AUTH_URL = process.env['PG_E2E_AUTH_URL'] ?? '';
export const E2E_JWT_SECRET =
  process.env['AUTH_JWT_SECRET'] ?? 'e2e-test-secret-0123456789abcdef-0123456789abcdef';

export const E2E_READY =
  E2E_ADMIN_URL.length > 0 && E2E_API_URL.length > 0 && E2E_AUTH_URL.length > 0;

/** 测试固定口令（公开测试固件，非秘密；库一次性容器随测随弃）。 */
export const PASSWORDS = {
  admin: 'dt113-admin-pass1',
  operator: 'dt113-operator-pass1',
  viewer: 'dt113-viewer-pass1',
  disabled: 'dt113-disabled-pass1',
} as const;

export interface SeededWorld {
  tenantA: string;
  tenantB: string;
  adminA: string;
  operatorA: string;
  viewerA: string;
  disabledA: string;
  adminB: string;
  buildingA1: string;
  buildingA2: string;
  buildingB1: string;
}

export async function seedWorld(): Promise<SeededWorld> {
  const pool = new pg.Pool({ connectionString: E2E_ADMIN_URL, max: 2 });
  try {
    const [adminHash, operatorHash, viewerHash, disabledHash] = await Promise.all([
      hashPassword(PASSWORDS.admin),
      hashPassword(PASSWORDS.operator),
      hashPassword(PASSWORDS.viewer),
      hashPassword(PASSWORDS.disabled),
    ]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`TRUNCATE tenant CASCADE`);

      function firstId(result: pg.QueryResult): string {
        const row = result.rows[0] as { id: string } | undefined;
        if (row === undefined) throw new Error('RETURNING 未返回行（种子数据异常）');
        return row.id;
      }
      const tenantA = firstId(
        await client.query(
          `INSERT INTO tenant (name, slug) VALUES ('DT113 租户A', 'dt113-a') RETURNING id`,
        ),
      );
      const tenantB = firstId(
        await client.query(
          `INSERT INTO tenant (name, slug) VALUES ('DT113 租户B', 'dt113-b') RETURNING id`,
        ),
      );

      for (const tenant of [tenantA, tenantB]) {
        await client.query(
          `INSERT INTO role (tenant_id, name)
           SELECT $1, n FROM unnest(ARRAY['admin','operator','viewer']) AS n`,
          [tenant],
        );
      }

      async function insertUser(
        tenant: string,
        email: string,
        passwordHash: string,
        status: 'active' | 'disabled' = 'active',
      ): Promise<string> {
        const localPart = email.split('@')[0] ?? email;
        return firstId(
          await client.query(
            `INSERT INTO app_user (tenant_id, email, password_hash, display_name, status)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [tenant, email, passwordHash, localPart, status],
          ),
        );
      }
      async function assignRole(
        tenant: string,
        user: string,
        role: 'admin' | 'operator' | 'viewer',
      ): Promise<void> {
        await client.query(
          `INSERT INTO user_role (tenant_id, user_id, role_id)
           SELECT $1, $2, id FROM role WHERE tenant_id = $1 AND name = $3`,
          [tenant, user, role],
        );
      }

      const [adminA, operatorA, viewerA, disabledA] = [
        await insertUser(tenantA, 'admin-a@dt113.test', adminHash),
        await insertUser(tenantA, 'operator-a@dt113.test', operatorHash),
        await insertUser(tenantA, 'viewer-a@dt113.test', viewerHash),
        await insertUser(tenantA, 'disabled-a@dt113.test', disabledHash, 'disabled'),
      ];
      const adminB = await insertUser(tenantB, 'admin-b@dt113.test', adminHash);
      await assignRole(tenantA, adminA, 'admin');
      await assignRole(tenantA, operatorA, 'operator');
      await assignRole(tenantA, viewerA, 'viewer');
      await assignRole(tenantA, disabledA, 'viewer');
      await assignRole(tenantB, adminB, 'admin');

      const buildingA1 = firstId(
        await client.query(
          `INSERT INTO building (tenant_id, name) VALUES ($1, 'A1 楼') RETURNING id`,
          [tenantA],
        ),
      );
      const buildingA2 = firstId(
        await client.query(
          `INSERT INTO building (tenant_id, name) VALUES ($1, 'A2 楼') RETURNING id`,
          [tenantA],
        ),
      );
      const buildingB1 = firstId(
        await client.query(
          `INSERT INTO building (tenant_id, name) VALUES ($1, 'B1 楼') RETURNING id`,
          [tenantB],
        ),
      );

      await client.query(
        `INSERT INTO user_building_scope (tenant_id, user_id, building_id) VALUES ($1, $2, $3)`,
        [tenantA, viewerA, buildingA1],
      );
      await client.query(
        `INSERT INTO user_building_scope (tenant_id, user_id, building_id)
         SELECT $1, $2, b.id FROM building b WHERE b.tenant_id = $1`,
        [tenantA, operatorA],
      );

      await client.query('COMMIT');
      return {
        tenantA,
        tenantB,
        adminA,
        operatorA,
        viewerA,
        disabledA,
        adminB,
        buildingA1,
        buildingA2,
        buildingB1,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

/** 以 e2e 环境装配 AppModule（env 在模块创建前写入 process.env，config 工厂读取）。 */
export async function bootE2eApp(): Promise<{ app: import('@nestjs/common').INestApplication }> {
  process.env['PG_API_URL'] = E2E_API_URL;
  process.env['PG_AUTH_URL'] = E2E_AUTH_URL;
  process.env['AUTH_JWT_SECRET'] = E2E_JWT_SECRET;
  process.env['AUTH_LOGIN_RATE_LIMIT'] = process.env['AUTH_LOGIN_RATE_LIMIT'] ?? '50/300';
  const { Test } = await import('@nestjs/testing');
  const { AppModule } = await import('../src/app.module.js');
  const { configureApp } = await import('../src/bootstrap.js');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  return { app };
}
