/**
 * 点表导入模块（modules M2-import；IMPL-15 / DAT-118）。
 *
 * - 复用 TelemetryModule 导出的 TELEMETRY_STORE（自检统计 read replica 读）；
 * - DownChannel 工厂：MQTT_BROKER_URL 设置 → MqttDownChannel（svc-api 内部账号，
 *   emqx.md §4 R6：down/config(retained)/down/read 发布 + config/ack 共享订阅）；
 *   未设置 → DisabledDownChannel（dev 停用形态，与 KAFKA/TSDB 同款纪律）；
 * - IdempotencyStore 复用 AssetModule 导出的单例（apply 幂等键 24h 窗）；
 * - MqttDownChannel 生命周期由 Nest 对 provider 实例调 onApplicationShutdown。
 */
import { Module } from '@nestjs/common';
import type { Logger } from 'pino';
import { APP_CONFIG } from '../infrastructure/core.module.js';
import { LOGGER } from '../infrastructure/logger.js';
import { TelemetryModule } from '../telemetry/telemetry.module.js';
import { AssetModule } from '../asset/asset.module.js';
import type { AppConfig } from '../config.js';
import { DisabledDownChannel, MqttDownChannel } from './down-channel.publisher.js';
import { DOWN_CHANNEL } from './import.tokens.js';
import { ImportMetrics } from './import.metrics.js';
import { ImportsController } from './imports.controller.js';
import { ImportsService } from './imports.service.js';

@Module({
  imports: [TelemetryModule, AssetModule],
  controllers: [ImportsController],
  providers: [
    ImportMetrics,
    ImportsService,
    {
      provide: DOWN_CHANNEL,
      inject: [APP_CONFIG, LOGGER],
      useFactory: (config: AppConfig, logger: Logger) => {
        if (config.MQTT_BROKER_URL.length === 0) {
          logger.info({ msg: 'import_down_channel_disabled', component: 'import' });
          return new DisabledDownChannel('MQTT_BROKER_URL 未配置');
        }
        const channel = new MqttDownChannel(config, logger);
        // 连接失败不阻断启动（publish 面按 gateway_ack_failed 收敛，结构化日志留痕）
        void channel.connect().catch((err: unknown) => {
          logger.error({ msg: 'import_down_channel_connect_failed', component: 'import', err });
        });
        return channel;
      },
    },
  ],
})
export class ImportModule {}
