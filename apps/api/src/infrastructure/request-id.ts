/**
 * request_id / trace_id 生成与解析（§5.1 request_id 全链路贯穿；API-ERR-06 响应头同写）。
 *
 * 形状 `req_<32hex>`：与 platform.md §5.1 示例 `req_01J8Z…` 同为 `req_` 前缀可排序字符串；
 * 骨架期用 crypto.randomUUID 去横线（免引入 ULID 依赖），换成 ULID 只改这里。
 */
import { randomUUID } from 'node:crypto';

function newPrefixedId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

export function newRequestId(): string {
  return newPrefixedId('req');
}

export function newTraceId(): string {
  return newPrefixedId('trc');
}

/** 头值可能是 string | string[] | undefined（express 类型面），收敛成 string | null。 */
export function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === 'string' && first.length > 0 ? first : null;
  }
  return typeof value === 'string' && value.length > 0 ? value : null;
}
