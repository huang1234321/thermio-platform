/**
 * 游标分页编解码（API-DSN-03：列表必须分页，优先游标）。
 *
 * keyset 游标：(created_at_epoch_us, id) 稳定排序对，base64url(JSON) 不透明下发；
 * 客户端原样回传 next_cursor。非法游标 → common.validation_failed（管道统一出口）。
 *
 * 时间键取 epoch **微秒** 字符串而非 ISO：JS Date 只有毫秒精度，timestamptz 的微秒
 * 尾数在 Date 往返中丢失，同事务建行的 created_at 全并列时 keyset 相等分支失配
 * （实测踩坑：第二页 0 行）。bigint 微秒串全程字符串传递，精度无损。
 */
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';

export interface CursorKey {
  /** 行 created_at 的 epoch 微秒（十进制字符串，bigint 语义）。 */
  readonly created_at_us: string;
  readonly id: string;
}

const BIGINT_PATTERN = /^\d{1,20}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** SQL 里可并列求值的排序列/键列（与服务层 ORDER BY 保持一致）。 */
export const KEYSET_COLUMNS = `((extract(epoch FROM u.created_at) * 1000000)::bigint, u.id)`;

export function encodeCursor(key: CursorKey): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw invalidCursor();
  }
  if (typeof parsed !== 'object' || parsed === null) throw invalidCursor();
  const { created_at_us, id } = parsed as { created_at_us?: unknown; id?: unknown };
  if (
    typeof created_at_us !== 'string' ||
    !BIGINT_PATTERN.test(created_at_us) ||
    typeof id !== 'string' ||
    !UUID_PATTERN.test(id)
  ) {
    throw invalidCursor();
  }
  return { created_at_us, id };
}

/** keyset 谓词片段（参数序号从 from 起，严格降序 = 新用户在前）。 */
export function appendKeysetPredicate(
  where: string[],
  params: unknown[],
  from: number,
  cursor: CursorKey,
): void {
  where.push(`${KEYSET_COLUMNS} < ($${String(from)}::bigint, $${String(from + 1)}::uuid)`);
  params.push(cursor.created_at_us, cursor.id);
}

/** 事实行的游标（created_at_us 由 SELECT 显式投影，见 UsersService.list）。 */
export function rowCursor(row: { created_at_us: string; id: string }): CursorKey {
  return { created_at_us: row.created_at_us, id: row.id };
}

function invalidCursor(): ReasonCodeException {
  return new ReasonCodeException('common.validation_failed', '游标无效', { cursor: 'malformed' });
}
