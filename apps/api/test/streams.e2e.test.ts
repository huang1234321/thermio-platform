/**
 * SSE 通道 e2e（platform.md §10 + M3-monitor §3.5，IMPL-14；PG 门控 + fake TSDB）。
 *
 * 覆盖 §14 负路径最小组 + 通道语义：
 * - 建流前校验：缺失 point_ids 422 / >500 整单 400 stream.limit_exceeded /
 *   越权点整单 400 point.not_found（details.point_ids）/ 连接数满 503 stream.server_busy
 *   + Retry-After: 5 / TSDB 不可用 503 telemetry.store_unavailable（建流前显式降级）；
 * - 建流后：text/event-stream + 首帧快照 + 节流窗口变更点推送（幂等最新值语义）+
 *   `: ping` 心跳 + 断开清理（连接 gauge 归零）。
 *
 * 快通道参数：SSE_THROTTLE_WINDOW_MS=1000（§12 下限）、心跳 500ms、并发上限 2
 * （server_busy 用例可触发）——生产默认 2000/15000/100 不变（config 钉死）。
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import pg from 'pg';
import { Test } from '@nestjs/testing';
import type { LoginResponse, TelemetryRawSample } from '@thermio/shared-types';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { TELEMETRY_STORE } from '../src/telemetry/telemetry.tokens.js';
import type { TelemetryStore } from '../src/telemetry/tsdb-read.repository.js';
import { TelemetryStoreUnavailableError } from '../src/telemetry/telemetry-store.error.js';
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
let baseUrl: string;
let world: SeededWorld;
let adminToken: string;
let primaryPoint: number;

/** fake TSDB：latest 可变（推送语义用例的核心驱动）+ 可切换为不可用形态。 */
const latestSamples = new Map<number, TelemetryRawSample>();
let unavailable = false;
const fakeStore: TelemetryStore = {
  latest: () => Promise.resolve(null),
  latestBatch: (pointIds) => {
    if (unavailable) return Promise.reject(new TelemetryStoreUnavailableError('e2e 停用形态'));
    const map = new Map<number, TelemetryRawSample>();
    for (const id of pointIds) {
      const sample = latestSamples.get(id);
      if (sample !== undefined) map.set(id, sample);
    }
    return Promise.resolve(map);
  },
  listRaw: () => Promise.resolve([]),
  listAggregate: () => Promise.resolve([]),
  windowEndpoints: () => Promise.resolve(new Map()),
};

/** node:http 原生 SSE 客户端（vitest worker 内 undici 流式读取不稳定，换确定性实现）。 */
interface SseClient {
  readonly buffer: () => string;
  waitUntil(predicate: (buffer: string) => boolean, timeoutMs?: number): Promise<string>;
  abort(): void;
}

function openStream(url: string, token: string): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const request = http.get(url, { headers: { Authorization: `Bearer ${token}` } }, (response) => {
      response.setEncoding('utf-8');
      response.on('data', (chunk: string) => {
        buffer += chunk;
      });
      const client: SseClient = {
        buffer: () => buffer,
        waitUntil: (predicate, timeoutMs = 8_000) =>
          new Promise<string>((waitResolve, waitReject) => {
            const deadline = Date.now() + timeoutMs;
            const tick = (): void => {
              if (predicate(buffer)) {
                waitResolve(buffer);
                return;
              }
              if (Date.now() > deadline) {
                waitReject(
                  new Error(`waitUntil 超时，缓冲区：${JSON.stringify(buffer.slice(-400))}`),
                );
                return;
              }
              setTimeout(tick, 50);
            };
            tick();
          }),
        abort: () => {
          response.destroy();
          request.destroy();
        },
      };
      if ((response.statusCode ?? 0) >= 400) {
        // 错误形态：聚合 body 后以 {status, text} reject——调用方按需断言信封
        let errorBody = '';
        response.on('data', (chunk: string) => {
          errorBody += chunk;
        });
        response.on('end', () => {
          reject(
            Object.assign(new Error(`HTTP ${String(response.statusCode)}`), {
              statusCode: response.statusCode,
              body: errorBody,
              headers: response.headers,
            }),
          );
        });
        return;
      }
      resolve(client);
    });
    request.on('error', (err: Error) => {
      reject(err);
    });
  });
}

/** 解析 SSE 文本中的第 N 个 telemetry 事件 data 载荷。 */
function parseEvents(buffer: string): Array<{ points: Array<{ point_id: number }> }> {
  const events: Array<{ points: Array<{ point_id: number }> }> = [];
  for (const block of buffer.split('\n\n')) {
    const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
    if (dataLine !== undefined && block.includes('event: telemetry')) {
      events.push(
        JSON.parse(dataLine.slice('data: '.length)) as { points: Array<{ point_id: number }> },
      );
    }
  }
  return events;
}

skipped('SSE 通道 e2e：/streams/telemetry（IMPL-14）', () => {
  beforeAll(async () => {
    world = await seedWorld();
    // 单点位种子（可见性正/负路径共用）
    const pool = new pg.Pool({ connectionString: E2E_ADMIN_URL, max: 1 });
    try {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO point (tenant_id, building_id, equipment_id, source_type, raw_name,
                            quantity_type, display_name, direction)
         VALUES ($1, $2, NULL, 'virtual', 'SSE.E2E.RUN', 'run_status', 'SSE.E2E.RUN', 'read')
         RETURNING id`,
        [world.tenantA, world.buildingA1],
      );
      primaryPoint = Number(result.rows[0]?.id);
    } finally {
      await pool.end();
    }

    process.env.PG_API_URL = E2E_API_URL;
    process.env.PG_AUTH_URL = E2E_AUTH_URL;
    process.env.AUTH_JWT_SECRET = E2E_JWT_SECRET;
    process.env.LOG_LEVEL = 'silent';
    process.env.KAFKA_BROKERS = '';
    process.env.SSE_THROTTLE_WINDOW_MS = '1000';
    process.env.SSE_HEARTBEAT_INTERVAL_MS = '500';
    process.env.SSE_MAX_CONNECTIONS = '2';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TELEMETRY_STORE)
      .useValue(fakeStore)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(address.port)}`;

    const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin-a@dt113.test', password: PASSWORDS.admin }),
    });
    adminToken = ((await login.json()) as LoginResponse).access_token;
  });

  afterAll(async () => {
    await app.close();
  });

  function streamUrl(pointIds: string): string {
    return `${baseUrl}/api/v1/streams/telemetry?point_ids=${pointIds}`;
  }

  it('shouldRejectMissingPointIds_with422', async () => {
    const response = await fetch(`${baseUrl}/api/v1/streams/telemetry`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { reason_code: string } };
    expect(body.error.reason_code).toBe('common.validation_failed');
  });

  it('shouldRejectOver500Points_wholeBatch_withStreamLimitExceeded', async () => {
    const csv = Array.from({ length: 501 }, (_, i) => String(primaryPoint + i)).join(',');
    const response = await fetch(streamUrl(csv), {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { reason_code: string } };
    expect(body.error.reason_code).toBe('stream.limit_exceeded');
  });

  it('shouldRejectInvisiblePoints_wholeBatch_withPointNotFound', async () => {
    const response = await fetch(streamUrl(`${String(primaryPoint)},999999999`), {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { reason_code: string; details: { point_ids: number[] } };
    };
    expect(body.error.reason_code).toBe('point.not_found');
    expect(body.error.details.point_ids).toEqual([999999999]);
  });

  it('shouldStreamSnapshot_thenPushChangedPointsWithHeartbeat', async () => {
    latestSamples.set(primaryPoint, {
      ts: '2026-09-27T06:00:00Z',
      value: null,
      value_text: '1',
      quality: 0,
    });
    const client = await openStream(streamUrl(String(primaryPoint)), adminToken);

    // 首帧 = 订阅集快照基线
    const first = await client.waitUntil((buffer) => parseEvents(buffer).length >= 1);
    expect(parseEvents(first)[0]?.points.map((p) => p.point_id)).toEqual([primaryPoint]);

    // 变更驱动：窗口轮询 diff 出变更点（幂等最新值：旧 ts 不重发）
    latestSamples.set(primaryPoint, {
      ts: '2026-09-27T06:00:05Z',
      value: null,
      value_text: '0',
      quality: 0,
    });
    const second = await client.waitUntil((buffer) => parseEvents(buffer).length >= 2);
    expect(parseEvents(second)[1]?.points.map((p) => p.point_id)).toEqual([primaryPoint]);

    // 心跳注释行（500ms 快通道）
    await client.waitUntil((buffer) => buffer.includes(': ping'));
    client.abort();
  }, 15_000);

  it('shouldReturnServerBusy_withRetryAfter_whenConnectionsFull', async () => {
    latestSamples.set(primaryPoint, {
      ts: '2026-09-27T06:00:00Z',
      value: 1,
      value_text: null,
      quality: 0,
    });
    const held: SseClient[] = [];
    try {
      for (let i = 0; i < 2; i += 1) {
        held.push(await openStream(streamUrl(String(primaryPoint)), adminToken));
      }
      const rejection = (await openStream(streamUrl(String(primaryPoint)), adminToken).catch(
        (err: unknown) => err,
      )) as Error & {
        statusCode?: number;
        body?: string;
        headers?: Record<string, string | string[] | undefined>;
      };
      expect(rejection).toBeInstanceOf(Error);
      expect(rejection.statusCode).toBe(503);
      expect(rejection.headers?.['retry-after']).toBe('5');
      const envelope = JSON.parse(rejection.body ?? '{}') as { error: { reason_code: string } };
      expect(envelope.error.reason_code).toBe('stream.server_busy');
    } finally {
      for (const client of held) client.abort();
    }
    // 连接清理后容量恢复（close 事件同步释放 registry 槽位）
    await new Promise((resolve) => setTimeout(resolve, 300));
    const reopened = await openStream(streamUrl(String(primaryPoint)), adminToken);
    reopened.abort();
  }, 15_000);

  it('shouldDegradeExplicitly_whenTelemetryStoreUnavailable', async () => {
    unavailable = true;
    try {
      const response = await fetch(streamUrl(String(primaryPoint)), {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: { reason_code: string } };
      expect(body.error.reason_code).toBe('telemetry.store_unavailable');
    } finally {
      unavailable = false;
    }
  });
});
