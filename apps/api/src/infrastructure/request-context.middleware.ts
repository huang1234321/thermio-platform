/**
 * 请求上下文中间件：解析/生成 request_id + trace_id（OBS-MT-03），写响应头（API-ERR-06）。
 *
 * 上游（网关/调用方）已带 X-Request-Id / X-Trace-Id 则透传（跨服务贯穿），
 * 否则生成；同值既进 AsyncLocalStorage（日志/信封/Kafka header 三处消费），
 * 也提前写回响应头，便于客户端对账。
 */
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { runWithRequestContext } from './request-context.js';
import { firstHeaderValue, newRequestId, newTraceId } from './request-id.js';

export const REQUEST_ID_HEADER = 'x-request-id';
export const TRACE_ID_HEADER = 'x-trace-id';

@Injectable()
export class RequestContextMenu implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const requestId = firstHeaderValue(req.headers[REQUEST_ID_HEADER]) ?? newRequestId();
    const traceId = firstHeaderValue(req.headers[TRACE_ID_HEADER]) ?? newTraceId();
    res.setHeader(REQUEST_ID_HEADER, requestId);
    res.setHeader(TRACE_ID_HEADER, traceId);
    runWithRequestContext({ request_id: requestId, trace_id: traceId }, next);
  }
}
