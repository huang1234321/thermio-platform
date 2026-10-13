/**
 * M11 kpi 域端点（modules/M11-kpi-dashboard.md §5 全集；base /api/v1，IMPL-22 / DAT-246）。
 *
 * - 能力键（§5.0）：kpi.read（三角色浏览）/ kpi.config（仅 admin，benchmark-config）/
 *   fdd.export（operator+，FDD 导出族）/ digest.manage（仅 admin，digest 面）；
 * - 端点族：/kpi/overview + /kpi/energy/trend + /kpi/energy/structure（§5.1–§5.3）/
 *   GET/PUT /kpi/benchmark-config（§5.5）/ POST /fdd/reports/{id}/export（§5.4）/
 *   /kpi/export-jobs 族（§5.6/§5.7，形状同 M9 §6.13，resource_type 恒 fdd_report）/
 *   GET/PUT /fdd/digest + /fdd/digest/deliveries（§5.8）；
 * - 错误域（§4.8）：kpi.range_invalid / kpi.benchmark_config_invalid /
 *   digest.recipient_invalid 新三码；载体条件码复用 M9（同条件同码不按
 *   resource_type 分叉）；越权楼宇与不存在同码同文案（SEC-AZ-03）；
 * - 签名文件端点（GET /kpi/exports/{id}/file）@Public + HMAC 门（302 目标，M9 同款）；
 * - Idempotency-Key 接受不要求（§5.4/§5.5/§5.8：重复导出 = 新任务行；PUT 全量替换
 *   天然幂等）。
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import {
  FddDigestDeliveriesQuerySchema,
  FddDigestPutSchema,
  FddDigestQuerySchema,
  FddExportJobsQuerySchema,
  KpiBenchmarkConfigPutSchema,
  KpiBenchmarkConfigQuerySchema,
  KpiOverviewQuerySchema,
  KpiStructureQuerySchema,
  KpiTrendQuerySchema,
} from '@thermio/shared-types';
import {
  ZodValidationPipe,
  zodFieldIssues,
} from '../infrastructure/validation/zod-validation.pipe.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { CapabilitiesGuard } from '../auth/capabilities.guard.js';
import { CurrentAuth, type AuthContext } from '../auth/auth-context.js';
import { RequireCapabilities } from '../auth/require-capabilities.decorator.js';
import { Public } from '../auth/public.decorator.js';
import type { KpiActor } from './kpi.service.js';
import { KpiService } from './kpi.service.js';
import { KpiExportService } from './kpi-export.service.js';
import { KpiDigestService } from './kpi-digest.service.js';

const UUID = z.uuid();

function actorOf(auth: AuthContext | undefined): KpiActor {
  if (auth === undefined) {
    throw new ReasonCodeException('auth.forbidden', '权限不足');
  }
  return { tenant_id: auth.tenant_id, user_id: auth.user_id, role: auth.role };
}

function parseBody<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ReasonCodeException('common.validation_failed', '请求体非法', {
      issues: zodFieldIssues(result.error),
    });
  }
  return result.data;
}

function parseQuery<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ReasonCodeException('common.validation_failed', '查询参数非法', {
      issues: zodFieldIssues(result.error),
    });
  }
  return result.data;
}

@Controller()
@UseGuards(CapabilitiesGuard)
export class KpiController {
  constructor(
    @Inject(KpiService) private readonly kpi: KpiService,
    @Inject(KpiExportService) private readonly exportSvc: KpiExportService,
    @Inject(KpiDigestService) private readonly digest: KpiDigestService,
  ) {}

  // ═══ 看板三端点（§5.1–§5.3，kpi.read 三角色） ═══

  /** GET /kpi/overview（KPI 卡组数据面；缺省窗 = 本月至今本地日界）。 */
  @Get('kpi/overview')
  @RequireCapabilities('kpi.read')
  async overview(
    @Query() query: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    return this.kpi.overview(actorOf(auth), parseQuery(KpiOverviewQuerySchema, query));
  }

  /** GET /kpi/energy/trend（§5.2：from/to 必填；interval/group_by 白名单 422 定位）。 */
  @Get('kpi/energy/trend')
  @RequireCapabilities('kpi.read')
  async trend(
    @Query() query: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    return this.kpi.trend(actorOf(auth), parseQuery(KpiTrendQuerySchema, query));
  }

  /** GET /kpi/energy/structure（§5.3：窗口级维度拆分）。 */
  @Get('kpi/energy/structure')
  @RequireCapabilities('kpi.read')
  async structure(
    @Query() query: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    return this.kpi.structure(actorOf(auth), parseQuery(KpiStructureQuerySchema, query));
  }

  // ═══ 基准配置（§5.5，kpi.config 仅 admin） ═══

  /** GET /kpi/benchmark-config（building_id 必填；无配置 = none 缺省形状不 404）。 */
  @Get('kpi/benchmark-config')
  @RequireCapabilities('kpi.config')
  async benchmarkConfig(
    @Query() query: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    const { building_id } = parseQuery(KpiBenchmarkConfigQuerySchema, query);
    return this.kpi.benchmarkConfig(actorOf(auth), building_id);
  }

  /** PUT /kpi/benchmark-config（全量替换幂等；source/params 匹配 422）。 */
  @Put('kpi/benchmark-config')
  @RequireCapabilities('kpi.config')
  async putBenchmarkConfig(
    @Query() query: unknown,
    @Body() raw: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    const { building_id } = parseQuery(KpiBenchmarkConfigQuerySchema, query);
    return this.kpi.putBenchmarkConfig(
      actorOf(auth),
      building_id,
      parseBody(KpiBenchmarkConfigPutSchema, raw),
    );
  }

  // ═══ FDD 导出族（§5.4/§5.6/§5.7，fdd.export operator+） ═══

  /** POST /fdd/reports/{id}/export（§5.4：202 + export_job；Body 无）。 */
  @Post('fdd/reports/:reportId/export')
  @HttpCode(202)
  @RequireCapabilities('fdd.export')
  async exportReport(
    @Param('reportId', new ZodValidationPipe(UUID)) reportId: string,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    return this.exportSvc.createExport(actorOf(auth), reportId);
  }

  /** GET /kpi/export-jobs（§5.6：恒 fdd_report；任务只看本人）。 */
  @Get('kpi/export-jobs')
  @RequireCapabilities('fdd.export')
  async listExports(
    @Query() query: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    return this.exportSvc.listExports(actorOf(auth), parseQuery(FddExportJobsQuerySchema, query));
  }

  /** GET /kpi/export-jobs/{id}（§5.7 详情；非本人/越权 404 载体码）。 */
  @Get('kpi/export-jobs/:jobId')
  @RequireCapabilities('fdd.export')
  async exportDetail(
    @Param('jobId', new ZodValidationPipe(UUID)) jobId: string,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    return this.exportSvc.exportDetail(actorOf(auth), jobId);
  }

  /** GET /kpi/export-jobs/{id}/download（§5.7：302 签名 URL 60 min）。 */
  @Get('kpi/export-jobs/:jobId/download')
  @RequireCapabilities('fdd.export')
  async download(
    @Param('jobId', new ZodValidationPipe(UUID)) jobId: string,
    @Res() response: Response,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<void> {
    const url = await this.exportSvc.download(actorOf(auth), jobId, publicBaseUrl(response));
    response.redirect(302, url);
  }

  /** GET /kpi/exports/{id}/file（302 目标：@Public + HMAC 签名门，M9 §4.3 同款）。 */
  @Get('kpi/exports/:jobId/file')
  @Public()
  async exportFile(
    @Param('jobId', new ZodValidationPipe(UUID)) jobId: string,
    @Query('expires') expires: string | undefined,
    @Query('sig') sig: string | undefined,
    @Query('tenant') tenant: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    if (tenant === undefined || !z.uuid().safeParse(tenant).success) {
      throw new ReasonCodeException('mv.report_not_found', '资源不存在', { entity: 'export_file' });
    }
    this.exportSvc.verifySignature(jobId, tenant, expires, sig);
    await this.exportSvc.streamFile(tenant, jobId, response);
  }

  // ═══ 订阅面（§5.8，digest.manage 仅 admin） ═══

  /** GET /fdd/digest（building_id 必填；无订阅 = 缺省形状不 404）。 */
  @Get('fdd/digest')
  @RequireCapabilities('digest.manage')
  async digestConfig(
    @Query() query: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    const { building_id } = parseQuery(FddDigestQuerySchema, query);
    return this.digest.digestConfig(actorOf(auth), building_id);
  }

  /** PUT /fdd/digest（全量替换幂等；收件人逐项校验 422 带序号）。 */
  @Put('fdd/digest')
  @RequireCapabilities('digest.manage')
  async putDigestConfig(
    @Query() query: unknown,
    @Body() raw: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    const { building_id } = parseQuery(FddDigestQuerySchema, query);
    return this.digest.putDigestConfig(
      actorOf(auth),
      building_id,
      parseBody(FddDigestPutSchema, raw),
    );
  }

  /** GET /fdd/digest/deliveries（投递记录；created_at DESC + 游标）。 */
  @Get('fdd/digest/deliveries')
  @RequireCapabilities('digest.manage')
  async deliveries(
    @Query() query: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    return this.digest.deliveries(actorOf(auth), parseQuery(FddDigestDeliveriesQuerySchema, query));
  }
}

/** 302 目标基址（M9 mv.controller 同款：请求 host，反代场景部署侧覆盖）。 */
function publicBaseUrl(response: Response): string {
  const req = response.req as
    { headers: { host?: string; 'x-forwarded-proto'?: string | string[] } } | undefined;
  const host = req?.headers.host ?? 'localhost';
  const forwarded = req?.headers['x-forwarded-proto'];
  const proto = typeof forwarded === 'string' ? forwarded : 'http';
  return `${proto}://${host}`;
}
