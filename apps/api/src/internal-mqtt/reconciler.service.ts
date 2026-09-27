/**
 * 对账循环（emqx.md §5.3，蓝本 IMPL-7 验收点 4）：
 *
 * 每 60s（EMQX_RECONCILE_INTERVAL_MS）对 status='online' 的网关问一遍 EMQX 管理 API；
 * EMQX 已无该会话 → 置 offline + 离线信号留痕（§5.2-3 同一出口）。
 * webhook 丢失时状态收敛不依赖 at-least-once——补偿链路兜底。
 *
 * fail-safe 纪律：单网关探测失败（网络/5xx）只跳过本轮该网关；循环级失败 ERROR 留痕。
 * ts 取 Date.now()——now 恒 ≥ 任何历史事件时刻，单调卫语句不会被补偿翻转击穿。
 * 未配置 EMQX_MANAGEMENT_BASE_URL = 对账停用（dev 栈内置认证形态，IMPL-8 接 provisioning）。
 */
import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import { APP_CONFIG } from '../infrastructure/core.module.js';
import { LOGGER } from '../infrastructure/logger.js';
import { MetricsService } from '../infrastructure/metrics/metrics.service.js';
import { EMQX_ADMIN, type EmqxAdminPort } from './emqx-admin.client.js';
import { GatewayStatusService } from './gateway-status.service.js';

@Injectable()
export class MqttReconcilerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger: Logger;
  private timer: NodeJS.Timeout | null = null;
  private cycleInFlight = false;

  constructor(
    @Inject(GatewayStatusService) private readonly gatewayStatus: GatewayStatusService,
    @Inject(EMQX_ADMIN) private readonly emqxAdmin: EmqxAdminPort,
    @Inject(LOGGER) rootLogger: Logger,
    @Inject(MetricsService) private readonly metrics: MetricsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.logger = rootLogger.child({ component: 'mqtt-reconciler' });
  }

  onModuleInit(): void {
    if (!this.config.emqxReconcileEnabled) {
      this.logger.warn({
        msg: 'mqtt_reconciler_disabled',
        hint: 'set EMQX_MANAGEMENT_BASE_URL to enable',
      });
      return;
    }
    this.logger.info({
      msg: 'mqtt_reconciler_started',
      interval_ms: this.config.EMQX_RECONCILE_INTERVAL_MS,
    });
    this.timer = setInterval(() => void this.runCycle(), this.config.EMQX_RECONCILE_INTERVAL_MS);
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** 单轮对账（public：验收点 4 的直接测试面）。防重入：上一轮未结束则本轮放弃。 */
  async runCycle(): Promise<{ readonly checked: number; readonly flippedOffline: number }> {
    if (this.cycleInFlight) {
      this.logger.warn({ msg: 'mqtt_reconciler_cycle_skipped_overlap' });
      return { checked: 0, flippedOffline: 0 };
    }
    this.cycleInFlight = true;
    let checked = 0;
    let flippedOffline = 0;
    try {
      const gateways = await this.gatewayStatus.listOnlineGateways();
      for (const gateway of gateways) {
        let hasSession: boolean;
        try {
          hasSession = await this.emqxAdmin.hasClientSession(gateway.mqtt_client_id);
        } catch (err: unknown) {
          // fail-safe：探不到 ≠ 失联。跳过本轮该网关，不动状态。
          this.logger.warn({
            msg: 'mqtt_reconciler_probe_failed',
            clientid: gateway.mqtt_client_id,
            err,
          });
          continue;
        }
        checked += 1;
        if (!hasSession) {
          const applied = await this.gatewayStatus.transition(
            gateway.mqtt_client_id,
            { id: gateway.id, name: gateway.name },
            gateway.tenant_id,
            'offline',
            Date.now(),
            'reconcile_no_session',
          );
          if (applied) flippedOffline += 1;
        }
      }
      this.metrics.recordMqttReconcileCycle('completed');
    } catch (err: unknown) {
      this.metrics.recordMqttReconcileCycle('failed');
      this.logger.error({ msg: 'mqtt_reconciler_cycle_failed', err });
    } finally {
      this.cycleInFlight = false;
    }
    if (flippedOffline > 0) {
      this.logger.info({ msg: 'mqtt_reconciler_flips', checked, flipped_offline: flippedOffline });
    }
    return { checked, flippedOffline };
  }
}
