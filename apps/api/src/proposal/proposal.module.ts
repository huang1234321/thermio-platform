/**
 * 建议域模块（modules M5-proposal.md，IMPL-17 / DAT-163）。
 *
 * 自包含接线：admin 面（proposals 控制器：列表/角标/详情/确认/驳回/执行详情/
 * 执行审计）+ internal 面（POST /internal/proposals 服务凭证提交）+ 过期沉降
 * sweeper + dev-only mock 执行沉降器。依赖（单向）：
 * - DbModule（@Global：TENANT_DB 租户事务 + AUTH_DB internal_read 旁路）；
 * - InternalAlgoModule（@Global：AlgoServiceAuthGuard + InternalRateLimiter）；
 * - IdempotencyStore（asset 域内存幂等件复用，API-DSN-01）。
 */
import { Module } from '@nestjs/common';
import { IdempotencyStore } from '../asset/idempotency.js';
import { InternalAlgoModule } from '../internal-algo/internal-algo.module.js';
import { ControlSafetyModule } from '../control-safety/control-safety.module.js';
import { ProposalsController } from './proposals.controller.js';
import { InternalProposalsController } from './internal-proposals.controller.js';
import { ProposalsService } from './proposals.service.js';
import { InternalProposalsService } from './internal-proposals.service.js';
import { ExpirySweeperService } from './expiry-sweeper.service.js';
import { MockExecutionSettlerService } from './mock-execution.settler.js';

@Module({
  // ControlSafetyModule：approve → 仲裁链即时 kick（IMPL-18 接通；单向依赖——
  // control-safety 不反向 import 本模块，提案读写经 SQL 直达）。
  imports: [InternalAlgoModule, ControlSafetyModule],
  controllers: [ProposalsController, InternalProposalsController],
  providers: [
    ProposalsService,
    InternalProposalsService,
    ExpirySweeperService,
    MockExecutionSettlerService,
    IdempotencyStore,
  ],
})
export class ProposalModule {}
