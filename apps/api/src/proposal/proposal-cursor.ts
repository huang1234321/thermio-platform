/**
 * 建议域游标分页编解码（API-DSN-03；M5-proposal.md §1.4 排序键表）。
 *
 * 时间键取 epoch **微秒**字符串（同 alarm/users 纪律：JS Date 毫秒丢 timestamptz
 * 微秒尾数；keyset 谓词用 bigint 行值比较，无浮点精度损失）。
 * - proposal：(created_at DESC, id DESC)——收件箱语义（最新置顶）；
 * - control_audit：(at DESC, id DESC)。
 */
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';

export interface KeysetCursor {
  readonly k: readonly string[];
  readonly id: string;
}

const BIGINT_US_PATTERN = /^\d{1,20}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_PATTERN = new RegExp(`^(?:${UUID_PATTERN.source}|\\d{1,19})$`, 'i');

export function encodeProposalCursor(cursor: KeysetCursor): string {
  return Buffer.from(JSON.stringify({ k: cursor.k, id: cursor.id }), 'utf8').toString('base64url');
}

export function decodeProposalCursor(cursor: string, keyLength: number): KeysetCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw invalidCursor();
  }
  if (typeof parsed !== 'object' || parsed === null) throw invalidCursor();
  const { k, id } = parsed as { k?: unknown; id?: unknown };
  if (!Array.isArray(k) || k.length !== keyLength) throw invalidCursor();
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw invalidCursor();
  if (!k.every((segment) => typeof segment === 'string' && BIGINT_US_PATTERN.test(segment))) {
    // 本域两端点排序键第 0 段均为时间键（epoch µs）
    throw invalidCursor();
  }
  return { k: k as string[], id };
}

/** 时间键行值谓词（DESC：严格小于游标行；ASC：严格大于）。 */
export function timeKeysetPredicate(
  direction: 'asc' | 'desc',
  timeExpr: string,
  idExpr: string,
  cursor: KeysetCursor,
  startParam: number,
): { sql: string; params: unknown[] } {
  const op = direction === 'desc' ? '<' : '>';
  return {
    sql: `(${timeExpr}, ${idExpr}) ${op} ($${String(startParam)}::bigint, $${String(startParam + 1)}::bigint)`,
    params: [cursor.k[0] ?? '0', cursor.id],
  };
}

function invalidCursor(): ReasonCodeException {
  return new ReasonCodeException('common.validation_failed', '游标非法或已过期', {
    field: 'cursor',
  });
}
