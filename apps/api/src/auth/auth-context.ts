/**
 * 请求级认证上下文（守卫校验后挂到 request，控制器经 @CurrentAuth() 取用）。
 * 源头是 access JWT claims + 服务端会话回查（会话与用户状态以 DB 为准，SEC-AZ-04）。
 */
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Role } from '@thermio/shared-types';

export interface AuthContext {
  readonly user_id: string;
  readonly tenant_id: string;
  readonly session_id: string;
  readonly role: Role;
  /** SEC-PW-03：初始/重置密码首登强制轮换标记（轮换完成前业务端点全部拒绝）。 */
  readonly must_change_password: boolean;
}

/** express request 上的挂载键（符号键，防与框架/业务字段碰撞）。 */
export const AUTH_CONTEXT_KEY = Symbol('thermio_auth_context');

export function setAuthContext(request: object, context: AuthContext): void {
  (request as Record<symbol, unknown>)[AUTH_CONTEXT_KEY] = context;
}

export function getAuthContext(request: object): AuthContext | undefined {
  return (request as Record<symbol, unknown>)[AUTH_CONTEXT_KEY] as AuthContext | undefined;
}

/** 控制器参数装饰器：取当前认证上下文（无认证路径为 undefined，调用方自行收窄）。 */
export const CurrentAuth = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContext | undefined => {
    const request = ctx.switchToHttp().getRequest<object>();
    return getAuthContext(request);
  },
);
