/**
 * 告警模块（modules M4，IMPL-13 / DAT-116）。
 *
 * 自包含接线：HTTP 面（alarms + alarm-rules 控制器）+ 引擎（四通道接入 + 定时器）+
 * Kafka 质量事件消费者。依赖（单向）：
 * - DbModule（@Global，TENANT_DB 租户事务）；
 * - InternalMqttModule（AUTH_DB 质量事件租户解析 + GatewayStatusService 离线信号
 *   sink 注册——IMPL-7 预留联动接通，M4-alarm.md §5.1 通道②）。
 * KAFKA_BROKERS 未配置时质量消费者停用（骨架形态，同 KafkaModule 纪律）；
 * 引擎启动即以 gateway.status 电平真值对账重建（§5.6）。
 */
import {
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import type { Logger } from 'pino';
import { APP_CONFIG } from '../infrastructure/core.module.js';
import { LOGGER } from '../infrastructure/logger.js';
import { InternalMqttModule } from '../internal-mqtt/internal-mqtt.module.js';
import { GatewayStatusService } from '../internal-mqtt/gateway-status.service.js';
import type { AppConfig } from '../config.js';
import { AlarmsController } from './alarms.controller.js';
import { AlarmRulesController } from './alarm-rules.controller.js';
import { AlarmsService } from './alarms.service.js';
import { AlarmRulesService } from './alarm-rules.service.js';
import { AlarmEngineService } from './alarm-engine.service.js';
import { QualityEventConsumer } from './quality.consumer.js';
import { IdempotencyStore } from '../asset/idempotency.js';

/**
 * 引擎外线接线（生命周期持有者）：EMQX 离线信号 sink 注册 + 质量消费者启停。
 * sink 注册在构造期（早于引擎 onModuleInit 的 gateway 真值对账——对账边沿经
 * 同一入口幂等重放）。
 */
@Injectable()
class AlarmEngineWiring implements OnModuleInit, OnApplicationShutdown {
  private consumer: QualityEventConsumer | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) logger: Logger,
    @Inject(AlarmEngineService) private readonly engine: AlarmEngineService,
    @Inject(GatewayStatusService) private readonly gatewayStatus: GatewayStatusService,
  ) {
    this.logger = logger.child({ component: 'alarm-wiring' });
    // IMPL-7 预留联动接通：EMQX 离线/在线边沿 → 引擎 gateway_offline 求值
    this.gatewayStatus.registerGatewaySignalSink({
      onGatewaySignal: (signal) =>
        engine.onGatewaySignal({
          tenantId: signal.tenantId,
          gatewayId: signal.gatewayId,
          gatewayName: signal.gatewayName,
          status: signal.status,
          reason: signal.reason,
          atMs: signal.atMs,
        }),
    });
  }

  private readonly logger: Logger;

  onModuleInit(): void {
    if (!this.config.kafkaEnabled) {
      this.logger.warn({
        msg: 'alarm_quality_consumer_disabled',
        hint: 'set KAFKA_BROKERS to enable',
      });
      return;
    }
    this.consumer = new QualityEventConsumer(
      this.config.KAFKA_BROKERS,
      this.config.KAFKA_CLIENT_ID,
      this.logger.child({ component: 'alarm-quality-consumer' }),
      this.engine,
    );
    void this.consumer.start().catch((err: unknown) => {
      this.logger.error({ msg: 'alarm_quality_consumer_start_failed', err });
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.consumer?.stop();
  }
}

@Module({
  imports: [InternalMqttModule],
  controllers: [AlarmsController, AlarmRulesController],
  providers: [
    AlarmsService,
    AlarmRulesService,
    AlarmEngineService,
    IdempotencyStore,
    AlarmEngineWiring,
  ],
  // 引擎导出：资产域停用点联动（M1-asset §10-O3 收口，points.service 注入）
  exports: [AlarmEngineService],
})
export class AlarmModule {}
