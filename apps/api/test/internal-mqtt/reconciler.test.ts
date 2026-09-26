/**
 * §5.3 对账循环测试（蓝本 IMPL-7 验收点 4）——stub EMQX 管理 API 端口。
 *
 * 断言口径：
 * - EMQX 已无会话的 online 网关被收敛为 offline（reason=reconcile_no_session，
 *   与事件路径同一条 §5.2-2 租户上下文 + 单调卫语句出口）；
 * - 会话仍在的网关不动；
 * - 单网关探测失败 → 跳过不动（fail-safe：探不到 ≠ 失联，不得连锁清空在线状态）；
 * - 循环级失败 → ERROR 留痕不崩溃。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { MetricsService } from '../../src/infrastructure/metrics/metrics.service.js';
import type { EmqxAdminPort } from '../../src/internal-mqtt/emqx-admin.client.js';
import { GatewayStatusService } from '../../src/internal-mqtt/gateway-status.service.js';
import { MqttReconcilerService } from '../../src/internal-mqtt/reconciler.service.js';
import { FakeDbQuery, FakeTenantDb, createCapturingLogger } from './helpers.js';

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function onlineGateways() {
  return [
    { id: 'gw-1', tenant_id: TENANT_A, mqtt_client_id: 'GW-BLDG-A-01' },
    { id: 'gw-2', tenant_id: TENANT_B, mqtt_client_id: 'GW-BLDG-B-02' },
  ];
}

describe('MqttReconcilerService.runCycle（emqx.md §5.3）', () => {
  let authDb: FakeDbQuery;
  let innerDb: FakeDbQuery;
  let tenantDb: FakeTenantDb;
  let metrics: MetricsService;
  let lines: string[];
  let emqxSessions: Map<string, boolean>;
  let probeShouldFail: boolean;
  let reconciler: MqttReconcilerService;

  beforeEach(() => {
    const { logger, lines: captured } = createCapturingLogger();
    lines = captured;
    authDb = new FakeDbQuery(() => onlineGateways());
    innerDb = new FakeDbQuery(() => []);
    innerDb.rowCountOverride = 1;
    tenantDb = new FakeTenantDb(innerDb);
    metrics = new MetricsService();
    emqxSessions = new Map([
      ['GW-BLDG-A-01', true],
      ['GW-BLDG-B-02', false],
    ]);
    probeShouldFail = false;

    const emqxAdmin: EmqxAdminPort = {
      hasClientSession: (clientid: string) => {
        if (probeShouldFail) throw new Error('management api unreachable');
        return Promise.resolve(emqxSessions.get(clientid) ?? false);
      },
    };
    const gatewayStatus = new GatewayStatusService(authDb, tenantDb, logger, metrics);
    const config = {
      ...loadConfig({
        LOG_LEVEL: 'silent',
        KAFKA_BROKERS: '',
        EMQX_MANAGEMENT_BASE_URL: 'http://emqx.test:18083',
      }),
    };
    reconciler = new MqttReconcilerService(gatewayStatus, emqxAdmin, logger, metrics, config);
  });

  it('EMQX 已无会话 → 收敛 offline（单调卫语句 + 租户上下文 + 离线信号）', async () => {
    const result = await reconciler.runCycle();
    // GW-BLDG-A-01 会话仍在；GW-BLDG-B-02 被翻转
    expect(result).toEqual({ checked: 2, flippedOffline: 1 });
    expect(innerDb.calls).toHaveLength(1);
    const update = innerDb.calls[0];
    expect(update?.sql).toContain('UPDATE gateway');
    expect(update?.sql).toContain(
      'AND (last_seen_at IS NULL OR last_seen_at <= to_timestamp($2::double precision / 1000))',
    );
    expect(update?.params[0]).toBe('offline');
    expect(update?.params[2]).toBe('GW-BLDG-B-02');
    expect(tenantDb.tenantIds).toEqual([TENANT_B]);
    // 对账翻转走离线信号出口（§5.2-3 同源，IMPL-13 接通点）
    const signal = lines.find((l) => l.includes('gateway_offline_signal'));
    expect(signal).toContain('reconcile_no_session');
  });

  it('会话仍在 → 不动', async () => {
    emqxSessions.set('GW-BLDG-B-02', true);
    const result = await reconciler.runCycle();
    expect(result).toEqual({ checked: 2, flippedOffline: 0 });
    expect(innerDb.calls).toHaveLength(0);
  });

  it('探测失败 → 跳过该网关，不动状态（fail-safe）', async () => {
    probeShouldFail = true;
    const result = await reconciler.runCycle();
    expect(result).toEqual({ checked: 0, flippedOffline: 0 });
    expect(innerDb.calls).toHaveLength(0);
    expect(lines.some((l) => l.includes('mqtt_reconciler_probe_failed'))).toBe(true);
  });

  it('扫描面读失败 → 循环 failed 留痕，不抛出（后台任务不崩）', async () => {
    authDb.dispatch = () => {
      throw new Error('pg down');
    };
    const result = await reconciler.runCycle();
    expect(result).toEqual({ checked: 0, flippedOffline: 0 });
    expect(lines.some((l) => l.includes('mqtt_reconciler_cycle_failed'))).toBe(true);
  });

  it('指标：循环 completed 计数', async () => {
    await reconciler.runCycle();
    const text = await metrics.render();
    expect(text).toContain('svc_mqtt_reconcile_cycles_total{outcome="completed"} 1');
    expect(text).toContain('svc_mqtt_offline_signals_total{reason="reconcile_no_session"} 1');
  });
});
