/**
 * 能力守卫（SEC-AZ-05：按能力判权，默认拒绝 SEC-AZ-01）。
 *
 * 与 /me 下发共用 shared-types 的 ROLE_CAPABILITIES 推导表——UI 显隐与服务端判权
 * 同源同表，控制器不出现角色名字符串分支。角色以守卫回查的 DB 值为准（会话回查
 * JOIN user_role），JWT 里的 role 仅供展示级参考。
 */
import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { capabilitiesForRole } from '@thermio/shared-types';
import { getAuthContext } from './auth-context.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { REQUIRE_CAPABILITIES } from './require-capabilities.decorator.js';

@Injectable()
export class CapabilitiesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<readonly string[] | undefined>(
      REQUIRE_CAPABILITIES,
      [context.getHandler(), context.getClass()],
    );
    if (required === undefined || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<object>();
    const auth = getAuthContext(request);
    if (auth === undefined) {
      // 能力守卫只装在受保护控制器上；走到这里说明认证守卫被绕过（编程性错误）→ fail-closed
      throw new ReasonCodeException('auth.forbidden', '权限不足');
    }
    const granted = new Set<string>(capabilitiesForRole(auth.role));
    for (const capability of required) {
      if (!granted.has(capability)) {
        throw new ReasonCodeException('auth.forbidden', '权限不足');
      }
    }
    return true;
  }
}
