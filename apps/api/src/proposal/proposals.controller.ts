/**
 * 建议审批端点（modules M5-proposal.md §3.0–§3.7，IMPL-17 / DAT-163）。
 *
 * - 能力键（§1.5）：proposals.read（viewer+，授权楼宇内）/ proposals.decide.write
 *   （operator+：approve/reject）；
 * - approve/reject 带 Idempotency-Key（API-DSN-01，§3.4/§3.5）——同键重放幂等回放
 *   2xx，无键/异键按状态机判定；
 * - reject reason 缺失/空白 → 422 proposal.reason_required（独立码，§1.2〔R6〕）；
 *   超长 → common.validation_failed；
 * - approve 202（异步走仲裁）/ reject 200（终态）。
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
import { ControlAuditListQuerySchema, ProposalListQuerySchema } from '@thermio/shared-types';
import { ZodValidationPipe } from '../infrastructure/validation/zod-validation.pipe.js';
import { zodFieldIssues } from '../infrastructure/validation/zod-validation.pipe.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { CapabilitiesGuard } from '../auth/capabilities.guard.js';
import { CurrentAuth, type AuthContext } from '../auth/auth-context.js';
import { RequireCapabilities } from '../auth/require-capabilities.decorator.js';
import { IdempotencyStore, idempotencyKey } from '../asset/idempotency.js';
import type { AssetActor } from '../asset/asset-shared.js';
import { ProposalsService } from './proposals.service.js';

const ProposalIdParam = z.uuid();

function actorOf(auth: AuthContext | undefined): AssetActor {
  if (auth === undefined) {
    throw new ReasonCodeException('auth.forbidden', '权限不足');
  }
  return { tenant_id: auth.tenant_id, user_id: auth.user_id, role: auth.role };
}

/** approve 请求体：comment 可选 ≤2000（§3.4）。 */
const ApproveBodyShape = z.object({ comment: z.string().max(2000).optional() }).strict();

@Controller()
@UseGuards(CapabilitiesGuard)
export class ProposalsController {
  constructor(
    @Inject(ProposalsService) private readonly proposals: ProposalsService,
    @Inject(IdempotencyStore) private readonly idempotency: IdempotencyStore,
  ) {}

  @Get('proposals')
  @RequireCapabilities('proposals.read')
  async list(
    @Query() query: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    const parsed = ProposalListQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new ReasonCodeException('common.validation_failed', '查询参数非法', {
        issues: zodFieldIssues(parsed.error),
      });
    }
    return this.proposals.list(actorOf(auth), parsed.data);
  }

  @Get('proposals/counts')
  @RequireCapabilities('proposals.read')
  async counts(
    @Query('building_id', new ZodValidationPipe(z.uuid().optional()))
    buildingId: string | undefined,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    return this.proposals.counts(actorOf(auth), buildingId);
  }

  @Get('proposals/:proposalId')
  @RequireCapabilities('proposals.read')
  async detail(
    @Param('proposalId', new ZodValidationPipe(ProposalIdParam)) proposalId: string,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    return this.proposals.detail(actorOf(auth), proposalId);
  }

  @Post('proposals/:proposalId/approve')
  @RequireCapabilities('proposals.decide.write')
  @HttpCode(202)
  async approve(
    @Param('proposalId', new ZodValidationPipe(ProposalIdParam)) proposalId: string,
    @Headers() headers: Record<string, unknown>,
    @Body() raw: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    const parsed = ApproveBodyShape.safeParse(raw ?? {});
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
      `POST /proposals/${proposalId}/approve`,
    );
    const execute = () => this.proposals.approve(who, proposalId, parsed.data.comment);
    return key === null ? execute() : this.idempotency.run(key, execute);
  }

  @Post('proposals/:proposalId/reject')
  @RequireCapabilities('proposals.decide.write')
  @HttpCode(200)
  async reject(
    @Param('proposalId', new ZodValidationPipe(ProposalIdParam)) proposalId: string,
    @Headers() headers: Record<string, unknown>,
    @Body() raw: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    // reason 必填（PRD D1）：缺失/空白 → proposal.reason_required（§3.5）；
    // 超长 → validation_failed。逐条判定而非 zod min(1) 一刀切，保两码分工。
    const reason = (raw as { reason?: unknown } | null)?.reason;
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw new ReasonCodeException('proposal.reason_required', '驳回原因必填', {
        field: 'reason',
      });
    }
    if (reason.length > 2000) {
      throw new ReasonCodeException('common.validation_failed', '驳回原因超长（≤2000）', {
        field: 'reason',
      });
    }
    const who = actorOf(auth);
    const key = idempotencyKey(
      headers,
      who.tenant_id,
      who.user_id,
      `POST /proposals/${proposalId}/reject`,
    );
    const execute = () => this.proposals.reject(who, proposalId, reason);
    return key === null ? execute() : this.idempotency.run(key, execute);
  }

  @Get('proposals/:proposalId/execution')
  @RequireCapabilities('proposals.read')
  async execution(
    @Param('proposalId', new ZodValidationPipe(ProposalIdParam)) proposalId: string,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    return this.proposals.execution(actorOf(auth), proposalId);
  }

  @Get('control-audit')
  @RequireCapabilities('proposals.read')
  async controlAudit(
    @Query() query: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    const parsed = ControlAuditListQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new ReasonCodeException('common.validation_failed', '查询参数非法', {
        issues: zodFieldIssues(parsed.error),
      });
    }
    return this.proposals.controlAudit(actorOf(auth), parsed.data);
  }
}
