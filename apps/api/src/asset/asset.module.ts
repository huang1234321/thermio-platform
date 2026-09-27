/**
 * 资产与接入管理模块（modules M1-asset，IMPL-11 / DAT-114）。
 *
 * §3.1–§3.6 + §3.8/§3.9 端点全集（§3.7 遥测读取归 IMPL-12 TelemetryModule——本模块
 * import 并消费其导出的 TSDB 只读仓储装配 latest 快照；§3.10 物理编辑随 DAT-151 另派）。
 * 幂等键内存去重（O1 MVP 形态）为本模块级单例。
 */
import { Module } from '@nestjs/common';
import { TelemetryModule } from '../telemetry/telemetry.module.js';
import { AlarmModule } from '../alarm/alarm.module.js';
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
  imports: [TelemetryModule, AlarmModule],
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
})
export class AssetModule {}
