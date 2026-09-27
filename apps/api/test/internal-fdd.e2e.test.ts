/**
 * internal algo·fdd 端点 e2e（IMPL-17 并入项 / DAT-163，PG 门控）。
 *
 * 覆盖（algo.md §8/§6.2、M6-fdd §3.2/§4.2/§4.4）：
 * - 认证：无/错凭证 401 auth.service_unauthorized；
 * - findings 批量 upsert：新命中 insert（status=open）→ 持续命中仅刷新
 *   last_detected_at（first 不变，时间轴不漂移）→ cleared 置 resolved +
 *   resolved_at；重复 clear 幂等不报错；api 维护字段（id/tenant_id/status）出现即
 *   422 validation_failed；
 * - equipment 不存在 404 asset.not_found；
 * - GET findings：活跃窗口谓词（first < to ∧ effective_end 空或 ≥ from）、
 *   keyset 分页、列表不含 evidence、跨租户经 building 解析；
 * - reports：合法提交 201 入库（daterange 闭开）；同期重生成 upsert 覆盖
 *   （不重复行）；start ≥ end 422；building 不存在 404；
 * - asset-snapshot：全量含 equipments+points（tenant_id 随行带出）；
 *   updated_since 增量只回 touched 点位。
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import type { AssetSnapshot, FddFindingList } from '@thermio/shared-types';
import { E2E_ADMIN_URL, E2E_READY, bootE2eApp, seedWorld, type SeededWorld } from './e2e-env.js';

const skipped = E2E_READY ? describe : describe.skip;

const SVC_TOKEN = 'e2e-svc-token-fdd-0123456789abcdef-0123456789abcd';

let app: INestApplication | null = null;
let world: SeededWorld;
let adminPool: pg.Pool | null = null;

interface FddSeed {
  readonly equipmentId: string;
  readonly pointA: number;
  readonly pointB: number;
}

let seed: FddSeed;

function requireApp(): INestApplication {
  if (app === null) throw new Error('app 未启动');
  return app;
}

function internalGet(path: string, token = SVC_TOKEN): request.Test {
  return request(requireApp().getHttpServer()).get(path).set('Authorization', `Bearer ${token}`);
}

function internalPost(path: string, body: unknown, token = SVC_TOKEN): request.Test {
  return request(requireApp().getHttpServer())
    .post(path)
    .set('Authorization', `Bearer ${token}`)
    .send(body as Record<string, unknown>);
}

/** admin 池连接（空断言禁用——fail-fast 抛错优于非空断言）。 */
function adminConnect(): Promise<pg.PoolClient> {
  if (adminPool === null) throw new Error('adminPool 未初始化');
  return adminPool.connect();
}

function evidence(): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    points: [{ point_id: 1, quantity_type: 'chw_supply_temp' }],
    window: { from: now, to: now },
    detail: { delta_t_avg_c: -12.3 },
  };
}

function hit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    equipment_id: seed.equipmentId,
    rule_key: 'chiller.delta_t_low',
    severity: 'warning',
    title: '1#冷机供回水温差持续低于 1.2°C',
    evidence: evidence(),
    suggested_action: '检查蒸发器结垢',
    first_detected_at: now,
    last_detected_at: now,
    ...overrides,
  };
}

skipped('internal algo·fdd e2e（IMPL-17 并入项）', () => {
  beforeAll(async () => {
    process.env['SVC_TOKEN_ALGO'] = SVC_TOKEN;
    app = (await bootE2eApp()).app;
    world = await seedWorld();
    adminPool = new pg.Pool({ connectionString: E2E_ADMIN_URL, max: 2 });

    const client = await adminPool.connect();
    try {
      const firstId = (result: pg.QueryResult): string => {
        const row = result.rows[0] as { id: string } | undefined;
        if (row === undefined) throw new Error('种子 RETURNING 缺行');
        return row.id;
      };
      const systemId = firstId(
        await client.query(
          `INSERT INTO hvac_system (tenant_id, building_id, system_type, name)
           VALUES ($1, $2, 'chilled_water', '冷冻系统') RETURNING id`,
          [world.tenantA, world.buildingA1],
        ),
      );
      const equipmentId = firstId(
        await client.query(
          `INSERT INTO equipment (tenant_id, system_id, equipment_type, name, local_id)
           VALUES ($1, $2, 'chiller', '1#冷机', '1#冷机') RETURNING id`,
          [world.tenantA, systemId],
        ),
      );
      const insertPoint = async (rawName: string): Promise<number> => {
        const row = (
          await client.query(
            `INSERT INTO point (tenant_id, building_id, equipment_id, source_type, raw_name,
                                quantity_type, unit_std, direction, is_controllable,
                                clamp_min, clamp_max)
             VALUES ($1, $2, $3, 'virtual', $4, 'chw_supply_temp', 'degC', 'readwrite', true, 5, 9)
             RETURNING id`,
            [world.tenantA, world.buildingA1, equipmentId, rawName],
          )
        ).rows[0] as { id: string };
        return Number(row.id);
      };
      seed = {
        equipmentId,
        pointA: await insertPoint('CHW_A'),
        pointB: await insertPoint('CHW_B'),
      };
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    const pool = adminPool;
    const application = app;
    if (pool !== null) await pool.end().catch(() => undefined);
    if (application !== null) await application.close().catch(() => undefined);
  });

  // -----------------------------------------------------------------
  // 认证面
  // -----------------------------------------------------------------
  it('shouldRejectAllInternalFddEndpoints_withoutValidToken_401', async () => {
    const probes: readonly { path: string; get: boolean }[] = [
      { path: '/internal/fdd/findings', get: true },
      { path: '/internal/fdd/findings', get: false },
      { path: '/internal/fdd/reports', get: false },
      { path: '/internal/algo/asset-snapshot', get: true },
    ];
    for (const probe of probes) {
      // 守卫先于一切校验：无凭证一律 401（不泄露路由细节差异）
      const noToken = probe.get
        ? await request(requireApp().getHttpServer()).get(probe.path)
        : await request(requireApp().getHttpServer()).post(probe.path).send({});
      expect(noToken.status).toBe(401);
      expect((noToken.body as { error: { reason_code: string } }).error.reason_code).toBe(
        'auth.service_unauthorized',
      );
      const badToken = probe.get
        ? await internalGet(probe.path, 'wrong-token-fdd')
        : await internalPost(probe.path, {}, 'wrong-token-fdd');
      expect(badToken.status).toBe(401);
    }
  });

  // -----------------------------------------------------------------
  // POST /internal/fdd/findings（upsert 语义，M6 §3.2）
  // -----------------------------------------------------------------
  it('shouldUpsertHits_insertThenRefreshOnlyTimelineFields', async () => {
    const t0 = '2026-09-27T10:00:00+08:00';
    const t1 = '2026-09-27T10:15:00+08:00';
    const first = await internalPost('/internal/fdd/findings', {
      algo_version: '0.1.0+9f3ab2c1',
      hits: [hit({ first_detected_at: t0, last_detected_at: t0 })],
      cleared: [],
    });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true });

    // 持续命中：last 刷新、first 不变（判定时间轴不变）+ 展示面覆盖
    const second = await internalPost('/internal/fdd/findings', {
      algo_version: '0.1.0+9f3ab2c1',
      hits: [
        hit({
          severity: 'major',
          title: '温差持续偏低（升级）',
          first_detected_at: t0,
          last_detected_at: t1,
        }),
      ],
      cleared: [],
    });
    expect(second.status).toBe(200);

    const list = await internalGet(
      `/internal/fdd/findings?building_id=${world.buildingA1}&limit=10`,
    );
    expect(list.status).toBe(200);
    const items = (list.body as FddFindingList).items;
    const row = items.find((item) => item.rule_key === 'chiller.delta_t_low');
    expect(row).toBeDefined();
    expect(row?.status).toBe('open');
    expect(row?.severity).toBe('major');
    expect(row?.title).toBe('温差持续偏低（升级）');
    expect(Date.parse(row?.first_detected_at ?? '')).toBe(Date.parse(t0));
    expect(Date.parse(row?.last_detected_at ?? '')).toBe(Date.parse(t1));
    expect(row?.equipment.local_id).toBe('1#冷机');
    expect(row?.building_id).toBe(world.buildingA1);
    // 列表不含 evidence（internal 复用面精瘦前提）
    expect(Object.hasOwn(row as object, 'evidence')).toBe(false);
  });

  it('shouldClearActiveRows_idempotentWhenNoActiveRow', async () => {
    const clearedAt = '2026-09-27T11:00:00+08:00';
    const first = await internalPost('/internal/fdd/findings', {
      algo_version: '0.1.0+9f3ab2c1',
      hits: [],
      cleared: [
        { equipment_id: seed.equipmentId, rule_key: 'chiller.delta_t_low', cleared_at: clearedAt },
      ],
    });
    expect(first.status).toBe(200);

    const list = await internalGet(
      `/internal/fdd/findings?building_id=${world.buildingA1}&limit=100`,
    );
    const row = (list.body as FddFindingList).items.find(
      (item) => item.rule_key === 'chiller.delta_t_low',
    );
    expect(row?.status).toBe('resolved');
    expect(Date.parse(row?.resolved_at ?? '')).toBe(Date.parse(clearedAt));

    // 重复 clear：无活跃行 → 忽略不报错（幂等）
    const again = await internalPost('/internal/fdd/findings', {
      algo_version: '0.1.0+9f3ab2c1',
      hits: [],
      cleared: [
        { equipment_id: seed.equipmentId, rule_key: 'chiller.delta_t_low', cleared_at: clearedAt },
      ],
    });
    expect(again.status).toBe(200);
  });

  it('shouldRejectApiMaintainedFieldsInPayload_422', async () => {
    const tainted = await internalPost('/internal/fdd/findings', {
      algo_version: '0.1.0+9f3ab2c1',
      hits: [hit({ id: '0192aaaa-0000-7000-8000-000000000001', status: 'open' })],
      cleared: [],
    });
    expect(tainted.status).toBe(422);
    expect((tainted.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'common.validation_failed',
    );
  });

  it('shouldRejectUnknownEquipment_404AssetNotFound', async () => {
    const response = await internalPost('/internal/fdd/findings', {
      algo_version: '0.1.0+9f3ab2c1',
      hits: [hit({ equipment_id: world.buildingA1 })],
      cleared: [],
    });
    expect(response.status).toBe(404);
    expect((response.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'asset.not_found',
    );
  });

  // -----------------------------------------------------------------
  // GET /internal/fdd/findings（活跃窗口谓词 + keyset）
  // -----------------------------------------------------------------
  it('shouldApplyActiveWindowPredicate_fromTo', async () => {
    // 已 resolved 的行（上一用例）：resolved_at=11:00 → from=11:30 窗内应不可见；
    // from=10:30 窗内应可见（消除时刻落于窗内）
    const after = await internalGet(
      `/internal/fdd/findings?building_id=${world.buildingA1}&from=${encodeURIComponent('2026-09-27T11:30:00+08:00')}&limit=100`,
    );
    expect(
      (after.body as FddFindingList).items.some((item) => item.rule_key === 'chiller.delta_t_low'),
    ).toBe(false);
    const within = await internalGet(
      `/internal/fdd/findings?building_id=${world.buildingA1}&from=${encodeURIComponent('2026-09-27T10:30:00+08:00')}&limit=100`,
    );
    expect(
      (within.body as FddFindingList).items.some((item) => item.rule_key === 'chiller.delta_t_low'),
    ).toBe(true);

    // building_id 缺失 → 422（internal 面必填：租户由目标实体解析）
    const missing = await internalGet('/internal/fdd/findings?limit=10');
    expect(missing.status).toBe(422);
  });

  // -----------------------------------------------------------------
  // POST /internal/fdd/reports（同期 upsert）
  // -----------------------------------------------------------------
  function reportBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      building_id: world.buildingA1,
      period_type: 'day',
      period: { start: '2026-09-26', end: '2026-09-27' },
      summary: {
        counts: { new: 3, resolved: 1, persisting: 2 },
        new_by_severity: { info: 0, warning: 2, minor: 1, major: 0, critical: 0 },
        open_by_severity: { info: 0, warning: 1, minor: 1, major: 0, critical: 0 },
        health_ranking: [
          {
            equipment_id: seed.equipmentId,
            equipment_name: '1#冷机',
            equipment_type: 'chiller',
            open_count: 2,
            weighted_score: 18,
          },
        ],
      },
      algo_version: '0.1.0+9f3ab2c1',
      ...overrides,
    };
  }

  it('shouldUpsertReport_samePeriodRegenerationOverwrites', async () => {
    const first = await internalPost('/internal/fdd/reports', reportBody());
    expect(first.status).toBe(201);

    // 同期重生成：upsert 覆盖（不重复行、summary 更新）
    const regenerate = await internalPost(
      '/internal/fdd/reports',
      reportBody({
        summary: {
          counts: { new: 5, resolved: 2, persisting: 3 },
          new_by_severity: { info: 0, warning: 3, minor: 2, major: 0, critical: 0 },
          open_by_severity: { info: 0, warning: 2, minor: 1, major: 0, critical: 0 },
          health_ranking: [],
        },
        algo_version: '0.1.0+aaaabbbb',
      }),
    );
    expect(regenerate.status).toBe(201);

    const client = await adminConnect();
    try {
      const rows = await client.query(
        `SELECT summary->'counts'->>'new' AS new_count, algo_version FROM fdd_report
         WHERE building_id = $1 AND period_type = 'day'`,
        [world.buildingA1],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({ new_count: '5', algo_version: '0.1.0+aaaabbbb' });
    } finally {
      client.release();
    }
  });

  it('shouldRejectInvalidReportPayload_422And404', async () => {
    const reversed = await internalPost(
      '/internal/fdd/reports',
      reportBody({ period: { start: '2026-09-27', end: '2026-09-26' } }),
    );
    expect(reversed.status).toBe(422);

    const unknownBuilding = await internalPost(
      '/internal/fdd/reports',
      reportBody({ building_id: seed.equipmentId }),
    );
    expect(unknownBuilding.status).toBe(404);
  });

  // -----------------------------------------------------------------
  // GET /internal/algo/asset-snapshot
  // -----------------------------------------------------------------
  it('shouldServeFullSnapshot_withTenantColumn_thenIncrementalByUpdatedSince', async () => {
    const full = await internalGet('/internal/algo/asset-snapshot');
    expect(full.status).toBe(200);
    const snapshot = full.body as AssetSnapshot;
    expect(snapshot.generated_at).toBeDefined();
    expect(snapshot.equipments.length).toBeGreaterThanOrEqual(1);
    const equipment = snapshot.equipments.find((item) => item.equipment_id === seed.equipmentId);
    expect(equipment).toMatchObject({
      equipment_type: 'chiller',
      local_id: '1#冷机',
      tenant_id: world.tenantA,
      building_id: world.buildingA1,
    });
    const pointA = snapshot.points.find((item) => item.point_id === seed.pointA);
    expect(pointA).toMatchObject({
      quantity_type: 'chw_supply_temp',
      unit_std: 'degC',
      is_controllable: true,
      clamp_min: 5,
      clamp_max: 9,
      control_mode: 'advisory',
    });

    // 增量：取两行当前最大 updated_at 为游标 → touch pointB（point_touch 刷
    // updated_at）→ 增量只回 B（A 的 updated_at 不越游标）
    const client = await adminConnect();
    let since: string;
    try {
      const maxRow = await client.query<{ max: Date }>(
        `SELECT max(updated_at) AS max FROM point WHERE id = ANY($1::bigint[])`,
        [[seed.pointA, seed.pointB]],
      );
      since = new Date((maxRow.rows[0]?.max ?? new Date()).getTime() + 1).toISOString();
      await client.query(`UPDATE point SET clamp_min = 5.5 WHERE id = $1`, [seed.pointB]);
    } finally {
      client.release();
    }
    const incremental = await internalGet(
      `/internal/algo/asset-snapshot?updated_since=${encodeURIComponent(since)}`,
    );
    expect(incremental.status).toBe(200);
    const delta = incremental.body as AssetSnapshot;
    const deltaIds = delta.points.map((point) => point.point_id);
    expect(deltaIds).toContain(seed.pointB);
    expect(deltaIds).not.toContain(seed.pointA);
    // equipments 恒全量带出（equipment 无 updated_at 列——DDL 缺口，见服务注释）
    expect(delta.equipments.length).toBe(snapshot.equipments.length);
  });
});
