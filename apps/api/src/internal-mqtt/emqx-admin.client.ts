/**
 * EMQX 管理 API 客户端（emqx.md §5.3 对账消费面；凭证走 env，SEC-KEY-01）。
 *
 * GET /api/v5/clients?clientid={id}（EMQX 5.x）：200 + data 非空 = 会话在；
 * 200 + data 空 = 明确无会话。网络失败/非 2xx 抛错——由 reconciler 决定跳过，
 * 绝不把「探不到」当「已失联」（EMQX 管理 API 故障不得连锁清空全部在线状态）。
 */
import { Inject, Injectable, type InjectionToken } from '@nestjs/common';
import type { AppConfig } from '../config.js';
import { APP_CONFIG } from '../infrastructure/core.module.js';

/** 管理 API 探测端口（测试以结构化假实现替换，不 mock fetch）。 */
export interface EmqxAdminPort {
  /** EMQX 是否持有该 clientid 的活跃会话；查询失败抛错（调用方 fail-safe 跳过）。 */
  hasClientSession(clientid: string): Promise<boolean>;
}

export const EMQX_ADMIN: InjectionToken<EmqxAdminPort> = Symbol('EMQX_ADMIN');

@Injectable()
export class EmqxAdminClient implements EmqxAdminPort {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async hasClientSession(clientid: string): Promise<boolean> {
    const url = `${this.config.EMQX_MANAGEMENT_BASE_URL}/api/v5/clients?clientid=${encodeURIComponent(clientid)}`;
    // EMQX 5.x 管理 API 默认凭证形态：api_key:api_secret（Basic）。
    const basic = Buffer.from(
      `${this.config.EMQX_MANAGEMENT_API_KEY}:${this.config.EMQX_MANAGEMENT_API_SECRET}`,
      'utf8',
    ).toString('base64');
    const res = await fetch(url, {
      method: 'GET',
      headers: { authorization: `Basic ${basic}` },
      signal: AbortSignal.timeout(this.config.EMQX_MANAGEMENT_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`emqx management api status ${String(res.status)}`);
    }
    const body = (await res.json()) as { data?: unknown };
    return Array.isArray(body.data) && body.data.length > 0;
  }
}
