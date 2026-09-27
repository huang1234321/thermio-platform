/**
 * FDD internal 面模块（platform.md §11 algo 端点族增量，IMPL-17 并入项 / DAT-163）。
 *
 * 三端点：GET /internal/algo/asset-snapshot、GET/POST /internal/fdd/findings、
 * POST /internal/fdd/reports——algo 白名单四写两读中除 POST /internal/proposals
 * （proposal 模块）外的全部。守卫/限速复用 InternalAlgoModule（@Global）。
 */
import { Module } from '@nestjs/common';
import { InternalFddController } from './internal-fdd.controller.js';
import { InternalFddService } from './internal-fdd.service.js';
import { InternalFddReadService } from './internal-fdd-read.service.js';

@Module({
  controllers: [InternalFddController],
  providers: [InternalFddService, InternalFddReadService],
})
export class InternalFddModule {}
