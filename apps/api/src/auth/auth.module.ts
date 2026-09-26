/**
 * 认证域模块（IMPL-10）：AuthService（login/logout/refresh/change-password/
 * complete-reset/me）+ 全局 JwtAuthGuard（APP_GUARD，默认保护一切路由）。
 * 依赖 @Global 的 CoreModule（APP_CONFIG/LOGGER）与 DbModule（双池 + TenantDb）。
 */
import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';

@Module({
  providers: [AuthService],
  controllers: [AuthController],
  exports: [AuthService],
})
export class AuthModule {}
