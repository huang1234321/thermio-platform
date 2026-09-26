/**
 * 可观测性拦截器（platform.md §7 / ADR-017）：
 * - 请求完成日志（INFO 生命周期，CODE-LOG-02/03）：method/route/status/duration_ms
 *   + 请求上下文统一字段（request_id/trace_id/tenant_id/...，由 childLogger 注入）；
 * - RED 之 Duration：svc_http_request_duration_ms，route 取路由模板防 label 基数爆炸；
 *   错误路径同样计时（tap.error），状态取异常携带值（过滤器尚未写回响应）。
 *
 * 另含 GateClampedInterceptor：闸门 2「成功但被修正」走 200 + 信封形状（§5.2 注 *，
 * 非错误，不违反 API-ERR-03），与错误出口共用 buildEnvelope；联动
 * thermio_gate_rejections_total{gate="gate_clamped"}（§5.2：五闸门 label 含
 * gate_clamped——「介入」计数，与拒绝同维观测）。
 */
import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Logger } from 'pino';
import type { Observable } from 'rxjs';
import { map, tap } from 'rxjs/operators';
import { buildEnvelope } from './errors/envelope.js';
import { GateClampedResult } from './errors/reason-code.exception.js';
import { childLogger, LOGGER } from './logger.js';
import { MetricsService } from './metrics/metrics.service.js';
import { getRequestContext } from './request-context.js';

/** 路由模板提取（label 基数防爆炸）：取不到模板时回落到 'unrouted'。 */
function routeTemplate(req: Request): string {
  const rawRoute: unknown = (req as { route?: unknown }).route;
  if (typeof rawRoute === 'object' && rawRoute !== null && 'path' in rawRoute) {
    const path = (rawRoute as { path?: unknown }).path;
    if (typeof path === 'string') return path;
  }
  return 'unrouted';
}

@Injectable()
export class ObservabilityInterceptor implements NestInterceptor {
  constructor(
    @Inject(LOGGER) private readonly rootLogger: Logger,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const start = process.hrtime.bigint();
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    return next.handle().pipe(
      tap({
        next: () => {
          this.record(req, res.statusCode, start);
        },
        error: (err: unknown) => {
          const status = err instanceof HttpException ? err.getStatus() : 500;
          this.record(req, status, start);
        },
      }),
    );
  }

  private record(req: Request, statusCode: number, start: bigint): void {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    const route = routeTemplate(req);
    this.metrics.recordHttpDuration(req.method, route, statusCode, durationMs);
    childLogger(this.rootLogger, getRequestContext()).info({
      msg: 'http_request',
      method: req.method,
      route,
      status: statusCode,
      duration_ms: Math.round(durationMs * 100) / 100,
    });
  }
}

@Injectable()
export class GateClampedInterceptor implements NestInterceptor {
  constructor(@Inject(MetricsService) private readonly metrics: MetricsService) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const res = _context.switchToHttp().getResponse<Response>();
    return next.handle().pipe(
      map((result: unknown) => {
        if (result instanceof GateClampedResult) {
          this.metrics.recordGate('gate_clamped');
          res.status(200).json(
            buildEnvelope({
              reason_code: 'proposal.gate_clamped',
              message: '提案已接受，写入值被值域夹紧（闸门 2）',
              request_id: undefined,
              details: result.details,
            }),
          );
          return null; // 响应已手写，控制器返回值不再二次序列化
        }
        return result;
      }),
    );
  }
}
