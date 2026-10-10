/**
 * 点表导入模块（modules M2-import；IMPL-15 / DAT-118）。
 *
 * - 复用 TelemetryModule 导出的 TELEMETRY_STORE（自检统计 read replica 读）；
 * - DownChannel（down/config retained + config/ack 共享订阅）自 DownChannelModule
 *   消费——DAT-151 起与 AssetModule §3.10 配置重推共用同一生产者实例；
 * - IdempotencyStore 复用 AssetModule 导出的单例（apply 幂等键 24h 窗）；
 * - MqttDownChannel 生命周期由 Nest 对 provider 实例调 onApplicationShutdown。
 */
import { Module } from '@nestjs/common';
import { TelemetryModule } from '../telemetry/telemetry.module.js';
import { AssetModule } from '../asset/asset.module.js';
import { DownChannelModule } from './down-channel.module.js';
import { ImportMetrics } from './import.metrics.js';
import { ImportsController } from './imports.controller.js';
import { ImportsService } from './imports.service.js';

@Module({
  imports: [TelemetryModule, AssetModule, DownChannelModule],
  controllers: [ImportsController],
  providers: [ImportMetrics, ImportsService],
})
export class ImportModule {}
