/**
 * 网关与凭证端点（modules M1-asset §3.8/§3.9）：
 * - GET/POST /gateways、GET/PATCH /gateways/{id}（能力 assets.read / gateways.manage）；
 * - POST /gateways/{id}/credentials（生成/轮换，secret 仅本次返回）；
 * - POST /credentials/{id}/disable（吊销，单向幂等）。
 */
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  CredentialDisableRequestSchema,
  GatewayCreateSchema,
  GatewayListQuerySchema,
  GatewayUpdateSchema,
  type CredentialDisableRequest,
  type CredentialIssueResponse,
  type CredentialMeta,
  type Gateway,
  type GatewayCreate,
  type GatewayDetail,
  type GatewayListQuery,
  type GatewayUpdate,
  type Page,
} from '@thermio/shared-types';
import { ZodValidationPipe } from '../infrastructure/validation/zod-validation.pipe.js';
import { CapabilitiesGuard } from '../auth/capabilities.guard.js';
import { CurrentAuth, type AuthContext } from '../auth/auth-context.js';
import { RequireCapabilities } from '../auth/require-capabilities.decorator.js';
import { GatewaysService } from './gateways.service.js';
import { IdempotencyStore, idempotencyKey } from './idempotency.js';
import { actor } from './buildings.controller.js';

const IdParam = z.uuid();

@Controller()
@UseGuards(CapabilitiesGuard)
export class GatewaysController {
  constructor(
    @Inject(GatewaysService) private readonly gateways: GatewaysService,
    @Inject(IdempotencyStore) private readonly idempotency: IdempotencyStore,
  ) {}

  @Get('gateways')
  @RequireCapabilities('assets.read')
  async list(
    @Query() query: GatewayListQuery,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<Page<Gateway>> {
    return this.gateways.list(actor(auth), GatewayListQuerySchema.parse(query));
  }

  @Post('gateways')
  @RequireCapabilities('gateways.manage')
  async create(
    @Headers() headers: Record<string, unknown>,
    @Body(new ZodValidationPipe(GatewayCreateSchema)) body: GatewayCreate,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<Gateway> {
    const who = actor(auth);
    const key = idempotencyKey(headers, who.tenant_id, who.user_id, 'POST /gateways');
    if (key === null) return this.gateways.create(who, body);
    return this.idempotency.run(key, () => this.gateways.create(who, body));
  }

  @Get('gateways/:gatewayId')
  @RequireCapabilities('assets.read')
  async detail(
    @Param('gatewayId', new ZodValidationPipe(IdParam)) gatewayId: string,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<GatewayDetail> {
    return this.gateways.detail(actor(auth), gatewayId);
  }

  @Patch('gateways/:gatewayId')
  @RequireCapabilities('gateways.manage')
  async update(
    @Param('gatewayId', new ZodValidationPipe(IdParam)) gatewayId: string,
    @Body(new ZodValidationPipe(GatewayUpdateSchema)) body: GatewayUpdate,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<GatewayDetail> {
    return this.gateways.update(actor(auth), gatewayId, body);
  }

  /** POST /gateways/{id}/credentials（幂等键：重试不得铸出两枚凭证，§3.9）。 */
  @Post('gateways/:gatewayId/credentials')
  @RequireCapabilities('gateways.manage')
  async issueCredential(
    @Headers() headers: Record<string, unknown>,
    @Param('gatewayId', new ZodValidationPipe(IdParam)) gatewayId: string,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<CredentialIssueResponse> {
    const who = actor(auth);
    const key = idempotencyKey(
      headers,
      who.tenant_id,
      who.user_id,
      `POST /gateways/${gatewayId}/credentials`,
    );
    if (key === null) return this.gateways.issueCredential(who, gatewayId);
    return this.idempotency.run(key, () => this.gateways.issueCredential(who, gatewayId));
  }

  @Post('credentials/:credentialId/disable')
  @RequireCapabilities('gateways.manage')
  @HttpCode(200)
  async disableCredential(
    @Param('credentialId', new ZodValidationPipe(IdParam)) credentialId: string,
    @Body(new ZodValidationPipe(CredentialDisableRequestSchema)) body: CredentialDisableRequest,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<CredentialMeta> {
    return this.gateways.disableCredential(actor(auth), credentialId, body);
  }
}
