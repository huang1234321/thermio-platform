/**
 * POST /internal/proposals 控制器（M5-proposal.md §3.8，platform.md §11）。
 *
 * - 挂载在全局前缀 /api/v1 之外（bootstrap.ts exclude；不进公开 OpenAPI 面，
 *   标记 x-internal）；网络面由 compose 内网隔离（公网 ingress 不转发该前缀）；
 * - AlgoServiceAuthGuard：Bearer SVC_TOKEN_ALGO（路由白名单由挂载范围结构性
 *   满足——algo 凭证只到得了本控制器与 fdd internal 面）；
 * - 用户能力键对 /internal/* 不生效（服务凭证面，M5 §8.2）；
 * - trace_id 请求头贯穿留痕（不记 token，SEC-KEY-02）。
 */
import { Body, Controller, Headers, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { AlgoServiceAuthGuard } from '../internal-algo/algo-service.guard.js';
import { Public } from '../auth/public.decorator.js';
import { InternalProposalsService } from './internal-proposals.service.js';

@Public()
@Controller('internal/proposals')
@UseGuards(AlgoServiceAuthGuard)
export class InternalProposalsController {
  constructor(
    @Inject(InternalProposalsService) private readonly submissions: InternalProposalsService,
  ) {}

  @Post()
  @HttpCode(201)
  async submit(
    @Body() body: unknown,
    @Headers() headers: Record<string, unknown>,
  ): Promise<unknown> {
    const traceId = headers['trace_id'];
    return this.submissions.submit(body, typeof traceId === 'string' ? traceId : undefined);
  }
}
