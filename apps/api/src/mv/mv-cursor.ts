/**
 * M&V 域游标分页编解码（API-DSN-03；M9-mv-report.md §1.4 排序键）。
 *
 * 时间键取 epoch 微秒字符串（同 fdd/alarm/users 纪律）；keyset 谓词用
 * (time µs, id::text) 双键严格小于：
 * - mv_baseline：(created_at DESC, id DESC)；
 * - mv_report：(generated_at DESC, id DESC)；
 * - export_job：(created_at DESC, id DESC)。
 */
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';

export interface MvKeysetCursor {
  readonly k: readonly string[];
  readonly id: string;
}

const BIGINT_US_PATTERN = /^\d{1,20}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeMvCursor(cursor: MvKeysetCursor): string {
  return Buffer.from(JSON.stringify({ k: cursor.k, id: cursor.id }), 'utf8').toString('base64url');
}

export function decodeMvCursor(cursor: string, keyLength: number): MvKeysetCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw invalidCursor();
  }
  if (typeof parsed !== 'object' || parsed === null) throw invalidCursor();
  const { k, id } = parsed as { k?: unknown; id?: unknown };
  if (!Array.isArray(k) || k.length !== keyLength) throw invalidCursor();
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) throw invalidCursor();
  if (!k.every((segment) => typeof segment === 'string' && BIGINT_US_PATTERN.test(segment))) {
    throw invalidCursor();
  }
  return { k: k as string[], id };
}

/** 时间(µs) + uuid 双键 DESC 谓词。 */
export function mvKeysetPredicate(
  timeExpr: string,
  idExpr: string,
  cursor: MvKeysetCursor,
  startParam: number,
): { sql: string; params: unknown[] } {
  return {
    sql: `((${timeExpr}), ${idExpr}) < ($${String(startParam)}::bigint, $${String(startParam + 1)}::text)`,
    params: [cursor.k[0] ?? '0', cursor.id],
  };
}

function invalidCursor(): ReasonCodeException {
  return new ReasonCodeException('common.validation_failed', '游标非法或已过期', {
    field: 'cursor',
  });
}

/** timestamptz → epoch 微秒（SQL 侧 (extract(epoch …)*1e6)::bigint 的 JS 对位）。 */
export function toEpochMicros(value: Date): string {
  return String(Math.floor(value.getTime() * 1000));
}
