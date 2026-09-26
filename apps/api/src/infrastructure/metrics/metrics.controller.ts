/**
 * /metrics 端点（platform.md §8 #4 验收：可被 Prometheus 刮取）。
 * 不进 /api/v1 前缀（Prometheus 约定路径），无业务语义不套错误信封。
 */
import { Controller, Get, Inject, Response } from '@nestjs/common';
import type { Response as ExpressResponse } from 'express';
import { Public } from '../../auth/public.decorator.js';
import { MetricsService } from './metrics.service.js';

@Public()
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(MetricsService) private readonly metrics: MetricsService) {}

  @Get()
  async render(@Response() res: ExpressResponse): Promise<void> {
    res.type(this.metrics.contentType());
    res.send(await this.metrics.render());
  }
}
