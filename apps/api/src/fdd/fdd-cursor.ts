/**
 * FDD 域游标分页编解码（API-DSN-03；modules/M6-fdd.md §5.2/§5.6 排序键）。
 *
 * 时间键取 epoch **微秒**字符串（同 alarm/proposal/users 纪律：JS Date 毫秒丢
 * timestamptz 微秒尾数；keyset 谓词用 bigint 行值比较，无浮点精度损失）。
 * 与 internal 读面（internal-fdd-read.service）同构，本文件供 admin 面复用：
 * - fdd_finding：(last_detected_at DESC, id DESC)——id 为 uuid，比较走 ::text；
 * - fdd_report：(generated_at DESC, id DESC)。
 */
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';

export interface KeysetCursor {
  readonly k: readonly string[];
  readonly id: string;
}

const BIGINT_US_PATTERN = /^\d{1,20}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeFddCursor(cursor: KeysetCursor): string {
  return Buffer.from(JSON.stringify({ k: cursor.k, id: cursor.id }), 'utf8').toString('base64url');
}

export function decodeFddCursor(cursor: string, keyLength: number): KeysetCursor {
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

/** 时间(µs) + uuid 双键 DESC 谓词：严格小于游标行（与 internal 读面同表达式）。 */
export function fddKeysetPredicate(
  timeExpr: string,
  idExpr: string,
  cursor: KeysetCursor,
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
