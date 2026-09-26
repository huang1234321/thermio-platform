/**
 * 全局核心提供者：配置 + 日志 + 指标（@Global——Kafka 等子模块可注入，
 * 不必逐模块转发）。DI 纪律：全部 useFactory + 显式 inject，无 design:paramtypes 依赖，
 * vitest/esbuild 与运行时同一套解析路径。
 */
import { Global, Module, type InjectionToken } from '@nestjs/common';
import type { Logger as PinoLogger } from 'pino';
import { loadConfig, type AppConfig } from '../config.js';
import { LOGGER, createRootLogger } from './logger.js';
import { MetricsService } from './metrics/metrics.service.js';

export const APP_CONFIG: InjectionToken<AppConfig> = Symbol('APP_CONFIG');

@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: (): AppConfig => loadConfig(),
    },
    {
      provide: LOGGER,
      useFactory: (config: AppConfig): PinoLogger => createRootLogger(config.LOG_LEVEL),
      inject: [APP_CONFIG],
    },
    MetricsService,
  ],
  exports: [APP_CONFIG, LOGGER, MetricsService],
})
export class CoreModule {}
