/**
 * /internal/* algo 面服务凭证守卫（platform.md §11-2，IMPL-17 / DAT-163）。
 *
 * 与 internal-mqtt ServiceAuthGuard 同构（EMQX 面先例）：
 * - Bearer SVC_TOKEN_ALGO（SEC-KEY-01 环境变量注入；≥256-bit）；
 * - 常量时间比较（sha256 摘要后 timingSafeEqual）；
 * - 轮换双读（SEC-KEY-04）：SVC_TOKEN_ALGO_PREVIOUS 同窗口接纳；
 * - 未配置 token = 一律拒绝（fail-closed，SEC-AZ-01）；
 * - 路由白名单由挂载范围结构性满足（守卫只加在 algo internal 控制器上）；
 * - 失败 401 auth.service_unauthorized，不泄露是哪一步失败（API-ERR-04）；
 *   token 值不落日志（SEC-KEY-02 / CODE-LOG-01）。
 */
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { AppConfig } from '../config.js';
import { APP_CONFIG } from '../infrastructure/core.module.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { bearerTokenMatches } from '../internal-mqtt/service-auth.guard.js';

@Injectable()
export class AlgoServiceAuthGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;
    const configured = this.collectConfiguredTokens();
    if (header === undefined || !header.startsWith('Bearer ') || configured.length === 0) {
      // 单一出口文案：不区分缺头/错值/未配置（API-ERR-04）。
      throw new ReasonCodeException('auth.service_unauthorized', '服务凭证校验失败');
    }
    const candidate = header.slice('Bearer '.length);
    const allowed = configured.some((token) => bearerTokenMatches(candidate, token));
    if (!allowed) {
      throw new ReasonCodeException('auth.service_unauthorized', '服务凭证校验失败');
    }
    return true;
  }

  /** 当前 + 轮换窗口内旧 token（空值过滤——不配轮换就只有一枚）。 */
  private collectConfiguredTokens(): string[] {
    return [this.config.SVC_TOKEN_ALGO, this.config.SVC_TOKEN_ALGO_PREVIOUS].filter(
      (token): token is string => typeof token === 'string' && token.length > 0,
    );
  }
}
