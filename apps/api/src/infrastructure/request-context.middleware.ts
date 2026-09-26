/**
 * 请求上下文中间件：解析/生成 request_id + trace_id（OBS-MT-03），写响应头（API-ERR-06）。
 *
 * 上游（网关/调用方）已带 X-Request-Id / X-Trace-Id 则透传（跨服务贯穿），
 * 否则生成；同值既进 AsyncLocalStorage（日志/信封/Kafka header 三处消费），
 * 也提前写回响应头，便于客户端对账。
 *
 * 挂载位置（QA 阻塞#2 修复）：必须在 express body-parser **之前**执行——Nest 的
 * parser 在 app.init()/listen() 时才注册，故由 bootstrap.configureApp 以 app.use()
 * 全局挂载（先入 stack）；畸形 JSON 的解析错误发生在 parser 层，此时上下文与响应头
 * 已就位，错误信封/日志才拿得到 request_id/trace_id。不做成 Nest 模块中间件
 * （模块中间件执行序在 parser 之后，正是被测出分叉的根因）。
 */
import type { NextFunction, Request, Response } from 'express';
import { runWithRequestContext } from './request-context.js';
import { firstHeaderValue, newRequestId, newTraceId } from './request-id.js';

export const REQUEST_ID_HEADER = 'x-request-id';
export const TRACE_ID_HEADER = 'x-trace-id';

/** express 原生签名，bootstrap 全局挂载（先于 body-parser）。 */
export function requestContextHandler(req: Request, res: Response, next: NextFunction): void {
  const requestId = firstHeaderValue(req.headers[REQUEST_ID_HEADER]) ?? newRequestId();
  const traceId = firstHeaderValue(req.headers[TRACE_ID_HEADER]) ?? newTraceId();
  res.setHeader(REQUEST_ID_HEADER, requestId);
  res.setHeader(TRACE_ID_HEADER, traceId);
  runWithRequestContext({ request_id: requestId, trace_id: traceId }, next);
}
