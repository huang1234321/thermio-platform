/**
 * pino 结构化日志（platform.md §7 / ADR-017 / CODE-LOG-01..03）。
 *
 * - 结构化 JSON，统一字段 tenant_id / building_id / point_id / trace_id（CODE-LOG-03）；
 * - 凭据与 PII 不落日志（CODE-LOG-01 / SEC-KEY-02）：redact 作为纵深防御——
 *   本骨架不整体落 req/body，仅记录选定的路由/状态字段；
 * - 级别语义按 CODE-LOG-02：ERROR 人介入 / WARN 可自动恢复 / INFO 生命周期 / DEBUG 细节。
 */
import type { InjectionToken } from '@nestjs/common';
import type { Logger } from 'pino';
import { pino } from 'pino';
import type { RequestContext } from './request-context.js';

/** DI token（显式 @Inject 消费——vitest/esbuild 不发射 design:paramtypes 的兼容面）。 */
export const LOGGER: InjectionToken<Logger> = Symbol('LOGGER');

export function createRootLogger(level: string): Logger {
  return pino({
    level,
    base: { svc: 'thermio-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'password',
        '*.password',
        '*.token',
        '*.access_token',
        '*.refresh_token',
      ],
      censor: '[REDACTED]',
    },
  });
}

/** 请求作用域子 logger：统一字段一次性注入（context 缺字段时降级为仅 request/trace id）。 */
export function childLogger(root: Logger, context: RequestContext | null): Logger {
  if (context === null) {
    return root.child({});
  }
  return root.child({
    request_id: context.request_id,
    trace_id: context.trace_id,
    ...(context.tenant_id !== undefined ? { tenant_id: context.tenant_id } : {}),
    ...(context.building_id !== undefined ? { building_id: context.building_id } : {}),
    ...(context.point_id !== undefined ? { point_id: context.point_id } : {}),
  });
}
