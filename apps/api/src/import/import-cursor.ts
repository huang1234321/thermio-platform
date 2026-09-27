/**
 * 导入域游标（M2-import §1.4：排序不开放参数，游标键 = 排序键值 + id 定位）。
 *
 * - GET /imports：created_at DESC, id DESC（收件箱语义）——微秒精度文本键（同 asset-cursor）；
 * - GET /imports/{id}/rows：row_no ASC, id ASC（Excel 行序）——int 键；
 * - cursor 不透明 base64url ≤512；非法/过期 → 422 common.validation_failed（details.field=cursor）。
 */
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';

export interface ImportCursor {
  readonly k: readonly string[];
  readonly id: string;
}

export function encodeImportCursor(cursor: ImportCursor): string {
  return Buffer.from(JSON.stringify({ k: cursor.k, id: cursor.id }), 'utf8').toString('base64url');
}

function decodeRaw(raw: string): ImportCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { k, id } = parsed as { k?: unknown; id?: unknown };
    if (!Array.isArray(k) || k.some((v) => typeof v !== 'string')) return null;
    if (typeof id !== 'string' || id.length === 0) return null;
    return { k, id };
  } catch {
    return null;
  }
}

/** 微秒精度键校验（created_at_us 形态，同 asset-cursor 的 isMicrosecondKey）。 */
function isMicrosecondKey(value: string): boolean {
  return /^\d{16,19}$/.test(value);
}

/** 作业列表游标（created_at_us DESC）：非法 → 422（M2-import §1.4）。 */
export function decodeJobCursor(raw: string): ImportCursor {
  const cursor = decodeRaw(raw);
  if (cursor === null || cursor.k.length !== 1 || !isMicrosecondKey(cursor.k[0] ?? '')) {
    throw new ReasonCodeException('common.validation_failed', '游标不合法或已过期', {
      field: 'cursor',
    });
  }
  return cursor;
}

/** 行列表游标（row_no ASC）：k[0] 为正整数文本。 */
export function decodeRowCursor(raw: string): ImportCursor {
  const cursor = decodeRaw(raw);
  const first = cursor?.k[0];
  if (cursor === null || cursor.k.length !== 1 || first === undefined || !/^\d+$/.test(first)) {
    throw new ReasonCodeException('common.validation_failed', '游标不合法或已过期', {
      field: 'cursor',
    });
  }
  return cursor;
}

/** keyset 谓词（<param 基序>；rows 用 (row_no, id) 升序严格大于组合）。 */
export function rowKeysetPredicate(cursor: ImportCursor, startParam: number): string {
  const p = startParam;
  return `(r.row_no, r.id) > (${dollar(p)}::int, ${dollar(p + 1)}::bigint)`;
}

function dollar(n: number): string {
  return `$${String(n)}`;
}
