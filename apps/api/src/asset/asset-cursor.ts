/**
 * 资产域游标分页编解码（API-DSN-03；users/cursor.ts 同款纪律的多样键泛化）。
 *
 * M1-asset §1.4 排序键表（排序不开放参数，每端点固定默认排序）：
 * - building / gateway：(created_at, id)——时间键取 epoch **微秒**字符串（JS Date
 *   毫秒精度丢 timestamptz 微秒尾数，同事务并列行 keyset 失配——users/cursor.ts 实测踩坑）；
 * - hvac_system：(system_type, name, id)；equipment：(equipment_type, name, id)——
 *   DDL 无 created_at（R9），排序键用 (type, name, id)；
 * - point：(raw_name, id)。
 *
 * 游标体 base64url(JSON) 不透明下发；键值全部字符串化（numeric/bigint 无精度损失）。
 * 非法游标 → common.validation_failed（details.field=cursor）。
 */
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';

/** 排序键值串（与各实体 KEYSET_COLUMNS 一一对应）+ id 定位。 */
export interface KeysetCursor {
  readonly k: readonly string[];
  readonly id: string;
}

const BIGINT_US_PATTERN = /^\d{1,20}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 定位列：uuid 族（building/system/equipment/gateway）或 point 的 bigint 主键。 */
const ID_PATTERN = new RegExp(`^(?:${UUID_PATTERN.source}|\\d{1,19})$`, 'i');
const TEXT_KEY_PATTERN = /^.{1,512}$/s;

/** 各实体的 keyset 排序键列（SQL 投影，游标谓词与 ORDER BY 共用同一形状）。 */
export const BUILDING_KEYSET_COLUMNS = `((extract(epoch FROM b.created_at) * 1000000)::bigint, b.id)`;
export const GATEWAY_KEYSET_COLUMNS = `((extract(epoch FROM g.created_at) * 1000000)::bigint, g.id)`;
export const SYSTEM_KEYSET_COLUMNS = `(s.system_type, s.name, s.id)`;
export const EQUIPMENT_KEYSET_COLUMNS = `(e.equipment_type, e.name, e.id)`;
export const POINT_KEYSET_COLUMNS = `(p.raw_name, p.id)`;

export function encodeAssetCursor(cursor: KeysetCursor): string {
  return Buffer.from(JSON.stringify({ k: cursor.k, id: cursor.id }), 'utf-8').toString('base64url');
}

/** key 长度由调用方按实体钉死（k 段数错误 = 非法游标）。 */
export function decodeAssetCursor(cursor: string, keyLength: number): KeysetCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8')) as unknown;
  } catch {
    throw invalidCursor();
  }
  if (typeof parsed !== 'object' || parsed === null) throw invalidCursor();
  const { k, id } = parsed as { k?: unknown; id?: unknown };
  if (!Array.isArray(k) || k.length !== keyLength) throw invalidCursor();
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw invalidCursor();
  if (!k.every((segment) => typeof segment === 'string' && TEXT_KEY_PATTERN.test(segment))) {
    throw invalidCursor();
  }
  return { k: k as string[], id };
}

/** 时间键校验（epoch 微秒）——created_at 族游标在 decode 后补验第 0 段。 */
export function isMicrosecondKey(segment: string): boolean {
  return BIGINT_US_PATTERN.test(segment);
}

/**
 * keyset 谓词片段（严格升序）：`(cols) > ($n..)` 行值比较与 ORDER BY ASC 语义一致。
 * 返回 [sql, 参数数组]——参数直接追加进调用方参数表。
 */
export function keysetPredicate(
  columns: string,
  cursor: KeysetCursor,
  startParam: number,
  cast: readonly string[],
): { sql: string; params: unknown[] } {
  const values = [...cursor.k, cursor.id];
  const placeholders = values
    .map((_, index) => `$${String(startParam + index)}${cast[index] ?? ''}`)
    .join(', ');
  return { sql: `${columns} > (${placeholders})`, params: values };
}

function invalidCursor(): ReasonCodeException {
  return new ReasonCodeException('common.validation_failed', '游标不合法或已过期', {
    field: 'cursor',
  });
}
