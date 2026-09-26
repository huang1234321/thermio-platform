/**
 * 入站 id 头校验矩阵（DAT-96 评审#1 / DAT-120）：长度边界 + 字符集白名单逐类钉死。
 * e2e（app.e2e.test.ts 入站硬化组）钉 HTTP 三面（信封/日志源头/响应头）行为，
 * 这里钉纯函数本身的约束矩阵。
 */
import { describe, expect, it } from 'vitest';
import {
  INBOUND_ID_MAX_LENGTH,
  firstHeaderValue,
  sanitizeInboundId,
} from '../src/infrastructure/request-id.js';

describe('sanitizeInboundId（入站 id 白名单/上限）', () => {
  it('shouldKeepTheValue_whenCharsetIsWhitelisted', () => {
    // 白名单五类字符各一例 + 既有 e2e 透传用例的实际形状
    expect(sanitizeInboundId('req_echo_me_123')).toBe('req_echo_me_123');
    expect(sanitizeInboundId('ABCabc019')).toBe('ABCabc019');
    expect(sanitizeInboundId('00-4bf92f35-00f067aa-01')).toBe('00-4bf92f35-00f067aa-01'); // W3C traceparent 形状
    expect(sanitizeInboundId('trc.01J8Z:backup')).toBe('trc.01J8Z:backup'); // `.` 与 `:`
  });

  it('shouldKeepTheValue_atExactlyTheMaxLengthBoundary', () => {
    const atCap = 'a'.repeat(INBOUND_ID_MAX_LENGTH);
    expect(sanitizeInboundId(atCap)).toBe(atCap);
  });

  it('shouldReject_whenLongerThanTheMaxLength', () => {
    expect(sanitizeInboundId('a'.repeat(INBOUND_ID_MAX_LENGTH + 1))).toBeNull();
  });

  it('shouldReject_whenAnyCharIsOutsideTheWhitelist', () => {
    expect(sanitizeInboundId('bad id')).toBeNull(); // 空格
    expect(sanitizeInboundId('id"quote')).toBeNull(); // 引号（日志/头注入面）
    expect(sanitizeInboundId('{"injected":"json"}')).toBeNull(); // 花括号（伪造结构化日志）
    expect(sanitizeInboundId('a/b+c=')).toBeNull(); // URL 保留字（白名单外可见 ASCII）
    expect(sanitizeInboundId('req_追踪1')).toBeNull(); // 非 ASCII
    expect(sanitizeInboundId('a\tb')).toBeNull(); // 控制字符
  });

  it('shouldReject_nullAndEmpty_andPassthroughFirstHeaderValueShapes', () => {
    expect(sanitizeInboundId(null)).toBeNull();
    expect(sanitizeInboundId('')).toBeNull();
    // 与 firstHeaderValue 的组合面：空数组/空串/undefined 均收敛为 null（→ 重生成）
    expect(firstHeaderValue(undefined)).toBeNull();
    expect(firstHeaderValue([])).toBeNull();
    expect(firstHeaderValue([''])).toBeNull();
    expect(firstHeaderValue(['legal', 'second'])).toBe('legal');
  });
});
