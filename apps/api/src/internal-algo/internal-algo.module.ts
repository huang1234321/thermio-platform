/**
 * /internal/* algo 面共享件模块（platform.md §11，IMPL-17 / DAT-163）。
 *
 * 提供两个可复用件（PR 拆分后 fdd internal 端点同面复用）：
 * - AlgoServiceAuthGuard：Bearer SVC_TOKEN_ALGO 常量时间比较 + 轮换双读；
 * - InternalRateLimiter：提交限速 60/min（platform §12）。
 * 控制器不在此模块（proposal / fdd 各自模块挂载守卫——路由白名单由挂载
 * 范围结构性满足）。
 */
import { Global, Module } from '@nestjs/common';
import { AlgoServiceAuthGuard } from './algo-service.guard.js';
import { InternalRateLimiter } from './internal-rate-limit.js';

@Global()
@Module({
  providers: [AlgoServiceAuthGuard, InternalRateLimiter],
  exports: [AlgoServiceAuthGuard, InternalRateLimiter],
})
export class InternalAlgoModule {}
