/**
 * 系统端点（modules M1-asset §3.2）：GET /buildings/{id}/systems、POST /systems、
 * GET/PATCH /systems/{id}。能力：assets.read / assets.write。
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
  SystemCreateSchema,
  SystemListQuerySchema,
  SystemUpdateSchema,
  type HvacSystem,
  type SystemCreate,
  type SystemListQuery,
  type SystemListResponse,
  type SystemUpdate,
} from '@thermio/shared-types';
import { ZodValidationPipe } from '../infrastructure/validation/zod-validation.pipe.js';
import { CapabilitiesGuard } from '../auth/capabilities.guard.js';
import { CurrentAuth, type AuthContext } from '../auth/auth-context.js';
import { RequireCapabilities } from '../auth/require-capabilities.decorator.js';
import { SystemsService } from './systems.service.js';
import { IdempotencyStore, idempotencyKey } from './idempotency.js';
import { actor } from './buildings.controller.js';

const IdParam = z.uuid();

@Controller()
@UseGuards(CapabilitiesGuard)
export class SystemsController {
  constructor(
    @Inject(SystemsService) private readonly systems: SystemsService,
    @Inject(IdempotencyStore) private readonly idempotency: IdempotencyStore,
  ) {}

  @Get('buildings/:buildingId/systems')
  @RequireCapabilities('assets.read')
  async listByBuilding(
    @Param('buildingId', new ZodValidationPipe(IdParam)) buildingId: string,
    @Query() query: SystemListQuery,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<SystemListResponse> {
    return this.systems.listByBuilding(actor(auth), buildingId, SystemListQuerySchema.parse(query));
  }

  @Post('systems')
  @RequireCapabilities('assets.write')
  async create(
    @Headers() headers: Record<string, unknown>,
    @Body(new ZodValidationPipe(SystemCreateSchema)) body: SystemCreate,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<HvacSystem> {
    const who = actor(auth);
    const key = idempotencyKey(headers, who.tenant_id, who.user_id, 'POST /systems');
    if (key === null) return this.systems.create(who, body);
    return this.idempotency.run(key, () => this.systems.create(who, body));
  }

  @Get('systems/:systemId')
  @RequireCapabilities('assets.read')
  async get(
    @Param('systemId', new ZodValidationPipe(IdParam)) systemId: string,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<HvacSystem> {
    return this.systems.get(actor(auth), systemId);
  }

  @Patch('systems/:systemId')
  @RequireCapabilities('assets.write')
  async update(
    @Param('systemId', new ZodValidationPipe(IdParam)) systemId: string,
    @Body(new ZodValidationPipe(SystemUpdateSchema)) body: SystemUpdate,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<HvacSystem> {
    return this.systems.update(actor(auth), systemId, body);
  }
}
