/**
 * 资产与接入管理模块（modules M1-asset，IMPL-11 / DAT-114；§3.10 物理编辑 DAT-151）。
 *
 * §3.1–§3.10 端点全集（§3.7 遥测读取归 IMPL-12 TelemetryModule——本模块
 * import 并消费其导出的 TSDB 只读仓储装配 latest 快照）。
 * §3.10 配置重推复用 M2 §8.4 生产者 → DownChannelModule（与 ImportModule 同一实例）。
 * 幂等键内存去重（O1 MVP 形态）为本模块级单例。
 */
import { Module } from '@nestjs/common';
import { TelemetryModule } from '../telemetry/telemetry.module.js';
import { AlarmModule } from '../alarm/alarm.module.js';
import { DownChannelModule } from '../import/down-channel.module.js';
import { BuildingsController } from './buildings.controller.js';
import { BuildingsService } from './buildings.service.js';
import { EquipmentsController } from './equipments.controller.js';
import { EquipmentsService } from './equipments.service.js';
import { GatewaysController } from './gateways.controller.js';
import { GatewaysService } from './gateways.service.js';
import { IdempotencyStore } from './idempotency.js';
import { PointsController } from './points.controller.js';
import { PointsService } from './points.service.js';
import { SystemsController } from './systems.controller.js';
import { SystemsService } from './systems.service.js';

@Module({
  imports: [TelemetryModule, AlarmModule, DownChannelModule],
  controllers: [
    BuildingsController,
    SystemsController,
    EquipmentsController,
    PointsController,
    GatewaysController,
  ],
  providers: [
    BuildingsService,
    SystemsService,
    EquipmentsService,
    PointsService,
    GatewaysService,
    IdempotencyStore,
  ],
  // M3 监控详情（IMPL-14）复用 PointsService 的 §3.4 latest 快照装配；IMPL-15 复用 IdempotencyStore（apply 幂等键，M2-import §8.1）
  exports: [PointsService, IdempotencyStore],
})
export class AssetModule {}
