/**
 * M11 kpi 域 e2e（M11-kpi-dashboard.md §5.9 契约测试矩阵；IMPL-22 / DAT-246）。
 *
 * PG 门控（一次性容器）+ KPI_TSDB/KPI_PDF_RENDERER/KPI_MAILER token 覆写为确定性
 * fake（mv.e2e 的 MV_TSDB 覆写同款纪律——信封/路由/守卫/状态机在真实 HTTP + 真实
 * PG 栈上验证；puppeteer/SMTP 外部依赖不进 e2e）。
 *
 * 覆盖（§5.9 矩阵逐项）：
 * - #2 viewer 深链他人楼宇 overview → 404 asset.not_found 同文案；
 * - #3 viewer export/digest PUT → 403；operator digest PUT → 403（能力矩阵）；
 * - #4 跨度 800 天 / hour+30 天 / group_by=foo → 422 kpi.range_invalid + details 字段；
 * - #5 表计清零序列 → reset 桶不计入 + 重置点重差分；
 * - #6 缺数段 → total null 不插值 + coverage 判据；
 * - #7 无基准 → missing；fixed 配置后 → ok + source_label（AC-8 双向）；
 * - #8 导出全链：202 → succeeded → 302 签名 URL → PDF 200 → 过期 409；
 * - #9 限流双层：租户在飞第 3 个 429 / 楼宇每小时第 21 次 429；
 * - #10 非本人任务详情/下载 → 404（admin 亦然，§5.6 只看本人定夺）；
 * - #11 digest PUT 坏邮箱/21 人 → 422 digest.recipient_invalid（details 序号）；
 * - #12 订阅投递：模拟时钟周一 08:00 → sent；无报告楼 skipped + no_report；
 *   SMTP 不可达注入 → failed（报告本体不受影响）；重跑 tick 不插行；
 * - #13 无 energy 点位楼宇 → 200 空集 linked=false；
 * - RLS：B 租户不见 A 租户投递/导出任务（沿 tenant-rls 模式）。
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
import { KPI_MAILER, KPI_PDF_RENDERER, KPI_TSDB } from '../src/kpi/kpi.tokens.js';
import type { KpiTsdbStore } from '../src/kpi/kpi-tsdb.repository.js';
import type { FddPdfRenderer } from '../src/kpi/kpi-fdd-pdf.js';
import type { DigestMailer } from '../src/kpi/kpi-mailer.js';
import { KpiDigestService } from '../src/kpi/kpi-digest.service.js';

const skipped = E2E_READY ? describe : describe.skip;

let app: INestApplication | null = null;
let world: SeededWorld;
let adminPool: pg.Pool | null = null;

interface KpiSeed {
  readonly pointGood: number; // A1 干净累计表（ok 全桶）
  readonly pointReset: number; // A1 含表计清零（reset 桶 + 重置点重差分）
  readonly pointUncertain: number; // A1 每桶带坏样（uncertain 计入）
  readonly pointGap: number; // A1 周期缺桶（gap 不插值）
  readonly pointUnclassified: number; // A1 未挂设备（unclassified 末位）
  readonly pointB: number; // B 楼能量点
}
let seed: KpiSeed;

let adminToken: string;
let operatorToken: string;
let viewerToken: string;
let adminBToken: string;

// ---------------------------------------------------------------------------
// fakes：TSDB 确定性合成 / PDF 渲染 / SMTP
// ---------------------------------------------------------------------------

/** 合成窗锚点（UTC 整点；reset 发生在窗内第 5 桶）。 */
const WIN_FROM = Date.UTC(2026, 9, 8, 0); // 2026-10-08T00:00Z
const WIN_TO = Date.UTC(2026, 9, 10, 0); // 48h 窗
const HOUR = 3_600_000;

function fakeHourRows(
  pointIds: readonly number[],
  from: Date,
  to: Date,
): ReturnType<KpiTsdbStore['hourRows']> {
  const rows: {
    point_id: number;
    bucket: Date;
    last: number | null;
    bad_count: number;
  }[] = [];
  for (const pointId of pointIds) {
    for (let t = from.getTime(); t < to.getTime(); t += HOUR) {
      const bucketIndex = Math.floor((t - WIN_FROM) / HOUR);
      if (pointId === seed.pointGap && bucketIndex % 3 === 2) continue; // 周期缺桶
      let last: number | null = 100_000 + bucketIndex * 12;
      if (pointId === seed.pointReset && t === Date.UTC(2026, 9, 8, 5)) {
        last = 500; // 表计清零（窗内第 5 桶 reset）
      } else if (pointId === seed.pointReset && bucketIndex > 5) {
        last = 500 + (bucketIndex - 5) * 12; // 从重置点重新走字
      }
      rows.push({
        point_id: pointId,
        bucket: new Date(t),
        last,
        bad_count: pointId === seed.pointUncertain ? 2 : 0,
      });
    }
  }
  return Promise.resolve(rows);
}

function fakeTsdb(): KpiTsdbStore {
  return { hourRows: fakeHourRows };
}

/** 渲染 fake：确定性 PDF 头（%PDF-1.x magic，非空即合法载荷）。 */
function fakeRenderer(): FddPdfRenderer {
  return {
    render(input) {
      const text = new TextEncoder().encode(
        `%PDF-1.4 fdd-report:${input.report.id} export:${input.exportNo}`,
      );
      return Promise.resolve(
        new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, ...text]),
      );
    },
  };
}

/** SMTP fake：可切换成功/不可达（投递失败注入）。 */
function fakeMailer(): DigestMailer & { failMode: boolean; sentCount: () => number } {
  let sent = 0;
  const state = { failMode: false };
  return {
    get failMode() {
      return state.failMode;
    },
    set failMode(value: boolean) {
      state.failMode = value;
    },
    sentCount: () => sent,
    send() {
      if (state.failMode) {
        return Promise.resolve({
          kind: 'failed',
          failure_msg: 'connect ECONNREFUSED (relay 不可达注入)',
        } as const);
      }
      sent += 1;
      return Promise.resolve({ kind: 'sent', delivered_at: new Date().toISOString() } as const);
    },
  };
}

let mailerFake: ReturnType<typeof fakeMailer>;

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
    .overrideProvider(KPI_TSDB)
    .useValue(fakeTsdb())
    .overrideProvider(KPI_PDF_RENDERER)
    .useValue(fakeRenderer())
    .overrideProvider(KPI_MAILER)
    .useValue(mailerFake)
    .overrideProvider(TELEMETRY_STORE)
    .useValue(emptyTelemetry)
    .compile();
  const application = moduleRef.createNestApplication();
  configureApp(application);
  await application.init();
  return application;
}

/** 测试内 app 一定已启动。 */
function digestService(): KpiDigestService {
  if (app === null) throw new Error('app 未启动');
  return app.get(KpiDigestService);
}

/** 测试内 adminPool 一定已连接。 */
function pool(): pg.Pool {
  if (adminPool === null) throw new Error('adminPool 未连接');
  return adminPool;
}

function passwordFor(email: string): string {
  if (email.startsWith('operator')) return PASSWORDS.operator;
  if (email.startsWith('viewer')) return PASSWORDS.viewer;
  return PASSWORDS.admin;
}

async function login(email: string): Promise<string> {
  const response = await request(http())
    .post('/api/v1/auth/login')
    .send({ email, password: passwordFor(email) });
  expect(response.status).toBe(200);
  return (response.body as LoginResponse).access_token;
}

type Method = 'get' | 'post' | 'put';

/** 测试内 app 一定已启动（beforeAll 完成后才进入用例）。 */
function http(): ReturnType<INestApplication['getHttpServer']> {
  if (app === null) throw new Error('app 未启动');
  return app.getHttpServer();
}

function authed(method: Method, path: string, token: string): request.Test {
  return request(http())[method](path).set('Authorization', `Bearer ${token}`);
}

const FROM = new Date(WIN_FROM).toISOString();
const TO = new Date(WIN_TO).toISOString();

async function seedKpiWorld(client: pg.PoolClient): Promise<KpiSeed> {
  function firstId(result: pg.QueryResult): string {
    const row = result.rows[0] as { id: string | number } | undefined;
    if (row === undefined) throw new Error('RETURNING 未返回行（种子数据异常）');
    return String(row.id);
  }
  async function energyPoint(
    tenant: string,
    building: string,
    name: string,
    equipment: string | null,
  ): Promise<number> {
    return Number(
      firstId(
        await client.query(
          `INSERT INTO point (tenant_id, building_id, source_type, raw_name, display_name,
                              quantity_type, unit_std, equipment_id)
           VALUES ($1, $2, 'virtual', $3, $3, 'energy', 'kWh', $4::uuid) RETURNING id`,
          [tenant, building, name, equipment],
        ),
      ),
    );
  }
  // A1 两系统（chilled_water/ahu）各一设备 + 未分类点
  const sysChw = firstId(
    await client.query(
      `INSERT INTO hvac_system (tenant_id, building_id, name, system_type)
       VALUES ($1, $2, '冷站', 'chilled_water') RETURNING id`,
      [world.tenantA, world.buildingA1],
    ),
  );
  const sysAhu = firstId(
    await client.query(
      `INSERT INTO hvac_system (tenant_id, building_id, name, system_type)
       VALUES ($1, $2, '空调', 'ahu') RETURNING id`,
      [world.tenantA, world.buildingA1],
    ),
  );
  const eqChiller = firstId(
    await client.query(
      `INSERT INTO equipment (tenant_id, system_id, equipment_type, name)
       VALUES ($1, $2, 'chiller', '1# 冷机') RETURNING id`,
      [world.tenantA, sysChw],
    ),
  );
  const eqAhu = firstId(
    await client.query(
      `INSERT INTO equipment (tenant_id, system_id, equipment_type, name)
       VALUES ($1, $2, 'ahu', 'F1 AHU') RETURNING id`,
      [world.tenantA, sysAhu],
    ),
  );
  const pointGood = await energyPoint(world.tenantA, world.buildingA1, '总进线电度', eqChiller);
  const pointReset = await energyPoint(world.tenantA, world.buildingA1, '清零电表', eqChiller);
  const pointUncertain = await energyPoint(world.tenantA, world.buildingA1, '坏样电表', eqAhu);
  const pointGap = await energyPoint(world.tenantA, world.buildingA1, '缺数电表', eqAhu);
  const pointUnclassified = await energyPoint(
    world.tenantA,
    world.buildingA1,
    '未挂设备电表',
    null,
  );
  const pointB = await energyPoint(world.tenantB, world.buildingB1, 'B 楼电度', null);

  // A1 面积（eui 卡）；A2 无面积
  await client.query(`UPDATE building SET gross_area_m2 = 10000 WHERE id = $1`, [world.buildingA1]);

  // S1 采样：2 approved + 1 rejected（窗口内决策）+ 1 expired（窗口内过期）
  const pointForProposal = pointGood;
  for (const [status, decidedAt] of [
    ['approved', '2026-10-09T02:00:00Z'],
    ['approved', '2026-10-09T03:00:00Z'],
    ['rejected', '2026-10-09T04:00:00Z'],
  ] as const) {
    await client.query(
      `INSERT INTO proposal (tenant_id, algo, algo_version, equipment_id, point_id, action,
                             rationale, status, decided_by, decided_at)
       VALUES ($1, 'optimizer', 'e2e', $2, $3, '{}', 'e2e 采样', $4, $5, $6::timestamptz)`,
      [world.tenantA, eqChiller, pointForProposal, status, world.adminA, decidedAt],
    );
  }
  await client.query(
    `INSERT INTO proposal (tenant_id, algo, algo_version, equipment_id, point_id, action,
                           rationale, status, expires_at)
     VALUES ($1, 'optimizer', 'e2e', $2, $3, '{}', 'e2e 过期采样', 'expired',
             '2026-10-09T12:00:00Z'::timestamptz)`,
    [world.tenantA, eqChiller, pointForProposal],
  );

  // S3 采样：4 已抽检（3 confirmed）+ 1 未抽检（7×24h 滚动窗内新增）
  // rule_key 逐条不同（fdd_finding_active_uidx：同设备同规则活跃唯一）
  let findingSeq = 0;
  for (const review of ['confirmed', 'confirmed', 'confirmed', 'false_positive', null]) {
    findingSeq += 1;
    await client.query(
      `INSERT INTO fdd_finding (tenant_id, equipment_id, rule_key, severity, title, evidence,
                                algo_version, first_detected_at, last_detected_at,
                                review_result, reviewed_at, reviewed_by)
       VALUES ($1, $2, $3, 'minor', 'e2e 发现', '{}', 'e2e',
               now() - INTERVAL '2 days', now() - INTERVAL '2 days',
               $4, ${review === null ? 'NULL' : 'now()'}, ${review === null ? 'NULL' : '$5'}::uuid)`,
      review === null
        ? [world.tenantA, eqChiller, `e2e_rule_${String(findingSeq)}`, null]
        : [world.tenantA, eqChiller, `e2e_rule_${String(findingSeq)}`, review, world.operatorA],
    );
  }

  // digest 种子：A1 有 [10-05,10-12) 周报；A2 无报告（skipped 注入）；B1 有报告（RLS 对照）
  const summary = JSON.stringify({
    counts: { new: 3, resolved: 1, persisting: 2 },
    new_by_severity: { info: 1, warning: 1, minor: 1, major: 0, critical: 0 },
    open_by_severity: { info: 1, warning: 0, minor: 1, major: 0, critical: 0 },
    health_ranking: [
      {
        equipment_id: eqChiller,
        equipment_name: '1# 冷机',
        equipment_type: 'chiller',
        open_count: 2,
        weighted_score: 5,
      },
    ],
  });
  for (const [tenant, building] of [
    [world.tenantA, world.buildingA1],
    [world.tenantB, world.buildingB1],
  ] as const) {
    await client.query(
      `INSERT INTO fdd_report (tenant_id, building_id, period_type, period, summary, generated_at, algo_version)
       VALUES ($1, $2, 'week', daterange('2026-10-05', '2026-10-12'), $3::jsonb, now(), 'e2e')`,
      [tenant, building, summary],
    );
  }
  return { pointGood, pointReset, pointUncertain, pointGap, pointUnclassified, pointB };
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

skipped('M11 kpi 域 e2e（§5.9 契约矩阵）', () => {
  beforeAll(async () => {
    mailerFake = fakeMailer();
    const pool = new pg.Pool({ connectionString: E2E_ADMIN_URL, max: 2 });
    adminPool = pool;
    const client = await pool.connect();
    try {
      world = await seedWorld();
      await client.query('BEGIN');
      seed = await seedKpiWorld(client);
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

  // ── #2 越楼宇深链 404 同文案（SEC-AZ-03） ──
  it('shouldReturnSame404_whenViewerDeepLinksOthersBuilding', async () => {
    const outOfScope = await authed(
      'get',
      `/api/v1/kpi/overview?building_id=${world.buildingA2}&from=${FROM}&to=${TO}`,
      viewerToken,
    );
    const nonexistent = await authed(
      'get',
      `/api/v1/kpi/overview?building_id=${crypto.randomUUID()}&from=${FROM}&to=${TO}`,
      viewerToken,
    );
    expect(outOfScope.status).toBe(404);
    expect(nonexistent.status).toBe(404);
    expect((outOfScope.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'asset.not_found',
    );
    expect((nonexistent.body as { error: { message: string } }).error.message).toBe(
      (outOfScope.body as { error: { message: string } }).error.message,
    );
  });

  // ── #5/#6/#13 看板三端点口径（合成遥测：reset/gap/uncertain/空集） ──
  it('shouldJudgeBuckets_andExcludeResetFromTotals（用例 5/6）', async () => {
    const response = await authed(
      'get',
      `/api/v1/kpi/energy/trend?building_id=${world.buildingA1}&from=${FROM}&to=${TO}&group_by=system_type`,
      adminToken,
    );
    expect(response.status).toBe(200);
    const trend = response.body as {
      interval: string;
      buckets: { bucket: string; total_kwh: number | null; status: string; partial: boolean }[];
      coverage: number;
      benchmark: { status: string };
    };
    expect(trend.interval).toBe('hour');
    expect(trend.benchmark.status).toBe('missing'); // #7 前半：无基准配置
    expect(trend.buckets).toHaveLength(48);
    const resetBucket = trend.buckets.find((b) => b.bucket === '2026-10-08T05:00:00.000Z');
    expect(resetBucket?.status).toBe('reset'); // 表计清零桶（图表标记）
    // 清零点位本桶不计入：total = 其余三路贡献 36（对照桶 6 全点位 60，差 12+12）
    expect(resetBucket?.total_kwh).toBe(36);
    const nextBucket = trend.buckets.find((b) => b.bucket === '2026-10-08T06:00:00.000Z');
    // 坏样点位每桶带 bad_count → 楼宇级标注 uncertain（值计入，§2.2 判据表）。
    // 总量 72 = 四路 12 + 缺数点位 24（LAG 差分跨缺失桶——累计表走字并入下一可用桶，
    // 缺失桶本身 null 不插值，§2.2 SQL 语义）
    expect(nextBucket?.status).toBe('uncertain');
    expect(nextBucket?.total_kwh).toBe(72);
    // 缺数点位每第 3 桶缺：该桶其余点位仍有值 → 非 gap；独立校验 gap 桶 via 合计点位面
    const gapCheck = await authed(
      'get',
      `/api/v1/kpi/energy/trend?building_id=${world.buildingA1}&from=${FROM}&to=${TO}&group_by=none`,
      viewerToken,
    );
    expect(gapCheck.status).toBe(200);
    const noneGrouped = gapCheck.body as typeof trend;
    // 48 桶中 ok/uncertain/reset 桶均有值；无插值（不存在「gap 但 total 非 null」的桶）
    for (const bucket of noneGrouped.buckets) {
      if (bucket.total_kwh === null) expect(bucket.status).toBe('gap');
    }
    expect(noneGrouped.coverage).toBeGreaterThan(0);
    expect(noneGrouped.coverage).toBeLessThanOrEqual(1);
  });

  it('shouldReportResetRebase_inPointLevelTotals（reset 后从重置点差分）', async () => {
    // 结构端点窗口级：清零点位 reset 桶不计入但后续桶从 500 重新累计（合成数据
    // 保证 reset 后每桶 +12）；总量 < 无 reset 平行世界 —— 以 overview 总量非空断言
    const response = await authed(
      'get',
      `/api/v1/kpi/overview?building_id=${world.buildingA1}&from=${FROM}&to=${TO}`,
      operatorToken,
    );
    expect(response.status).toBe(200);
    const overview = response.body as {
      energy: {
        total_kwh: number | null;
        coverage: number;
        eui_kwh_m2: number | null;
        linked: boolean;
      };
      proposal_acceptance: {
        rate: number | null;
        decided: number;
        expired: number;
        unavailable: boolean;
      };
      fdd_hit_rate: { hit_rate: number | null; reviewed: number; confirmed: number };
      saving: { kwh: number | null; linked: boolean };
      freshness: { includes_realtime: boolean; data_as_of: string };
    };
    expect(overview.energy.linked).toBe(true);
    expect(overview.energy.total_kwh).not.toBeNull();
    expect(overview.energy.eui_kwh_m2).not.toBeNull(); // A1 有面积 10000 m²
    // S1：2 approved ÷ 3 decided = 0.667；expired 单独观测
    expect(overview.proposal_acceptance.rate).toBeCloseTo(2 / 3, 2);
    expect(overview.proposal_acceptance.decided).toBe(3);
    expect(overview.proposal_acceptance.expired).toBe(1);
    expect(overview.proposal_acceptance.unavailable).toBe(false);
    // S3：3 confirmed ÷ 4 reviewed = 0.75（M6 §4.5 同式）
    expect(overview.fdd_hit_rate.hit_rate).toBe(0.75);
    expect(overview.fdd_hit_rate.reviewed).toBe(4);
    // 节能量卡：M9 域无报告 → linked=false 引导态（§2.6）
    expect(overview.saving.linked).toBe(false);
    expect(overview.saving.kwh).toBeNull();
  });

  it('shouldReturnEmptySet_whenBuildingHasNoEnergyPoints（用例 13）', async () => {
    const response = await authed(
      'get',
      `/api/v1/kpi/overview?building_id=${world.buildingA2}&from=${FROM}&to=${TO}`,
      adminToken,
    );
    expect(response.status).toBe(200); // 200 空集不报错（§2.1）
    const overview = response.body as { energy: { linked: boolean; total_kwh: number | null } };
    expect(overview.energy.linked).toBe(false);
    expect(overview.energy.total_kwh).toBeNull();
    const trend = await authed(
      'get',
      `/api/v1/kpi/energy/trend?building_id=${world.buildingA2}&from=${FROM}&to=${TO}`,
      adminToken,
    );
    expect(trend.status).toBe(200);
    expect((trend.body as { buckets: unknown[] }).buckets).toHaveLength(0);
  });

  it('shouldBreakDownStructure_withUnclassifiedLast', async () => {
    const response = await authed(
      'get',
      `/api/v1/kpi/energy/structure?building_id=${world.buildingA1}&from=${FROM}&to=${TO}&group_by=system_type`,
      adminToken,
    );
    expect(response.status).toBe(200);
    const structure = response.body as {
      total_kwh: number | null;
      items: { key: string; kwh: number; share_pct: number | null }[];
    };
    expect(structure.total_kwh).not.toBeNull();
    const keys = structure.items.map((i) => i.key);
    expect(keys.indexOf('unclassified')).toBe(keys.length - 1); // 恒末位
    expect(keys).toContain('chilled_water');
    expect(keys).toContain('ahu');
    expect(structure.items[0]?.share_pct).not.toBeNull();
  });

  // ── #4 时间窗/粒度/分组 422 定位 ──
  it('shouldRejectInvalidRange_withFieldDetails（用例 4）', async () => {
    const span800 = await authed(
      'get',
      `/api/v1/kpi/energy/trend?from=${new Date(WIN_FROM).toISOString()}&to=${new Date(WIN_FROM + 801 * 86_400_000).toISOString()}`,
      adminToken,
    );
    expect(span800.status).toBe(422);
    expect((span800.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'kpi.range_invalid',
    );

    const hourWith30d = await authed(
      'get',
      `/api/v1/kpi/energy/trend?from=${FROM}&to=${new Date(WIN_FROM + 30 * 86_400_000).toISOString()}&interval=hour`,
      adminToken,
    );
    expect(hourWith30d.status).toBe(422);
    const body = hourWith30d.body as { error: { reason_code: string; details: { field: string } } };
    expect(body.error.reason_code).toBe('kpi.range_invalid');
    expect(body.error.details.field).toBe('interval');

    const badGroup = await authed(
      'get',
      `/api/v1/kpi/energy/trend?from=${FROM}&to=${TO}&group_by=foo`,
      adminToken,
    );
    expect(badGroup.status).toBe(422);
    const groupBody = badGroup.body as {
      error: { reason_code: string; details: { field: string } };
    };
    expect(groupBody.error.reason_code).toBe('kpi.range_invalid');
    expect(groupBody.error.details.field).toBe('group_by');
  });

  // ── #7 基准缺失显式化（AC-8 双向） ──
  it('shouldExposeBenchmarkExplicitly_acrossConfigStates（用例 7）', async () => {
    const before = await authed(
      'get',
      `/api/v1/kpi/overview?building_id=${world.buildingA1}&from=${FROM}&to=${TO}`,
      adminToken,
    );
    expect((before.body as { benchmark: { status: string } }).benchmark.status).toBe('missing');

    const put = await request(http())
      .put(`/api/v1/kpi/benchmark-config?building_id=${world.buildingA1}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ source: 'fixed', params: { kwh_per_day: 2400 } });
    expect(put.status).toBe(200);

    const after = await authed(
      'get',
      `/api/v1/kpi/overview?building_id=${world.buildingA1}&from=${FROM}&to=${TO}`,
      adminToken,
    );
    const benchmark = (
      after.body as { benchmark: { status: string; source_label: string; baseline_kwh: number } }
    ).benchmark;
    expect(benchmark.status).toBe('ok');
    expect(benchmark.source_label).toContain('定额基准');
    expect(benchmark.baseline_kwh).toBeCloseTo(2400 * 2, 0); // 48h 窗 = 2 日

    // source/params 匹配 422：fixed 缺 kwh_per_day
    const mismatch = await request(http())
      .put(`/api/v1/kpi/benchmark-config?building_id=${world.buildingA1}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ source: 'fixed', params: {} });
    expect(mismatch.status).toBe(422);
    expect((mismatch.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'kpi.benchmark_config_invalid',
    );
  });

  it('shouldExposeUnlinked_forMvBaselineSource（不伪算）', async () => {
    await request(http())
      .put(`/api/v1/kpi/benchmark-config?building_id=${world.buildingA1}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ source: 'mv_baseline', params: {} });
    const response = await authed(
      'get',
      `/api/v1/kpi/overview?building_id=${world.buildingA1}&from=${FROM}&to=${TO}`,
      adminToken,
    );
    const benchmark = (
      response.body as { benchmark: { status: string; unlinked_reason: string | null } }
    ).benchmark;
    expect(benchmark.status).toBe('unlinked');
    expect(benchmark.unlinked_reason).toBe('mv_baseline_pending');
  });

  // ── #3 能力矩阵（403 族） ──
  it('shouldEnforceCapabilityMatrix（用例 3）', async () => {
    const report = await authed('get', '/api/v1/fdd/reports?limit=1', viewerToken);
    expect(report.status).toBe(200);
    const firstId = (report.body as { items: { id: string }[] }).items[0]?.id;
    expect(firstId).toBeDefined();
    const reportId: string = firstId as string;

    const viewerExport = await authed(
      'post',
      `/api/v1/fdd/reports/${reportId}/export`,
      viewerToken,
    );
    expect(viewerExport.status).toBe(403);
    expect((viewerExport.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'auth.forbidden',
    );

    const viewerDigest = await request(http())
      .put(`/api/v1/fdd/digest?building_id=${world.buildingA1}`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ enabled: true, recipients: [{ email: 'a@b.cn' }] });
    expect(viewerDigest.status).toBe(403);

    const operatorDigest = await request(http())
      .put(`/api/v1/fdd/digest?building_id=${world.buildingA1}`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ enabled: true, recipients: [{ email: 'a@b.cn' }] });
    expect(operatorDigest.status).toBe(403);

    const viewerBenchmark = await request(http())
      .put(`/api/v1/kpi/benchmark-config?building_id=${world.buildingA1}`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ source: 'none', params: {} });
    expect(viewerBenchmark.status).toBe(403);
    // kpi.read 三角色可浏览
    const viewerOverview = await authed('get', '/api/v1/kpi/overview', viewerToken);
    expect(viewerOverview.status).toBe(200);
  });

  // ── #8/#9/#10 导出全链 + 限流双层 + 只看本人 ──
  it('shouldCompleteExportChain_202ToSignedDownload（用例 8）', async () => {
    const report = await authed('get', '/api/v1/fdd/reports?limit=1', operatorToken);
    const reportId = (report.body as { items: { id: string }[] }).items[0]?.id as string;

    const create = await authed('post', `/api/v1/fdd/reports/${reportId}/export`, operatorToken);
    expect(create.status).toBe(202);
    const { export_job_id: jobId } = create.body as { export_job_id: string; status: string };

    // 轮询至 succeeded（渲染 fake 即时；上限 5s）
    let job = null as {
      status: string;
      file_bytes: number | null;
      expires_at: string | null;
    } | null;
    for (let i = 0; i < 25; i += 1) {
      const detail = await authed('get', `/api/v1/kpi/export-jobs/${jobId}`, operatorToken);
      expect(detail.status).toBe(200);
      job = detail.body as { status: string; file_bytes: number | null; expires_at: string | null };
      if (job.status === 'succeeded' || job.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(job).not.toBeNull();
    expect(job?.status).toBe('succeeded');
    expect((job?.file_bytes ?? 0) > 0).toBe(true);

    // 302 签名 URL → @Public 文件端点 200 PDF
    const download = await authed(
      'get',
      `/api/v1/kpi/export-jobs/${jobId}/download`,
      operatorToken,
    );
    expect(download.status).toBe(302);
    const location = download.headers.location as string;
    expect(location).toContain('/api/v1/kpi/exports/');
    expect(location).toContain('sig=');
    const file = await request(http()).get(location.replace(/^https?:\/\/[^/]+/, ''));
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');

    // 过期 409（载体无独立 expired 态——expires_at 判定）
    const client = await pool().connect();
    try {
      await client.query(
        `UPDATE export_job SET expires_at = now() - INTERVAL '1 day' WHERE id = $1`,
        [jobId],
      );
    } finally {
      client.release();
    }
    const expired = await authed('get', `/api/v1/kpi/export-jobs/${jobId}/download`, operatorToken);
    expect(expired.status).toBe(409);
    expect((expired.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'mv.export_file_expired',
    );
  }, 20_000);

  it('shouldRateLimit_inFlightAndHourly（用例 9）', async () => {
    const report = await authed('get', '/api/v1/fdd/reports?limit=1', adminToken);
    const reportId = (report.body as { items: { id: string }[] }).items[0]?.id as string;

    // 在飞第 3 个 → 429（M9 载体行：每租户 ≤2）
    const client = await pool().connect();
    try {
      for (let i = 0; i < 2; i += 1) {
        await client.query(
          `INSERT INTO export_job (id, tenant_id, resource_type, resource_id, requested_by)
           VALUES ($1, $2, 'fdd_report', $3, $4)`,
          [crypto.randomUUID(), world.tenantA, reportId, world.adminA],
        );
      }
      const third = await authed('post', `/api/v1/fdd/reports/${reportId}/export`, adminToken);
      expect(third.status).toBe(429);
      expect((third.body as { error: { reason_code: string } }).error.reason_code).toBe(
        'common.rate_limited',
      );
      // 清在飞（改 succeeded），保留行计入楼宇每小时计数
      await client.query(
        `UPDATE export_job SET status = 'succeeded', file_object_key = 'mv-exports/x',
            file_bytes = 1, expires_at = now() + INTERVAL '30 days'
         WHERE tenant_id = $1 AND status = 'queued'`,
        [world.tenantA],
      );
      // 补足楼宇每小时 20 上限（已有 3 行——2 造 + 1 前一用例）
      const existing = await client.query<{ count: string }>(
        `SELECT count(*) AS count FROM export_job e
         JOIN fdd_report r ON r.tenant_id = e.tenant_id AND r.id = e.resource_id
         WHERE e.tenant_id = $1 AND e.resource_type = 'fdd_report'
           AND r.building_id = $2 AND e.created_at >= now() - INTERVAL '1 hour'`,
        [world.tenantA, world.buildingA1],
      );
      for (let i = Number(existing.rows[0]?.count ?? 0); i < 20; i += 1) {
        await client.query(
          `INSERT INTO export_job (id, tenant_id, resource_type, resource_id, requested_by)
           VALUES ($1, $2, 'fdd_report', $3, $4)`,
          [crypto.randomUUID(), world.tenantA, reportId, world.adminA],
        );
      }
      const twentyFirst = await authed(
        'post',
        `/api/v1/fdd/reports/${reportId}/export`,
        adminToken,
      );
      expect(twentyFirst.status).toBe(429);
      expect((twentyFirst.body as { error: { reason_code: string } }).error.reason_code).toBe(
        'common.rate_limited',
      );
    } finally {
      // 清该楼宇本小时造的计数行（后续用例不受影响）
      await client.query(
        `DELETE FROM export_job WHERE tenant_id = $1 AND resource_type = 'fdd_report'`,
        [world.tenantA],
      );
      client.release();
    }
  });

  it('shouldHideOtherUsersJobs_evenFromAdmin（用例 10 + 只看本人）', async () => {
    // operator 发起一个导出，admin 查同租户该任务 → 404（§5.6 定夺）
    const report = await authed('get', '/api/v1/fdd/reports?limit=1', operatorToken);
    const reportId = (report.body as { items: { id: string }[] }).items[0]?.id as string;
    const create = await authed('post', `/api/v1/fdd/reports/${reportId}/export`, operatorToken);
    expect(create.status).toBe(202);
    const jobId = (create.body as { export_job_id: string }).export_job_id;

    const adminView = await authed('get', `/api/v1/kpi/export-jobs/${jobId}`, adminToken);
    expect(adminView.status).toBe(404);
    expect((adminView.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'mv.report_not_found',
    );

    const list = await authed('get', '/api/v1/kpi/export-jobs', operatorToken);
    expect(list.status).toBe(200);
    const items = (list.body as { items: { id: string }[] }).items;
    expect(items.some((i) => i.id === jobId)).toBe(true);
    // admin 列表看不到 operator 的任务
    const adminList = await authed('get', '/api/v1/kpi/export-jobs', adminToken);
    const adminItems = (adminList.body as { items: { id: string }[] }).items;
    expect(adminItems.some((i) => i.id === jobId)).toBe(false);

    // 不存在的报告 → 404 fdd.report_not_found（报告本体 404）
    const badReport = await authed(
      'post',
      `/api/v1/fdd/reports/${crypto.randomUUID()}/export`,
      operatorToken,
    );
    expect(badReport.status).toBe(404);
    expect((badReport.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'fdd.report_not_found',
    );
  });

  // ── #11/#12 订阅配置与投递链路 ──
  it('shouldValidateDigestRecipients_withIndexDetails（用例 11）', async () => {
    const badEmail = await request(http())
      .put(`/api/v1/fdd/digest?building_id=${world.buildingA1}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: true, recipients: [{ email: 'ok@x.cn' }, { email: 'not-an-email' }] });
    expect(badEmail.status).toBe(422);
    const errBody = badEmail.body as { error: { reason_code: string; details: { index: number } } };
    expect(errBody.error.reason_code).toBe('digest.recipient_invalid');
    expect(errBody.error.details.index).toBe(2);

    const twentyOne = await request(http())
      .put(`/api/v1/fdd/digest?building_id=${world.buildingA1}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        enabled: true,
        recipients: Array.from({ length: 21 }, (_, i) => ({ email: `u${String(i)}@x.cn` })),
      });
    expect(twentyOne.status).toBe(422);
    expect((twentyOne.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'digest.recipient_invalid',
    );
  });

  it('shouldDeliverWeeklyDigest_onSimulatedMonday（用例 12：sent/skipped/failed/幂等）', async () => {
    // A1 有周报 + 订阅；A2 无周报 + 订阅；B1 有周报 + 订阅（失败注入目标）
    for (const [building, recipients] of [
      [world.buildingA1, [{ email: 'fm@tenant-a.cn' }]],
      [world.buildingA2, [{ email: 'ops@tenant-a.cn' }]],
      [world.buildingB1, [{ email: 'fm@tenant-b.cn' }]],
    ] as const) {
      const put = await request(http())
        .put(`/api/v1/fdd/digest?building_id=${building}`)
        .set('Authorization', `Bearer ${building === world.buildingB1 ? adminBToken : adminToken}`)
        .send({ enabled: true, recipients: [...recipients] });
      expect(put.status).toBe(200);
      expect((put.body as { enabled: boolean }).enabled).toBe(true);
    }

    const digest = digestService();
    // 模拟时钟：周一 2026-10-12 08:00（Asia/Shanghai）——周报期 [10-05, 10-12)
    const simulatedMonday = new Date(Date.UTC(2026, 9, 12, 0, 0, 0)); // = 上海 08:00
    mailerFake.failMode = false;
    const tick1 = await digest.deliverWeeklyTick(simulatedMonday);
    expect(tick1.delivered).toBe(2); // A1 + B1（有报告）
    expect(tick1.skipped).toBe(1); // A2（无报告 → skipped + no_report）

    const a1Deliveries = await authed(
      'get',
      `/api/v1/fdd/digest/deliveries?building_id=${world.buildingA1}`,
      adminToken,
    );
    expect(a1Deliveries.status).toBe(200);
    const items = (
      a1Deliveries.body as {
        items: {
          status: string;
          skip_reason: string | null;
          report_id: string | null;
          recipients_count: number;
        }[];
      }
    ).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe('sent');
    expect(items[0]?.recipients_count).toBe(1);
    expect(items[0]?.report_id).not.toBeNull();
    expect(mailerFake.sentCount()).toBe(2);

    const a2Deliveries = await authed(
      'get',
      `/api/v1/fdd/digest/deliveries?building_id=${world.buildingA2}`,
      adminToken,
    );
    const a2Items = (
      a2Deliveries.body as {
        items: { status: string; skip_reason: string | null }[];
      }
    ).items;
    expect(a2Items[0]?.status).toBe('skipped');
    expect(a2Items[0]?.skip_reason).toBe('no_report'); // 不伪造空报告

    // 幂等：重跑同周 tick 不插行不重发
    const sentBefore = mailerFake.sentCount();
    const tick2 = await digest.deliverWeeklyTick(simulatedMonday);
    expect(tick2.delivered).toBe(0);
    expect(mailerFake.sentCount()).toBe(sentBefore);
    const a1After = await authed(
      'get',
      `/api/v1/fdd/digest/deliveries?building_id=${world.buildingA1}`,
      adminToken,
    );
    expect((a1After.body as { items: unknown[] }).items.length).toBe(1);

    // SMTP 不可达注入 → B 租户下期投递 failed（先补 B1 下一期周报，再用次周一 tick）
    const client = await pool().connect();
    try {
      await client.query(
        `INSERT INTO fdd_report (tenant_id, building_id, period_type, period, summary, generated_at, algo_version)
         VALUES ($1, $2, 'week', daterange('2026-10-12', '2026-10-19'), $3::jsonb, now(), 'e2e')`,
        [
          world.tenantB,
          world.buildingB1,
          JSON.stringify({
            counts: { new: 1, resolved: 0, persisting: 1 },
            new_by_severity: { info: 1, warning: 0, minor: 0, major: 0, critical: 0 },
            open_by_severity: { info: 0, warning: 0, minor: 1, major: 0, critical: 0 },
            health_ranking: [],
          }),
        ],
      );
    } finally {
      client.release();
    }
    // A1/A2 也补下一期报告/订阅空缺：A2 依旧无报告（skipped 由 UNIQUE 幂等——同期行已存在则 no-op）
    mailerFake.failMode = true;
    const nextMonday = new Date(Date.UTC(2026, 9, 19, 0, 0, 0));
    await digest.deliverWeeklyTick(nextMonday);
    const bDeliveries = await authed(
      'get',
      `/api/v1/fdd/digest/deliveries?building_id=${world.buildingB1}`,
      adminBToken,
    );
    const bItems = (
      bDeliveries.body as {
        items: { status: string; failure_msg: string | null; period: { start: string } }[];
      }
    ).items;
    const failed = bItems.find((i) => i.period.start === '2026-10-12');
    expect(failed?.status).toBe('failed');
    expect(failed?.failure_msg).toContain('不可达'); // PII 纪律：不含收件地址
    mailerFake.failMode = false;
  });

  it('shouldIsolateTenants_onDigestAndExportFaces（RLS）', async () => {
    // B 管理员看投递记录：只见 B 楼（A1 的 sent 不可见）
    const bDeliveries = await authed('get', '/api/v1/fdd/digest/deliveries', adminBToken);
    expect(bDeliveries.status).toBe(200);
    const items = (bDeliveries.body as { items: { building: { id: string } }[] }).items;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.building.id).not.toBe(world.buildingA1);
    }
    // B 管理员读 A 的订阅 → 404（越楼宇同文案）
    const aConfig = await request(http())
      .get(`/api/v1/fdd/digest?building_id=${world.buildingA1}`)
      .set('Authorization', `Bearer ${adminBToken}`);
    expect(aConfig.status).toBe(404);
  });
});
