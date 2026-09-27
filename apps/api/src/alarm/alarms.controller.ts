/**
 * 告警端点（modules M4-alarm.md §3.1–§3.7，IMPL-13 / DAT-116）。
 *
 * - 能力键（§1.5 = M7-auth §4.1 定稿逐字）：alarms.read（viewer+）/ alarms.ack
 *   （operator+）/ alarms.suppress（admin）；
 * - 幂等键可选（API-DSN-01）：ack/close（suppress/batch-ack 不挂幂等——
 *   suppress 天然可重复触发、batch-ack 逐项 207 自幂等）；
 * - batch-ack 逐项 207（API-DSN-05，上限 100 = platform §12 容量表）；
 * - 错误码域见 shared-types reason-codes 五批注册（alarm.*）。
 */
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  AlarmAckSchema,
  AlarmBatchAckSchema,
  AlarmCloseSchema,
  AlarmListQuerySchema,
  AlarmSuppressionListQuerySchema,
  AlarmUnsuppressSchema,
} from '@thermio/shared-types';
import {
  ZodValidationPipe,
  zodFieldIssues,
} from '../infrastructure/validation/zod-validation.pipe.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { CapabilitiesGuard } from '../auth/capabilities.guard.js';
import { CurrentAuth, type AuthContext } from '../auth/auth-context.js';
import { RequireCapabilities } from '../auth/require-capabilities.decorator.js';
import { IdempotencyStore, idempotencyKey } from '../asset/idempotency.js';
import { AlarmsService } from './alarms.service.js';
import type { AlarmActor } from './alarm-shared.js';

/** 告警主键 bigint IDENTITY（非 uuid 族）。 */
const AlarmIdParam = z.coerce.number().int().positive();

function actorOf(auth: AuthContext | undefined): AlarmActor {
  if (auth === undefined) {
    throw new ReasonCodeException('auth.forbidden', '权限不足');
  }
  return { tenant_id: auth.tenant_id, user_id: auth.user_id, role: auth.role };
}

/**
 * suppress 请求体形状（duration_s 仅形状校验——整数；值域 [300, 86400] 映射
 * alarm.suppress_duration_invalid，由服务层判定，§3.6/§1.2）。
 */
const SuppressBodyShape = z.object({
  duration_s: z.number().int(),
  reason: z.string().min(1).max(1024),
  cascade: z.boolean().optional(),
});

@Controller()
@UseGuards(CapabilitiesGuard)
export class AlarmsController {
  constructor(
    @Inject(AlarmsService) private readonly alarms: AlarmsService,
    @Inject(IdempotencyStore) private readonly idempotency: IdempotencyStore,
  ) {}

  @Get('alarms')
  @RequireCapabilities('alarms.read')
  async list(
    @Query() query: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    const parsed = AlarmListQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new ReasonCodeException('common.validation_failed', '查询参数非法', {
        issues: zodFieldIssues(parsed.error),
      });
    }
    return this.alarms.list(actorOf(auth), parsed.data);
  }

  @Get('alarms/counts')
  @RequireCapabilities('alarms.read')
  async counts(
    @Query('building_id', new ZodValidationPipe(z.uuid().optional()))
    buildingId: string | undefined,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    return this.alarms.counts(actorOf(auth), buildingId);
  }

  @Get('alarms/suppressions')
  @RequireCapabilities('alarms.read')
  async suppressionList(
    @Query() query: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    const parsed = AlarmSuppressionListQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new ReasonCodeException('common.validation_failed', '查询参数非法', {
        issues: zodFieldIssues(parsed.error),
      });
    }
    return this.alarms.suppressionList(actorOf(auth), parsed.data);
  }

  @Get('alarms/:alarmId')
  @RequireCapabilities('alarms.read')
  async detail(
    @Param('alarmId', new ZodValidationPipe(AlarmIdParam)) alarmId: number,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    return this.alarms.detail(actorOf(auth), alarmId);
  }

  @Post('alarms/batch-ack')
  @RequireCapabilities('alarms.ack')
  @HttpCode(207)
  async batchAck(
    @Body() raw: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    const parsed = AlarmBatchAckSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ReasonCodeException('common.validation_failed', '请求体非法', {
        issues: zodFieldIssues(parsed.error),
      });
    }
    return this.alarms.batchAck(actorOf(auth), parsed.data.ids);
  }

  @Post('alarms/:alarmId/ack')
  @RequireCapabilities('alarms.ack')
  @HttpCode(200)
  async ack(
    @Param('alarmId', new ZodValidationPipe(AlarmIdParam)) alarmId: number,
    @Headers() headers: Record<string, unknown>,
    @Body() raw: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    const parsed = AlarmAckSchema.safeParse(raw ?? {});
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
      `POST /alarms/${String(alarmId)}/ack`,
    );
    if (key === null) return this.alarms.ack(who, alarmId, parsed.data.reason);
    return this.idempotency.run(key, () => this.alarms.ack(who, alarmId, parsed.data.reason));
  }

  @Post('alarms/:alarmId/close')
  @RequireCapabilities('alarms.ack')
  @HttpCode(200)
  async close(
    @Param('alarmId', new ZodValidationPipe(AlarmIdParam)) alarmId: number,
    @Headers() headers: Record<string, unknown>,
    @Body() raw: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    const parsed = AlarmCloseSchema.safeParse(raw);
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
      `POST /alarms/${String(alarmId)}/close`,
    );
    if (key === null) return this.alarms.close(who, alarmId, parsed.data.reason);
    return this.idempotency.run(key, () => this.alarms.close(who, alarmId, parsed.data.reason));
  }

  @Post('alarms/:alarmId/suppress')
  @RequireCapabilities('alarms.suppress')
  @HttpCode(200)
  async suppress(
    @Param('alarmId', new ZodValidationPipe(AlarmIdParam)) alarmId: number,
    @Body() raw: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    const parsed = SuppressBodyShape.safeParse(raw);
    if (!parsed.success) {
      throw new ReasonCodeException('common.validation_failed', '请求体非法', {
        issues: zodFieldIssues(parsed.error),
      });
    }
    const { duration_s, reason } = parsed.data;
    return this.alarms.suppress(actorOf(auth), alarmId, {
      duration_s,
      reason,
      ...(parsed.data.cascade !== undefined ? { cascade: parsed.data.cascade } : {}),
    });
  }

  @Post('alarms/:alarmId/unsuppress')
  @RequireCapabilities('alarms.suppress')
  @HttpCode(200)
  async unsuppress(
    @Param('alarmId', new ZodValidationPipe(AlarmIdParam)) alarmId: number,
    @Body() raw: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    const parsed = AlarmUnsuppressSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      throw new ReasonCodeException('common.validation_failed', '请求体非法', {
        issues: zodFieldIssues(parsed.error),
      });
    }
    return this.alarms.unsuppress(actorOf(auth), alarmId, parsed.data.cascade);
  }
}
