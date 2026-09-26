/**
 * 中台内部端点（emqx.md §7 端点清单）：/internal/mqtt/authenticate + /internal/mqtt/events。
 *
 * - 挂载在全局前缀 /api/v1 之外（bootstrap.ts exclude；不进公开 OpenAPI 面）；
 * - ServiceAuthGuard：Bearer 服务凭证（platform.md §11-2，EMQX 凭证只到得了本控制器
 *   ——路由白名单由挂载范围结构性满足）；
 * - authenticate：一切凭证类失败都是 HTTP 200 + {result:"deny"}（SEC-PW-04 不泄露
 *   存在性；畸形体同样 deny 而非 4xx——EMQX 侧只认 result 语义）；
 * - events：畸形体 422 信封（API-ERR-01/03），未注册 clientid WARN + 忽略（§5.2-1），
 *   DB 异常走全局过滤器 5xx 信封（webhook at-least-once 会重投，幂等吸收）。
 */
import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import type { Logger } from 'pino';
import { LOGGER } from '../infrastructure/logger.js';
import { MetricsService } from '../infrastructure/metrics/metrics.service.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { zodFieldIssues } from '../infrastructure/validation/zod-validation.pipe.js';
import { MqttAuthenticateService } from './authenticate.service.js';
import {
  MQTT_AUTH_ALLOW,
  MQTT_AUTH_DENY,
  MQTT_EVENTS_ACCEPTED,
  MqttAuthenticateRequestSchema,
  MqttClientEventSchema,
} from './contract.js';
import { MqttEventsService } from './events.service.js';
import { ServiceAuthGuard } from './service-auth.guard.js';

@Controller('internal/mqtt')
@UseGuards(ServiceAuthGuard)
export class MqttInternalController {
  private readonly logger: Logger;

  constructor(
    @Inject(MqttAuthenticateService) private readonly authenticateService: MqttAuthenticateService,
    @Inject(MqttEventsService) private readonly eventsService: MqttEventsService,
    @Inject(LOGGER) rootLogger: Logger,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {
    this.logger = rootLogger.child({ component: 'mqtt-internal-endpoints' });
  }

  /** §3.2：成功/失败同一 HTTP 200 包形；此处不抛——deny 是业务结果不是错误。 */
  @Post('authenticate')
  @HttpCode(200)
  async authenticate(@Body() body: unknown): Promise<{ result: 'allow' | 'deny' }> {
    const parsed = MqttAuthenticateRequestSchema.safeParse(body);
    if (!parsed.success) {
      // 畸形体按 deny（fail-closed）+ WARN；不出 4xx：EMQX 只消费 result 语义。
      this.logger.warn({ msg: 'mqtt_auth_request_malformed' });
      this.metrics.recordMqttAuth('deny');
      return MQTT_AUTH_DENY;
    }
    const outcome = await this.authenticateService.authenticate(parsed.data);
    this.metrics.recordMqttAuth(outcome.result);
    return outcome.result === 'allow' ? MQTT_AUTH_ALLOW : MQTT_AUTH_DENY;
  }

  @Post('events')
  @HttpCode(200)
  async events(@Body() body: unknown): Promise<{ accepted: boolean }> {
    const parsed = MqttClientEventSchema.safeParse(body);
    if (!parsed.success) {
      // 事件体畸形 = rule SQL 配错，422 让问题在 EMQX 侧重试与告警里可见（§7 4xx 语义）。
      this.logger.warn({ msg: 'mqtt_event_malformed' });
      throw new ReasonCodeException(
        'common.validation_failed',
        '事件体校验失败',
        zodFieldIssues(parsed.error),
      );
    }
    await this.eventsService.handleEvent(parsed.data);
    return MQTT_EVENTS_ACCEPTED;
  }
}
