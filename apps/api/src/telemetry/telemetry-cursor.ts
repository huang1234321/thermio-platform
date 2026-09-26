/**
 * 遥测游标（API-DSN-03 游标分页）：不透明 base64url(JSON) 载荷，
 * 客户端原样回传。载荷只含翻页锚点（上一页末行时间戳），不含筛选语义——
 * 改 from/to/interval 后旧游标仍单调有效（时间轴锚点与窗口求交）。
 * 畸形游标在入参校验层拒绝（common.validation_failed），不静默回首页。
 */
import { Rfc3339Schema } from '@thermio/shared-types';
import { z } from 'zod';

const CursorPayloadSchema = z.object({ ts: Rfc3339Schema });

export type CursorPayload = z.infer<typeof CursorPayloadSchema>;

/** 编码：明文 JSON → base64url（无填充）。 */
export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify({ ts: payload.ts }), 'utf8').toString('base64url');
}

/** 解码并校验；非法输入返回 null（调用方归一为 common.validation_failed）。 */
export function decodeCursor(raw: string | undefined): CursorPayload | null {
  if (raw === undefined) return null;
  try {
    const json: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    const parsed = CursorPayloadSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
