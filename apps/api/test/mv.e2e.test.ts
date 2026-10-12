/**
 * M&V 域 e2e（M9-mv-report.md §14 契约测试负路径最小组 + §10 就绪链路；DAT-242）。
 *
 * PG 门控（一次性容器）+ MV_TSDB token 覆写为确定性内存 fake（telemetry/monitor
 * e2e 同款纪律——信封/路由/守卫/状态机在真实 HTTP + 真实 PG 栈上验证）。
 *
 * 覆盖（§14 最小组逐项）：
 * - 越权楼宇 404 同码同文案 ×（基线/报告/任务三族，SEC-AZ-03）；
 * - PATCH/DELETE 非 draft 409；activate 四拒（state/window/fit/overlap）+ supersede
 *   原子换代（旧 retired 新 active，非冲突 supersede 目标 422）；
 * - generate 五态：非 active 409 / 期值域 422 / 在飞合并 202 同 id / period_locked
 *   409 / 数据不足 409+缺口明细且零残留（作业不入库）；
 * - approve 重复 409；DELETE approved 409；未审批删除后可重出；
 * - 降级报告双口径并列（weather_adjusted NULL + degraded 数据位）；
 * - 导出全链路（渲染→下载 302→签名 URL 200 PDF）+ 过期 409；
 * - 白名单外参数 422；能力矩阵（viewer 生成 403 / operator 建基线 403 / 读面 200）；
 * - 全链路：建→校→激→生成→审批→导出（§10 M9-B 判据的 API 面预演）；
 * - M3 接线：approved 后 /monitor/overview saving_period_kwh 非 null（§3.7）。
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import type { LoginResponse } from '@thermio/shared-types';
import {
  E2E_ADMIN_URL,
  E2E_API_URL,
  E2E_AUTH_URL,
  E2E_READY,
  PASSWORDS,
  seedWorld,
  type SeededWorld,
} from './e2e-env.js';
import { MV_TSDB } from '../src/mv/mv.tokens.js';
import type { MvTsdbStore } from '../src/mv/mv-tsdb.repository.js';
import type { PointDayStat, WeatherDayStat } from '../src/mv/mv-calc.js';

const skipped = E2E_READY ? describe : describe.skip;

let app: INestApplication | null = null;
let world: SeededWorld;
let adminPool: pg.Pool | null = null;

/** 计量点种子（tenantA × buildingA1/buildingA2 + tenantB）。 */
interface MvSeed {
  readonly pointA1: number; // 能量点（好数据楼宇）
  readonly pointA1b: number;
  readonly pointGap: number; // 能量点（缺口楼宇——覆盖率不足）
  readonly pointNoisy: number; // 能量点（噪声大——拟合不合格）
  readonly pointTemp: number; // 非 energy 点（计量边界 422 用）
  readonly pointB: number; // 租户 B 能量点
  readonly baselineB: string; // 租户 B 已有 active 基线（越权 404 用）
}
let seed: MvSeed;

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

type Method = 'get' | 'post' | 'patch' | 'delete';

function authed(method: Method, path: string, token: string): request.Test {
  return request(requireApp().getHttpServer())
    [method](path)
    .set('Authorization', `Bearer ${token}`);
}

function postJson(path: string, token: string, body: unknown, key?: string): request.Test {
  const req = request(requireApp().getHttpServer())
    .post(path)
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', 'application/json');
  return (key === undefined ? req : req.set('Idempotency-Key', key)).send(body as object);
}

// ---------------------------------------------------------------------------
// MV_TSDB 内存 fake：确定性合成（累计表日差 + 季节度日）
// ---------------------------------------------------------------------------

/** 确定性伪随机（与 mv-calc.test 同款 mulberry32）。 */
function rng(seedValue: number): () => number {
  let a = seedValue >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STATION = 'ST-E2E-01';
/** 度日形态（与 §3.3 公式同构的小时展开）。 */
function degreeDays(dayStart: Date): { cdd: number; hdd: number } {
  const doy = Math.floor((dayStart.getTime() - Date.UTC(2026, 0, 1)) / 86_400_000);
  const tMean = 16 + 12 * Math.sin(((doy - 100) / 365) * 2 * Math.PI);
  let cdd = 0;
  let hdd = 0;
  for (let h = 0; h < 24; h += 1) {
    const tHour = tMean + 3 * Math.sin(((h - 6) / 24) * 2 * Math.PI);
    cdd += Math.max(0, tHour - 26) / 24;
    hdd += Math.max(0, 18 - tHour) / 24;
  }
  return { cdd, hdd };
}

/** 点位日增量形态：energy 相关分量 + 楼宇常数底噪（好数据 → 拟合合格）。 */
function dailyIncrement(pointId: number, dayStart: Date, mode: 'good' | 'noisy'): number {
  const { cdd, hdd } = degreeDays(dayStart);
  const weekday = dayStart.getUTCDay();
  const weekendFactor = weekday === 0 || weekday === 6 ? 0.72 : 1;
  if (mode === 'noisy') {
    // 纯随机增量：恒正（无复位缺口）、与度日无关 → CVRMSE ≈ 52%（合格线 30% 外）
    return 300 + rng(pointId * 31 + dayStart.getUTCDate())() * 6000;
  }
  const base = 3000 + 812 * cdd + 936 * hdd + (weekday === 0 || weekday === 6 ? -600 : 0);
  return base * weekendFactor + (pointId % 7);
}

/** fake 可控状态：指定点位在某日期段缺数据（覆盖率分流）/ 天气段缺失（降级分流）。 */
const gapPointDays = new Map<number, Set<string>>();
const weatherGapDays = new Set<string>();

function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (
    let ts = Date.parse(`${from}T00:00:00Z`);
    ts < Date.parse(`${to}T00:00:00Z`);
    ts += 86_400_000
  ) {
    out.push(new Date(ts).toISOString().slice(0, 10));
  }
  return out;
}

function fakePointDayStatsNow(
  pointIds: readonly number[],
  fromDate: string,
  toDate: string,
): PointDayStat[] {
  const out: PointDayStat[] = [];
  for (const pointId of pointIds) {
    const mode = pointId === seed.pointNoisy ? 'noisy' : 'good';
    let cumulative = 1_000_000 + pointId;
    for (const date of datesBetween(fromDate, toDate)) {
      const dayStart = new Date(Date.parse(`${date}T00:00:00Z`));
      const increment = dailyIncrement(pointId, dayStart, mode);
      cumulative += increment;
      const gap = gapPointDays.get(pointId)?.has(date) ?? false;
      out.push({
        point_id: pointId,
        date,
        hours: gap ? 12 : 24,
        samples: gap ? 120 : 240,
        bad_samples: 0,
        day_last: gap ? cumulative - increment * 0.5 : cumulative,
      });
    }
  }
  return out;
}

function fakePointDayStats(
  pointIds: readonly number[],
  fromDate: string,
  toDate: string,
): Promise<PointDayStat[]> {
  return Promise.resolve(fakePointDayStatsNow(pointIds, fromDate, toDate));
}

function fakeWeatherDayStats(
  stationId: string,
  fromDate: string,
  toDate: string,
): Promise<WeatherDayStat[]> {
  return Promise.resolve(fakeWeatherOut(stationId, fromDate, toDate));
}

function fakeWeatherOut(stationId: string, fromDate: string, toDate: string): WeatherDayStat[] {
  if (stationId !== STATION) return [];
  const out: WeatherDayStat[] = [];
  for (const date of datesBetween(fromDate, toDate)) {
    if (weatherGapDays.has(date)) continue; // 整日无观测
    const { cdd, hdd } = degreeDays(new Date(Date.parse(`${date}T00:00:00Z`)));
    out.push({ date, hours: 24, cdd, hdd });
  }
  return out;
}

function fakeStore(): MvTsdbStore {
  return {
    pointDayStats: fakePointDayStats,
    weatherDayStats: fakeWeatherDayStats,
    listStations: async () =>
      await Promise.resolve([
        {
          station_id: STATION,
          source: 'e2e-synthetic',
          last_obs_at: new Date().toISOString(),
          coverage_90d: 1,
        },
      ]),
    stationRecentObservation: async (stationId: string) =>
      await Promise.resolve(stationId === STATION ? new Date().toISOString() : null),
  };
}

// ---------------------------------------------------------------------------
// 种子与启动
// ---------------------------------------------------------------------------

async function bootApp(): Promise<INestApplication> {
  process.env['PG_API_URL'] = E2E_API_URL;
  process.env['PG_AUTH_URL'] = E2E_AUTH_URL;
  process.env['AUTH_JWT_SECRET'] =
    process.env['AUTH_JWT_SECRET'] ?? 'e2e-test-secret-0123456789abcdef-0123456789abcdef';
  const { Test } = await import('@nestjs/testing');
  const { AppModule } = await import('../src/app.module.js');
  const { configureApp } = await import('../src/bootstrap.js');
  const { TELEMETRY_STORE } = await import('../src/telemetry/telemetry.tokens.js');
  const emptyTelemetry = {
    latest: () => Promise.resolve(null),
    latestBatch: () => Promise.resolve(new Map()),
    listRaw: () => Promise.resolve([]),
    listAggregate: () => Promise.resolve([]),
    windowEndpoints: () => Promise.resolve(new Map()),
  };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MV_TSDB)
    .useValue(fakeStore())
    .overrideProvider(TELEMETRY_STORE)
    .useValue(emptyTelemetry)
    .compile();
  const application = moduleRef.createNestApplication();
  configureApp(application);
  await application.init();
  return application;
}

async function seedMvWorld(client: pg.PoolClient): Promise<MvSeed> {
  function firstId(result: pg.QueryResult): string {
    const row = result.rows[0] as { id: string | number } | undefined;
    if (row === undefined) throw new Error('RETURNING 未返回行（种子数据异常）');
    return String(row.id);
  }
  async function energyPoint(tenant: string, building: string, name: string): Promise<number> {
    return Number(
      firstId(
        await client.query(
          `INSERT INTO point (tenant_id, building_id, source_type, raw_name, display_name, quantity_type, unit_std)
           VALUES ($1, $2, 'virtual', $3, $3, 'energy', 'kWh') RETURNING id`,
          [tenant, building, name],
        ),
      ),
    );
  }
  const pointA1 = await energyPoint(world.tenantA, world.buildingA1, '总进线电度');
  const pointA1b = await energyPoint(world.tenantA, world.buildingA1, '冷站电度');
  const pointGap = await energyPoint(world.tenantA, world.buildingA2, '缺口电表');
  const pointNoisy = await energyPoint(world.tenantA, world.buildingA2, '噪声电表');
  const pointTemp = Number(
    firstId(
      await client.query(
        `INSERT INTO point (tenant_id, building_id, source_type, raw_name, quantity_type, unit_std)
         VALUES ($1, $2, 'virtual', '供水温度', 'chw_supply_temp', 'degC') RETURNING id`,
        [world.tenantA, world.buildingA1],
      ),
    ),
  );
  const pointB = await energyPoint(world.tenantB, world.buildingB1, 'B 楼电度');
  // 租户 B 预置 active 基线（越权三族对照）
  const baselineB = firstId(
    await client.query(
      `INSERT INTO mv_baseline (tenant_id, building_id, method, baseline_period, model_type, weather_source, status)
       VALUES ($1, $2, 'ipmvp_option_c', daterange('2026-01-01', '2026-07-01'), 'ols_daily_cdd_hdd', $3, 'active')
       RETURNING id`,
      [world.tenantB, world.buildingB1, STATION],
    ),
  );
  await client.query(
    `INSERT INTO mv_baseline_point (tenant_id, baseline_id, point_id) VALUES ($1, $2, $3)`,
    [world.tenantB, baselineB, pointB],
  );
  return { pointA1, pointA1b, pointGap, pointNoisy, pointTemp, pointB, baselineB };
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

skipped('M&V 域 e2e', () => {
  beforeAll(async () => {
    const pool = new pg.Pool({ connectionString: E2E_ADMIN_URL, max: 2 });
    adminPool = pool;
    const client = await pool.connect();
    try {
      world = await seedWorld();
      await client.query('BEGIN');
      seed = await seedMvWorld(client);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    app = await bootApp();
    adminToken = await login('admin-a@dt113.test');
    operatorToken = await login('operator-a@dt113.test');
    viewerToken = await login('viewer-a@dt113.test');
    adminBToken = await login('admin-b@dt113.test');
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await adminPool?.end();
  });

  // 契约辅助
  let goodBaselineId = ''; // 好数据基线（全链路）
  let gapBaselineId = ''; // 缺口数据基线（window_insufficient）
  let noisyBaselineId = ''; // 噪声基线（fit_unqualified）
  let overlapBaselineId = ''; // 重叠基线（overlap / supersede）
  let reportId = '';
  let degradedReportId = '';

  function createBody(
    pointIds: number[],
    building = world.buildingA1,
    period?: { start: string; end: string },
  ) {
    return {
      building_id: building,
      method: 'ipmvp_option_c',
      baseline_period: period ?? { start: '2026-01-01', end: '2026-07-01' },
      model_type: 'ols_daily_cdd_hdd',
      model_spec: {},
      metering_point_ids: pointIds,
      weather_source: STATION,
    };
  }

  it('shouldRejectUnknownQueryParams_whitelistDiscipline', async () => {
    const sort = await authed('get', '/api/v1/mv/baselines?foo=1', adminToken);
    expect(sort.status).toBe(422);
    expect((sort.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'common.validation_failed',
    );
    const badStatus = await authed('get', '/api/v1/mv/baselines?status=archived', adminToken);
    expect(badStatus.status).toBe(422);
    const reports = await authed('get', '/api/v1/mv/reports?sort=name', adminToken);
    expect(reports.status).toBe(422);
  });

  it('shouldEnforceCapabilityMatrix_onWriteSurfaces', async () => {
    const viewerCreate = await authed('post', '/api/v1/mv/baselines', viewerToken).send(
      createBody([seed.pointA1]),
    );
    expect(viewerCreate.status).toBe(403);
    const operatorCreate = await authed('post', '/api/v1/mv/baselines', operatorToken).send(
      createBody([seed.pointA1]),
    );
    expect(operatorCreate.status).toBe(403);
    const viewerGenerate = await postJson(
      '/api/v1/mv/reports/generate',
      viewerToken,
      {
        baseline_id: '0b7a8a3e-6f2c-4d1e-9a1b-3c5d7e9f0a1b',
        period: { start: '2026-07-01', end: '2026-07-31' },
      },
      'viewer-key-1',
    );
    expect(viewerGenerate.status).toBe(403);
    const viewerExport = await authed('post', '/api/v1/mv/export-jobs', viewerToken);
    expect([403, 404]).toContain(viewerExport.status);
    const read = await authed('get', '/api/v1/mv/baselines', operatorToken);
    expect(read.status).toBe(200);
    // 租户 B admin 读面正常（跨租户隔离由深链用例钉）
    const readB = await authed('get', '/api/v1/mv/baselines', adminBToken);
    expect(readB.status).toBe(200);
  });

  it('shouldRejectInvalidMeteringPoints_andUnknownStation_with422', async () => {
    const mixed = await authed('post', '/api/v1/mv/baselines', adminToken).send(
      createBody([seed.pointA1, seed.pointTemp]),
    );
    expect(mixed.status).toBe(422);
    const error = (
      mixed.body as { error: { reason_code: string; details: { offenders: unknown[] } } }
    ).error;
    expect(error.reason_code).toBe('mv.metering_points_invalid');
    expect(error.details.offenders.length).toBeGreaterThan(0);

    const crossBuilding = await authed('post', '/api/v1/mv/baselines', adminToken).send(
      createBody([seed.pointGap]),
    );
    expect(crossBuilding.status).toBe(422);

    const badStationBody = { ...createBody([seed.pointA1]), weather_source: 'ST-NOPE' };
    const badStationRes = await authed('post', '/api/v1/mv/baselines', adminToken).send(
      badStationBody,
    );
    expect(badStationRes.status).toBe(422);
    expect((badStationRes.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'mv.weather_station_invalid',
    );
  });

  it('shouldCreateBaselineWithFirstValidation_andList', async () => {
    const created = await authed('post', '/api/v1/mv/baselines', adminToken).send(
      createBody([seed.pointA1, seed.pointA1b]),
    );
    expect(created.status).toBe(201);
    const body = created.body as {
      id: string;
      status: string;
      validation_result: {
        window: { coverage: number; complete_days: number };
        fit: { qualified: boolean } | null;
      };
      model_params: { coefficients: unknown } | null;
    };
    expect(body.status).toBe('draft');
    expect(body.validation_result.window.complete_days).toBe(181);
    expect(body.validation_result.window.coverage).toBeGreaterThanOrEqual(0.9);
    expect(body.validation_result.fit?.qualified ?? false).toBe(true);
    expect(body.model_params?.coefficients).not.toBeNull();
    goodBaselineId = body.id;

    const listed = await authed('get', '/api/v1/mv/baselines?status=draft', adminToken);
    expect(listed.status).toBe(200);
    expect(
      (listed.body as { items: { id: string }[] }).items.some((item) => item.id === goodBaselineId),
    ).toBe(true);
  });

  it('shouldReturnSameCodeAndMessage_forCrossTenantDeepLinks_acrossThreeFamilies', async () => {
    const baselineCross = await authed('get', `/api/v1/mv/baselines/${seed.baselineB}`, adminToken);
    const baselineMissing = await authed(
      'get',
      '/api/v1/mv/baselines/00000000-0000-4000-8000-000000000001',
      adminToken,
    );
    expect(baselineCross.status).toBe(404);
    expect(baselineMissing.status).toBe(404);
    const crossError = (baselineCross.body as { error: { reason_code: string; message: string } })
      .error;
    const missingError = (
      baselineMissing.body as { error: { reason_code: string; message: string } }
    ).error;
    expect(crossError.reason_code).toBe(missingError.reason_code);
    expect(crossError.message).toBe(missingError.message);

    // 报告族：先在租户 B 直接落一条报告（管理面外种子——越权对照用）
    const client = await (adminPool as pg.Pool).connect();
    try {
      await client.query('BEGIN');
      const reportB = await client.query<{ id: string }>(
        `INSERT INTO mv_report (tenant_id, baseline_id, report_period, baseline_energy_kwh,
                                actual_energy_kwh, weather_adjusted_saving_kwh, requested_by)
         VALUES ($1, $2, daterange('2026-07-01', '2026-07-31'), 1000, 900, 100,
                 (SELECT id FROM app_user WHERE tenant_id = $1 AND email = 'admin-b@dt113.test'))
         RETURNING id`,
        [world.tenantB, seed.baselineB],
      );
      const jobB = await client.query<{ id: string }>(
        `INSERT INTO mv_generation_job (tenant_id, baseline_id, report_period, requested_by)
         VALUES ($1, $2, daterange('2026-07-01', '2026-07-31'),
                 (SELECT id FROM app_user WHERE tenant_id = $1 AND email = 'admin-b@dt113.test'))
         RETURNING id`,
        [world.tenantB, seed.baselineB],
      );
      await client.query('COMMIT');
      const reportCross = await authed(
        'get',
        `/api/v1/mv/reports/${String(reportB.rows[0]?.id)}`,
        adminToken,
      );
      const reportMissing = await authed(
        'get',
        '/api/v1/mv/reports/00000000-0000-4000-8000-000000000002',
        adminToken,
      );
      expect(reportCross.status).toBe(404);
      expect(reportMissing.status).toBe(404);
      const rc = (reportCross.body as { error: { reason_code: string; message: string } }).error;
      const rm = (reportMissing.body as { error: { reason_code: string; message: string } }).error;
      expect(rc.reason_code).toBe(rm.reason_code);
      expect(rc.message).toBe(rm.message);

      const jobCross = await authed(
        'get',
        `/api/v1/mv/generation-jobs/${String(jobB.rows[0]?.id)}`,
        adminToken,
      );
      const jobMissing = await authed(
        'get',
        '/api/v1/mv/generation-jobs/00000000-0000-4000-8000-000000000003',
        adminToken,
      );
      expect(jobCross.status).toBe(404);
      expect(jobMissing.status).toBe(404);
      const jc = (jobCross.body as { error: { reason_code: string; message: string } }).error;
      const jm = (jobMissing.body as { error: { reason_code: string; message: string } }).error;
      expect(jc.reason_code).toBe(jm.reason_code);
      expect(jc.message).toBe(jm.message);
    } finally {
      client.release();
    }
  });

  it('shouldRejectActivateOnWindowInsufficient_withGapDetails', async () => {
    // 缺口楼宇：7 月 12 天缺数据 → 覆盖率 170/182 < 90%（缺口段进 details）
    const gapDays = new Set<string>();
    for (const date of datesBetween('2026-06-01', '2026-06-26')) gapDays.add(date);
    gapPointDays.set(seed.pointGap, gapDays);
    const created = await authed('post', '/api/v1/mv/baselines', adminToken).send(
      createBody([seed.pointGap], world.buildingA2),
    );
    expect(created.status).toBe(201);
    gapBaselineId = (created.body as { id: string }).id;
    const activated = await authed(
      'post',
      `/api/v1/mv/baselines/${gapBaselineId}/activate`,
      adminToken,
    ).send({});
    expect(activated.status).toBe(409);
    const error = activated.body as {
      error: { reason_code: string; details: { window: { gaps: unknown[] } } };
    };
    expect(error.error.reason_code).toBe('mv.window_insufficient');
    expect(error.error.details.window.gaps.length).toBeGreaterThan(0);
  });

  it('shouldRejectActivateOnFitUnqualified_withMetrics', async () => {
    const created = await authed('post', '/api/v1/mv/baselines', adminToken).send(
      createBody([seed.pointNoisy], world.buildingA2),
    );
    expect(created.status).toBe(201);
    noisyBaselineId = (created.body as { id: string }).id;
    const activated = await authed(
      'post',
      `/api/v1/mv/baselines/${noisyBaselineId}/activate`,
      adminToken,
    ).send({});
    expect(activated.status).toBe(409);
    const error = activated.body as {
      error: { reason_code: string; details: { metrics: { cvrmse_pct: number } | null } };
    };
    expect(error.error.reason_code).toBe('mv.fit_unqualified');
    if (error.error.details.metrics !== null) {
      expect(error.error.details.metrics.cvrmse_pct).toBeGreaterThan(30);
    }
  });

  it('shouldRejectGenerateOnNonActiveBaseline_andPeriodDomain_andMissingKey', async () => {
    const nonActive = await postJson(
      '/api/v1/mv/reports/generate',
      adminToken,
      { baseline_id: gapBaselineId, period: { start: '2026-07-01', end: '2026-07-31' } },
      'key-nonactive-1',
    );
    expect(nonActive.status).toBe(409);
    expect((nonActive.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'mv.baseline_not_active',
    );

    // Idempotency-Key 缺失 → 422
    const noKey = await authed('post', '/api/v1/mv/reports/generate', adminToken).send({
      baseline_id: seed.baselineB,
      period: { start: '2026-07-01', end: '2026-07-31' },
    });
    expect(noKey.status).toBe(422);
  });

  it('shouldActivateBaseline_thenRejectPatchAndDelete_onNonDraft', async () => {
    const activated = await authed(
      'post',
      `/api/v1/mv/baselines/${goodBaselineId}/activate`,
      adminToken,
    ).send({});
    expect(activated.status).toBe(200);
    expect((activated.body as { status: string }).status).toBe('active');

    const patched = await authed(
      'patch',
      `/api/v1/mv/baselines/${goodBaselineId}`,
      adminToken,
    ).send({
      weather_source: STATION,
    });
    expect(patched.status).toBe(409);
    expect((patched.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'mv.baseline_state_invalid',
    );

    const deleted = await authed('delete', `/api/v1/mv/baselines/${goodBaselineId}`, adminToken);
    expect(deleted.status).toBe(409);

    // 状态重激活 → 409（state 拒）
    const reactivated = await authed(
      'post',
      `/api/v1/mv/baselines/${goodBaselineId}/activate`,
      adminToken,
    ).send({});
    expect(reactivated.status).toBe(409);
  });

  it('shouldGenerateReport_andPollJob_andApprove_thenLockPeriod', async () => {
    // 期值域 422（active 基线上）：期止非已完成日 / 期起早于基线期止 / 长度越界
    const future = await postJson(
      '/api/v1/mv/reports/generate',
      adminToken,
      { baseline_id: goodBaselineId, period: { start: '2026-07-01', end: '2999-01-01' } },
      'key-future-1',
    );
    expect(future.status).toBe(422);
    expect((future.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'mv.period_invalid',
    );
    const beforeBaselineEnd = await postJson(
      '/api/v1/mv/reports/generate',
      adminToken,
      { baseline_id: goodBaselineId, period: { start: '2026-06-15', end: '2026-07-15' } },
      'key-early-1',
    );
    expect(beforeBaselineEnd.status).toBe(422);
    expect((beforeBaselineEnd.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'mv.period_invalid',
    );

    const generated = await postJson(
      '/api/v1/mv/reports/generate',
      operatorToken,
      { baseline_id: goodBaselineId, period: { start: '2026-07-01', end: '2026-07-31' } },
      'key-gen-1',
    );
    expect(generated.status).toBe(202);
    const job = generated.body as { job_id: string; status: string };
    expect(job.status).toBe('queued');

    // 轮询至收敛（§10 全链预演：生成 → 审批 → 导出）
    let reportIdLocal = '';
    for (let i = 0; i < 40; i += 1) {
      const detail = await authed('get', `/api/v1/mv/generation-jobs/${job.job_id}`, operatorToken);
      expect(detail.status).toBe(200);
      const body = detail.body as {
        status: string;
        report_id: string | null;
        failure?: { code: string } | null;
      };
      if (body.status === 'succeeded' && body.report_id !== null) {
        reportIdLocal = body.report_id;
        break;
      }
      if (body.status === 'failed') throw new Error(`生成失败：${JSON.stringify(body.failure)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(reportIdLocal).not.toBe('');
    reportId = reportIdLocal;

    const report = await authed('get', `/api/v1/mv/reports/${reportId}`, viewerToken);
    expect(report.status).toBe(200);
    const detail = report.body as {
      status: string;
      degraded: boolean;
      weather_adjusted_saving_kwh: number | null;
      raw_saving_kwh: number;
      series: { date: string; actual_kwh: number | null }[];
      report_no: string;
      imputed_days: number;
    };
    expect(detail.status).toBe('pending_approval');
    expect(detail.degraded).toBe(false);
    expect(detail.weather_adjusted_saving_kwh).not.toBeNull();
    expect(detail.series).toHaveLength(30); // [07-01, 07-31) 半开
    expect(detail.report_no).toMatch(/^MV-.+-2026-07-01-2026-07-31-/);

    // operator 无审批能力（SEC-AZ-05）→ 403；admin 审批 → 锁定
    const operatorApprove = await authed(
      'post',
      `/api/v1/mv/reports/${reportId}/approve`,
      operatorToken,
    );
    expect(operatorApprove.status).toBe(403);
    const approved = await authed('post', `/api/v1/mv/reports/${reportId}/approve`, adminToken);
    expect(approved.status).toBe(200);
    expect((approved.body as { approved_at: string }).approved_at).not.toBeNull();

    // 重复 approve → 409；DELETE approved → 409；同（基线×期）再生成 → period_locked
    const reApprove = await authed('post', `/api/v1/mv/reports/${reportId}/approve`, adminToken);
    expect(reApprove.status).toBe(409);
    const deleteApproved = await authed('delete', `/api/v1/mv/reports/${reportId}`, adminToken);
    expect(deleteApproved.status).toBe(409);
    const locked = await postJson(
      '/api/v1/mv/reports/generate',
      adminToken,
      { baseline_id: goodBaselineId, period: { start: '2026-07-01', end: '2026-07-31' } },
      'key-gen-locked',
    );
    expect(locked.status).toBe(409);
    expect(
      (locked.body as { error: { reason_code: string; details: { report_id: string } } }).error
        .details.report_id,
    ).toBe(reportId);

    // M3 接线（§3.7）：approved 后楼宇 KPI saving_period_kwh 非 null
    const overview = await authed(
      'get',
      `/api/v1/monitor/overview?building_id=${world.buildingA1}`,
      adminToken,
    );
    expect(overview.status).toBe(200);
    expect(
      (overview.body as { kpi: { saving_period_kwh: number | null } }).kpi.saving_period_kwh,
    ).not.toBeNull();
  });

  it('shouldMergeInFlightGeneration_sameJobId', async () => {
    // 预置 queued 任务行（库级在飞守卫的合并语义：后到 202 同 id）
    const client = await (adminPool as pg.Pool).connect();
    let queuedJobId = '';
    try {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO mv_generation_job (tenant_id, baseline_id, report_period, requested_by)
         VALUES ($1, $2, daterange('2026-07-05', '2026-08-05'),
                 (SELECT id FROM app_user WHERE tenant_id = $1 AND email = 'admin-a@dt113.test'))
         RETURNING id`,
        [world.tenantA, goodBaselineId],
      );
      queuedJobId = String(inserted.rows[0]?.id);
    } finally {
      client.release();
    }
    const merged = await postJson(
      '/api/v1/mv/reports/generate',
      adminToken,
      { baseline_id: goodBaselineId, period: { start: '2026-07-05', end: '2026-08-05' } },
      'key-merge-1',
    );
    expect(merged.status).toBe(202);
    expect((merged.body as { job_id: string }).job_id).toBe(queuedJobId);
  });

  it('shouldRejectInsufficientPeriodData_withGapDetails_andZeroResidue', async () => {
    // 报告期大缺口（>10%）→ 同步前置拒绝：作业不入库、零报告行（9 月窗避开 merge 遗留任务）
    const gapDays = new Set<string>();
    for (const date of datesBetween('2026-09-08', '2026-09-23')) gapDays.add(date);
    gapPointDays.set(seed.pointA1, gapDays);
    try {
      const rejected = await postJson(
        '/api/v1/mv/reports/generate',
        adminToken,
        { baseline_id: goodBaselineId, period: { start: '2026-09-01', end: '2026-09-30' } },
        'key-insufficient-1',
      );
      expect(rejected.status).toBe(409);
      const error = rejected.body as {
        error: { reason_code: string; details: { coverage: number; gaps: { from: string }[] } };
      };
      expect(error.error.reason_code).toBe('mv.period_data_insufficient');
      expect(error.error.details.coverage).toBeLessThan(0.9);
      expect(error.error.details.gaps.length).toBeGreaterThan(0);
    } finally {
      gapPointDays.delete(seed.pointA1);
    }
  });

  it('shouldGenerateDegradedReport_whenWeatherMissing_dualCaliberSideBySide', async () => {
    // 8 月拔掉 2 天天气（29/31 = 93.5% < 95%）→ 降级：口径 B/CID NULL、口径 A 恒出
    for (const date of datesBetween('2026-08-03', '2026-08-05')) weatherGapDays.add(date);
    try {
      const generated = await postJson(
        '/api/v1/mv/reports/generate',
        adminToken,
        { baseline_id: goodBaselineId, period: { start: '2026-08-01', end: '2026-08-31' } },
        'key-degraded-1',
      );
      expect(generated.status).toBe(202);
      const job = generated.body as { job_id: string };
      let degradedId = '';
      for (let i = 0; i < 40; i += 1) {
        const detail = await authed('get', `/api/v1/mv/generation-jobs/${job.job_id}`, adminToken);
        const body = detail.body as { status: string; report_id: string | null };
        if (body.status === 'succeeded' && body.report_id !== null) {
          degradedId = body.report_id;
          break;
        }
        if (body.status === 'failed') throw new Error('降级生成分支意外失败');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(degradedId).not.toBe('');
      degradedReportId = degradedId;
      const report = await authed('get', `/api/v1/mv/reports/${degradedReportId}`, adminToken);
      const detail = report.body as {
        degraded: boolean;
        weather_adjusted_saving_kwh: number | null;
        confidence_interval: { uncertainty_high: boolean } | null;
        raw_saving_kwh: number;
      };
      expect(detail.degraded).toBe(true);
      expect(detail.weather_adjusted_saving_kwh).toBeNull();
      expect(detail.confidence_interval).toBeNull();
      expect(Number.isFinite(detail.raw_saving_kwh)).toBe(true);

      // 列表筛选 degraded=true 命中
      const listed = await authed('get', '/api/v1/mv/reports?degraded=true', adminToken);
      const items = (listed.body as { items: { id: string }[] }).items;
      expect(items.some((item) => item.id === degradedReportId)).toBe(true);

      // 未审批删除 → 可重出（204 后详情 404）
      const deleted = await authed('delete', `/api/v1/mv/reports/${degradedReportId}`, adminToken);
      expect(deleted.status).toBe(204);
      const gone = await authed('get', `/api/v1/mv/reports/${degradedReportId}`, adminToken);
      expect(gone.status).toBe(404);
    } finally {
      weatherGapDays.clear();
    }
  });

  it('shouldExportReport_fullChain_with302SignedUrl_andExpireGuard', async () => {
    const created = await authed('post', `/api/v1/mv/reports/${reportId}/export`, operatorToken);
    expect(created.status).toBe(202);
    const exportJob = created.body as { export_job_id: string };

    let fileBytes = 0;
    let downloadUrl = '';
    for (let i = 0; i < 40; i += 1) {
      const detail = await authed(
        'get',
        `/api/v1/mv/export-jobs/${exportJob.export_job_id}`,
        operatorToken,
      );
      const body = detail.body as { status: string; file_bytes: number | null; failure: unknown };
      if (body.status === 'succeeded') {
        fileBytes = body.file_bytes ?? 0;
        break;
      }
      if (body.status === 'failed') throw new Error(`导出失败：${JSON.stringify(body.failure)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(fileBytes).toBeGreaterThan(10_000); // 内置 CJK 字体 PDF

    // 302 签名 URL → 无 Authorization 跟随可得 PDF
    const download = await authed(
      'get',
      `/api/v1/mv/export-jobs/${exportJob.export_job_id}/download`,
      operatorToken,
    );
    expect(download.status).toBe(302);
    downloadUrl = (download.headers as { location: string }).location;
    expect(downloadUrl).toContain('/api/v1/mv/exports/');
    expect(downloadUrl).toContain('sig=');
    const signedPath = new URL(downloadUrl).pathname + new URL(downloadUrl).search;
    const signed = await request(requireApp().getHttpServer()).get(signedPath);
    expect(signed.status).toBe(200);
    expect((signed.headers as { 'content-type': string })['content-type']).toBe('application/pdf');

    // 签名破坏 → 404（不泄露存在性）
    const tampered = await request(requireApp().getHttpServer()).get(`${signedPath}x`);
    expect([404, 400]).toContain(tampered.status);

    // 过期：expires_at 置过去 → 409 mv.export_file_expired
    const client = await (adminPool as pg.Pool).connect();
    try {
      await client.query(
        `UPDATE export_job SET expires_at = now() - INTERVAL '1 day' WHERE id = $1`,
        [exportJob.export_job_id],
      );
    } finally {
      client.release();
    }
    const expired = await authed(
      'get',
      `/api/v1/mv/export-jobs/${exportJob.export_job_id}/download`,
      operatorToken,
    );
    expect(expired.status).toBe(409);
    expect((expired.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'mv.export_file_expired',
    );

    // 列表白名单外参数 → 422
    const badList = await authed('get', '/api/v1/mv/export-jobs?foo=1', operatorToken);
    expect(badList.status).toBe(422);
  });

  it('shouldRejectActivateOnOverlap_andSupersedeAtomically', async () => {
    // 重叠 draft（期 2026-03-01..2026-09-01，与 active 基线重叠）
    const created = await authed('post', '/api/v1/mv/baselines', adminToken).send(
      createBody([seed.pointA1, seed.pointA1b], world.buildingA1, {
        start: '2026-03-01',
        end: '2026-09-01',
      }),
    );
    expect(created.status).toBe(201);
    overlapBaselineId = (created.body as { id: string }).id;

    const rejected = await authed(
      'post',
      `/api/v1/mv/baselines/${overlapBaselineId}/activate`,
      adminToken,
    ).send({});
    expect(rejected.status).toBe(409);
    const error = rejected.body as {
      error: { reason_code: string; details: { conflicts: string[]; cause: string } };
    };
    expect(error.error.reason_code).toBe('mv.baseline_overlap');
    expect(error.error.details.conflicts).toContain(goodBaselineId);

    // 非冲突 supersede 目标 → 422
    const badSupersede = await authed(
      'post',
      `/api/v1/mv/baselines/${overlapBaselineId}/activate`,
      adminToken,
    ).send({
      supersede: seed.baselineB,
    });
    expect(badSupersede.status).toBe(422);

    // supersede 原子换代：旧 → retired，新 → active
    const superseded = await authed(
      'post',
      `/api/v1/mv/baselines/${overlapBaselineId}/activate`,
      adminToken,
    ).send({
      supersede: goodBaselineId,
    });
    expect(superseded.status).toBe(200);
    expect((superseded.body as { superseded: string[] }).superseded).toEqual([goodBaselineId]);
    const oldDetail = await authed('get', `/api/v1/mv/baselines/${goodBaselineId}`, adminToken);
    expect((oldDetail.body as { status: string }).status).toBe('retired');
    const newDetail = await authed('get', `/api/v1/mv/baselines/${overlapBaselineId}`, adminToken);
    expect((newDetail.body as { status: string }).status).toBe('active');

    // retired 终态：被替代方不可复激活（draft → active 唯一入路口，§4.1）
    const reactivatedRetired = await authed(
      'post',
      `/api/v1/mv/baselines/${goodBaselineId}/activate`,
      adminToken,
    ).send({});
    expect(reactivatedRetired.status).toBe(409);
    expect((reactivatedRetired.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'mv.baseline_state_invalid',
    );
  });

  it('shouldListWeatherStations_forSelector', async () => {
    const stations = await authed('get', '/api/v1/mv/weather-stations', operatorToken);
    expect(stations.status).toBe(200);
    const items = (stations.body as { items: { station_id: string; coverage_90d: number }[] })
      .items;
    expect(items.some((item) => item.station_id === STATION)).toBe(true);
  });
});
