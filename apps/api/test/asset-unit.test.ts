/**
 * 资产域单元测试：游标编解码（多样键形）+ 幂等内存去重（O1 MVP 形态）。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  decodeAssetCursor,
  encodeAssetCursor,
  isMicrosecondKey,
  keysetPredicate,
} from '../src/asset/asset-cursor.js';
import { IdempotencyStore } from '../src/asset/idempotency.js';
import { ReasonCodeException } from '../src/infrastructure/errors/reason-code.exception.js';

describe('asset keyset cursor', () => {
  it('shouldRoundtrip_timeKeyedCursor', () => {
    const encoded = encodeAssetCursor({
      k: ['1760000000000000'],
      id: '00000000-0000-0000-0000-000000000001',
    });
    const decoded = decodeAssetCursor(encoded, 1);
    expect(decoded.k).toEqual(['1760000000000000']);
    expect(isMicrosecondKey(decoded.k[0] ?? '')).toBe(true);
  });

  it('shouldRoundtrip_textKeyedCursor', () => {
    const encoded = encodeAssetCursor({
      k: ['chilled_water', '冷冻系统'],
      id: '00000000-0000-0000-0000-000000000002',
    });
    const decoded = decodeAssetCursor(encoded, 2);
    expect(decoded.k).toEqual(['chilled_water', '冷冻系统']);
  });

  it('shouldAcceptBigintPointId', () => {
    const encoded = encodeAssetCursor({ k: ['CHW.ST01.TEMP'], id: '42' });
    expect(decodeAssetCursor(encoded, 1).id).toBe('42');
  });

  it('shouldRejectMalformedCursors_withValidationFailed', () => {
    const cases = ['not-a-cursor', Buffer.from('{"k":["a"],"id":"42"}').toString('base64url')]; // 少键段
    for (const cursor of cases) {
      expect(() => decodeAssetCursor(cursor, 2)).toThrow(ReasonCodeException);
    }
    const wrongLength = encodeAssetCursor({ k: ['a'], id: '00000000-0000-0000-0000-000000000003' });
    expect(() => decodeAssetCursor(wrongLength, 2)).toThrow(ReasonCodeException);
  });

  it('shouldBuildTuplePredicate_withCasts', () => {
    const predicate = keysetPredicate('(p.raw_name, p.id)', { k: ['A'], id: '7' }, 3, [
      '',
      '::bigint',
    ]);
    expect(predicate.sql).toBe('(p.raw_name, p.id) > ($3, $4::bigint)');
    expect(predicate.params).toEqual(['A', '7']);
  });
});

describe('IdempotencyStore（O1 MVP 内存形态）', () => {
  it('shouldReplayTheSameOutcome_forTheSameKey', async () => {
    const store = new IdempotencyStore();
    const execute = vi.fn(async () => {
      await Promise.resolve();
      return { id: 'once' };
    });
    const first = await store.run('k1', execute);
    const second = await store.run('k1', execute);
    expect(first).toEqual({ id: 'once' });
    expect(second).toEqual(first);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('shouldShareInFlightExecution_forConcurrentSameKey', async () => {
    const store = new IdempotencyStore();
    let started = 0;
    const execute = async (): Promise<string> => {
      started += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return `result-${String(started)}`;
    };
    const [a, b] = await Promise.all([store.run('k2', execute), store.run('k2', execute)]);
    expect(started).toBe(1);
    expect(a).toBe('result-1');
    expect(b).toBe('result-1');
  });

  it('shouldNotCacheFailures_andExecuteAgainAfterError', async () => {
    const store = new IdempotencyStore();
    let attempts = 0;
    await expect(
      store.run('k3', async () => {
        attempts += 1;
        await Promise.reject(new Error('transient'));
      }),
    ).rejects.toThrow('transient');
    const ok = await store.run('k3', async () => {
      attempts += 1;
      await Promise.resolve();
      return 'recovered';
    });
    expect(ok).toBe('recovered');
    expect(attempts).toBe(2);
  });

  it('shouldIsolateKeys_byScope', async () => {
    const store = new IdempotencyStore();
    const a = await store.run('tenant:user:path:K', () => Promise.resolve('A'));
    const b = await store.run('tenant:other:path:K', () => Promise.resolve('B'));
    expect(a).toBe('A');
    expect(b).toBe('B');
  });
});
