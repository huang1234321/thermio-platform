/**
 * gateway.status / last_seen_at 维护（emqx.md §5.2，蓝本 IMPL-7 验收点 2）。
 *
 * 读走 thermio_auth 旁路（clientid → gateway，跨租户）；写切租户上下文
 * （thermio_api + set_config('app.tenant_id', …, true)，RLS 内）。
 *
 * 单调时间卫语句天然吸收乱序与重复（webhook at-least-once）：旧事件/重放事件
 * 不满足 WHERE 直接空更新——幂等即正确性。last_seen_at 语义 = 连接事件时刻
 * （§5.2 注：数据新鲜度归 ingest stale 检测，不混用）。
 *
 * 离线告警联动（§5.2-3）：告警引擎 IMPL-13 才就绪——v1 先 WARN + 指标留痕
 * （offline_signal），takeover/discarded 提级 error 级（配置事故信号）；
 * onOfflineSignal 端口即 IMPL-13 的接通点。
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { LOGGER } from '../infrastructure/logger.js';
import { MetricsService } from '../infrastructure/metrics/metrics.service.js';
import { ESCALATED_OFFLINE_REASONS, type OfflineAlarmReason } from './contract.js';
import type { DbQueryPort, TenantDbPort } from './db.js';
import { AUTH_DB, TENANT_DB } from './db.js';

/** 对账扫描行（type alias：pg 泛型约束需要隐式索引签名）。 */
export type OnlineGatewayRow = {
  readonly id: string;
  readonly tenant_id: string;
  readonly mqtt_client_id: string;
};

/** §5.2-3 单调卫语句 UPDATE（ts 毫秒 → timestamptz；相等也放行 = 重复事件幂等重写）。 */
const GATEWAY_TRANSITION_SQL = `
UPDATE gateway
SET status = $1::text, last_seen_at = to_timestamp($2::double precision / 1000)
WHERE mqtt_client_id = $3
  AND (last_seen_at IS NULL OR last_seen_at <= to_timestamp($2::double precision / 1000))`;

@Injectable()
export class GatewayStatusService {
  private readonly logger: Logger;

  constructor(
    @Inject(AUTH_DB) private readonly authDb: DbQueryPort,
    @Inject(TENANT_DB) private readonly tenantDb: TenantDbPort,
    @Inject(LOGGER) rootLogger: Logger,
    private readonly metrics: MetricsService,
  ) {
    this.logger = rootLogger.child({ component: 'mqtt-gateway-status' });
  }

  /** clientid → gateway（跨租户旁路读；未注册返回 null）。 */
  async findGatewayByClientId(clientid: string): Promise<{ id: string; tenantId: string } | null> {
    const { rows } = await this.authDb.query<OnlineGatewayRow>(
      'SELECT id, tenant_id, mqtt_client_id FROM gateway WHERE mqtt_client_id = $1',
      [clientid],
    );
    const row = rows[0];
    return row === undefined ? null : { id: row.id, tenantId: row.tenant_id };
  }

  /** §5.3 对账扫描面：当前 status='online' 的网关全集。 */
  async listOnlineGateways(): Promise<OnlineGatewayRow[]> {
    const { rows } = await this.authDb.query<OnlineGatewayRow>(
      'SELECT id, tenant_id, mqtt_client_id FROM gateway WHERE status = $1::text',
      ['online'],
    );
    return rows;
  }

  /**
   * 状态翻转（单调卫语句内）。返回是否真的翻转（false = 旧事件被卫语句吸收）。
   * alarmReason 非 null 时触发离线告警留痕（§5.2-3）。
   */
  async transition(
    clientid: string,
    tenantId: string,
    status: 'online' | 'offline',
    eventTsMs: number,
    alarmReason: OfflineAlarmReason | null,
  ): Promise<boolean> {
    const applied = await this.tenantDb.withTenant(tenantId, async (db: DbQueryPort) => {
      const result = await db.query(GATEWAY_TRANSITION_SQL, [status, eventTsMs, clientid]);
      return (result.rowCount ?? 0) > 0;
    });
    if (!applied) {
      this.logger.debug({
        msg: 'gateway_event_stale_ignored',
        clientid,
        status,
        event_ts_ms: eventTsMs,
      });
      return false;
    }
    this.logger.info({
      msg: 'gateway_status_transition',
      clientid,
      tenant_id: tenantId,
      status,
      event_ts_ms: eventTsMs,
      ...(alarmReason !== null ? { alarm_reason: alarmReason } : {}),
    });
    if (alarmReason !== null) this.leaveOfflineSignalTrace(clientid, tenantId, alarmReason);
    return true;
  }

  /**
   * 离线信号留痕（IMPL-13 接通点）：WARN 日志 + 指标计数。
   * takeover/discarded 提级 error（§5.1：配置事故信号，warning 以上）。
   */
  private leaveOfflineSignalTrace(
    clientid: string,
    tenantId: string,
    reason: OfflineAlarmReason,
  ): void {
    const logPayload = {
      msg: 'gateway_offline_signal',
      clientid,
      tenant_id: tenantId,
      reason,
      hook: 'IMPL-13 alarm engine（alarm_rule scope=gateway / rule_type=gateway_offline → alarm_event source_type=gateway，root_group 聚合）',
    };
    if (ESCALATED_OFFLINE_REASONS.includes(reason)) {
      this.logger.error(logPayload);
    } else {
      this.logger.warn(logPayload);
    }
    this.metrics.recordMqttOfflineSignal(reason);
  }
}
