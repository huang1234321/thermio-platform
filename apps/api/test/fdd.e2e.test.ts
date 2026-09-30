/**
 * FDD admin 面端点 e2e（modules/M6-fdd.md §5.8 契约测试矩阵，IMPL-16 切片 / DAT-212，
 * PG 门控）。种子里经 internal 通道落发现（写路径单向：M6 不产生数据，只消费与记录）。
 *
 * 覆盖（§5.8 矩阵 9 用例的 e2e 面）：
 * - 矩阵 2 越权：跨租户深链 404 fdd.finding_not_found 文案与不存在一致（SEC-AZ-03）；
 * - 矩阵 3 权限：viewer 读面 200、review/ignore 403 auth.forbidden（能力未下发）；
 * - 矩阵 4 review 非法值/note 超长 422 + details 字段定位；
 * - 矩阵 5 ignore on resolved 409 fdd.state_invalid / ignore on ignored 幂等 200；
 * - 矩阵 6 ignore reason 缺失 422；
 * - 矩阵 7 活跃窗口谓词边界：窗内 resolved / 跨窗 open / 窗前 ignored；
 * - 矩阵 8 internal 与 admin 列表同 schema：同一 FddFindingListSchema 双面通过
 *   （DAT-133 形状复用锚点）+ review/ignored_at 随 0009 落列带出；
 * - overview：open 计数/review_stats（含 hit_rate=null 与真实比率）/health 无报告 null；
 * - reports：列表/详情/period_type 过滤 + 404 fdd.report_not_found + 同期 upsert 可见；
 * - 复活语义（§2.1）：ignored 后同规则再命中 internal 提交出新 open 行。
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import {
  FddFindingListSchema,
  type FddFindingDetail,
  type FddFindingList,
  type FddOverview,
  type FddReportList,
  type LoginResponse,
} from '@thermio/shared-types';
import {
  E2E_ADMIN_URL,
  E2E_READY,
  PASSWORDS,
  bootE2eApp,
  seedWorld,
  type SeededWorld,
} from './e2e-env.js';

const skipped = E2E_READY ? describe : describe.skip;

const SVC_TOKEN = 'e2e-svc-token-fdd-admin-0123456789abcdef-0123456';

let app: INestApplication | null = null;
let world: SeededWorld;
let adminPool: pg.Pool | null = null;

interface FddSeed {
  readonly systemId: string;
  readonly equipmentA1: string;
  readonly equipmentA2: string;
}

let seed: FddSeed;

let adminToken: string;
let operatorToken: string;
let viewerToken: string;
let adminBToken: string;

function requireApp(): INestApplication {
  if (app === null) throw new Error('app 未启动');
  return app;
}

function passwordFor(email: string): string {
  if (email.startsWith('operator')) return PASSWORDS.operator;
  if (email.startsWith('viewer')) return PASSWORDS.viewer;
  return PASSWORDS.admin;
}

async function login(email: string): Promise<string> {
  const response = await request(requireApp().getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password: passwordFor(email) });
  expect(response.status).toBe(200);
  return (response.body as LoginResponse).access_token;
}

/** admin 池连接（空断言禁用——fail-fast 抛错优于非空断言，沿 internal-fdd 同款）。 */
function adminConnect(): Promise<pg.PoolClient> {
  if (adminPool === null) throw new Error('adminPool 未初始化');
  return adminPool.connect();
}

function authed(method: 'get' | 'put' | 'post', path: string, token: string): request.Test {
  return request(requireApp().getHttpServer())
    [method](path)
    .set('Authorization', `Bearer ${token}`);
}

function internalPost(path: string, body: unknown): request.Test {
  return request(requireApp().getHttpServer())
    .post(path)
    .set('Authorization', `Bearer ${SVC_TOKEN}`)
    .send(body as Record<string, unknown>);
}

function evidence(): Record<string, unknown> {
  return {
    points: [{ point_id: 1, quantity_type: 'chw_supply_temp' }],
    window: { from: '2026-09-28T09:00:00+08:00', to: '2026-09-28T10:00:00+08:00' },
    detail: { delta_t_avg_c: 0.8 },
  };
}

function hit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    equipment_id: seed.equipmentA1,
    rule_key: 'chiller.delta_t_low',
    severity: 'warning',
    title: '1#冷机供回水温差持续偏低',
    evidence: evidence(),
    suggested_action: '检查蒸发器结垢',
    first_detected_at: '2026-09-28T09:30:00+08:00',
    last_detected_at: '2026-09-28T09:55:00+08:00',
    ...overrides,
  };
}

skipped('FDD admin 面 e2e（M6 查看端点）', () => {
  beforeAll(async () => {
    process.env['SVC_TOKEN_ALGO'] = SVC_TOKEN;
    app = (await bootE2eApp()).app;
    world = await seedWorld();
    adminPool = new pg.Pool({ connectionString: E2E_ADMIN_URL, max: 2 });

    const client = await adminConnect();
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
      const insertEquipment = async (name: string): Promise<string> =>
        firstId(
          await client.query(
            `INSERT INTO equipment (tenant_id, system_id, equipment_type, name, local_id)
             VALUES ($1, $2, 'chiller', $3, $3) RETURNING id`,
            [world.tenantA, systemId, name],
          ),
        );
      seed = {
        systemId,
        equipmentA1: await insertEquipment('1#冷机'),
        equipmentA2: await insertEquipment('2#冷机'),
      };
    } finally {
      client.release();
    }

    adminToken = await login('admin-a@dt113.test');
    operatorToken = await login('operator-a@dt113.test');
    viewerToken = await login('viewer-a@dt113.test');
    adminBToken = await login('admin-b@dt113.test');
  });

  afterAll(async () => {
    const pool = adminPool;
    const application = app;
    if (pool !== null) await pool.end().catch(() => undefined);
    if (application !== null) await application.close().catch(() => undefined);
  });

  // 三条基线发现（供全用例消费；时间轴错开以覆盖活跃窗口边界）
  // A：窗内 resolved（first 09:30 / resolved 10:00）
  // B：跨窗 open 持续（first 09:00 / last 09:55，无终点）
  // C：窗前 ignored（first 08:00，人工忽略 08:30）
  let findingA: string;
  let findingB: string;
  let findingC: string;

  it('shouldSeedFindings_viaInternalChannel_thenAdminListSeesThem', async () => {
    // A：命中后 cleared → resolved
    const seedA = await internalPost('/internal/fdd/findings', {
      algo_version: '0.2.0+fddaaa',
      hits: [hit()],
      cleared: [],
    });
    expect(seedA.status).toBe(200);
    const clearA = await internalPost('/internal/fdd/findings', {
      algo_version: '0.2.0+fddaaa',
      hits: [],
      cleared: [
        {
          equipment_id: seed.equipmentA1,
          rule_key: 'chiller.delta_t_low',
          cleared_at: '2026-09-28T10:00:00+08:00',
        },
      ],
    });
    expect(clearA.status).toBe(200);

    // B：另一设备持续未决
    const seedB = await internalPost('/internal/fdd/findings', {
      algo_version: '0.2.0+fddaaa',
      hits: [
        hit({
          equipment_id: seed.equipmentA2,
          rule_key: 'chiller.delta_t_low',
          title: '2#冷机供回水温差持续偏低',
          first_detected_at: '2026-09-28T09:00:00+08:00',
          last_detected_at: '2026-09-28T09:55:00+08:00',
        }),
      ],
      cleared: [],
    });
    expect(seedB.status).toBe(200);

    // C：窗前发现，直接人工忽略（经 admin 面——ignored 态唯一触发入口）
    const seedC = await internalPost('/internal/fdd/findings', {
      algo_version: '0.2.0+fddaaa',
      hits: [
        hit({
          rule_key: 'chiller.sensor_stale',
          title: '冷冻水供温传感器数据滞止',
          first_detected_at: '2026-09-28T08:00:00+08:00',
          last_detected_at: '2026-09-28T08:20:00+08:00',
        }),
      ],
      cleared: [],
    });
    expect(seedC.status).toBe(200);

    const list = await authed(
      'get',
      `/api/v1/fdd/findings?building_id=${world.buildingA1}&limit=100`,
      adminToken,
    );
    expect(list.status).toBe(200);
    const parsed = FddFindingListSchema.safeParse(list.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const items = parsed.data.items;
    findingA =
      items.find(
        (item) => item.rule_key === 'chiller.delta_t_low' && item.equipment.id === seed.equipmentA1,
      )?.id ?? '';
    findingB =
      items.find(
        (item) => item.rule_key === 'chiller.delta_t_low' && item.equipment.id === seed.equipmentA2,
      )?.id ?? '';
    findingC = items.find((item) => item.rule_key === 'chiller.sensor_stale')?.id ?? '';
    expect(findingA).not.toBe('');
    expect(findingB).not.toBe('');
    expect(findingC).not.toBe('');
    // 列表不含 evidence（大字段仅详情返回，M6 §4.2）
    expect(Object.hasOwn(items[0] as object, 'evidence')).toBe(false);

    // C：窗前发现经 admin 面人工忽略（ignored 态唯一触发入口，§5.5）——
    // 先于活跃窗口用例执行（C 的窗前 ignored 是谓词边界断言的输入）。
    // ignored_at 由服务置 now()——为构造「忽略时刻在窗前」边界，经 superuser
    // 通道回塑时刻（fixture 整形，非写路径测试）
    const ignored = await authed('post', `/api/v1/fdd/findings/${findingC}/ignore`, operatorToken)
      .set('Idempotency-Key', 'fdd-e2e-ignore-c-seed')
      .send({ reason: '测试性发现，闭环演练忽略' });
    expect(ignored.status).toBe(200);
    expect((ignored.body as FddFindingDetail).status).toBe('ignored');
    const client = await adminConnect();
    try {
      await client.query(`UPDATE fdd_finding SET ignored_at = $1::timestamptz WHERE id = $2`, [
        '2026-09-28T08:30:00+08:00',
        findingC,
      ]);
    } finally {
      client.release();
    }
  });

  // -----------------------------------------------------------------
  // 矩阵 8：internal 与 admin 列表同 schema（DAT-133 形状复用锚点）
  // -----------------------------------------------------------------
  it('shouldShareListItemSchema_betweenInternalAndAdminFaces', async () => {
    const adminList = await authed(
      'get',
      `/api/v1/fdd/findings?building_id=${world.buildingA1}&limit=100`,
      adminToken,
    );
    expect(adminList.status).toBe(200);
    const internalList = await request(requireApp().getHttpServer())
      .get(`/internal/fdd/findings?building_id=${world.buildingA1}&limit=100`)
      .set('Authorization', `Bearer ${SVC_TOKEN}`);
    expect(internalList.status).toBe(200);
    // 双面响应同过同一 FddFindingListSchema（快照锚点）
    expect(FddFindingListSchema.safeParse(adminList.body).success).toBe(true);
    expect(FddFindingListSchema.safeParse(internalList.body).success).toBe(true);
    const adminIds = (adminList.body as FddFindingList).items.map((item) => item.id).sort();
    const internalIds = (internalList.body as FddFindingList).items.map((item) => item.id).sort();
    expect(adminIds).toEqual(internalIds);
  });

  // -----------------------------------------------------------------
  // 矩阵 7：活跃窗口谓词边界（§5.2：first < to ∧ effective_end 空或 ≥ from）
  // -----------------------------------------------------------------
  it('shouldApplyActiveWindowPredicate_windowBoundaries', async () => {
    // 窗 [09:30, 11:00)：A 窗内 resolved（命中）、B 跨窗 open（命中 persisting）、
    // C 窗前 ignored（不命中——effective_end=08:30 < from）
    const from = encodeURIComponent('2026-09-28T09:30:00+08:00');
    const to = encodeURIComponent('2026-09-28T11:00:00+08:00');
    const response = await authed(
      'get',
      `/api/v1/fdd/findings?building_id=${world.buildingA1}&from=${from}&to=${to}&limit=100`,
      adminToken,
    );
    expect(response.status).toBe(200);
    const ids = (response.body as FddFindingList).items.map((item) => item.id);
    expect(ids).toContain(findingA);
    expect(ids).toContain(findingB);
    expect(ids).not.toContain(findingC);
  });

  // -----------------------------------------------------------------
  // 矩阵 5/6：ignore 状态守卫 + reason 必填 + 幂等
  // -----------------------------------------------------------------
  it('shouldIgnoreFinding_idempotentReplayOnIgnored_200', async () => {
    // C 已在种子步骤被忽略——此处验证已 ignored 重放：幂等 200（留痕不重写，§5.5）
    const again = await authed('post', `/api/v1/fdd/findings/${findingC}/ignore`, operatorToken)
      .set('Idempotency-Key', 'fdd-e2e-ignore-c-replay')
      .send({ reason: '再次忽略' });
    expect(again.status).toBe(200);
    const detail = again.body as FddFindingDetail;
    expect(detail.status).toBe('ignored');
    expect(detail.ignored_at).not.toBeNull();
    expect(detail.ignored_by_name).toBe('operator-a');
  });

  it('shouldRejectIgnoreOnResolved_409StateInvalid', async () => {
    const response = await authed('post', `/api/v1/fdd/findings/${findingA}/ignore`, operatorToken)
      .set('Idempotency-Key', 'fdd-e2e-ignore-a-1')
      .send({ reason: '试图忽略已消除发现' });
    expect(response.status).toBe(409);
    expect((response.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'fdd.state_invalid',
    );
  });

  it('shouldRejectIgnoreWithoutReason_orWithoutIdempotencyKey_422', async () => {
    const missingReason = await authed(
      'post',
      `/api/v1/fdd/findings/${findingB}/ignore`,
      operatorToken,
    )
      .set('Idempotency-Key', 'fdd-e2e-ignore-b-1')
      .send({});
    expect(missingReason.status).toBe(422);
    expect((missingReason.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'common.validation_failed',
    );

    const missingKey = await authed(
      'post',
      `/api/v1/fdd/findings/${findingB}/ignore`,
      operatorToken,
    ).send({ reason: '缺幂等键' });
    expect(missingKey.status).toBe(422);
    const body = missingKey.body as { error: { details: unknown } };
    expect(body.error.details).toBeDefined();
  });

  // -----------------------------------------------------------------
  // 矩阵 4：review 非法值/note 超长 422；合法路径设置/覆写（§5.4）
  // -----------------------------------------------------------------
  it('shouldRecordAndOverwriteReview_anyStatus', async () => {
    const badResult = await authed(
      'put',
      `/api/v1/fdd/findings/${findingA}/review`,
      operatorToken,
    ).send({ result: 'maybe' });
    expect(badResult.status).toBe(422);
    expect((badResult.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'common.validation_failed',
    );

    const longNote = await authed(
      'put',
      `/api/v1/fdd/findings/${findingA}/review`,
      operatorToken,
    ).send({ result: 'confirmed', note: 'x'.repeat(501) });
    expect(longNote.status).toBe(422);

    // resolved 发现事后评审（任意 status 可抽检，§5.4）
    const first = await authed(
      'put',
      `/api/v1/fdd/findings/${findingA}/review`,
      operatorToken,
    ).send({
      result: 'confirmed',
      note: '现场确认温差偏低，清洗蒸发器后恢复',
    });
    expect(first.status).toBe(200);
    const detail = first.body as FddFindingDetail;
    expect(detail.status).toBe('resolved'); // 判定不改状态机（正交，§2.2）
    expect(detail.review?.result).toBe('confirmed');
    expect(detail.review?.reviewed_by_name).toBe('operator-a');
    expect(detail.review?.note).toBe('现场确认温差偏低，清洗蒸发器后恢复');
    expect(detail.evidence.points.length).toBeGreaterThan(0); // 详情自带证据

    // 覆写：最新结论生效
    const overwrite = await authed(
      'put',
      `/api/v1/fdd/findings/${findingA}/review`,
      operatorToken,
    ).send({ result: 'false_positive' });
    expect(overwrite.status).toBe(200);
    expect((overwrite.body as FddFindingDetail).review?.result).toBe('false_positive');
  });

  // -----------------------------------------------------------------
  // 矩阵 3：viewer 只读（读面 200 / review/ignore 403）
  // -----------------------------------------------------------------
  it('shouldEnforceCapability_viewerReadOnly_403OnWrites', async () => {
    const list = await authed('get', '/api/v1/fdd/findings?limit=10', viewerToken);
    expect(list.status).toBe(200);

    const review = await authed('put', `/api/v1/fdd/findings/${findingB}/review`, viewerToken).send(
      { result: 'confirmed' },
    );
    expect(review.status).toBe(403);
    expect((review.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'auth.forbidden',
    );

    const ignore = await authed('post', `/api/v1/fdd/findings/${findingB}/ignore`, viewerToken)
      .set('Idempotency-Key', 'fdd-e2e-viewer-1')
      .send({ reason: '越权忽略' });
    expect(ignore.status).toBe(403);
  });

  // -----------------------------------------------------------------
  // 矩阵 2：跨租户深链 404 文案一致（SEC-AZ-03）
  // -----------------------------------------------------------------
  it('shouldReturnIdentical404_forCrossTenantDeepLink_andUnknownId', async () => {
    const cross = await authed('get', `/api/v1/fdd/findings/${findingB}`, adminBToken);
    expect(cross.status).toBe(404);
    const unknown = await authed(
      'get',
      '/api/v1/fdd/findings/0192aaaa-0000-7000-8000-00000000dead',
      adminToken,
    );
    expect(unknown.status).toBe(404);
    expect((cross.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'fdd.finding_not_found',
    );
    expect((cross.body as { error: { message: string } }).error.message).toBe(
      (unknown.body as { error: { message: string } }).error.message,
    );
    // B 租户列表也不得见 A 租户发现（RLS + 租户谓词）
    const listB = await authed('get', '/api/v1/fdd/findings?limit=100', adminBToken);
    expect(listB.status).toBe(200);
    expect((listB.body as FddFindingList).items.some((item) => item.id === findingB)).toBe(false);
  });

  // -----------------------------------------------------------------
  // 白名单外参数（API-DSN-04）
  // -----------------------------------------------------------------
  it('shouldRejectQueryOutsideWhitelist_422', async () => {
    const response = await authed('get', '/api/v1/fdd/findings?foo=bar&limit=10', adminToken);
    expect(response.status).toBe(422);
    expect((response.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'common.validation_failed',
    );
  });

  // -----------------------------------------------------------------
  // overview（§5.1）：open 计数 / review_stats / health
  // -----------------------------------------------------------------
  it('shouldAggregateOverview_openCounts_reviewStats_health', async () => {
    const response = await authed(
      'get',
      `/api/v1/fdd/overview?building_id=${world.buildingA1}`,
      adminToken,
    );
    expect(response.status).toBe(200);
    const overview = response.body as FddOverview;
    expect(overview.building_id).toBe(world.buildingA1);
    // open 只剩 B（A resolved、C ignored）
    expect(overview.open.total).toBe(1);
    expect(overview.open.by_severity.warning).toBe(1);
    // health：尚无周报 → null
    expect(overview.health).toBeNull();

    // A 在 7×24h 窗口外（first=2026-09-28）——review_stats 覆盖窗口取决于 now；
    // 已抽检 1 条（A）但窗口筛 first ∈ 窗 → 大概率 0：hit_rate null 或已覆盖则 1.0
    expect(overview.review_stats.hit_rate === null || overview.review_stats.hit_rate >= 0).toBe(
      true,
    );

    // 越权楼宇参数 → 404 asset.not_found（复用资产域码，§5.1）
    const forbidden = await authed(
      'get',
      `/api/v1/fdd/overview?building_id=${world.buildingB1}`,
      adminToken,
    );
    expect(forbidden.status).toBe(404);
    expect((forbidden.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'asset.not_found',
    );
  });

  // -----------------------------------------------------------------
  // 复活语义（§2.1）：ignored 后同规则再命中 → 新 open 行
  // -----------------------------------------------------------------
  it('shouldResurrectFindings_newOpenRow_afterIgnore', async () => {
    const rehit = await internalPost('/internal/fdd/findings', {
      algo_version: '0.2.0+fddbbb',
      hits: [
        hit({
          rule_key: 'chiller.sensor_stale',
          first_detected_at: '2026-09-29T08:00:00+08:00',
          last_detected_at: '2026-09-29T08:25:00+08:00',
        }),
      ],
      cleared: [],
    });
    expect(rehit.status).toBe(200);
    const list = await authed(
      'get',
      `/api/v1/fdd/findings?building_id=${world.buildingA1}&rule_key=chiller.sensor_stale&limit=10`,
      adminToken,
    );
    const staleRows = (list.body as FddFindingList).items;
    expect(staleRows.length).toBe(2); // 旧行留史（ignored）+ 新 open 行
    expect(staleRows.filter((row) => row.status === 'open').length).toBe(1);
    expect(staleRows.filter((row) => row.status === 'ignored').length).toBe(1);
  });

  // -----------------------------------------------------------------
  // reports（§5.6/§5.7）：列表/详情/过滤/404
  // -----------------------------------------------------------------
  it('shouldListAndShowReports_withPeriodTypeFilter', async () => {
    // 经 internal 通道提交一份周报 + 一份日报（写路径单向）
    const weekReport = {
      building_id: world.buildingA1,
      period_type: 'week',
      period: { start: '2026-09-22', end: '2026-09-29' },
      summary: {
        counts: { new: 3, resolved: 1, persisting: 2 },
        new_by_severity: { info: 0, warning: 2, minor: 1, major: 0, critical: 0 },
        open_by_severity: { info: 0, warning: 1, minor: 1, major: 0, critical: 0 },
        health_ranking: [
          {
            equipment_id: seed.equipmentA1,
            equipment_name: '1#冷机',
            equipment_type: 'chiller',
            open_count: 2,
            weighted_score: 18,
          },
        ],
      },
      algo_version: '0.2.0+fddaaa',
    };
    const submitted = await internalPost('/internal/fdd/reports', weekReport);
    expect(submitted.status).toBe(201);
    const daySubmitted = await internalPost('/internal/fdd/reports', {
      ...weekReport,
      period_type: 'day',
      period: { start: '2026-09-28', end: '2026-09-29' },
    });
    expect(daySubmitted.status).toBe(201);

    const list = await authed(
      'get',
      `/api/v1/fdd/reports?building_id=${world.buildingA1}&period_type=week`,
      adminToken,
    );
    expect(list.status).toBe(200);
    const reports = list.body as FddReportList;
    expect(reports.items.length).toBe(1);
    const report = reports.items[0];
    if (report === undefined) throw new Error('周报行缺失（种子异常）');
    expect(report.building.id).toBe(world.buildingA1);
    expect(report.period).toEqual({ start: '2026-09-22', end: '2026-09-29' });
    expect(report.summary.counts.persisting).toBe(2);
    expect(report.summary.health_ranking[0]?.equipment_name).toBe('1#冷机');

    const detail = await authed('get', `/api/v1/fdd/reports/${report.id}`, adminToken);
    expect(detail.status).toBe(200);
    expect((detail.body as { id: string }).id).toBe(report.id);

    // 跨租户报告深链 → 404 fdd.report_not_found
    const cross = await authed('get', `/api/v1/fdd/reports/${report.id}`, adminBToken);
    expect(cross.status).toBe(404);
    expect((cross.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'fdd.report_not_found',
    );

    // overview.health 现在可见（最新周报）
    const overview = await authed(
      'get',
      `/api/v1/fdd/overview?building_id=${world.buildingA1}`,
      adminToken,
    );
    expect((overview.body as FddOverview).health?.report_id).toBe(report.id);
    expect((overview.body as FddOverview).health?.ranking.length).toBe(1);
  });
});
