/**
 * API 错误响应信封（platform.md §5.1，API-ERR-01..06）。
 *
 * - reason_code 机器可读、稳定（只增不改义，API-CT-02 同构承诺）——首版种子表在
 *   reason-codes.ts（IMPL-2 / platform.md §5.2）；
 * - message 人读文案走 locale 资源（I18N-01），客户端只按 reason_code 分支，不解析文案；
 * - request_id 全链路贯穿（OBS-MT-03），响应头同写一份；
 * - details 结构化上下文（可选；不含堆栈/SQL/内部路径，API-ERR-04）。
 *
 * parseApiError 是客户端消费面（§5.3 / §5.4）：响应先 safeParse、失败走宽松回退
 * （API-CT-01/03），未知 reason_code 走通用兜底不白屏不崩溃（API-ERR-02）。
 */
import { z } from 'zod';
import { isReasonCode } from './reason-codes.js';

export const ApiErrorEnvelopeSchema = z.object({
  error: z.object({
    reason_code: z.string().min(1),
    message: z.string(),
    request_id: z.string().min(1),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ApiErrorEnvelope = z.infer<typeof ApiErrorEnvelopeSchema>;

/** 畸形响应的通用兜底文案（骨架期中文常量；走 locale 资源是 I18N-01 的后续动作）。 */
export const GENERIC_FALLBACK_MESSAGE = '服务暂不可用，请稍后重试';

/** parseApiError 的兜底产物：绝不抛异常（§5.4 畸形响应测试的对象）。 */
export interface ParsedApiError {
  /** 原样保留（可能为清单外值或畸形残片）；清单内才可安全用于分支。 */
  readonly reason_code: string;
  readonly message: string;
  readonly request_id: string | null;
  readonly details: Readonly<Record<string, unknown>> | null;
  /** reason_code 是否在首版种子表内——客户端通用兜底分支的判据（API-ERR-02）。 */
  readonly known: boolean;
}

function extractRawReasonCode(body: unknown): string {
  if (typeof body === 'object' && body !== null) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === 'object' && error !== null) {
      const code = (error as { reason_code?: unknown }).reason_code;
      if (typeof code === 'string' && code.length > 0) return code;
    }
  }
  return '';
}

/**
 * 安全解析错误响应（不抛异常、不裸断言网络 JSON，API-CT-01）：
 * - 信封合法且 reason_code 在种子表内 → known=true，字段完整提取；
 * - 信封合法但 code 清单外 → known=false，code 原样保留供展示/上报（API-ERR-02）；
 * - 信封畸形（缺字段/错类型/非对象）→ known=false + 通用兜底文案（§5.4）。
 */
export function parseApiError(body: unknown): ParsedApiError {
  const parsed = ApiErrorEnvelopeSchema.safeParse(body);
  if (parsed.success) {
    const { reason_code, message, request_id, details } = parsed.data.error;
    return {
      reason_code,
      message,
      request_id,
      details: details ?? null,
      known: isReasonCode(reason_code),
    };
  }
  return {
    reason_code: extractRawReasonCode(body),
    message: GENERIC_FALLBACK_MESSAGE,
    request_id: null,
    details: null,
    known: false,
  };
}
