/**
 * 告警规则端点（modules M4-alarm.md §3.8–§3.10，IMPL-13 / DAT-116）。
 *
 * 能力键：GET → alarms.read（viewer+）；POST/PATCH/DELETE → alarm_rules.write（admin）。
 * 校验序与不可变语义见 AlarmRulesService（§3.9：scope/scope_id/rule_type 不可变）。
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  AlarmRuleListQuerySchema,
  AlarmRulePatchSchema,
  type AlarmRuleCreate,
} from '@thermio/shared-types';
import { zodFieldIssues } from '../infrastructure/validation/zod-validation.pipe.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { CapabilitiesGuard } from '../auth/capabilities.guard.js';
import { CurrentAuth, type AuthContext } from '../auth/auth-context.js';
import { RequireCapabilities } from '../auth/require-capabilities.decorator.js';
import { IdempotencyStore, idempotencyKey } from '../asset/idempotency.js';
import { AlarmRulesService } from './alarm-rules.service.js';
import type { AlarmActor } from './alarm-shared.js';

function actorOf(auth: AuthContext | undefined): AlarmActor {
  if (auth === undefined) {
    throw new ReasonCodeException('auth.forbidden', '权限不足');
  }
  return { tenant_id: auth.tenant_id, user_id: auth.user_id, role: auth.role };
}

/**
 * 创建体形状：枚举字段以 string 进服务层（值域外映射域码 rule_type_unknown /
 * severity_unknown，M4 §1.2——zod enum 在此会吞成 common.validation_failed）。
 */
const RuleCreateShape = z.object({
  scope: z.string().min(1),
  scope_id: z.union([z.string().min(1), z.number().int().positive()]),
  rule_type: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
  severity: z.string().min(1),
  sustained_s: z.number().int().optional(),
  enabled: z.boolean().optional(),
});

@Controller()
@UseGuards(CapabilitiesGuard)
export class AlarmRulesController {
  constructor(
    @Inject(AlarmRulesService) private readonly rules: AlarmRulesService,
    @Inject(IdempotencyStore) private readonly idempotency: IdempotencyStore,
  ) {}

  @Get('alarm-rules')
  @RequireCapabilities('alarms.read')
  async list(
    @Query() query: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    const parsed = AlarmRuleListQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new ReasonCodeException('common.validation_failed', '查询参数非法', {
        issues: zodFieldIssues(parsed.error),
      });
    }
    return this.rules.list(actorOf(auth), parsed.data);
  }

  @Post('alarm-rules')
  @RequireCapabilities('alarm_rules.write')
  async create(
    @Headers() headers: Record<string, unknown>,
    @Body() raw: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    const parsed = RuleCreateShape.safeParse(raw);
    if (!parsed.success) {
      throw new ReasonCodeException('common.validation_failed', '请求体非法', {
        issues: zodFieldIssues(parsed.error),
      });
    }
    const who = actorOf(auth);
    const body = parsed.data as unknown as AlarmRuleCreate;
    const key = idempotencyKey(headers, who.tenant_id, who.user_id, 'POST /alarm-rules');
    if (key === null) return this.rules.create(who, body);
    return this.idempotency.run(key, () => this.rules.create(who, body));
  }

  @Patch('alarm-rules/:ruleId')
  @RequireCapabilities('alarm_rules.write')
  async patch(
    @Param('ruleId', new ParseUUIDPipe()) ruleId: string,
    @Body() raw: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    const parsed = AlarmRulePatchSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ReasonCodeException('common.validation_failed', '请求体非法', {
        issues: zodFieldIssues(parsed.error),
      });
    }
    return this.rules.patch(actorOf(auth), ruleId, parsed.data);
  }

  @Delete('alarm-rules/:ruleId')
  @RequireCapabilities('alarm_rules.write')
  async remove(
    @Param('ruleId', new ParseUUIDPipe()) ruleId: string,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<void> {
    return this.rules.remove(actorOf(auth), ruleId);
  }
}
