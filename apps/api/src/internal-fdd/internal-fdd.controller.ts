/**
 * /internal/* FDD + 资产快照端点（platform.md §11 端点族增量之二/之三，algo.md §15-1；
 * IMPL-17 并入项 / DAT-163）。
 *
 * - 挂载在全局前缀 /api/v1 之外（bootstrap.ts exclude；x-internal 不进公开 OpenAPI 面）；
 * - AlgoServiceAuthGuard：Bearer SVC_TOKEN_ALGO（algo 白名单四写两读——路由白名单由
 *   挂载范围结构性满足：POST proposals 在 proposal 模块，其余全部在本控制器）；
 * - 载荷 zod 单源 shared-types fdd.ts（strict——api 维护字段出现即 422 validation_failed）；
 * - findings 200 / reports 201（对齐 algo §8 通道语义与既有 mock 行为）。
 */
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  AssetSnapshotQuerySchema,
  FddFindingsBatchSchema,
  FddReportSubmissionSchema,
  InternalFddFindingsQuerySchema,
} from '@thermio/shared-types';
import { AlgoServiceAuthGuard } from '../internal-algo/algo-service.guard.js';
import { Public } from '../auth/public.decorator.js';
import { zodFieldIssues } from '../infrastructure/validation/zod-validation.pipe.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { InternalFddService } from './internal-fdd.service.js';
import { InternalFddReadService } from './internal-fdd-read.service.js';

@Public()
@Controller()
@UseGuards(AlgoServiceAuthGuard)
export class InternalFddController {
  constructor(
    @Inject(InternalFddService) private readonly writes: InternalFddService,
    @Inject(InternalFddReadService) private readonly reads: InternalFddReadService,
  ) {}

  /** GET /internal/fdd/findings：发现历史（报告聚合数据源，algo.md §8.3）。 */
  @Get('internal/fdd/findings')
  async listFindings(@Query() query: unknown): Promise<unknown> {
    const parsed = InternalFddFindingsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new ReasonCodeException('common.validation_failed', '查询参数非法', {
        issues: zodFieldIssues(parsed.error),
      });
    }
    return this.reads.listFindings(parsed.data);
  }

  /** POST /internal/fdd/findings：批量 upsert（algo.md §8.2 / M6 §3.2）。 */
  @Post('internal/fdd/findings')
  @HttpCode(200)
  async submitFindings(
    @Body() body: unknown,
    @Headers() headers: Record<string, unknown>,
  ): Promise<{ ok: true }> {
    const parsed = FddFindingsBatchSchema.safeParse(body);
    if (!parsed.success) {
      throw new ReasonCodeException('common.validation_failed', '载荷校验失败', {
        issues: zodFieldIssues(parsed.error),
      });
    }
    await this.writes.submitFindings(parsed.data, traceIdOf(headers));
    return { ok: true };
  }

  /** POST /internal/fdd/reports：同期 upsert（algo.md §8.3 / M6 §3.4）。 */
  @Post('internal/fdd/reports')
  @HttpCode(201)
  async submitReport(
    @Body() body: unknown,
    @Headers() headers: Record<string, unknown>,
  ): Promise<{ ok: true }> {
    const parsed = FddReportSubmissionSchema.safeParse(body);
    if (!parsed.success) {
      throw new ReasonCodeException('common.validation_failed', '载荷校验失败', {
        issues: zodFieldIssues(parsed.error),
      });
    }
    await this.writes.submitReport(parsed.data, traceIdOf(headers));
    return { ok: true };
  }

  /** GET /internal/algo/asset-snapshot：语义资产快照（algo.md §6.2）。 */
  @Get('internal/algo/asset-snapshot')
  async assetSnapshot(@Query() query: unknown): Promise<unknown> {
    const parsed = AssetSnapshotQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new ReasonCodeException('common.validation_failed', '查询参数非法', {
        issues: zodFieldIssues(parsed.error),
      });
    }
    return this.reads.assetSnapshot(parsed.data.updated_since);
  }
}

function traceIdOf(headers: Record<string, unknown>): string | undefined {
  const value = headers['trace_id'];
  return typeof value === 'string' ? value : undefined;
}
