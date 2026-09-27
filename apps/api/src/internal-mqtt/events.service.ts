/**
 * 上下线事件处理（emqx.md §5.2，蓝本 IMPL-7 验收点 2）：
 *
 * 1 解析：clientid → gateway（thermio_auth 旁路读）；未注册 clientid 不应出现
 *   （认证已拦）——WARN + 忽略，不报错（webhook 不因此重投）；
 * 2 落库：单调卫语句 UPDATE（GatewayStatusService.transition），乱序/重复天然幂等；
 * 3 离线告警联动：reason ∈ keepalive_timeout|discarded|takeover 才触发离线信号
 *   （IMPL-13 已接通告警引擎——M4-alarm.md §5.1 通道②；closed/kicked 不触发）；
 * 4 在线事件无从属动作（ADR-009 边缘层职责，云端只审计）。
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { LOGGER } from '../infrastructure/logger.js';
import { MetricsService } from '../infrastructure/metrics/metrics.service.js';
import {
  OFFLINE_ALARM_REASONS,
  type MqttClientEvent,
  type OfflineAlarmReason,
} from './contract.js';
import { GatewayStatusService } from './gateway-status.service.js';

@Injectable()
export class MqttEventsService {
  private readonly logger: Logger;

  constructor(
    @Inject(GatewayStatusService) private readonly gatewayStatus: GatewayStatusService,
    @Inject(LOGGER) rootLogger: Logger,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {
    this.logger = rootLogger.child({ component: 'mqtt-events' });
  }

  async handleEvent(event: MqttClientEvent): Promise<void> {
    const gateway = await this.gatewayStatus.findGatewayByClientId(event.clientid);
    if (gateway === null) {
      // §5.2-1：未注册 clientid（认证已拦，出现即异常路径）——WARN + 忽略。
      this.logger.warn({
        msg: 'mqtt_event_unknown_clientid',
        clientid: event.clientid,
        event: event.event,
        username: event.username,
        peerhost: event.peerhost,
      });
      this.metrics.recordMqttEvent('unknown_client_ignored');
      return;
    }

    const status = event.event === 'client.connected' ? ('online' as const) : ('offline' as const);
    const applied = await this.gatewayStatus.transition(
      event.clientid,
      { id: gateway.id, name: gateway.name },
      gateway.tenantId,
      status,
      event.ts,
      alarmReasonFor(event),
    );
    this.metrics.recordMqttEvent(applied ? 'applied' : 'stale_ignored');
  }
}

/** §5.2-3 触发闭集之外（closed/kicked/缺 reason）一律 null——不留痕不告警。 */
function alarmReasonFor(event: MqttClientEvent): OfflineAlarmReason | null {
  if (event.event !== 'client.disconnected' || event.reason === undefined) return null;
  return (OFFLINE_ALARM_REASONS as readonly string[]).includes(event.reason)
    ? (event.reason as OfflineAlarmReason)
    : null;
}
