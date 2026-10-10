/**
 * 下行通道共享模块（emqx.md §4 R6 / M2-import §8.4）。
 *
 * DAT-151 起 §3.10 物理编辑的配置重推「与 apply 同一生产者」——DownChannel
 * 提升为独立模块供 ImportModule 与 AssetModule 共同消费（单例：同一 MQTT 连接
 * 与 config/ack 共享订阅，双实例会重复连接且互抢应答）。
 */
import { Module } from '@nestjs/common';
import type { Logger } from 'pino';
import { APP_CONFIG } from '../infrastructure/core.module.js';
import { LOGGER } from '../infrastructure/logger.js';
import type { AppConfig } from '../config.js';
import { DisabledDownChannel, MqttDownChannel } from './down-channel.publisher.js';
import { DOWN_CHANNEL } from './import.tokens.js';

@Module({
  providers: [
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
  exports: [DOWN_CHANNEL],
})
export class DownChannelModule {}
