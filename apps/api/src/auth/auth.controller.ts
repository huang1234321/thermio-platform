/**
 * 认证与会话端点（modules M7 API 草案：/auth/login、/auth/logout、/auth/refresh、
 * /auth/change-password、/auth/complete-reset、GET /me）。
 *
 * - 认证三端点 @Public（其余默认受全局 JwtAuthGuard 保护，SEC-AZ-01）；
 * - 请求体过 zod 管道（TS-02）；密码策略失败码独立为 user.password_policy_failed
 *   （modules M7 草案码，服务层显式判定），transport 层只做长度/形状校验；
 * - 客户端 IP/UA 只进会话记录不进日志正文（CODE-LOG-01）。
 */
import { Body, Controller, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  ChangePasswordRequestSchema,
  CompleteResetRequestSchema,
  type LoginResponse,
  type LoginRequest,
  type MeResponse,
  type RefreshRequest,
  LoginRequestSchema,
  RefreshRequestSchema,
} from '@thermio/shared-types';
import { ZodValidationPipe } from '../infrastructure/validation/zod-validation.pipe.js';
import { CurrentAuth, type AuthContext } from './auth-context.js';
import { Public } from './public.decorator.js';
import { AuthService } from './auth.service.js';

/** transport 层密码只限长度（策略语义由服务层给 user.password_policy_failed）。 */
const PlainPassword = z.string().min(1).max(128);

const ChangePasswordBody = ChangePasswordRequestSchema.extend({
  old_password: PlainPassword,
  new_password: PlainPassword,
});
const CompleteResetBody = CompleteResetRequestSchema.extend({
  new_password: PlainPassword,
});

@Controller()
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public()
  @Post('auth/login')
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(LoginRequestSchema)) body: LoginRequest,
    @Req() req: Request,
  ): Promise<LoginResponse> {
    const userAgent = req.headers['user-agent'];
    return this.auth.login(
      body.email,
      body.password,
      req.ip ?? null,
      typeof userAgent === 'string' ? userAgent : null,
    );
  }

  @Post('auth/logout')
  @HttpCode(204)
  async logout(@CurrentAuth() auth: AuthContext | undefined): Promise<void> {
    if (auth === undefined) return; // 不可达：全局守卫保证（类型收窄）
    await this.auth.logout(auth.tenant_id, auth.session_id);
  }

  @Public()
  @Post('auth/refresh')
  @HttpCode(200)
  async refresh(
    @Body(new ZodValidationPipe(RefreshRequestSchema)) body: RefreshRequest,
  ): Promise<LoginResponse> {
    return this.auth.refresh(body.refresh_token);
  }

  @Post('auth/change-password')
  @HttpCode(200)
  async changePassword(
    @Body(new ZodValidationPipe(ChangePasswordBody)) body: z.infer<typeof ChangePasswordBody>,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<LoginResponse> {
    if (auth === undefined) throw new Error('unreachable: 全局守卫保证认证上下文');
    return this.auth.changePassword(
      auth.tenant_id,
      auth.user_id,
      auth.session_id,
      body.old_password,
      body.new_password,
    );
  }

  @Public()
  @Post('auth/complete-reset')
  @HttpCode(204)
  async completeReset(
    @Body(new ZodValidationPipe(CompleteResetBody)) body: z.infer<typeof CompleteResetBody>,
  ): Promise<void> {
    await this.auth.completeReset(body.email, body.reset_token, body.new_password);
  }

  @Get('me')
  async me(@CurrentAuth() auth: AuthContext | undefined): Promise<MeResponse> {
    if (auth === undefined) throw new Error('unreachable: 全局守卫保证认证上下文');
    return this.auth.me(auth.tenant_id, auth.user_id, auth.session_id);
  }
}
