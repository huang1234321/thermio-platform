/**
 * 应用根模块（platform.md §8 #4 骨架）：全局异常过滤器 + zod pipe + pino 日志 +
 * prom-client 指标 + kafkajs 两 topic 接线。
 *
 * DI 纪律：所有构造注入显式 @Inject(token)——vitest/esbuild 不发射 design:paramtypes，
 * 显式 token 让测试环境与运行时同一套解析路径。
 * 请求上下文中间件不在本模块（Nest 模块中间件执行序在 body-parser 之后），
 * 由 bootstrap.configureApp 以 app.use 先行挂载（QA 阻塞#2 修复）。
 *
 * IMPL-10 增量：APP_GUARD JwtAuthGuard（SEC-AZ-01 默认拒绝——除 @Public 显式豁免
 * 一切路由默认受保护；认证域未接线时骨架降级，见 jwt-auth.guard）；DbModule
 * （双 PG 池 + TenantDb 每事务 SET LOCAL app.tenant_id，ddl.md §5.2）。
 */
import { Module, type Provider } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from './auth/auth.module.js';
import { JwtAuthGuard } from './auth/jwt-auth.guard.js';
import { HealthController } from './health/health.controller.js';
import { HttpExceptionFilter } from './infrastructure/errors/http-exception.filter.js';
import { CoreModule } from './infrastructure/core.module.js';
import { InternalMqttModule } from './internal-mqtt/internal-mqtt.module.js';
import { DbModule } from './infrastructure/db/db.module.js';
import { KafkaModule } from './infrastructure/kafka/kafka.module.js';
import { MetricsController } from './infrastructure/metrics/metrics.controller.js';
import {
  GateClampedInterceptor,
  ObservabilityInterceptor,
} from './infrastructure/observability.interceptor.js';
import { MonitorModule } from './monitor/monitor.module.js';
import { TelemetryModule } from './telemetry/telemetry.module.js';
import { UsersModule } from './users/users.module.js';
import { AssetModule } from './asset/asset.module.js';
import { AlarmModule } from './alarm/alarm.module.js';
import { ImportModule } from './import/import.module.js';

/** 全局过滤器/拦截器（执行序：中间件 → 拦截器 → 管道 → 控制器）。 */
const GLOBAL_OBSERVABILITY: Provider[] = [
  { provide: APP_FILTER, useClass: HttpExceptionFilter },
  { provide: APP_INTERCEPTOR, useClass: ObservabilityInterceptor },
  { provide: APP_INTERCEPTOR, useClass: GateClampedInterceptor },
];

@Module({
  imports: [
    CoreModule,
    DbModule,
    KafkaModule,
    TelemetryModule,
    InternalMqttModule,
    AuthModule,
    UsersModule,
    // MonitorModule 必须先于 AssetModule：`points/latest`（M3 §3.6）需抢在资产域
    // `points/:pointId` 之前注册（express 按注册序匹配）；e2e 有路由序回归钉。
    MonitorModule,
    AssetModule,
    AlarmModule,
    ImportModule,
  ],
  controllers: [HealthController, MetricsController],
  providers: [...GLOBAL_OBSERVABILITY, { provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AppModule {}
