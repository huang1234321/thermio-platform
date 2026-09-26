/**
 * 请求级上下文（OBS-MT-03 / CODE-LOG-03）。
 *
 * request_id / trace_id 全链路贯穿：日志统一字段、错误信封 request_id、
 * Kafka 消息头 trace_id 三处消费同一份上下文（ADR-017：首期不做全链路 trace，
 * api 请求级结构化日志 + Kafka header 透传即闭环）。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** CODE-LOG-03 统一字段：tenant_id / building_id / point_id / trace_id。 */
export interface RequestContext {
  readonly request_id: string;
  readonly trace_id: string;
  readonly tenant_id?: string;
  readonly building_id?: string;
  readonly point_id?: string;
}

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return requestContextStorage.run(context, fn);
}

/** 当前请求上下文；管道外（如启动期）返回 null，消费方自行兜底。 */
export function getRequestContext(): RequestContext | null {
  return requestContextStorage.getStore() ?? null;
}

/** 当前 trace_id（Kafka 消息头透传用）；无上下文时生成一次性值。 */
export function currentTraceId(fallback: () => string): string {
  return getRequestContext()?.trace_id ?? fallback();
}
