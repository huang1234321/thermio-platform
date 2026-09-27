/**
 * 应用引导配置（main.ts 与 e2e 共用，唯一真相）：
 * - 请求上下文中间件 app.use 全局挂载——必须先于 Nest 注册的 body-parser
 *   （QA 阻塞#2：畸形 JSON 解析错误发生在 parser 层，上下文/响应头要先就位，
 *   否则 422 信封 request_id 头体分叉、日志缺统一字段 API-ERR-06/OBS-MT-03）；
 * - 全局前缀 /api/v1（platform.md §5.2 末段 base path 约定）+
 *   /healthz、/metrics 排除在前缀外（探针与 Prometheus 约定路径）；
 *   /internal/mqtt/* 与 /internal/proposals 同样排除——内部端点不走公开 API 前缀
 *   （emqx.md §7、platform.md §11：不进公开 OpenAPI 面，网络面由 compose 内网隔离）；
 * - 优雅停机钩子（kafka 断开挂在上面）。
 */
import type { INestApplication } from '@nestjs/common';
import { requestContextHandler } from './infrastructure/request-context.middleware.js';

export function configureApp(app: INestApplication): INestApplication {
  app.use(requestContextHandler);
  app.setGlobalPrefix('api/v1', {
    exclude: [
      'healthz',
      'metrics',
      'internal/mqtt/authenticate',
      'internal/mqtt/events',
      'internal/proposals',
    ],
  });
  app.enableShutdownHooks();
  return app;
}
