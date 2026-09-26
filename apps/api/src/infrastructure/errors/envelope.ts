/**
 * 错误信封构造（platform.md §5.1 逐字段）：reason_code / message / request_id / details。
 *
 * 错误路径（异常过滤器）与 gate_clamped 2xx 路径共用这一处构造，
 * 保证两条出口的字段形状永远一致（含 details 缺省语义：无内容时不出现键，
 * 与 shared-types ApiErrorEnvelopeSchema 的 optional 对齐）。
 */
import type { ApiErrorEnvelope } from '@thermio/shared-types';
import { newRequestId } from '../request-id.js';
import { getRequestContext } from '../request-context.js';

export interface EnvelopeInput {
  readonly reason_code: string;
  readonly message: string;
  readonly request_id: string | undefined;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}

/** 信封 request_id 优先取请求上下文（OBS-MT-03），管道外场景兜底新生成。 */
export function buildEnvelope(input: EnvelopeInput): ApiErrorEnvelope {
  const requestId = input.request_id ?? getRequestContext()?.request_id ?? newRequestId();
  return {
    error: {
      reason_code: input.reason_code,
      message: input.message,
      request_id: requestId,
      ...(input.details !== undefined && Object.keys(input.details).length > 0
        ? { details: input.details }
        : {}),
    },
  };
}
