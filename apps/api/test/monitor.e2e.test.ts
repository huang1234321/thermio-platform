/**
 * M3 监控端点 e2e（M3-monitor §3 契约矩阵，IMPL-14 api 包；PG 门控 + fake TSDB）。
 *
 * 覆盖 §14 契约测试负路径最小组（scenes 相关除外——R3 未落）：
 * - overview：KPI 能耗/负荷率/告警计数/网关、缺省楼宇、越权 404 同码同文案（SEC-AZ-03）；
 * - equipments 检索：run_state 求值（running/fault=告警且非 running/standby）、
 *   key_points ≤5、run_state/equipment_type/keyword 筛选、游标分页、非法 run_state 422；
 * - 详情：points（M1 §3.4 latest 快照复用）+ alarms top（R11 equipment∪点位）+ fdd 空形状 + 越权 404；
 * - points/latest：无数据点 null 不 404、越权点整单 404、路由序回归（points/latest 不被 points/:pointId 吃掉）。
 *
 * TSDB 面（latest 批量 / 能量窗口首末）以 DI token 覆写为内存 fake——
 * PG 面（资产/告警/RLS/越权）走真实栈（与 asset/alarm e2e 同款纪律）。
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { Test } from '@nestjs/testing';
import type { LoginResponse, TelemetryRawSample } from '@thermio/shared-types';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { TELEMETRY_STORE } from '../src/telemetry/telemetry.tokens.js';
import type { TelemetryStore } from '../src/telemetry/tsdb-read.repository.js';
import {
  E2E_ADMIN_URL,
  E2E_API_URL,
  E2E_AUTH_URL,
  E2E_JWT_SECRET,
  E2E_READY,
  PASSWORDS,
  seedWorld,
  type SeededWorld,
} from './e2e-env.js';

const skipped = E2E_READY ? describe : describe.skip;

let app: INestApplication;
let world: SeededWorld;
let seed: MonitorSeed;

interface MonitorSeed {
  systemId: string;
  chiller1: string;
  chiller2: string;
  pump: string;
  points: {
    ch1Run: number;
    ch1Load: number;
    ch1Energy: number;
    ch1Temp: number;
    ch1Power: number;
    ch2Run: number;
    ch2Load: number;
    pumpRun: number;
    spare: number; // 无 quantity_type / 无遥测
  };
}

function passwordFor(email: string): string {
  if (email.startsWith('operator')) return PASSWORDS.operator;
  if (email.startsWith('viewer')) return PASSWORDS.viewer;
  return PASSWORDS.admin;
}

async function login(email: string): Promise<string> {
  const response = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password: passwordFor(email) });
  expect(response.status).toBe(200);
  return (response.body as LoginResponse).access_token;
}

let adminToken: string;
let viewerToken: string;
let adminBToken: string;

function authed(method: 'get', path: string, token: string): request.Test {
  return request(app.getHttpServer())[method](path).set('Authorization', `Bearer ${token}`);
}

/** fake TSDB：latest 批量 + 能量窗口首末（真实 HTTP 栈 + PG，遥测面内存可控）。 */
function buildFakeStore(seedRef: () => MonitorSeed) {
  const latestSamples = new Map<number, TelemetryRawSample>();
  const energyEndpoints = new Map<number, { first: number; last: number }>();
  const store: TelemetryStore = {
    latest: () => Promise.resolve(null),
    latestBatch: (pointIds) => {
      const map = new Map<number, TelemetryRawSample>();
      for (const id of pointIds) {
        const sample = latestSamples.get(id);
        if (sample !== undefined) map.set(id, sample);
      }
      return Promise.resolve(map);
    },
    presentInWindow: () => Promise.resolve(new Set<number>()), // IMPL-15 面（本套不触达）
    listRaw: () => Promise.resolve([]),
    listAggregate: () => Promise.resolve([]),
    windowEndpoints: (pointIds) => {
      const map = new Map<number, { first: number; last: number }>();
      for (const id of pointIds) {
        const endpoints = energyEndpoints.get(id);
        if (endpoints !== undefined) map.set(id, endpoints);
      }
      return Promise.resolve(map);
    },
  };
  return { store, latestSamples, energyEndpoints, seedRef };
}

skipped('monitor e2e：总览/设备工况/批量 latest（IMPL-14 api 包）', () => {
  beforeAll(async () => {
    world = await seedWorld();
    seed = await seedMonitorWorld();

    const fake = buildFakeStore(() => seed);
    // latest：CH-01 运行（'1'，80% 负荷）、CH-02 备用（'0'）、泵运行；值卡温度/功率
    fake.latestSamples.set(seed.points.ch1Run, raw('2026-09-27T06:00:00Z', null, '1'));
    fake.latestSamples.set(seed.points.ch1Load, raw('2026-09-27T06:00:00Z', 80, null));
    fake.latestSamples.set(seed.points.ch2Run, raw('2026-09-27T06:00:00Z', null, '0'));
    fake.latestSamples.set(seed.points.ch2Load, raw('2026-09-27T06:00:00Z', 60, null));
    fake.latestSamples.set(seed.points.pumpRun, raw('2026-09-27T06:00:00Z', null, '1'));
    fake.latestSamples.set(seed.points.ch1Temp, raw('2026-09-27T06:00:00Z', 7.4, null));
    fake.latestSamples.set(seed.points.ch1Power, raw('2026-09-27T06:00:00Z', 320, null));
    // 能量：窗口差值 40 kWh（当日/当期同 fake 值）
    fake.energyEndpoints.set(seed.points.ch1Energy, { first: 1000, last: 1040 });

    process.env.PG_API_URL = E2E_API_URL;
    process.env.PG_AUTH_URL = E2E_AUTH_URL;
    process.env.AUTH_JWT_SECRET = E2E_JWT_SECRET;
    process.env.LOG_LEVEL = 'silent';
    process.env.KAFKA_BROKERS = '';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TELEMETRY_STORE)
      .useValue(fake.store)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    adminToken = await login('admin-a@dt113.test');
    viewerToken = await login('viewer-a@dt113.test');
    adminBToken = await login('admin-b@dt113.test');
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /monitor/overview（§3.1）', () => {
    it('shouldAggregateKpi_alarmsAndGateways', async () => {
      const response = await authed(
        'get',
        `/api/v1/monitor/overview?building_id=${world.buildingA1}`,
        adminToken,
      );
      expect(response.status).toBe(200);
      expect(response.body.building).toMatchObject({ id: world.buildingA1 });
      expect(response.body.scenes).toEqual([]);
      expect(response.body.kpi.energy_today_kwh).toBe(40);
      expect(response.body.kpi.energy_period_kwh).toBe(40);
      expect(response.body.kpi.saving_period_kwh).toBeNull();
      // CH-01 运行 80%（cap 1000）在权、CH-02 备用出局 → 加权 = 80
      expect(response.body.kpi.load_rate_pct).toBe(80);
      expect(response.body.kpi.load_rate_linked).toBe(true);
      expect(response.body.kpi.alarms).toEqual({
        open_total: 2,
        open_by_severity: { info: 1, warning: 0, minor: 0, major: 1, critical: 0 },
      });
      expect(response.body.gateways).toEqual({ online: 1, total: 2 });
    });

    it('shouldResolveDefaultBuilding_toVisibleBuilding', async () => {
      // 缺省楼宇 = 可见集首楼（(created_at,id) 序——同事务种子 created_at 相同，uuid 决胜，
      // 断言只锚「落在可见集」这一契约语义，不钉具体楼）
      const response = await authed('get', '/api/v1/monitor/overview', adminToken);
      expect(response.status).toBe(200);
      expect([world.buildingA1, world.buildingA2]).toContain(response.body.building.id);
    });

    it('shouldReturnIdentical404_forNonexistentVsCrossTenantBuilding', async () => {
      const nonexistent = await authed(
        'get',
        '/api/v1/monitor/overview?building_id=00000000-0000-7000-8000-000000000001',
        adminToken,
      );
      const crossTenant = await authed(
        'get',
        `/api/v1/monitor/overview?building_id=${world.buildingB1}`,
        adminToken,
      );
      expect(nonexistent.status).toBe(404);
      expect(nonexistent.body.error.reason_code).toBe('asset.not_found');
      expect(nonexistent.body.error.message).toBe(crossTenant.body.error.message);
      expect(crossTenant.body.error.reason_code).toBe('asset.not_found');
    });

    it('shouldAllowViewer_monitorReadCapability', async () => {
      const response = await authed(
        'get',
        `/api/v1/monitor/overview?building_id=${world.buildingA1}`,
        viewerToken,
      );
      expect(response.status).toBe(200);
    });
  });

  describe('GET /monitor/equipments（§3.2 检索）', () => {
    it('shouldEvaluateRunState_alarmWorst_andKeyPoints', async () => {
      const response = await authed(
        'get',
        `/api/v1/monitor/equipments?building_id=${world.buildingA1}`,
        adminToken,
      );
      expect(response.status).toBe(200);
      const items = response.body.items as Array<{
        equipment: { name: string };
        run_state: string;
        alarm_worst: string | null;
        key_points: Array<{ point_id: number; latest: { value_text: string | null } | null }>;
      }>;
      const ch1 = items.find((item) => item.equipment.name === 'CH-01');
      const ch2 = items.find((item) => item.equipment.name === 'CH-02');
      const pump = items.find((item) => item.equipment.name === 'CHWP-01');
      expect(ch1?.run_state).toBe('running'); // running 优先于告警
      expect(ch1?.alarm_worst).toBe('major');
      expect(ch2?.run_state).toBe('fault'); // standby + open 告警 → fault
      expect(ch2?.alarm_worst).toBe('info');
      expect(pump?.run_state).toBe('running');
      // key_points：run_status + 首条 temp + 首条 power（去重 ≤5）
      expect(ch1?.key_points.map((p) => p.point_id).sort((a, b) => a - b)).toEqual(
        [seed.points.ch1Run, seed.points.ch1Temp, seed.points.ch1Power].sort((a, b) => a - b),
      );
      expect(ch1?.key_points.every((p) => p.latest !== null)).toBe(true);
    });

    it('shouldFilterByRunState_equipmentType_andKeyword', async () => {
      const base = `/api/v1/monitor/equipments?building_id=${world.buildingA1}`;
      const running = await authed('get', `${base}&run_state=running`, adminToken);
      expect(
        running.body.items.map((i: { equipment: { name: string } }) => i.equipment.name),
      ).toEqual(['CH-01', 'CHWP-01']);
      const fault = await authed('get', `${base}&run_state=fault`, adminToken);
      expect(
        fault.body.items.map((i: { equipment: { name: string } }) => i.equipment.name),
      ).toEqual(['CH-02']);
      const chillers = await authed('get', `${base}&equipment_type=chiller`, adminToken);
      expect(chillers.body.items).toHaveLength(2);
      const kw = await authed('get', `${base}&keyword=ch-01`, adminToken);
      expect(kw.body.items.map((i: { equipment: { name: string } }) => i.equipment.name)).toEqual([
        'CH-01',
      ]);
    });

    it('shouldPaginateWithCursor_stableOrdering', async () => {
      const base = `/api/v1/monitor/equipments?building_id=${world.buildingA1}`;
      const page1 = await authed('get', `${base}&limit=2`, adminToken);
      expect(page1.body.items).toHaveLength(2);
      expect(page1.body.next_cursor).toBeTruthy();
      const cursor = String(page1.body.next_cursor);
      const page2 = await authed('get', `${base}&limit=2&cursor=${cursor}`, adminToken);
      expect(page2.body.items).toHaveLength(1);
      const names = [...page1.body.items, ...page2.body.items].map(
        (i: { equipment: { name: string } }) => i.equipment.name,
      );
      expect(names).toEqual([...names].sort());
    });

    it('shouldRejectInvalidRunState_with422', async () => {
      const response = await authed(
        'get',
        `/api/v1/monitor/equipments?building_id=${world.buildingA1}&run_state=bogus`,
        adminToken,
      );
      expect(response.status).toBe(422);
      expect(response.body.error.reason_code).toBe('common.validation_failed');
    });

    it('shouldRejectUnknownBuilding_withBuilding404', async () => {
      const response = await authed(
        'get',
        `/api/v1/monitor/equipments?building_id=${world.buildingB1}`,
        viewerToken,
      );
      expect(response.status).toBe(404);
      expect(response.body.error.reason_code).toBe('asset.not_found');
    });
  });

  describe('GET /monitor/equipments/{id}（§3.3 详情）', () => {
    it('shouldAggregatePoints_alarms_andEmptyFdd', async () => {
      const response = await authed(
        'get',
        `/api/v1/monitor/equipments/${seed.chiller1}`,
        adminToken,
      );
      expect(response.status).toBe(200);
      expect(response.body.run_state).toBe('running');
      const pointIds = (response.body.points as Array<{ point: { id: number } }>).map(
        (item) => item.point.id,
      );
      expect(pointIds).toContain(seed.points.ch1Run);
      expect(pointIds).toContain(seed.points.ch1Energy);
      expect(response.body.alarms.open_by_severity).toMatchObject({ major: 1 });
      expect(response.body.alarms.items).toHaveLength(1);
      expect(response.body.alarms.items[0]).toMatchObject({
        severity: 'major',
        rule_summary: 'CH-01 冷凝压力高',
      });
      expect(response.body.fdd).toEqual({ open_total: 0, items: [] }); // IMPL-16 未交付
    });

    it('shouldReturnIdentical404_forNonexistentVsCrossTenantEquipment', async () => {
      const nonexistent = await authed(
        'get',
        '/api/v1/monitor/equipments/00000000-0000-7000-8000-000000000002',
        adminToken,
      );
      const crossTenant = await authed(
        'get',
        `/api/v1/monitor/equipments/${seed.chiller1}`,
        adminBToken,
      );
      expect(nonexistent.status).toBe(404);
      expect(crossTenant.status).toBe(404);
      expect(nonexistent.body.error.message).toBe(crossTenant.body.error.message);
      expect(nonexistent.body.error.reason_code).toBe('asset.not_found');
    });
  });

  describe('GET /points/latest（§3.6 批量）', () => {
    it('shouldReturnNullsForNoDataPoints_not404', async () => {
      const ids = [seed.points.ch1Run, seed.points.spare].map(String).join(',');
      const response = await authed('get', `/api/v1/points/latest?point_ids=${ids}`, adminToken);
      expect(response.status).toBe(200);
      expect(response.body.items).toEqual([
        {
          point_id: seed.points.ch1Run,
          ts: '2026-09-27T06:00:00Z',
          value: null,
          value_text: '1',
          quality: 0,
        },
        { point_id: seed.points.spare, ts: null, value: null, value_text: null, quality: null },
      ]);
    });

    it('shouldRejectWholeBatch_whenAnyPointInvisible', async () => {
      const response = await authed(
        'get',
        `/api/v1/points/latest?point_ids=${String(seed.points.ch1Run)},999999999`,
        adminToken,
      );
      expect(response.status).toBe(404);
      expect(response.body.error.reason_code).toBe('asset.not_found');
      expect(response.body.error.details.point_ids).toEqual([999999999]);
    });

    it('shouldWinRouteOrder_overPointsByIdRoute', async () => {
      // 路由序回归：points/latest 必须命中批量端点（200），而非 points/:pointId（422 数字解析失败）
      const response = await authed(
        'get',
        `/api/v1/points/latest?point_ids=${String(seed.points.ch1Run)}`,
        adminToken,
      );
      expect(response.status).toBe(200);
      expect(response.body.items).toHaveLength(1);
    });
  });
});

function raw(ts: string, value: number | null, value_text: string | null): TelemetryRawSample {
  return { ts, value, value_text, quality: 0 };
}

/** 监控域种子（在 IMPL-10 世界上追加：双冷机 + 泵 + 关键点位 + 网关在线/离线 + 两条 open 告警）。 */
async function seedMonitorWorld(): Promise<MonitorSeed> {
  const pool = new pg.Pool({ connectionString: E2E_ADMIN_URL, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const firstId = (result: pg.QueryResult): string => {
        const row = result.rows[0] as { id: string } | undefined;
        if (row === undefined) throw new Error('种子 RETURNING 未返回行');
        return row.id;
      };
      const systemId = firstId(
        await client.query(
          `INSERT INTO hvac_system (tenant_id, building_id, system_type, name)
           VALUES ($1, $2, 'chilled_water', 'E2E 冷源系统') RETURNING id`,
          [world.tenantA, world.buildingA1],
        ),
      );
      const equipment = async (
        name: string,
        type: 'chiller' | 'chwp_pump',
        rated: Record<string, number> | null,
      ): Promise<string> =>
        firstId(
          await client.query(
            `INSERT INTO equipment (tenant_id, system_id, equipment_type, name, local_id, rated_params)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [
              world.tenantA,
              systemId,
              type,
              name,
              name,
              rated === null ? null : JSON.stringify(rated),
            ],
          ),
        );
      const chiller1 = await equipment('CH-01', 'chiller', { rated_cooling_capacity_kw: 1000 });
      const chiller2 = await equipment('CH-02', 'chiller', { rated_cooling_capacity_kw: 500 });
      const pump = await equipment('CHWP-01', 'chwp_pump', null);

      const point = async (
        rawName: string,
        quantityType: string | null,
        equipmentId: string | null,
        unitStd: string | null,
      ): Promise<number> => {
        const result = await client.query<{ id: string }>(
          `INSERT INTO point (tenant_id, building_id, equipment_id, source_type, raw_name,
                              quantity_type, display_name, unit_std, direction)
           VALUES ($1, $2, $3, 'virtual', $4, $5, $6, $7, 'read') RETURNING id`,
          [world.tenantA, world.buildingA1, equipmentId, rawName, quantityType, rawName, unitStd],
        );
        return Number(result.rows[0]?.id);
      };
      const ch1Run = await point('CH01.RUN', 'run_status', chiller1, null);
      const ch1Load = await point('CH01.LOAD', 'load_rate', chiller1, '%');
      const ch1Energy = await point('CH01.KWH', 'energy', chiller1, 'kWh');
      const ch1Temp = await point('CH01.CHWS.TEMP', 'chw_supply_temp', chiller1, 'DegC');
      const ch1Power = await point('CH01.PWR', 'power', chiller1, 'kW');
      const ch2Run = await point('CH02.RUN', 'run_status', chiller2, null);
      const ch2Load = await point('CH02.LOAD', 'load_rate', chiller2, '%');
      const pumpRun = await point('P01.RUN', 'run_status', pump, null);
      const spare = await point('SPARE.NO.QUANTITY', null, null, null);

      // 网关：一在线一离线（overview gateways 计数）
      for (const [serial, status] of [
        ['E2EGW-ON', 'online'],
        ['E2EGW-OFF', 'offline'],
      ] as const) {
        await client.query(
          `INSERT INTO gateway (tenant_id, building_id, name, serial, mqtt_client_id, status)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [world.tenantA, world.buildingA1, `E2E 网关 ${serial}`, serial, `gw-${serial}`, status],
        );
      }

      // 在用告警：CH-01（equipment 源，major）+ CH-02 负荷率点位（point 源，info → fault 求值）
      await client.query(
        `INSERT INTO alarm_event (tenant_id, rule_id, source_type, source_id, severity, message, status, category)
         VALUES ($1, NULL, 'equipment', $2, 'major', 'CH-01 冷凝压力高', 'open', 'fdd_finding')`,
        [world.tenantA, chiller1],
      );
      await client.query(
        `INSERT INTO alarm_event (tenant_id, rule_id, source_type, source_id, severity, message, status, category)
         VALUES ($1, NULL, 'point', $2, 'info', 'CH-02 负荷率回读停滞', 'open', 'point_stale')`,
        [world.tenantA, String(ch2Load)],
      );

      await client.query('COMMIT');
      return {
        systemId,
        chiller1,
        chiller2,
        pump,
        points: { ch1Run, ch1Load, ch1Energy, ch1Temp, ch1Power, ch2Run, ch2Load, pumpRun, spare },
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
