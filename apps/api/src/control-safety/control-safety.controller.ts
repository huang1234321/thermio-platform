/**
 * M8 控制安全端点（overview §4 M8 / M8-safety-ui.md §8，IMPL-18 / DAT-164）。
 *
 * - GET /control/points：可控点清单（§2.2 行实体：gate 四字段 + 模式 + 熔断联动位）；
 * - PATCH /points/{id}/gate：闸门参数编辑（reason 必填 + 二次确认在 UI；C1 逐字段
 *   config_audit；服务端复核 GATE_CLAMP_RANGE_INVALID / GATE_CONTROLLABLE_REQUIRES_
 *   CLAMP / GATE_RATE_INVALID——R8 语义扩展：可控点必填频率上限）；
 * - POST /points/{id}/control-mode：模式切换（前进一档/回退跨档 reason 必填；
 *   跳档与熔断前进封锁 → CONTROL_MODE_TRANSITION_INVALID details.cause=skip|fuse_open
 *   〔R6〕；C2 config_audit）；
 * - GET /config-audit：变更历史检索（field/actor_type/时间窗过滤，at DESC keyset）；
 * - 熔断两读端点在 FuseService（fuse-status / fuse-events）。
 *
 * 热生效（§3.0 T2）：本卡所有写端点不触碰执行中提案——已入队提案在派发前由
 * dispatcher 全量复评按最新参数仲裁（闸门 2 clamp/闸门 1 白名单在此拦下）。
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
  ConfigAuditListQuerySchema,
  ControlModeChangeRequestSchema,
  ControlPointsListQuerySchema,
  GatePatchRequestSchema,
  type ConfigAuditListResponse,
  type ControlModeChangeResponse,
  type ControlPointsListResponse,
  type FuseEventsResponse,
  type FuseStatusResponse,
  type GatePatchResponse,
} from '@thermio/shared-types';
import {
  ZodValidationPipe,
  zodFieldIssues,
} from '../infrastructure/validation/zod-validation.pipe.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { CapabilitiesGuard } from '../auth/capabilities.guard.js';
import { CurrentAuth, type AuthContext } from '../auth/auth-context.js';
import { RequireCapabilities } from '../auth/require-capabilities.decorator.js';
import type { AssetActor } from '../asset/asset-shared.js';
import { IdempotencyStore, idempotencyKey } from '../asset/idempotency.js';
import { ControlSafetyService } from './control-safety.service.js';
import { FuseService } from './fuse.service.js';

const PointIdParam = z.coerce.number().int().positive();
const SystemIdParam = z.uuid();

function actorOf(auth: AuthContext | undefined): AssetActor {
  if (auth === undefined) throw new ReasonCodeException('auth.forbidden', '权限不足');
  return { tenant_id: auth.tenant_id, user_id: auth.user_id, role: auth.role };
}

@Controller()
@UseGuards(CapabilitiesGuard)
export class ControlSafetyController {
  constructor(
    @Inject(ControlSafetyService) private readonly control: ControlSafetyService,
    @Inject(FuseService) private readonly fuse: FuseService,
    @Inject(IdempotencyStore) private readonly idempotency: IdempotencyStore,
  ) {}

  @Get('control/points')
  @RequireCapabilities('control.read')
  async listPoints(
    @Query() query: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<ControlPointsListResponse> {
    const parsed = ControlPointsListQuerySchema.parse(query ?? {});
    return this.control.listPoints(actorOf(auth), parsed);
  }

  @Patch('points/:pointId/gate')
  @RequireCapabilities('control.write')
  async patchGate(
    @Param('pointId', new ZodValidationPipe(PointIdParam)) pointId: number,
    @Headers() headers: Record<string, unknown>,
    @Body() raw: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<GatePatchResponse> {
    const parsed = GatePatchRequestSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      throw new ReasonCodeException('common.validation_failed', '请求体非法', {
        issues: zodFieldIssues(parsed.error),
      });
    }
    const who = actorOf(auth);
    const key = idempotencyKey(
      headers,
      who.tenant_id,
      who.user_id,
      `PATCH /points/${String(pointId)}/gate`,
    );
    const execute = () => this.control.patchGate(who, pointId, parsed.data);
    return key === null ? execute() : this.idempotency.run(key, execute);
  }

  @Post('points/:pointId/control-mode')
  @RequireCapabilities('control.write')
  @HttpCode(200)
  async changeMode(
    @Param('pointId', new ZodValidationPipe(PointIdParam)) pointId: number,
    @Headers() headers: Record<string, unknown>,
    @Body() raw: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<ControlModeChangeResponse> {
    const parsed = ControlModeChangeRequestSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      throw new ReasonCodeException('common.validation_failed', '请求体非法', {
        issues: zodFieldIssues(parsed.error),
      });
    }
    const who = actorOf(auth);
    const key = idempotencyKey(
      headers,
      who.tenant_id,
      who.user_id,
      `POST /points/${String(pointId)}/control-mode`,
    );
    const execute = () => this.control.changeMode(who, pointId, parsed.data);
    return key === null ? execute() : this.idempotency.run(key, execute);
  }

  @Get('config-audit')
  @RequireCapabilities('control.read')
  async configAudit(
    @Query() query: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<ConfigAuditListResponse> {
    const parsed = ConfigAuditListQuerySchema.parse(query ?? {});
    return this.control.configAudit(actorOf(auth), parsed);
  }

  @Get('control/systems/:systemId/fuse-status')
  @RequireCapabilities('control.read')
  async fuseStatus(
    @Param('systemId', new ZodValidationPipe(SystemIdParam)) systemId: string,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<FuseStatusResponse> {
    return this.fuse.status(actorOf(auth), systemId);
  }

  @Get('control/systems/:systemId/fuse-events')
  @RequireCapabilities('control.read')
  async fuseEvents(
    @Param('systemId', new ZodValidationPipe(SystemIdParam)) systemId: string,
    @Query() query: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<FuseEventsResponse> {
    const parsed = z
      .object({
        cursor: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(query ?? {});
    return this.fuse.events(actorOf(auth), systemId, parsed.cursor, parsed.limit);
  }
}
