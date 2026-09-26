/**
 * 游标编解码单测（API-DSN-03）：roundtrip + 非法输入统一 422 语义出口。
 */
import { describe, expect, it } from 'vitest';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { appendKeysetPredicate, decodeCursor, encodeCursor } from './cursor.js';

describe('cursor codec', () => {
  it('shouldRoundtripKeysetKeys', () => {
    const key = {
      created_at_us: '1795413600000123456',
      id: '0b7285a0-0000-4000-8000-000000000001',
    };
    expect(decodeCursor(encodeCursor(key))).toEqual(key);
  });

  it('shouldRejectGarbage_asValidationFailed', () => {
    expect(() => decodeCursor('%%%not-base64%%%')).toThrow(ReasonCodeException);
    expect(() => decodeCursor(Buffer.from('{"nope":1}').toString('base64url'))).toThrow(
      ReasonCodeException,
    );
    expect(() =>
      decodeCursor(
        Buffer.from(
          '{"created_at_us":"not-digits","id":"0b7285a0-0000-4000-8000-000000000001"}',
        ).toString('base64url'),
      ),
    ).toThrow(ReasonCodeException);
    expect(() =>
      decodeCursor(Buffer.from('{"created_at_us":"123","id":"not-a-uuid"}').toString('base64url')),
    ).toThrow(ReasonCodeException);
  });

  it('shouldAppendKeysetPredicate_withSequentialPlaceholders', () => {
    const where: string[] = ['u.tenant_id = $1'];
    const params: unknown[] = ['t1'];
    appendKeysetPredicate(where, params, 2, {
      created_at_us: '1795413600000123456',
      id: '0b7285a0-0000-4000-8000-000000000002',
    });
    expect(where[1]).toContain('$2::bigint');
    expect(where[1]).toContain('$3::uuid');
    expect(params).toHaveLength(3);
  });
});
