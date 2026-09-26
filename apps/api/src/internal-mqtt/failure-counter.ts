/**
 * 认证失败限速（emqx.md §3.3-6）：按 username + peerhost 计数的滑动窗口。
 *
 * 两个动作分离：isBlocked 在校验前早判（触顶直接 deny），recordFailure 只登记
 * 「密码校验失败」类结果（猜密码信号才是防爆破目标；disabled/绑定不符不计入，
 * 避免非暴力场景锁死合法网关）。触顶信号 WARN 留痕供告警域消费（IMPL-13 接通）。
 * v1 内存实现（单副本形态）；多副本时升 PG 计数，端点行为不变。
 */
import { type InjectionToken } from '@nestjs/common';

export interface MqttAuthFailureCounterPort {
  /** 窗口内失败数已达阈值 → true（早判，不改动计数）。 */
  isBlocked(username: string, peerhost: string): boolean;
  /** 登记一次失败；登记后达到阈值返回 true（供触顶留痕）。 */
  recordFailure(username: string, peerhost: string): boolean;
}

export const MQTT_AUTH_FAILURE_COUNTER: InjectionToken<MqttAuthFailureCounterPort> = Symbol(
  'MQTT_AUTH_FAILURE_COUNTER',
);

export class SlidingWindowFailureCounter implements MqttAuthFailureCounterPort {
  private readonly windows = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly onThresholdReached: (username: string, peerhost: string) => void,
    private readonly now: () => number = () => Date.now(),
  ) {}

  isBlocked(username: string, peerhost: string): boolean {
    return this.windowFailureCount(username, peerhost) >= this.limit;
  }

  recordFailure(username: string, peerhost: string): boolean {
    const now = this.now();
    const key = `${username}|${peerhost}`;
    const failures = (this.windows.get(key) ?? []).filter((t) => t > now - this.windowMs);
    failures.push(now);
    this.windows.set(key, failures);
    const reached = failures.length >= this.limit;
    if (reached) this.onThresholdReached(username, peerhost);
    return reached;
  }

  private windowFailureCount(username: string, peerhost: string): number {
    this.sweepStaleEntries();
    const failures = this.windows.get(`${username}|${peerhost}`) ?? [];
    return failures.filter((t) => t > this.now() - this.windowMs).length;
  }

  /** 惰性清扫：每过一个窗口周期清一次全表，防止 key 无界增长。 */
  private sweepStaleEntries(): void {
    const now = this.now();
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    const cutoff = now - this.windowMs;
    for (const [key, failures] of this.windows) {
      const alive = failures.filter((t) => t > cutoff);
      if (alive.length === 0) this.windows.delete(key);
      else this.windows.set(key, alive);
    }
  }
}
