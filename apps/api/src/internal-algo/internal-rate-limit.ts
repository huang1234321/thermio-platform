/**
 * internal 提交限速（platform.md §12：proposals / fdd findings 各 60/min per
 * service token）——命中 429 common.rate_limited（details.retry_after_s 供客户端
 * 退避；algo 侧尊重 Retry-After 头，缺头时按自带指数退避，algo.md §8.1）。
 *
 * 形态：进程内固定窗口计数（auth LoginRateLimiter 同构；单调用方单实例 MVP 形态，
 * 多副本横向扩展时换共享存储——边界在交付说明显式声明，不静默假设已覆盖）。
 */
import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '../config.js';
import { APP_CONFIG } from '../infrastructure/core.module.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { parseRateLimitSpec } from '../auth/login-rate-limiter.js';

interface WindowState {
  count: number;
  windowStart: number;
}

@Injectable()
export class InternalRateLimiter {
  private readonly windows = new Map<string, WindowState>();

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const { max, windowMs } = parseRateLimitSpec(config.INTERNAL_SUBMIT_RATE_LIMIT);
    this.max = max;
    this.windowMs = windowMs;
  }

  private readonly max: number;
  private readonly windowMs: number;

  /** 计数并判定：超限抛 429（重试等待秒进 details）。 */
  consume(key: string, now: number = Date.now()): void {
    const state = this.windows.get(key);
    if (state === undefined || now - state.windowStart >= this.windowMs) {
      this.windows.set(key, { count: 1, windowStart: now });
      return;
    }
    state.count += 1;
    if (state.count > this.max) {
      const retryAfterS = Math.ceil((state.windowStart + this.windowMs - now) / 1000);
      throw new ReasonCodeException('common.rate_limited', '提交限速', {
        retry_after_s: retryAfterS,
      });
    }
  }
}
