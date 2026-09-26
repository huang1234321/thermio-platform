/**
 * @Public() 豁免标记（SEC-AZ-01 的显式例外）：全局 JwtAuthGuard 对标注路由放行。
 * 仅用于：认证端点本身（login/refresh/complete-reset）与探针（healthz/metrics）。
 * 其余一切路由默认受保护——新增端点不需要（也不应该）记得加锁。
 */
import { SetMetadata } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export const IS_PUBLIC = 'thermio_is_public';

export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

/** 守卫用：目标路由（方法级优先，类级兜底）是否豁免。 */
export function isPublicRoute(reflector: Reflector, context: ExecutionContext): boolean {
  return (
    reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]) ?? false
  );
}
