/**
 * API 错误响应信封（platform.md §5.1，API-ERR-01..06）。
 *
 * - reason_code 机器可读、稳定（只增不改义，API-CT-02 同构承诺）——首版种子表在
 *   apps/api 落地（IMPL-2 / platform.md §5.2），此处先钉信封形状；
 * - message 人读文案走 locale 资源（I18N-01），客户端只按 reason_code 分支，不解析文案；
 * - request_id 全链路贯穿（OBS-MT-03），响应头同写一份；
 * - details 结构化上下文（可选；不含堆栈/SQL/内部路径，API-ERR-04）。
 */
import { z } from 'zod';

export const ApiErrorEnvelopeSchema = z.object({
  error: z.object({
    reason_code: z.string().min(1),
    message: z.string(),
    request_id: z.string().min(1),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ApiErrorEnvelope = z.infer<typeof ApiErrorEnvelopeSchema>;
