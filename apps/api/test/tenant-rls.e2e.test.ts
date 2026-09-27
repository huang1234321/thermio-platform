/**
 * 租户上下文纪律 e2e（IMPL-10 验收要点：漏设上下文 = 零可见 fail-closed；
 * ddl.md §5.2/§8 用例 2/3 的应用角色复证）。
 *
 * 与 db/scripts/verify-rls.sh（psql 直连探针）互补：这里从 api 进程内、
 * 以应用真实连接角色（thermio_api）验证：
 * 1. 无 app.tenant_id 的事务读零行（fail-closed）；
 * 2. SET LOCAL 事务结束后上下文自动失效（连接池回租不串号——§5.2「禁止会话级 SET」的动机）；
 * 3. TenantDb.withTenant 的 A/B 隔离（读）与跨租户写 0 行（WITH CHECK）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { E2E_API_URL, E2E_READY, seedWorld, type SeededWorld } from './e2e-env.js';
import { TenantDb } from '../src/infrastructure/db/tenant-db.js';

const skipped = E2E_READY ? describe : describe.skip;

let world: SeededWorld;
let pool: pg.Pool;

skipped('tenant context discipline（ddl.md §5.2 fail-closed）', () => {
  beforeAll(async () => {
    world = await seedWorld();
    pool = new pg.Pool({ connectionString: E2E_API_URL, max: 2 });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('shouldSeeZeroRows_withoutTenantContext_failClosed', async () => {
    const client = await pool.connect();
    try {
      // 显式不开事务、不设上下文——RLS fail-closed 必须零可见
      const result = await client.query(`SELECT count(*)::int AS n FROM app_user`);
      expect(result.rows[0]).toEqual({ n: 0 });
    } finally {
      client.release();
    }
  });

  it('shouldExpireSetLocalWithTheTransaction_noLeakAcrossPoolReuse', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.tenant_id = '${world.tenantA}'`);
      const inside = await client.query(`SELECT count(*)::int AS n FROM app_user`);
      await client.query('COMMIT');
      // 事务结束：同一连接上上下文已失效（连接池回租安全的机制性证据）
      const outside = await client.query(`SELECT count(*)::int AS n FROM app_user`);
      expect(inside.rows[0]).toEqual({ n: 4 });
      expect(outside.rows[0]).toEqual({ n: 0 });
    } finally {
      client.release();
    }
  });

  it('shouldIsolateTenants_throughTenantDb', async () => {
    const tenantDb = new TenantDb(pool);
    const inA = await tenantDb.withTenant(world.tenantA, (tx) =>
      tx.query(`SELECT email FROM app_user ORDER BY email`),
    );
    const inB = await tenantDb.withTenant(world.tenantB, (tx) =>
      tx.query(`SELECT email FROM app_user ORDER BY email`),
    );
    expect(inA.rows).toHaveLength(4);
    expect(inA.rows.every((r) => (r as { email: string }).email.endsWith('@dt113.test'))).toBe(
      true,
    );
    expect(inB.rows).toHaveLength(1);
    expect((inB.rows[0] as { email: string }).email).toBe('admin-b@dt113.test');
  });

  it('shouldBlockCrossTenantWrites_withCheck_zeroRows', async () => {
    const tenantDb = new TenantDb(pool);
    // 以 B 上下文尝试改 A 的用户名：RLS USING 下行不可见 → UPDATE 0 行（隔离不依赖应用自觉）
    const affected = await tenantDb.withTenant(world.tenantB, (tx) =>
      tx.query(`UPDATE app_user SET display_name = 'hijack' WHERE id = $1`, [world.adminA]),
    );
    expect(affected.rowCount).toBe(0);
    // 复证 A 侧未被改写
    const unchanged = await tenantDb.withTenant(world.tenantA, (tx) =>
      tx.query(`SELECT display_name FROM app_user WHERE id = $1`, [world.adminA]),
    );
    expect((unchanged.rows[0] as { display_name: string }).display_name).not.toBe('hijack');
  });

  it('shouldGuardAgainstNonUuidTenantIds_atTheOnlySetLocalInlet', async () => {
    const tenantDb = new TenantDb(pool);
    await expect(
      tenantDb.withTenant("a'; DROP TABLE app_user; --", async () => {
        await Promise.resolve();
      }),
    ).rejects.toThrow(/uuid/);
  });

  it('shouldKeepTheAuthRoleBypassNarrow_enumeratedInternalReadOnly', async () => {
    // thermio_auth 旁路面验收：旁路 = 枚举的 internal_read 只读表集（面收窄纪律），
    // 其余业务表一律拒绝。枚举集随 /internal/* 面扩列：
    // - 0001：device_credential / gateway（EMQX 认证）；
    // - 0005：app_user（登录 email 解析）；
    // - 0007：tenant / equipment（internal 面租户由目标实体解析，platform §11-5）；
    // - 0008：building / point / hvac_system（asset-snapshot 投影 + report 定位）。
    const authPool = new pg.Pool({
      connectionString: process.env['PG_E2E_AUTH_URL'],
      max: 1,
    });
    try {
      const users = await authPool.query(`SELECT count(*)::int AS n FROM app_user`);
      expect(users.rows[0]).toEqual({ n: 5 }); // 双租户全部用户（email 全局解析需要）
      for (const table of ['tenant', 'equipment', 'building', 'point', 'hvac_system']) {
        const readable = await authPool.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect(readable.rows[0]?.n).toBeGreaterThanOrEqual(0); // 有权限即可达
      }
      // 负探针：枚举集之外的业务表仍然拒绝（旁路面未失控）
      for (const table of [
        'auth_session',
        'proposal',
        'fdd_finding',
        'fdd_report',
        'control_audit',
        'alarm_event',
      ]) {
        await expect(authPool.query(`SELECT count(*) FROM ${table}`)).rejects.toThrow(
          /permission denied/i,
        );
      }
    } finally {
      await authPool.end();
    }
  });
});
