/**
 * request_id / trace_id 生成与解析（§5.1 request_id 全链路贯穿；API-ERR-06 响应头同写）。
 *
 * 形状 `req_<32hex>`：与 platform.md §5.1 示例 `req_01J8Z…` 同为 `req_` 前缀可排序字符串；
 * 骨架期用 crypto.randomUUID 去横线（免引入 ULID 依赖），换成 ULID 只改这里。
 *
 * 入站硬化（DAT-96 评审#1 / DAT-120）：上游传入的 id 头只当「建议值」——
 * 超长或含白名单外字符即整体丢弃、服务端重生成，不做截断（截断仍保留
 * 攻击者可控前缀，且会把不同入站 id 别名到同一出站 id，污染对账/关联分析）。
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

/** 入站 id 长度上限：自家形状 36 字符，主流网关链（UUID/ULID/W3C traceparent）≤ 55，128 已留足余量。 */
export const INBOUND_ID_MAX_LENGTH = 128;

/**
 * 入站 id 字符集白名单：字母/数字/`_` `-` `.` `:`。
 * 覆盖自家 `req_<hex>`、UUID、ULID、W3C traceparent、B3 single-header 等常见形状；
 * 排除空白/引号/花括号/控制字符/非 ASCII——这些进结构化日志（CODE-LOG-03）、
 * 响应头（API-ERR-06）、Kafka header 三处消费面都只有风险没有收益。
 */
const INBOUND_ID_PATTERN = new RegExp(`^[A-Za-z0-9_.:-]{1,${String(INBOUND_ID_MAX_LENGTH)}}$`);

/** 入站 id 校验：合法原值返回；非法（含空值）返回 null，由调用方重生成。 */
export function sanitizeInboundId(value: string | null): string | null {
  return value !== null && INBOUND_ID_PATTERN.test(value) ? value : null;
}

/** 头值可能是 string | string[] | undefined（express 类型面），收敛成 string | null。 */
export function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === 'string' && first.length > 0 ? first : null;
  }
  return typeof value === 'string' && value.length > 0 ? value : null;
}
