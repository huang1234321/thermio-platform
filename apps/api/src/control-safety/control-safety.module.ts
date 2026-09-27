/**
 * control-safety 模块（docs/design/control-safety.md，IMPL-18 / DAT-164）。
 *
 * 组成（§1 模块落点图）：
 * - 仲裁器 ArbitrationService（§3 五道闸门）+ 派发器 ControlDispatcherService
 *   （§3.7 排队/合并/溢出/超时 + 预算兜底）+ 执行器 ControlExecutorService
 *   （§4/§5 写-应答-回读-回滚）；
 * - 租约 LeaseService（§6 心跳端点 + 过期接管）+ 熔断 FuseService（§7 评估/
 *   trip/恢复 + M8 读模型）+ 对账 ControlReconcilerService（§5.5）；
 * - M8 控制器（清单/闸门编辑/模式切换/config-audit/fuse 两读）+ internal 心跳；
 * - CONTROL_CHANNEL 工厂：CONTROL_MQTT_BROKER_URL 设置 → MqttControlChannel
 *   （svc-control 内部账号），未设置 → DisabledControlChannel（dev 停用形态，
 *   执行链降级语义见 control-channel.ts 头注）。
 *
 * 依赖（单向）：DbModule(@Global) / KafkaModule(@Global KAFKA_PUBLISHER) /
 * CoreModule(@Global) / InternalAlgoModule(@Global 守卫+限速) / TelemetryModule
 * (TELEMETRY_STORE 只读) / AlarmModule（直写通道 open）。
 */
import { Module, type Provider } from '@nestjs/common';
import type { Logger } from 'pino';
import { LOGGER } from '../infrastructure/logger.js';
import type { AppConfig } from '../config.js';
import { APP_CONFIG } from '../infrastructure/core.module.js';
import { AlarmModule } from '../alarm/alarm.module.js';
import { TelemetryModule } from '../telemetry/telemetry.module.js';
import { KafkaModule } from '../infrastructure/kafka/kafka.module.js';
import { ArbitrationService } from './arbitration.service.js';
import { ControlDispatcherService } from './dispatcher.service.js';
import { ControlExecutorService } from './executor.service.js';
import { LeaseService } from './lease.service.js';
import { FuseService } from './fuse.service.js';
import { ControlReconcilerService } from './reconciler.service.js';
import { ControlEventsPublisher } from './control-events.publisher.js';
import { ControlSafetyController } from './control-safety.controller.js';
import { ControlSafetyService } from './control-safety.service.js';
import { InternalLeasesController } from './internal-leases.controller.js';
import { DisabledControlChannel, MqttControlChannel } from './control-channel.js';
import { CONTROL_CHANNEL } from './control-safety.tokens.js';
import { IdempotencyStore } from '../asset/idempotency.js';

const CONTROL_CHANNEL_FACTORY: Provider = {
  provide: CONTROL_CHANNEL,
  useFactory: async (config: AppConfig, logger: Logger) => {
    if (!config.controlChannelEnabled) {
      return new DisabledControlChannel(
        'CONTROL_MQTT_BROKER_URL 未配置（执行链降级：仲裁照常，下行不可达走回写原值语义）',
      );
    }
    const channel = new MqttControlChannel(config, logger);
    try {
      await channel.connect();
      return channel;
    } catch (err: unknown) {
      // 连接失败不阻断启动（dev 栈可能后起 EMQX；KafkaGateway 同款纪律）——
      // 后续 publish 抛 ChannelUnavailableError，执行链按 §4.4 收敛
      logger.error({ msg: 'control_channel_connect_failed', err });
      return new DisabledControlChannel('控制通道连接失败（执行链降级至回滚语义）');
    }
  },
  inject: [APP_CONFIG, LOGGER],
};

@Module({
  imports: [AlarmModule, TelemetryModule, KafkaModule],
  controllers: [ControlSafetyController, InternalLeasesController],
  providers: [
    CONTROL_CHANNEL_FACTORY,
    ArbitrationService,
    ControlDispatcherService,
    ControlExecutorService,
    LeaseService,
    FuseService,
    ControlReconcilerService,
    ControlEventsPublisher,
    ControlSafetyService,
    IdempotencyStore,
    // 租约 cmd 等待收敛：channel 事件扇出到 lease 等待表（executor 在构造时自接）
    {
      provide: 'LEASE_EVENT_HOOK',
      useFactory: (
        channel: import('./control-channel.js').ControlChannel,
        leases: LeaseService,
      ) => {
        channel.onUpEvent((event) => {
          leases.handleUpEvent(event);
        });
        return true;
      },
      inject: [CONTROL_CHANNEL, LeaseService],
    },
  ],
  exports: [ControlDispatcherService, ControlSafetyService],
})
export class ControlSafetyModule {}
