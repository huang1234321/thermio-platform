/**
 * §5.2 上下线事件处理测试（蓝本 IMPL-7 验收点 2 + §7 端点纪律）。
 *
 * 断言口径：
 * - connected/disconnected → 单调卫语句 UPDATE（SQL 形状 + 参数绑定 + 租户上下文）；
 * - 乱序/重复事件：卫语句 rowCount=0 → stale_ignored，不回写不告警（幂等即正确性）；
 * - 离线告警联动留痕：keepalive_timeout/discarded/takeover 触发 WARN/ERROR + 指标，
 *   closed/kicked 不触发（§5.2-3 闭集）；takeover/discarded 提级（验收点：提级语义）；
 * - 未注册 clientid → WARN + 忽略（§5.2-1）；
 * - 畸形事件体 → 422 信封（§7 4xx 语义）；DB 异常 → 5xx 信封（webhook 重投幂等吸收）。
 */
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { configureApp } from '../../src/bootstrap.js';
import { loadConfig } from '../../src/config.js';
import { APP_CONFIG } from '../../src/infrastructure/core.module.js';
import { LOGGER } from '../../src/infrastructure/logger.js';
import { InternalMqttModule } from '../../src/internal-mqtt/internal-mqtt.module.js';
import { AUTH_DB, TENANT_DB } from '../../src/internal-mqtt/db.js';
import { PASSWORD_VERIFIER } from '../../src/internal-mqtt/password-verifier.js';
import { MQTT_AUTH_FAILURE_COUNTER } from '../../src/internal-mqtt/failure-counter.js';
import { SlidingWindowFailureCounter } from '../../src/internal-mqtt/failure-counter.js';
import {
  FakeDbQuery,
  FakePasswordVerifier,
  FakeTenantDb,
  applyProductionGlobals,
  createCapturingLogger,
} from './helpers.js';
import { MetricsService } from '../../src/infrastructure/metrics/metrics.service.js';

const SERVICE_TOKEN = 'test-emqx-internal-token-0123456789abcdef';
const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const GATEWAY_ID = '11111111-1111-1111-1111-111111111111';

function connectedEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: 'client.connected',
    clientid: 'GW-BLDG-A-01',
    username: 'gw-bldg-a-01@tenant-a',
    peerhost: '10.0.7.31',
    ts: 1793412345678,
    ...overrides,
  };
}

function disconnectedEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: 'client.disconnected',
    clientid: 'GW-BLDG-A-01',
    username: 'gw-bldg-a-01@tenant-a',
    reason: 'closed',
    ts: 1793412399999,
    ...overrides,
  };
}

interface EventsHarness {
  app: INestApplication;
  authDb: FakeDbQuery;
  tenantDb: FakeTenantDb;
  innerDb: FakeDbQuery;
  lines: string[];
  /** 每次 UPDATE 的 rowCount 编程（默认全部命中=1）。 */
  setUpdateRowCount: (n: number) => void;
}

async function createEventsHarness(
  opts: { readonly unknownClient?: boolean } = {},
): Promise<EventsHarness> {
  const { logger, lines } = createCapturingLogger();
  const authDb = new FakeDbQuery(() =>
    opts.unknownClient === true
      ? []
      : [{ id: GATEWAY_ID, tenant_id: TENANT_A, mqtt_client_id: 'GW-BLDG-A-01' }],
  );
  // pg rowCount 语义：0 = 卫语句吸收（旧事件），1 = 命中翻转
  const innerDb = new FakeDbQuery(() => []);
  const tenantDb = new FakeTenantDb(innerDb);

  const config = {
    ...loadConfig({
      LOG_LEVEL: 'silent',
      KAFKA_BROKERS: '',
      EMQX_INTERNAL_TOKEN: SERVICE_TOKEN,
    }),
  };

  const moduleRef = await Test.createTestingModule({ imports: [InternalMqttModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(config)
    .overrideProvider(LOGGER)
    .useValue(logger)
    .overrideProvider(AUTH_DB)
    .useValue(authDb)
    .overrideProvider(TENANT_DB)
    .useValue(tenantDb)
    .overrideProvider(PASSWORD_VERIFIER)
    .useValue(new FakePasswordVerifier([]))
    .overrideProvider(MQTT_AUTH_FAILURE_COUNTER)
    .useValue(new SlidingWindowFailureCounter(100, 300_000, () => {}))
    .compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  applyProductionGlobals(app, logger, new MetricsService());
  await app.init();
  return {
    app,
    authDb,
    tenantDb,
    innerDb,
    lines,
    setUpdateRowCount: (n: number) => {
      innerDb.rowCountOverride = n;
    },
  };
}

describe('POST /internal/mqtt/events（emqx.md §5.2）', () => {
  let h: EventsHarness;

  beforeAll(async () => {
    h = await createEventsHarness();
  });

  afterAll(async () => {
    await h.app.close();
  });

  it('connected → 单调卫语句 UPDATE status=online（SQL 形状 + 参数绑定 + 租户上下文）', async () => {
    const res = await request(h.app.getHttpServer())
      .post('/internal/mqtt/events')
      .set('authorization', `Bearer ${SERVICE_TOKEN}`)
      .send(connectedEvent())
      .expect(200); // @HttpCode(200)：webhook 只看 2xx，非资源创建语义
    expect(res.body).toEqual({ accepted: true });

    // 写路径切了租户上下文（§5.2-2：SET LOCAL 纪律 → withTenant(tenant_id)）
    expect(h.tenantDb.tenantIds).toEqual([TENANT_A]);
    const update = h.innerDb.calls[0];
    expect(update?.sql).toContain('UPDATE gateway');
    expect(update?.sql).toContain(
      'SET status = $1::text, last_seen_at = to_timestamp($2::double precision / 1000)',
    );
    // 单调卫语句在 WHERE 里（乱序/重复吸收）
    expect(update?.sql).toContain(
      'AND (last_seen_at IS NULL OR last_seen_at <= to_timestamp($2::double precision / 1000))',
    );
    expect(update?.sql).toContain('WHERE mqtt_client_id = $3');
    expect(update?.params).toEqual(['online', 1793412345678, 'GW-BLDG-A-01']);
  });

  it('disconnected(closed) → offline，但无离线信号（§5.2-3 闭集外）', async () => {
    const res = await request(h.app.getHttpServer())
      .post('/internal/mqtt/events')
      .set('authorization', `Bearer ${SERVICE_TOKEN}`)
      .send(disconnectedEvent({ reason: 'closed' }))
      .expect(200);
    expect(res.body).toEqual({ accepted: true });
    expect(h.innerDb.calls.at(-1)?.params).toEqual(['offline', 1793412399999, 'GW-BLDG-A-01']);
    expect(h.lines.some((l) => l.includes('gateway_offline_signal'))).toBe(false);
  });

  it('乱序/重复事件（卫语句 rowCount=0）→ 不回写、留 stale 痕迹（验收点 2）', async () => {
    h.setUpdateRowCount(0);
    const res = await request(h.app.getHttpServer())
      .post('/internal/mqtt/events')
      .set('authorization', `Bearer ${SERVICE_TOKEN}`)
      .send(disconnectedEvent({ reason: 'keepalive_timeout', ts: 1793412000000 }))
      .expect(200);
    expect(res.body).toEqual({ accepted: true });
    expect(h.lines.some((l) => l.includes('gateway_event_stale_ignored'))).toBe(true);
    // 关键：旧事件不触发离线信号（避免已重连网关误报告警）
    expect(h.lines.some((l) => l.includes('gateway_offline_signal'))).toBe(false);
    h.setUpdateRowCount(1);
  });

  it('disconnected(keepalive_timeout) → offline + 离线信号 WARN 留痕（§5.2-3）', async () => {
    await request(h.app.getHttpServer())
      .post('/internal/mqtt/events')
      .set('authorization', `Bearer ${SERVICE_TOKEN}`)
      .send(disconnectedEvent({ reason: 'keepalive_timeout' }))
      .expect(200);
    const signal = h.lines.find((l) => l.includes('gateway_offline_signal'));
    expect(signal).toBeDefined();
    expect(signal).toContain('keepalive_timeout');
    // 留痕不含用户名/密钥类字段之外的敏感面：事件用户名是设备账号（非敏感），可留
    expect(signal).toContain('GW-BLDG-A-01');
  });

  it('disconnected(takeover) → 提级 error 级（§5.1 配置事故信号）', async () => {
    await request(h.app.getHttpServer())
      .post('/internal/mqtt/events')
      .set('authorization', `Bearer ${SERVICE_TOKEN}`)
      .send(disconnectedEvent({ reason: 'takeover' }))
      .expect(200);
    const line = h.lines
      .filter((l) => l.includes('gateway_offline_signal'))
      .find((l) => l.includes('"reason":"takeover"'));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line ?? '{}') as { level: number };
    expect(parsed.level).toBe(50); // pino: error（takeover/discarded 提级）
  });

  it('未注册 clientid → WARN + 忽略（§5.2-1，不报错防 webhook 重投风暴）', async () => {
    const local = await createEventsHarness({ unknownClient: true });
    try {
      const res = await request(local.app.getHttpServer())
        .post('/internal/mqtt/events')
        .set('authorization', `Bearer ${SERVICE_TOKEN}`)
        .send(connectedEvent({ clientid: 'GW-GHOST-00' }))
        .expect(200);
      expect(res.body).toEqual({ accepted: true });
      expect(local.lines.some((l) => l.includes('mqtt_event_unknown_clientid'))).toBe(true);
      // 没有走到写路径
      expect(local.tenantDb.tenantIds).toEqual([]);
    } finally {
      await local.app.close();
    }
  });

  it('畸形事件体 → 422 信封 common.validation_failed（§7 4xx 语义）', async () => {
    const res = await request(h.app.getHttpServer())
      .post('/internal/mqtt/events')
      .set('authorization', `Bearer ${SERVICE_TOKEN}`)
      .send({ event: 'client.exploded', clientid: '', ts: -1 })
      .expect(422);
    expect(res.body.error.reason_code).toBe('common.validation_failed');
    expect(res.body.error.details).toBeDefined();
  });

  it('读路径 DB 异常 → 5xx 信封 common.internal_error（不泄露内部）', async () => {
    const local = await createEventsHarness();
    try {
      local.authDb.dispatch = () => {
        throw new Error('pg connection reset');
      };
      const res = await request(local.app.getHttpServer())
        .post('/internal/mqtt/events')
        .set('authorization', `Bearer ${SERVICE_TOKEN}`)
        .send(connectedEvent())
        .expect(500);
      expect(res.body.error.reason_code).toBe('common.internal_error');
      expect(JSON.stringify(res.body)).not.toContain('pg connection reset');
    } finally {
      await local.app.close();
    }
  });

  it('缺 Bearer → 401 auth.service_unauthorized（§7：内部端点不豁免认证）', async () => {
    const res = await request(h.app.getHttpServer())
      .post('/internal/mqtt/events')
      .send(connectedEvent())
      .expect(401);
    expect(res.body.error.reason_code).toBe('auth.service_unauthorized');
  });
});
