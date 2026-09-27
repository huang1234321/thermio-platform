/**
 * 设备端点（modules M1-asset §3.3）：GET /systems/{id}/equipments、POST /equipments、
 * GET/PATCH /equipments/{id}。能力：assets.read / assets.write。
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
  EquipmentCreateSchema,
  EquipmentListQuerySchema,
  EquipmentUpdateSchema,
  type Equipment,
  type EquipmentCreate,
  type EquipmentListQuery,
  type EquipmentListResponse,
  type EquipmentUpdate,
} from '@thermio/shared-types';
import { ZodValidationPipe } from '../infrastructure/validation/zod-validation.pipe.js';
import { CapabilitiesGuard } from '../auth/capabilities.guard.js';
import { CurrentAuth, type AuthContext } from '../auth/auth-context.js';
import { RequireCapabilities } from '../auth/require-capabilities.decorator.js';
import { EquipmentsService } from './equipments.service.js';
import { IdempotencyStore, idempotencyKey } from './idempotency.js';
import { actor } from './buildings.controller.js';

const IdParam = z.uuid();

@Controller()
@UseGuards(CapabilitiesGuard)
export class EquipmentsController {
  constructor(
    @Inject(EquipmentsService) private readonly equipments: EquipmentsService,
    @Inject(IdempotencyStore) private readonly idempotency: IdempotencyStore,
  ) {}

  @Get('systems/:systemId/equipments')
  @RequireCapabilities('assets.read')
  async listBySystem(
    @Param('systemId', new ZodValidationPipe(IdParam)) systemId: string,
    @Query() query: EquipmentListQuery,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<EquipmentListResponse> {
    return this.equipments.listBySystem(
      actor(auth),
      systemId,
      EquipmentListQuerySchema.parse(query),
    );
  }

  @Post('equipments')
  @RequireCapabilities('assets.write')
  async create(
    @Headers() headers: Record<string, unknown>,
    @Body(new ZodValidationPipe(EquipmentCreateSchema)) body: EquipmentCreate,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<Equipment> {
    const who = actor(auth);
    const key = idempotencyKey(headers, who.tenant_id, who.user_id, 'POST /equipments');
    if (key === null) return this.equipments.create(who, body);
    return this.idempotency.run(key, () => this.equipments.create(who, body));
  }

  @Get('equipments/:equipmentId')
  @RequireCapabilities('assets.read')
  async get(
    @Param('equipmentId', new ZodValidationPipe(IdParam)) equipmentId: string,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<Equipment> {
    return this.equipments.get(actor(auth), equipmentId);
  }

  @Patch('equipments/:equipmentId')
  @RequireCapabilities('assets.write')
  async update(
    @Param('equipmentId', new ZodValidationPipe(IdParam)) equipmentId: string,
    @Body(new ZodValidationPipe(EquipmentUpdateSchema)) body: EquipmentUpdate,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<Equipment> {
    return this.equipments.update(actor(auth), equipmentId, body);
  }
}
