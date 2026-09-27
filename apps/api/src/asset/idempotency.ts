/**
 * 幂等键内存去重（API-DSN-01；M1-asset 开放点 O1 的 MVP 定夺形态）。
 *
 * - 单实例内存承载，24h 窗口；ADR-014 阶段 2 API×2 时换 PG 增量表或等价共享承载
 *   （O1 与 platform §5.3 幂等全局方案合并定夺，IMPL-2/18）；
 * - 只缓存 **2xx 成功结果**（失败/校验错误不缓存，客户端重试合法）；
 * - in-flight promise 去重：同键并发请求共享首次执行（「重试不得铸出两枚凭证」
 *   的并发面，M1-asset §3.9）；
 * - 键作用域 = (tenant_id, user_id, 路径, Idempotency-Key)——跨用户/跨端点不串。
 */
import { Injectable } from '@nestjs/common';

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 10_000;

interface CachedOutcome {
  readonly body: unknown;
  readonly expiresAt: number;
}

@Injectable()
export class IdempotencyStore {
  private readonly cached = new Map<string, CachedOutcome>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  /** 同键执行：命中缓存回放 2xx body；in-flight 等待首次结果；否则执行并缓存。 */
  async run<T>(scopedKey: string, execute: () => Promise<T>): Promise<T> {
    const hit = this.cached.get(scopedKey);
    if (hit !== undefined && hit.expiresAt > Date.now()) {
      return hit.body as T;
    }
    this.cached.delete(scopedKey);

    const running = this.inFlight.get(scopedKey);
    if (running !== undefined) {
      return (await running) as T;
    }
    const promise = Promise.resolve()
      .then(execute)
      .finally(() => {
        this.inFlight.delete(scopedKey);
      });
    this.inFlight.set(scopedKey, promise);

    const body = await promise;
    if (this.cached.size >= MAX_ENTRIES) this.sweep();
    this.cached.set(scopedKey, { body, expiresAt: Date.now() + TTL_MS });
    return body;
  }

  /** 过期清扫（惰性触发，摊 O(n) 到写入面）。 */
  private sweep(): void {
    const now = Date.now();
    for (const [key, outcome] of this.cached) {
      if (outcome.expiresAt <= now) this.cached.delete(key);
    }
    // 仍超上限：整体丢弃（MVP 形态宁可丢幂等记忆不做 LRU 复杂度）。
    if (this.cached.size >= MAX_ENTRIES) this.cached.clear();
  }
}

/** Idempotency-Key 请求头读取 + 作用域拼装（缺头 → null，不启用幂等）。 */
export function idempotencyKey(
  headers: Record<string, unknown>,
  tenantId: string,
  userId: string,
  path: string,
): string | null {
  const raw = headers['idempotency-key'];
  if (raw === undefined || typeof raw !== 'string' || raw.trim().length === 0) return null;
  return `${tenantId}:${userId}:${path}:${raw.trim()}`;
}
