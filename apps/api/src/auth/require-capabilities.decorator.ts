/**
 * @RequireCapabilities(...capabilities)：端点能力声明（SEC-AZ-05 能力判权 + SEC-AZ-01
 * 默认拒绝）。CapabilitiesGuard 与 GET /me 下发共用 shared-types 的推导表——
 * UI 显隐与服务端判权同源，禁止在控制器内按角色名硬编码分支。
 */
import { SetMetadata } from '@nestjs/common';
import type { Capability } from '@thermio/shared-types';

export const REQUIRE_CAPABILITIES = 'thermio_require_capabilities';

export const RequireCapabilities = (...capabilities: readonly Capability[]): MethodDecorator =>
  SetMetadata(REQUIRE_CAPABILITIES, capabilities);
