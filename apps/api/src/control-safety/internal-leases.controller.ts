/**
 * POST /internal/control/leases/heartbeat（control-safety.md §6.2〔R3〕；
 * platform.md §11 清单行，IMPL-18 / DAT-164）。
 *
 * - 挂载面沿 internal-proposals 先例：@Public + AlgoServiceAuthGuard（Bearer
 *   SVC_TOKEN_ALGO 复用，常量时间比较 + 轮换双读 + 默认拒绝——§11 纪律照抄）；
 *   路由白名单由挂载范围结构性满足（algo 凭证只到得了本控制器）；
 * - body {holder, point_ids ≤500}（platform §12 批量上限同量级）；
 * - 响应逐点 {renewed|not_found|stale}——跨租户点集按租户分组批查；
 * - 限速共用 InternalRateLimiter（proposals/findings 同款 60/min 面）。
 */
import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { LeaseHeartbeatRequestSchema, type LeaseHeartbeatResponse } from '@thermio/shared-types';
import { AlgoServiceAuthGuard } from '../internal-algo/algo-service.guard.js';
import { InternalRateLimiter } from '../internal-algo/internal-rate-limit.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { zodFieldIssues } from '../infrastructure/validation/zod-validation.pipe.js';
import { Public } from '../auth/public.decorator.js';
import { LeaseService } from './lease.service.js';

@Public()
@Controller('internal/control/leases')
@UseGuards(AlgoServiceAuthGuard)
export class InternalLeasesController {
  constructor(
    @Inject(LeaseService) private readonly leases: LeaseService,
    @Inject(InternalRateLimiter) private readonly rateLimiter: InternalRateLimiter,
  ) {}

  @Post('heartbeat')
  @HttpCode(200)
  async heartbeat(@Body() body: unknown): Promise<LeaseHeartbeatResponse> {
    this.rateLimiter.consume('internal:leases-heartbeat');
    const parsed = LeaseHeartbeatRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new ReasonCodeException('common.validation_failed', '请求体非法', {
        issues: zodFieldIssues(parsed.error),
      });
    }
    const results = await this.leases.heartbeat(parsed.data.holder, parsed.data.point_ids);
    return { results };
  }
}
