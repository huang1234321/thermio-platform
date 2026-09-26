/**
 * 用户管理模块（IMPL-10，modules M7）：users/roles/building-scopes/reset-password。
 * 判权走 CapabilitiesGuard + @RequireCapabilities('users.manage')（控制器内声明）。
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [AuthModule],
  providers: [UsersService],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}
