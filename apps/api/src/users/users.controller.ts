/**
 * 用户管理端点（modules M7 API 草案：GET/POST /users、PATCH /users/{id}、
 * PUT /users/{id}/roles、PUT /users/{id}/building-scopes、POST /users/{id}/reset-password）。
 *
 * 全部 @RequireCapabilities('users.manage')（M7 admin 专属，overview §7 矩阵）——
 * 判权在 CapabilitiesGuard，控制器不写角色名分支（SEC-AZ-05）。
 * 查询参数白名单校验（API-DSN-04）过 zod 管道。
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  CreateUserRequestSchema,
  UpdateBuildingScopesRequestSchema,
  UpdateRolesRequestSchema,
  UpdateUserRequestSchema,
  UserListQuerySchema,
  type CreateUserRequest,
  type ResetPasswordResponse,
  type UpdateBuildingScopesRequest,
  type UpdateRolesRequest,
  type UpdateUserRequest,
  type UserListItem,
  type UserListQuery,
  type UserListResponse,
} from '@thermio/shared-types';
import { ZodValidationPipe } from '../infrastructure/validation/zod-validation.pipe.js';
import { CapabilitiesGuard } from '../auth/capabilities.guard.js';
import { CurrentAuth, type AuthContext } from '../auth/auth-context.js';
import { RequireCapabilities } from '../auth/require-capabilities.decorator.js';
import { UsersService } from './users.service.js';

const UserIdParam = z.uuid();

/** transport 层建用户密码只限长度（策略语义在服务层 → user.password_policy_failed）。 */
const CreateBody = CreateUserRequestSchema.extend({
  password: z.string().min(1).max(128),
});

@Controller()
@UseGuards(CapabilitiesGuard)
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Get('users')
  @RequireCapabilities('users.manage')
  async list(
    @Query() query: UserListQuery,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<UserListResponse> {
    assertAuth(auth);
    const parsed = UserListQuerySchema.parse(query);
    return this.users.list(auth.tenant_id, parsed);
  }

  @Post('users')
  @RequireCapabilities('users.manage')
  async create(
    @Body(new ZodValidationPipe(CreateBody)) body: CreateUserRequest,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<UserListItem> {
    assertAuth(auth);
    return this.users.create(auth.tenant_id, body);
  }

  @Patch('users/:id')
  @RequireCapabilities('users.manage')
  async update(
    @Param('id', new ZodValidationPipe(UserIdParam)) id: string,
    @Body(new ZodValidationPipe(UpdateUserRequestSchema)) body: UpdateUserRequest,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<UserListItem> {
    assertAuth(auth);
    return this.users.update(auth.tenant_id, id, body);
  }

  @Put('users/:id/roles')
  @RequireCapabilities('users.manage')
  @HttpCode(200)
  async updateRoles(
    @Param('id', new ZodValidationPipe(UserIdParam)) id: string,
    @Body(new ZodValidationPipe(UpdateRolesRequestSchema)) body: UpdateRolesRequest,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<{ ok: true }> {
    assertAuth(auth);
    await this.users.updateRoles(auth.tenant_id, id, body.role);
    return { ok: true };
  }

  @Put('users/:id/building-scopes')
  @RequireCapabilities('users.manage')
  @HttpCode(200)
  async updateBuildingScopes(
    @Param('id', new ZodValidationPipe(UserIdParam)) id: string,
    @Body(new ZodValidationPipe(UpdateBuildingScopesRequestSchema))
    body: UpdateBuildingScopesRequest,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<{ ok: true }> {
    assertAuth(auth);
    await this.users.updateBuildingScopes(auth.tenant_id, id, body.building_ids);
    return { ok: true };
  }

  @Post('users/:id/reset-password')
  @RequireCapabilities('users.manage')
  @HttpCode(200)
  async resetPassword(
    @Param('id', new ZodValidationPipe(UserIdParam)) id: string,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<ResetPasswordResponse> {
    assertAuth(auth);
    return this.users.resetPassword(auth.tenant_id, id);
  }
}

/** 类型收窄：类级 CapabilitiesGuard 在全局 JwtAuthGuard 之后，必有认证上下文。 */
function assertAuth(auth: AuthContext | undefined): asserts auth is AuthContext {
  if (auth === undefined) {
    throw new Error('unreachable: 全局守卫保证认证上下文');
  }
}
