/**
 * 遥测查询端点 e2e（platform.md §5.4 契约测试矩阵：端点 × {正/负/边界}）。
 *
 * 仓储以 DI token 覆写为内存 fake（TELEMETRY_STORE / POINT_REGISTRY）——
 * 信封、schema 校验、路由、游标翻页在真实 HTTP 栈上验证；
 * 另设「真实模块 + 空配置」组验证 dev 降级形态（503 telemetry.store_unavailable）。
 */
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import {
  AggregateTelemetryPageSchema,
  ApiErrorEnvelopeSchema,
  PointLatestSchema,
  RawTelemetryPageSchema,
} from '@thermio/shared-types';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { POINT_REGISTRY, TELEMETRY_STORE } from '../src/telemetry/telemetry.tokens.js';
import type { PointRegistry } from '../src/telemetry/point-lookup.service.js';
import type { TelemetryStore } from '../src/telemetry/tsdb-read.repository.js';

const POINT_ID = 9;
const LATEST_PATH = '/api/v1/points/9/latest';
const TELEMETRY_PATH = '/api/v1/points/9/telemetry';

interface FakeWindow {
  from: string;
  to: string;
  after: string | null;
  fetchLimit: number;
}

function buildStore() {
  const rawSamples = Array.from({ length: 120 }, (_, i) => ({
    ts: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
    value: 7 + (i % 10) / 10,
    value_text: null,
    quality: 0,
  }));
  const aggBuckets = Array.from({ length: 120 }, (_, i) => ({
    bucket: new Date(Date.UTC(2026, 8, 1, 0, i * 5)).toISOString(),
    avg: 7.5,
    min: 7.0,
    max: 8.0,
    last: 7.6,
    stddev: 0.2,
    sample_count: 5,
    bad_count: 0,
    quality_mask: 0,
  }));
  const state = { rawCalls: 0, aggCalls: [] as number[] };
  const store: TelemetryStore & typeof state = {
    ...state,
    latest: () =>
      Promise.resolve({ ts: '2026-09-26T08:00:00Z', value: 7.5, value_text: null, quality: 0 }),
    windowEndpoints: () => Promise.resolve(new Map()),
    latestBatch: () => Promise.resolve(new Map()),
    listRaw: (window: FakeWindow) => {
      store.rawCalls += 1;
      return Promise.resolve(
        rawSamples
          .filter(
            (row) =>
              row.ts >= window.from &&
              row.ts < window.to &&
              (window.after === null || row.ts > window.after),
          )
          .slice(0, window.fetchLimit),
      );
    },
    listAggregate: (interval: '5min' | '1h', window: FakeWindow) => {
      store.aggCalls.push(interval === '5min' ? 5 : 60);
      return Promise.resolve(
        aggBuckets
          .filter(
            (row) =>
              row.bucket >= window.from &&
              row.bucket < window.to &&
              (window.after === null || row.bucket > window.after),
          )
          .slice(0, window.fetchLimit),
      );
    },
    presentInWindow: () => Promise.resolve(new Set<number>()), // IMPL-15 自检面（本套不触达）
  };
  return store;
}

describe('遥测查询 e2e（IMPL-12，fake 仓储 + 真实 HTTP 栈）', () => {
  let app: INestApplication;
  let store: ReturnType<typeof buildStore>;

  beforeAll(async () => {
    process.env.LOG_LEVEL = 'silent';
    process.env.KAFKA_BROKERS = '';
    process.env.TSDB_READ_URL = '';
    process.env.PG_URL = '';
    store = buildStore();
    const registry: PointRegistry = {
      exists: (pointId: number) => Promise.resolve(pointId === POINT_ID),
    };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TELEMETRY_STORE)
      .useValue(store)
      .overrideProvider(POINT_REGISTRY)
      .useValue(registry)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET latest', () => {
    it('shouldReturnTheLatestSample_andParseAgainstTheContractSchema', async () => {
      const res = await request(app.getHttpServer()).get(LATEST_PATH).expect(200);
      expect(PointLatestSchema.safeParse(res.body).success).toBe(true);
      expect(res.body).toEqual({
        point_id: POINT_ID,
        ts: '2026-09-26T08:00:00Z',
        value: 7.5,
        value_text: null,
        quality: 0,
      });
    });

    it('shouldReturnAssetNotFound404_forUnregisteredPoints', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/points/404/latest').expect(404);
      expect(ApiErrorEnvelopeSchema.safeParse(res.body).success).toBe(true);
      expect(res.body.error.reason_code).toBe('asset.not_found');
      expect(res.body.error.details).toEqual({ point_id: 404 });
    });

    it('shouldReturnPointNoData404_whenRegisteredButEmpty', async () => {
      const emptyStore = buildStore();
      emptyStore.latest = () => Promise.resolve(null);
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(TELEMETRY_STORE)
        .useValue(emptyStore)
        .overrideProvider(POINT_REGISTRY)
        .useValue({ exists: () => Promise.resolve(true) } satisfies PointRegistry)
        .compile();
      const scopedApp = configureApp(moduleRef.createNestApplication());
      await scopedApp.init();
      try {
        const res = await request(scopedApp.getHttpServer()).get(LATEST_PATH).expect(404);
        expect(res.body.error.reason_code).toBe('point.no_data');
      } finally {
        await scopedApp.close();
      }
    });

    it('shouldRejectNonNumericIds_withValidationFailed422', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/points/abc/latest').expect(422);
      expect(res.body.error.reason_code).toBe('common.validation_failed');
    });
  });

  describe('GET telemetry（interval 路由）', () => {
    const FROM = '2026-09-01T00:00:00Z';
    const TO = '2026-09-01T02:00:00Z'; // 120 分钟窗，正好喂满 120 样本

    it('shouldServeRawFromTheHypertableRoute_andPageByCursor', async () => {
      store.rawCalls = 0;
      store.aggCalls = [];
      const first = await request(app.getHttpServer())
        .get(TELEMETRY_PATH)
        .query({ from: FROM, to: TO, interval: 'raw', limit: 50 })
        .expect(200);
      expect(RawTelemetryPageSchema.safeParse(first.body).success).toBe(true);
      expect(first.body.interval).toBe('raw');
      expect(first.body.items).toHaveLength(50);
      expect(first.body.next_cursor).toBeTruthy();

      const second = await request(app.getHttpServer())
        .get(TELEMETRY_PATH)
        .query({ from: FROM, to: TO, interval: 'raw', limit: 50, cursor: first.body.next_cursor })
        .expect(200);
      expect(second.body.items).toHaveLength(50);
      // 翻页不重不漏：第二页首行严格晚于第一页末行
      expect(second.body.items[0].ts > first.body.items.at(-1).ts).toBe(true);

      const third = await request(app.getHttpServer())
        .get(TELEMETRY_PATH)
        .query({ from: FROM, to: TO, interval: 'raw', limit: 50, cursor: second.body.next_cursor })
        .expect(200);
      expect(third.body.items).toHaveLength(20);
      expect(third.body.next_cursor).toBeNull();
      // raw 路由只打 hypertable 出口，聚合出口零调用（验收要点 1 的服务面）
      expect(store.rawCalls).toBe(3);
      expect(store.aggCalls).toEqual([]);
    });

    it('shouldServe5minFromTheCaggRoute_withBucketShapedItems', async () => {
      store.rawCalls = 0;
      store.aggCalls = [];
      const res = await request(app.getHttpServer())
        .get(TELEMETRY_PATH)
        .query({ from: FROM, to: TO, interval: '5min', limit: 10 })
        .expect(200);
      expect(AggregateTelemetryPageSchema.safeParse(res.body).success).toBe(true);
      expect(res.body.interval).toBe('5min');
      expect(res.body.items[0]).toMatchObject({ avg: 7.5, sample_count: 5 });
      expect(store.rawCalls).toBe(0);
      expect(store.aggCalls).toEqual([5]);
    });

    it('shouldServe1hFromTheCaggRoute', async () => {
      store.aggCalls = [];
      const res = await request(app.getHttpServer())
        .get(TELEMETRY_PATH)
        .query({ from: FROM, to: '2026-09-02T00:00:00Z', interval: '1h', limit: 200 })
        .expect(200);
      expect(res.body.interval).toBe('1h');
      expect(store.aggCalls).toEqual([60]);
    });
  });

  describe('负路径：参数与跨度（验收要点 2）', () => {
    it('shouldReturnRangeInvalid422_withCapDetails_whenSpanExceedsTheRawCap', async () => {
      const res = await request(app.getHttpServer())
        .get(TELEMETRY_PATH)
        .query({
          from: '2026-01-01T00:00:00Z',
          to: '2026-09-01T00:00:00Z', // 243 天 > raw 31 天
          interval: 'raw',
        })
        .expect(422);
      expect(ApiErrorEnvelopeSchema.safeParse(res.body).success).toBe(true);
      expect(res.body.error.reason_code).toBe('telemetry.range_invalid');
      expect(res.body.error.details).toMatchObject({ interval: 'raw', max_span_days: 31 });
    });

    it('shouldAcceptTheSameSpan_onACoarserGrain', async () => {
      await request(app.getHttpServer())
        .get(TELEMETRY_PATH)
        .query({
          from: '2026-01-01T00:00:00Z',
          to: '2026-09-01T00:00:00Z',
          interval: '1h',
        })
        .expect(200);
    });

    it('shouldRejectInvalidIntervalsAndLimits_withValidationFailed', async () => {
      const badInterval = await request(app.getHttpServer())
        .get(TELEMETRY_PATH)
        .query({ interval: '15min' })
        .expect(422);
      expect(badInterval.body.error.reason_code).toBe('common.validation_failed');

      const badLimit = await request(app.getHttpServer())
        .get(TELEMETRY_PATH)
        .query({ limit: 999 })
        .expect(422);
      expect(badLimit.body.error.reason_code).toBe('common.validation_failed');
    });

    it('shouldRejectGarbageCursors_withValidationFailed', async () => {
      const res = await request(app.getHttpServer())
        .get(TELEMETRY_PATH)
        .query({ cursor: '%%not-a-cursor%%' })
        .expect(422);
      expect(res.body.error.reason_code).toBe('common.validation_failed');
    });

    it('shouldRejectReversedWindows_withRangeInvalid', async () => {
      const res = await request(app.getHttpServer())
        .get(TELEMETRY_PATH)
        .query({ from: '2026-09-02T00:00:00Z', to: '2026-09-01T00:00:00Z' })
        .expect(422);
      expect(res.body.error.reason_code).toBe('telemetry.range_invalid');
    });
  });
});

describe('遥测查询 e2e（真实模块 + 空配置 → dev 降级形态）', () => {
  let bareApp: INestApplication;

  beforeAll(async () => {
    process.env.LOG_LEVEL = 'silent';
    process.env.KAFKA_BROKERS = '';
    process.env.TSDB_READ_URL = '';
    process.env.PG_URL = '';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    bareApp = configureApp(moduleRef.createNestApplication());
    await bareApp.init();
  });

  afterAll(async () => {
    await bareApp.close();
  });

  it('shouldReturnTelemetryStoreUnavailable503_whenNoStoreIsConfigured', async () => {
    for (const path of [LATEST_PATH, TELEMETRY_PATH]) {
      const res = await request(bareApp.getHttpServer()).get(path).expect(503);
      expect(ApiErrorEnvelopeSchema.safeParse(res.body).success).toBe(true);
      expect(res.body.error.reason_code).toBe('telemetry.store_unavailable');
    }
  });

  it('shouldKeepLivenessAndMetricsHealthy_whileTelemetryIsDegraded', async () => {
    await request(bareApp.getHttpServer()).get('/healthz').expect(200);
    await request(bareApp.getHttpServer()).get('/metrics').expect(200);
  });
});
