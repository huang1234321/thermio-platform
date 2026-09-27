/**
 * M3 实时监控模块（modules M3-monitor.md，IMPL-14 api 包）：
 * monitor/overview + equipments×2 + points/latest（§3.1/§3.2/§3.3/§3.6）
 * + SSE /streams/telemetry（§3.5，platform.md §10 通道）。
 *
 * 组装：TelemetryModule（TSDB 只读仓储）+ AssetModule（PointsService 点位快照装配）；
 * PG 侧经全局 DbModule 的 TenantDb（RLS 每事务租户上下文）。
 * 不含 /scenes×2 与 scene DDL（R3 待拍板另批）。
 */
import { Module } from '@nestjs/common';
import { TelemetryModule } from '../telemetry/telemetry.module.js';
import { AssetModule } from '../asset/asset.module.js';
import { MonitorController } from './monitor.controller.js';
import { MonitorService } from './monitor.service.js';
import { StreamsController } from './streams.controller.js';

@Module({
  imports: [TelemetryModule, AssetModule],
  controllers: [MonitorController, StreamsController],
  providers: [MonitorService],
})
export class MonitorModule {}
