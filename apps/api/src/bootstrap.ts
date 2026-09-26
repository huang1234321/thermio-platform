/**
 * 应用引导配置（main.ts 与 e2e 共用，唯一真相）：
 * 全局前缀 /api/v1（platform.md §5.2 末段 base path 约定）+
 * /healthz、/metrics 排除在前缀外（探针与 Prometheus 约定路径）+
 * 优雅停机钩子（kafka 断开挂在上面）。
 */
import type { INestApplication } from '@nestjs/common';

export function configureApp(app: INestApplication): INestApplication {
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'metrics'] });
  app.enableShutdownHooks();
  return app;
}
