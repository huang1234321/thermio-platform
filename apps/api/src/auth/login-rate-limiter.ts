/**
 * 登录防爆破限速（SEC-PW-04【强制】防爆破限速；platform.md §12：命中限速 429
 * common.rate_limited）。
 *
 * 形态：进程内固定窗口计数（key = 归一化 email + 客户端 IP），只计**失败**次数，
 * 成功登录清零。单实例 MVP 形态；多副本横向扩展时换共享存储（如 PG/Redis）——
 * 该边界在交付说明中显式声明，不静默假设已覆盖。
 */
export interface LoginRateLimitOptions {
  /** 窗口内允许的最大失败次数。 */
  readonly max: number;
  /** 窗口长度（毫秒）。 */
  readonly windowMs: number;
  /** 清扫周期（毫秒，默认窗口的 2 倍）。 */
  readonly sweepMs?: number;
}

export interface RateLimitVerdict {
  readonly allowed: boolean;
  /** 触发限速时距离窗口重置的剩余毫秒（未触发为 0）。 */
  readonly retryAfterMs: number;
}

interface WindowState {
  count: number;
  windowStart: number;
}

/** 解析 "次数/窗口秒"（AUTH_LOGIN_RATE_LIMIT）→ 选项；非法格式回退默认 10/300s。 */
export function parseRateLimitSpec(spec: string): LoginRateLimitOptions {
  const match = /^(\d{1,4})\/(\d{1,5})$/.exec(spec);
  if (match === null) return { max: 10, windowMs: 300_000 };
  const max = Number.parseInt(match[1] ?? '10', 10);
  const windowSeconds = Number.parseInt(match[2] ?? '300', 10);
  return { max, windowMs: windowSeconds * 1000 };
}

export class LoginRateLimiter {
  private readonly windows = new Map<string, WindowState>();
  private readonly sweepMs: number;
  private lastSweep = Date.now();

  constructor(private readonly options: LoginRateLimitOptions) {
    this.sweepMs = options.sweepMs ?? options.windowMs * 2;
  }

  /** 登录尝试前检查：窗口内失败次数已达上限则拒绝（429 common.rate_limited）。 */
  check(key: string, now: number = Date.now()): RateLimitVerdict {
    this.maybeSweep(now);
    const state = this.windows.get(key);
    if (state === undefined) return { allowed: true, retryAfterMs: 0 };
    if (now - state.windowStart >= this.options.windowMs) return { allowed: true, retryAfterMs: 0 };
    if (state.count >= this.options.max) {
      return { allowed: false, retryAfterMs: state.windowStart + this.options.windowMs - now };
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  /** 记录一次失败（成功路径调 reset）。 */
  recordFailure(key: string, now: number = Date.now()): void {
    const state = this.windows.get(key);
    if (state === undefined || now - state.windowStart >= this.options.windowMs) {
      this.windows.set(key, { count: 1, windowStart: now });
      return;
    }
    state.count += 1;
  }

  /** 成功登录清零（合法用户不被历史失败拖累）。 */
  reset(key: string): void {
    this.windows.delete(key);
  }

  /** 过期窗口清扫（防止 Map 无界增长）。 */
  private maybeSweep(now: number): void {
    if (now - this.lastSweep < this.sweepMs) return;
    this.lastSweep = now;
    for (const [key, state] of this.windows) {
      if (now - state.windowStart >= this.options.windowMs) this.windows.delete(key);
    }
  }
}
