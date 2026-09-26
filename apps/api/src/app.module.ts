/**
 * 应用根模块（platform.md §8 #4 骨架）：全局异常过滤器 + zod pipe + pino 日志 +
 * prom-client 指标 + kafkajs 两 topic 接线。
 *
 * DI 纪律：所有构造注入显式 @Inject(token)——vitest/esbuild 不发射 design:paramtypes，
 * 显式 token 让测试环境与运行时同一套解析路径。
 */
import { Module, type MiddlewareConsumer, type NestModule, type Provider } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { HealthController } from './health/health.controller.js';
import { HttpExceptionFilter } from './infrastructure/errors/http-exception.filter.js';
import { CoreModule } from './infrastructure/core.module.js';
import { KafkaModule } from './infrastructure/kafka/kafka.module.js';
import { MetricsController } from './infrastructure/metrics/metrics.controller.js';
import {
  GateClampedInterceptor,
  ObservabilityInterceptor,
} from './infrastructure/observability.interceptor.js';
import { RequestContextMenu } from './infrastructure/request-context.middleware.js';

/** 全局过滤器/拦截器（执行序：中间件 → 拦截器 → 管道 → 控制器）。 */
const GLOBAL_OBSERVABILITY: Provider[] = [
  { provide: APP_FILTER, useClass: HttpExceptionFilter },
  { provide: APP_INTERCEPTOR, useClass: ObservabilityInterceptor },
  { provide: APP_INTERCEPTOR, useClass: GateClampedInterceptor },
];

@Module({
  imports: [CoreModule, KafkaModule],
  controllers: [HealthController, MetricsController],
  providers: [...GLOBAL_OBSERVABILITY],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMenu).forRoutes('*');
  }
}
