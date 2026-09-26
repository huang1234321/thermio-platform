/**
 * 遥测查询端点（modules/overview M1 端点表，蓝本 IMPL-12）：
 * - GET /points/{id}/latest —— 最新遥测值 + quality + ts；
 * - GET /points/{id}/telemetry —— interval=raw|5min|1h 路由 + 跨度上限 + 游标分页。
 *
 * 入参全部过 zod pipe（TS-02 服务器面）：路径参数 PointIdParamSchema、
 * 查询串 TelemetryQuerySchema（shared-types 单源）；校验失败统一
 * common.validation_failed 422（信封出口由全局过滤器保证）。
 */
import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import {
  PointIdParamSchema,
  TelemetryQuerySchema,
  type PointLatest,
  type TelemetryPage,
  type TelemetryQuery,
} from '@thermio/shared-types';
import { ZodValidationPipe } from '../infrastructure/validation/zod-validation.pipe.js';
import { TelemetryService } from './telemetry.service.js';

@Controller('points')
export class TelemetryController {
  constructor(@Inject(TelemetryService) private readonly service: TelemetryService) {}

  @Get(':id/latest')
  async latest(
    @Param('id', new ZodValidationPipe(PointIdParamSchema)) pointId: number,
  ): Promise<PointLatest> {
    return this.service.latest(pointId);
  }

  @Get(':id/telemetry')
  async telemetry(
    @Param('id', new ZodValidationPipe(PointIdParamSchema)) pointId: number,
    @Query(new ZodValidationPipe(TelemetryQuerySchema)) query: TelemetryQuery,
  ): Promise<TelemetryPage> {
    return this.service.telemetry(pointId, query);
  }
}
