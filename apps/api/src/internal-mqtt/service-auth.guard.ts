/**
 * /internal/mqtt/* 服务间认证守卫（platform.md §11-2，emqx.md §3.1）。
 *
 * - Bearer 静态服务凭证（EMQX_INTERNAL_TOKEN，SEC-KEY-01 环境变量注入）；
 * - 常量时间比较（sha256 摘要后 timingSafeEqual——防时序侧信道，且与密文长度无关）；
 * - 轮换双读（SEC-KEY-04）：PREVIOUS token 同窗口接纳，切换后撤旧不留缝；
 * - 未配置 token = 一律拒绝（fail-closed，SEC-AZ-01：dev 栈不配钩子时端点不可用而非裸奔）；
 * - 路由白名单由挂载范围结构性满足（守卫只加在 internal/mqtt 控制器上，
 *   EMQX 凭证到不了其他路由）；
 * - 失败 401 auth.service_unauthorized，不泄露是哪一步失败（API-ERR-04）；
 *   token 值不落日志（SEC-KEY-02 / CODE-LOG-01）。
 */
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { AppConfig } from '../config.js';
import { APP_CONFIG } from '../infrastructure/core.module.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';

/** 常量时间 Bearer 比较：摘要等长后比较，比较耗时只与摘要长度（恒定）相关。 */
export function bearerTokenMatches(candidate: string, expected: string): boolean {
  const candidateDigest = createHash('sha256').update(candidate).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}

@Injectable()
export class ServiceAuthGuard implements CanActivate {
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

  /** 当前 + 轮换窗口内旧 token（空值/占位值过滤——不配轮换就只有一枚）。 */
  private collectConfiguredTokens(): string[] {
    return [this.config.EMQX_INTERNAL_TOKEN, this.config.EMQX_INTERNAL_TOKEN_PREVIOUS].filter(
      (token): token is string => typeof token === 'string' && token.length > 0,
    );
  }
}
