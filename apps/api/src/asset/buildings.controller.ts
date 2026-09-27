/**
 * 楼宇端点（modules M1-asset §3.1）：GET/POST /buildings、GET/PATCH /buildings/{id}。
 * 能力：assets.read / assets.write（§1.5）；幂等键可选（POST，O1 MVP 内存去重）。
 */
import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  BuildingCreateSchema,
  BuildingListQuerySchema,
  BuildingUpdateSchema,
  type Building,
  type BuildingCreate,
  type BuildingListQuery,
  type BuildingListResponse,
  type BuildingUpdate,
} from '@thermio/shared-types';
import { ZodValidationPipe } from '../infrastructure/validation/zod-validation.pipe.js';
import { CapabilitiesGuard } from '../auth/capabilities.guard.js';
import { CurrentAuth, type AuthContext } from '../auth/auth-context.js';
import { RequireCapabilities } from '../auth/require-capabilities.decorator.js';
import { BuildingsService } from './buildings.service.js';
import { IdempotencyStore, idempotencyKey } from './idempotency.js';
import type { AssetActor } from './asset-shared.js';

const BuildingIdParam = z.uuid();

@Controller()
@UseGuards(CapabilitiesGuard)
export class BuildingsController {
  constructor(
    @Inject(BuildingsService) private readonly buildings: BuildingsService,
    @Inject(IdempotencyStore) private readonly idempotency: IdempotencyStore,
  ) {}

  @Get('buildings')
  @RequireCapabilities('assets.read')
  async list(
    @Query() query: BuildingListQuery,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<BuildingListResponse> {
    return this.buildings.list(actor(auth), BuildingListQuerySchema.parse(query));
  }

  @Post('buildings')
  @RequireCapabilities('assets.write')
  async create(
    @Headers() headers: Record<string, unknown>,
    @Body(new ZodValidationPipe(BuildingCreateSchema)) body: BuildingCreate,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<Building> {
    const who = actor(auth);
    const key = idempotencyKey(headers, who.tenant_id, who.user_id, 'POST /buildings');
    if (key === null) return this.buildings.create(who, body);
    return this.idempotency.run(key, () => this.buildings.create(who, body));
  }

  @Get('buildings/:buildingId')
  @RequireCapabilities('assets.read')
  async get(
    @Param('buildingId', new ZodValidationPipe(BuildingIdParam)) buildingId: string,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<Building> {
    return this.buildings.get(actor(auth), buildingId);
  }

  @Patch('buildings/:buildingId')
  @RequireCapabilities('assets.write')
  async update(
    @Param('buildingId', new ZodValidationPipe(BuildingIdParam)) buildingId: string,
    @Body(new ZodValidationPipe(BuildingUpdateSchema)) body: BuildingUpdate,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<Building> {
    return this.buildings.update(actor(auth), buildingId, body);
  }
}

/** 类型收窄 + AuthContext → 资产域身份（复用 users 控制器同款 unreachable 注记）。 */
export function actor(auth: AuthContext | undefined): AssetActor {
  if (auth === undefined) throw new Error('unreachable: 全局守卫保证认证上下文');
  return { tenant_id: auth.tenant_id, user_id: auth.user_id, role: auth.role };
}
