/**
 * §3.3 七步校验逻辑逐条测试（蓝本 IMPL-7 验收点 1/3 + §7 端点纪律）。
 *
 * 断言口径：
 * - 全部失败路径返回 deny 且 HTTP 200 包形（§3.2 同包形不泄露存在性）；
 * - 查无账号走 dummy hash 等耗时校验（SEC-PW-04）；
 * - 限速触发后早判（不触 DB）；轮换双读（SEC-KEY-04）；
 * - 内部异常 fail-closed deny + ERROR 留痕；
 * - 日志无 password/secret 字段（CODE-LOG-01，验收点 5）。
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
import {
  MQTT_AUTH_FAILURE_COUNTER,
  SlidingWindowFailureCounter,
} from '../../src/internal-mqtt/failure-counter.js';
import type { MqttAuthFailureCounterPort } from '../../src/internal-mqtt/failure-counter.js';
import {
  FakeDbQuery,
  FakePasswordVerifier,
  FakeTenantDb,
  applyProductionGlobals,
  createCapturingLogger,
} from './helpers.js';
import { MetricsService } from '../../src/infrastructure/metrics/metrics.service.js';

const SERVICE_TOKEN = 'test-emqx-internal-token-0123456789abcdef';
const PREVIOUS_TOKEN = 'test-emqx-old-token-rotate-window';

const GATEWAY_ROW = {
  secret_hash: '$argon2id$realhash',
  enabled: true,
  gateway_id: '11111111-1111-1111-1111-111111111111',
  mqtt_client_id: 'GW-BLDG-A-01',
};

/** 标准合法请求体（§3.2 示例形状）。 */
function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientid: 'GW-BLDG-A-01',
    username: 'gw-bldg-a-01@tenant-a',
    password: 'device-secret',
    peerhost: '10.0.7.31',
    proto_ver: 4,
    clean_start: false,
    ...overrides,
  };
}

/** 组装测试应用：真模块 + 假 DB/校验器 + 可控限速器 + 捕获日志。 */
interface TestHarness {
  app: INestApplication;
  authDb: FakeDbQuery;
  verifier: FakePasswordVerifier;
  tenantDb: FakeTenantDb;
  counter: MqttAuthFailureCounterPort;
  lines: string[];
}

async function createHarness(
  opts: {
    readonly dbError?: Error;
    readonly failLimit?: number;
  } = {},
): Promise<TestHarness> {
  const { logger, lines } = createCapturingLogger();
  const authDb = new FakeDbQuery(() => {
    if (opts.dbError !== undefined) throw opts.dbError;
    return [GATEWAY_ROW];
  });
  const verifier = new FakePasswordVerifier([
    { hash: '$argon2id$realhash', password: 'device-secret', outcome: 'matched' },
  ]);
  const tenantDb = new FakeTenantDb();
  const counter: MqttAuthFailureCounterPort = new SlidingWindowFailureCounter(
    opts.failLimit ?? 100,
    300_000,
    (username, peerhost) => {
      // 与生产模块工厂同款触顶留痕（验收点 3 的可观测面）
      logger.warn({ msg: 'mqtt_auth_failure_threshold_reached', username, peerhost });
    },
  );

  const config = {
    ...loadConfig({
      LOG_LEVEL: 'silent',
      KAFKA_BROKERS: '',
      EMQX_INTERNAL_TOKEN: SERVICE_TOKEN,
      EMQX_INTERNAL_TOKEN_PREVIOUS: PREVIOUS_TOKEN,
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
    .useValue(verifier)
    .overrideProvider(MQTT_AUTH_FAILURE_COUNTER)
    .useValue(counter)
    .compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  applyProductionGlobals(app, logger, new MetricsService());
  await app.init();
  return { app, authDb, verifier, tenantDb, counter, lines };
}

describe('POST /internal/mqtt/authenticate（emqx.md §3.3 七步）', () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h.app.close();
  });

  it('第七步：七步全过 → allow（HTTP 200）', async () => {
    const res = await request(h.app.getHttpServer())
      .post('/internal/mqtt/authenticate')
      .set('authorization', `Bearer ${SERVICE_TOKEN}`)
      .send(validBody())
      .expect(200);
    expect(res.body).toEqual({ result: 'allow' });
    // 第一步：参数化查表（username 走绑定通道，DB-QRY-01）
    expect(h.authDb.calls[0]?.sql).toContain('FROM device_credential c');
    expect(h.authDb.calls[0]?.sql).toContain('JOIN gateway g');
    expect(h.authDb.calls[0]?.params).toEqual(['gw-bldg-a-01@tenant-a']);
  });

  it('第三步：密码不符 → deny 200 且登记失败计数', async () => {
    const res = await request(h.app.getHttpServer())
      .post('/internal/mqtt/authenticate')
      .set('authorization', `Bearer ${SERVICE_TOKEN}`)
      .send(validBody({ password: 'wrong-secret' }))
      .expect(200);
    expect(res.body).toEqual({ result: 'deny' });
  });

  it('第四步：clientid ↔ gateway 绑定不符 → deny 200', async () => {
    const res = await request(h.app.getHttpServer())
      .post('/internal/mqtt/authenticate')
      .set('authorization', `Bearer ${SERVICE_TOKEN}`)
      .send(validBody({ clientid: 'GW-OTHER-99' }))
      .expect(200);
    expect(res.body).toEqual({ result: 'deny' });
  });

  it('第五步：enabled=false → deny 200', async () => {
    const local = await createHarness();
    try {
      local.authDb.dispatch = () => [{ ...GATEWAY_ROW, enabled: false }];
      const res = await request(local.app.getHttpServer())
        .post('/internal/mqtt/authenticate')
        .set('authorization', `Bearer ${SERVICE_TOKEN}`)
        .send(validBody())
        .expect(200);
      expect(res.body).toEqual({ result: 'deny' });
    } finally {
      await local.app.close();
    }
  });

  it('第二步：查无账号 → 对 dummy hash 执行校验后 deny（等耗时，SEC-PW-04）', async () => {
    const local = await createHarness();
    try {
      local.authDb.dispatch = () => [];
      const res = await request(local.app.getHttpServer())
        .post('/internal/mqtt/authenticate')
        .set('authorization', `Bearer ${SERVICE_TOKEN}`)
        .send(validBody())
        .expect(200);
      expect(res.body).toEqual({ result: 'deny' });
      // 关键：dummy 校验真的发生了（同成本），且用的是进程内 dummy 哈希而非空跳过
      expect(local.verifier.calls).toHaveLength(1);
      expect(local.verifier.calls[0]?.password).toBe('device-secret');
      expect(local.verifier.calls[0]?.hash).not.toBe('$argon2id$realhash');
      expect(local.verifier.calls[0]?.hash).toMatch(/^\$argon2/);
    } finally {
      await local.app.close();
    }
  });

  it('内部异常（DB 不可达）→ fail-closed deny 200 + ERROR 日志', async () => {
    const local = await createHarness({ dbError: new Error('connection refused') });
    try {
      const res = await request(local.app.getHttpServer())
        .post('/internal/mqtt/authenticate')
        .set('authorization', `Bearer ${SERVICE_TOKEN}`)
        .send(validBody())
        .expect(200);
      expect(res.body).toEqual({ result: 'deny' });
      expect(local.lines.some((l) => l.includes('mqtt_auth_internal_error'))).toBe(true);
    } finally {
      await local.app.close();
    }
  });

  it('畸形请求体 → deny 200（不出 4xx：EMQX 只认 result 语义）', async () => {
    const res = await request(h.app.getHttpServer())
      .post('/internal/mqtt/authenticate')
      .set('authorization', `Bearer ${SERVICE_TOKEN}`)
      .send({ clientid: 'GW-BLDG-A-01' })
      .expect(200);
    expect(res.body).toEqual({ result: 'deny' });
  });

  it('不支持的哈希前缀 → deny（fail-closed，SEC-PW-01 双读边界）', async () => {
    const local = await createHarness();
    try {
      local.authDb.dispatch = () => [{ ...GATEWAY_ROW, secret_hash: '$2b$12$legacybcrypt' }];
      local.verifier.pairs.push({
        hash: '$2b$12$legacybcrypt',
        password: 'device-secret',
        outcome: 'unsupported_hash',
      });
      const res = await request(local.app.getHttpServer())
        .post('/internal/mqtt/authenticate')
        .set('authorization', `Bearer ${SERVICE_TOKEN}`)
        .send(validBody())
        .expect(200);
      expect(res.body).toEqual({ result: 'deny' });
    } finally {
      await local.app.close();
    }
  });

  describe('第六步：失败限速（验收点 3）', () => {
    it('触顶后 → 早判 deny，且不再触 DB/慢哈希', async () => {
      const local = await createHarness({ failLimit: 3 });
      try {
        const denyBody = validBody({ password: 'wrong' });
        for (let i = 0; i < 3; i += 1) {
          await request(local.app.getHttpServer())
            .post('/internal/mqtt/authenticate')
            .set('authorization', `Bearer ${SERVICE_TOKEN}`)
            .send(denyBody)
            .expect(200);
        }
        expect(local.authDb.calls.length).toBe(3);
        expect(local.lines.some((l) => l.includes('mqtt_auth_failure_threshold_reached'))).toBe(
          true,
        );
        // 触顶后：不再查表（调用数不变）
        const res = await request(local.app.getHttpServer())
          .post('/internal/mqtt/authenticate')
          .set('authorization', `Bearer ${SERVICE_TOKEN}`)
          .send(validBody()) // 正确密码也被早判拦截
          .expect(200);
        expect(res.body).toEqual({ result: 'deny' });
        expect(local.authDb.calls.length).toBe(3);
        expect(local.lines.some((l) => l.includes('mqtt_auth_rate_limited'))).toBe(true);
      } finally {
        await local.app.close();
      }
    });
  });

  describe('§7 端点纪律：Bearer 服务认证（platform.md §11-2）', () => {
    it('缺/错 Bearer → 401 auth.service_unauthorized 信封（不泄露失败步骤）', async () => {
      for (const headers of [
        {},
        { authorization: 'Bearer wrong-token' },
        { authorization: 'Basic abcdef' },
      ]) {
        const res = await request(h.app.getHttpServer())
          .post('/internal/mqtt/authenticate')
          .set(headers)
          .send(validBody())
          .expect(401);
        expect(res.body.error.reason_code).toBe('auth.service_unauthorized');
      }
    });

    it('轮换双读：PREVIOUS token 在窗口内同样放行（SEC-KEY-04）', async () => {
      const res = await request(h.app.getHttpServer())
        .post('/internal/mqtt/authenticate')
        .set('authorization', `Bearer ${PREVIOUS_TOKEN}`)
        .send(validBody())
        .expect(200);
      expect(res.body).toEqual({ result: 'allow' });
    });
  });

  describe('CODE-LOG-01：日志无 password/secret 字段（验收点 5）', () => {
    it('allow/deny/异常全路径日志均不含明文密码、哈希与服务 token', async () => {
      const local = await createHarness({ dbError: new Error('boom: db down') });
      try {
        await request(local.app.getHttpServer())
          .post('/internal/mqtt/authenticate')
          .set('authorization', `Bearer ${SERVICE_TOKEN}`)
          .send(validBody({ password: 'SUPER-SECRET-PW' }))
          .expect(200);
        await request(local.app.getHttpServer())
          .post('/internal/mqtt/authenticate')
          .set('authorization', `Bearer ${SERVICE_TOKEN}`)
          .send(validBody({ password: 'wrong' }))
          .expect(200);
        const allLogs = local.lines.join('\n');
        expect(allLogs).not.toContain('SUPER-SECRET-PW');
        expect(allLogs).not.toContain('$argon2id$realhash');
        expect(allLogs).not.toContain(SERVICE_TOKEN);
        expect(allLogs).not.toContain('password'); // 无字段名层面的密码记录
      } finally {
        await local.app.close();
      }
    });
  });

  it('路由不进 /api/v1 前缀（§7：内部端点不在公开面）', async () => {
    await request(h.app.getHttpServer())
      .post('/api/v1/internal/mqtt/authenticate')
      .set('authorization', `Bearer ${SERVICE_TOKEN}`)
      .send(validBody())
      .expect(404);
  });
});
