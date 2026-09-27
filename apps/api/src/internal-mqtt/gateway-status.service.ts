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
 * 离线告警联动（§5.2-3，IMPL-13 已接通）：applied 边沿投递 GatewaySignalSink
 * （= 告警引擎 gateway_offline 求值，M4-alarm.md §5.1 通道②）。sink 按状态表
 * 边沿去重——同 ts disconnect 重投不再重复 WARN（DAT-110 跟踪项 2 随防抖/去重
 * 一并收口）；未注册 sink 时保留 v1 WARN + 指标留痕形态（独立运行可观测）。
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
  readonly name: string;
};

/** IMPL-13 接通点：离线/在线信号边沿投递（sink = 告警引擎；返回是否新边沿）。 */
export interface GatewaySignalSink {
  onGatewaySignal(signal: {
    readonly tenantId: string;
    readonly gatewayId: string;
    readonly gatewayName: string;
    readonly status: 'online' | 'offline';
    readonly reason: string | null;
    readonly atMs: number;
  }): Promise<boolean>;
}

/** §5.2-3 单调卫语句 UPDATE（ts 毫秒 → timestamptz；相等也放行 = 重复事件幂等重写）。 */
const GATEWAY_TRANSITION_SQL = `
UPDATE gateway
SET status = $1::text, last_seen_at = to_timestamp($2::double precision / 1000)
WHERE mqtt_client_id = $3
  AND (last_seen_at IS NULL OR last_seen_at <= to_timestamp($2::double precision / 1000))`;

@Injectable()
export class GatewayStatusService {
  private readonly logger: Logger;
  private sink: GatewaySignalSink | null = null;

  constructor(
    @Inject(AUTH_DB) private readonly authDb: DbQueryPort,
    @Inject(TENANT_DB) private readonly tenantDb: TenantDbPort,
    @Inject(LOGGER) rootLogger: Logger,
    private readonly metrics: MetricsService,
  ) {
    this.logger = rootLogger.child({ component: 'mqtt-gateway-status' });
  }

  /** 告警引擎注册（AlarmModule 装配时调用；单向依赖，internal-mqtt 不 import alarm）。 */
  registerGatewaySignalSink(sink: GatewaySignalSink): void {
    this.sink = sink;
  }

  /** clientid → gateway（跨租户旁路读；未注册返回 null）。 */
  async findGatewayByClientId(
    clientid: string,
  ): Promise<{ id: string; tenantId: string; name: string } | null> {
    const { rows } = await this.authDb.query<OnlineGatewayRow>(
      'SELECT id, tenant_id, mqtt_client_id, name FROM gateway WHERE mqtt_client_id = $1',
      [clientid],
    );
    const row = rows[0];
    return row === undefined ? null : { id: row.id, tenantId: row.tenant_id, name: row.name };
  }

  /** §5.3 对账扫描面：当前 status='online' 的网关全集。 */
  async listOnlineGateways(): Promise<OnlineGatewayRow[]> {
    const { rows } = await this.authDb.query<OnlineGatewayRow>(
      'SELECT id, tenant_id, mqtt_client_id, name FROM gateway WHERE status = $1::text',
      ['online'],
    );
    return rows;
  }

  /**
   * 状态翻转（单调卫语句内）。返回是否真的翻转（false = 旧事件被卫语句吸收）。
   * alarmReason 非 null 时触发离线信号留痕/引擎投递（§5.2-3）。
   */
  async transition(
    clientid: string,
    gateway: { id: string; name: string },
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
    if (alarmReason !== null || status === 'online') {
      await this.dispatchSignal(clientid, tenantId, gateway, status, eventTsMs, alarmReason);
    }
    return true;
  }

  /**
   * 信号投递（§5.2-3）：sink（告警引擎）接通时边沿进引擎求值，WARN/指标按引擎
   * 状态表新边沿计——同 ts 重投被去重（DAT-110）；无 sink 保留 v1 WARN + 指标形态。
   */
  private async dispatchSignal(
    clientid: string,
    tenantId: string,
    gateway: { id: string; name: string },
    status: 'online' | 'offline',
    eventTsMs: number,
    reason: OfflineAlarmReason | null,
  ): Promise<void> {
    if (this.sink !== null) {
      try {
        const newEdge = await this.sink.onGatewaySignal({
          tenantId,
          gatewayId: gateway.id,
          gatewayName: gateway.name,
          status,
          reason,
          atMs: eventTsMs,
        });
        if (status === 'offline' && reason !== null) {
          if (newEdge) {
            this.metrics.recordMqttOfflineSignal(reason);
          } else {
            // 同 ts 重投/未变边沿：引擎已按状态表吸收——本服务侧只留 debug（DAT-110）
            this.logger.debug({
              msg: 'gateway_offline_signal_absorbed',
              gateway_id: gateway.id,
              reason,
            });
          }
        }
      } catch (err: unknown) {
        // EMQX 通道无重放：丢失边沿由重启 gateway.status 电平对账兜底（M4 §5.6）
        this.logger.error({
          msg: 'gateway_signal_sink_failed',
          gateway_id: gateway.id,
          status,
          err,
        });
      }
      return;
    }
    if (status === 'offline' && reason !== null) {
      this.leaveOfflineSignalTrace(clientid, gateway.id, gateway.name, tenantId, reason);
    }
  }

  /**
   * 离线信号留痕（v1 形态，sink 未注册时的兜底）：WARN 日志 + 指标计数。
   * takeover/discarded 提级 error（§5.1：配置事故信号，warning 以上）。
   */
  private leaveOfflineSignalTrace(
    clientid: string,
    gatewayId: string,
    gatewayName: string,
    tenantId: string,
    reason: OfflineAlarmReason,
  ): void {
    const logPayload = {
      msg: 'gateway_offline_signal',
      clientid,
      gateway_id: gatewayId,
      gateway_name: gatewayName,
      tenant_id: tenantId,
      reason,
      hint: '告警引擎未接线（sink 未注册），v1 WARN 留痕形态',
    };
    if (ESCALATED_OFFLINE_REASONS.includes(reason)) {
      this.logger.error(logPayload);
    } else {
      this.logger.warn(logPayload);
    }
    this.metrics.recordMqttOfflineSignal(reason);
  }
}
