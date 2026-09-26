/**
 * api 启动入口（platform.md §8 #4）。引导配置在 bootstrap.ts（与 e2e 共享，
 * 避免 main.ts 侧效应被测试导入误触发）。
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap.js';
import { loadConfig } from './config.js';
import { LOGGER } from './infrastructure/logger.js';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(config.PORT);
  app.get(LOGGER).info({
    msg: 'api_started',
    port: config.PORT,
    kafka_enabled: config.kafkaEnabled,
  });
}

void bootstrap();
