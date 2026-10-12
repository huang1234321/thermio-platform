/**
 * M&V 域端点（modules/M9-mv-report.md §6 全集 19 个；base /api/v1，IMPL-21 / DAT-242）。
 *
 * - 能力键（§1.5）：mv.read（三角色浏览）/ mv_baselines.write（仅 admin）/
 *   mv_reports.generate（operator+）/ mv_reports.approve（仅 admin）/
 *   mv_reports.export（operator+，viewer 仅在线浏览——出域最小化）；
 * - 查询白名单（API-DSN-04）：白名单外参数 → 422（strict zod）；
 * - generate/export 为后果性写：Idempotency-Key 必带（缺失 422，API-DSN-01），
 *   同键重放 202 同 job（24h 窗，IdempotencyStore 承载）；
 * - 错误域（§1.2）：mv.* 十四码；越权楼宇与不存在同码同文案（SEC-AZ-03）；
 * - 签名文件端点（GET /mv/exports/{id}/file）@Public + HMAC 门（302 目标，§4.3）。
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import {
  MvBaselineActivateSchema,
  MvBaselineCreateSchema,
  MvBaselinePatchSchema,
  MvBaselinesQuerySchema,
  MvExportJobsQuerySchema,
  MvGenerateRequestSchema,
  MvReportsQuerySchema,
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
import { IdempotencyStore, idempotencyKey } from '../asset/idempotency.js';
import type { MvActor } from './mv-shared.js';
import { MvService } from './mv.service.js';
import { MvGenerateService } from './mv-generate.service.js';
import { MvExportService } from './mv-export.service.js';

const UUID = z.uuid();

function actorOf(auth: AuthContext | undefined): MvActor {
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
export class MvController {
  constructor(
    @Inject(MvService) private readonly mv: MvService,
    @Inject(MvGenerateService) private readonly generate: MvGenerateService,
    @Inject(MvExportService) private readonly exportSvc: MvExportService,
    @Inject(IdempotencyStore) private readonly idempotency: IdempotencyStore,
  ) {}

  // ═══ 基线（§6.1/§6.4） ═══

  /** GET /mv/baselines（§6.1：building_id / status 白名单筛选）。 */
  @Get('mv/baselines')
  @RequireCapabilities('mv.read')
  async listBaselines(
    @Query() query: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    return this.mv.listBaselines(actorOf(auth), parseQuery(MvBaselinesQuerySchema, query));
  }

  /** POST /mv/baselines（§6.4：admin 建 draft，含首次校核）。 */
  @Post('mv/baselines')
  @RequireCapabilities('mv_baselines.write')
  async createBaseline(
    @Body() raw: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    return this.mv.createBaseline(actorOf(auth), parseBody(MvBaselineCreateSchema, raw));
  }

  /** GET /mv/baselines/{id}（§6.4 详情）。 */
  @Get('mv/baselines/:baselineId')
  @RequireCapabilities('mv.read')
  async baselineDetail(
    @Param('baselineId', new ZodValidationPipe(UUID)) baselineId: string,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    return this.mv.baselineDetail(actorOf(auth), baselineId);
  }

  /** PATCH /mv/baselines/{id}（§6.4：仅 draft，口径四项）。 */
  @Patch('mv/baselines/:baselineId')
  @RequireCapabilities('mv_baselines.write')
  async patchBaseline(
    @Param('baselineId', new ZodValidationPipe(UUID)) baselineId: string,
    @Body() raw: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    return this.mv.patchBaseline(actorOf(auth), baselineId, parseBody(MvBaselinePatchSchema, raw));
  }

  /** DELETE /mv/baselines/{id}（§6.4：仅 draft；204）。 */
  @Delete('mv/baselines/:baselineId')
  @HttpCode(204)
  @RequireCapabilities('mv_baselines.write')
  async deleteBaseline(
    @Param('baselineId', new ZodValidationPipe(UUID)) baselineId: string,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<void> {
    await this.mv.deleteBaseline(actorOf(auth), baselineId);
  }

  // ═══ 基线生命周期动作（§6.5–§6.7） ═══

  /** POST /mv/baselines/{id}/validate（§6.5：重跑校核，仅 draft；200）。 */
  @Post('mv/baselines/:baselineId/validate')
  @HttpCode(200)
  @RequireCapabilities('mv_baselines.write')
  async validateBaseline(
    @Param('baselineId', new ZodValidationPipe(UUID)) baselineId: string,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    return this.mv.validateBaseline(actorOf(auth), baselineId);
  }

  /** POST /mv/baselines/{id}/activate（§6.6：三重门槛 + supersede 原子换代；200）。 */
  @Post('mv/baselines/:baselineId/activate')
  @HttpCode(200)
  @RequireCapabilities('mv_baselines.write')
  async activateBaseline(
    @Param('baselineId', new ZodValidationPipe(UUID)) baselineId: string,
    @Body() raw: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    const body =
      raw === null || typeof raw !== 'object' || Object.keys(raw).length === 0
        ? {}
        : parseBody(MvBaselineActivateSchema, raw);
    return this.mv.activateBaseline(actorOf(auth), baselineId, body);
  }

  /** POST /mv/baselines/{id}/retire（§6.7：仅 active；200）。 */
  @Post('mv/baselines/:baselineId/retire')
  @HttpCode(200)
  @RequireCapabilities('mv_baselines.write')
  async retireBaseline(
    @Param('baselineId', new ZodValidationPipe(UUID)) baselineId: string,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    return this.mv.retireBaseline(actorOf(auth), baselineId);
  }

  // ═══ 报告（§6.2/§6.3/§6.8–§6.11） ═══

  /** POST /mv/reports/generate（§6.2：同步前置全过才 202；Idempotency-Key 必带）。 */
  @Post('mv/reports/generate')
  @HttpCode(202)
  @RequireCapabilities('mv_reports.generate')
  async generateReport(
    @Headers() headers: Record<string, unknown>,
    @Body() raw: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    const who = actorOf(auth);
    const key = idempotencyKey(headers, who.tenant_id, who.user_id, 'POST /mv/reports/generate');
    if (key === null) {
      throw new ReasonCodeException('common.validation_failed', 'generate 必带 Idempotency-Key', {
        field: 'Idempotency-Key',
      });
    }
    const body = parseBody(MvGenerateRequestSchema, raw);
    return this.idempotency.run(key, () => this.generate.generate(who, body));
  }

  /** GET /mv/generation-jobs/{id}（§6.3：任务态可见）。 */
  @Get('mv/generation-jobs/:jobId')
  @RequireCapabilities('mv.read')
  async generationJob(
    @Param('jobId', new ZodValidationPipe(UUID)) jobId: string,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    return this.generate.jobDetail(actorOf(auth), jobId);
  }

  /** GET /mv/reports（§6.8：白名单筛选 + keyset 分页）。 */
  @Get('mv/reports')
  @RequireCapabilities('mv.read')
  async listReports(
    @Query() query: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    return this.mv.listReports(actorOf(auth), parseQuery(MvReportsQuerySchema, query));
  }

  /** GET /mv/reports/{id}（§6.9 详情）。 */
  @Get('mv/reports/:reportId')
  @RequireCapabilities('mv.read')
  async reportDetail(
    @Param('reportId', new ZodValidationPipe(UUID)) reportId: string,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    return this.mv.reportDetail(actorOf(auth), reportId);
  }

  /** DELETE /mv/reports/{id}（§6.10：仅未审批，删除后同周期可重出；204）。 */
  @Delete('mv/reports/:reportId')
  @HttpCode(204)
  @RequireCapabilities('mv_reports.generate')
  async deleteReport(
    @Param('reportId', new ZodValidationPipe(UUID)) reportId: string,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<void> {
    await this.mv.deleteReport(actorOf(auth), reportId);
  }

  /** POST /mv/reports/{id}/approve（§6.11：审批锁定；重复 approve 409；200）。 */
  @Post('mv/reports/:reportId/approve')
  @HttpCode(200)
  @RequireCapabilities('mv_reports.approve')
  async approveReport(
    @Param('reportId', new ZodValidationPipe(UUID)) reportId: string,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    return this.mv.approveReport(actorOf(auth), reportId);
  }

  // ═══ 导出（§6.12/§6.13） ═══

  /** POST /mv/reports/{id}/export（§6.12：202 + 导出任务）。 */
  @Post('mv/reports/:reportId/export')
  @HttpCode(202)
  @RequireCapabilities('mv_reports.export')
  async exportReport(
    @Headers() headers: Record<string, unknown>,
    @Param('reportId', new ZodValidationPipe(UUID)) reportId: string,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    const who = actorOf(auth);
    const key = idempotencyKey(
      headers,
      who.tenant_id,
      who.user_id,
      `POST /mv/reports/${reportId}/export`,
    );
    const run = (): Promise<unknown> => this.exportSvc.createExport(who, reportId);
    return key === null ? run() : this.idempotency.run(key, run);
  }

  /** GET /mv/export-jobs（§6.13 列表）。 */
  @Get('mv/export-jobs')
  @RequireCapabilities('mv_reports.export')
  async listExports(
    @Query() query: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    return this.exportSvc.listExports(actorOf(auth), parseQuery(MvExportJobsQuerySchema, query));
  }

  /** GET /mv/export-jobs/{id}（§6.13 详情）。 */
  @Get('mv/export-jobs/:jobId')
  @RequireCapabilities('mv_reports.export')
  async exportDetail(
    @Param('jobId', new ZodValidationPipe(UUID)) jobId: string,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    return this.exportSvc.exportDetail(actorOf(auth), jobId);
  }

  /** GET /mv/export-jobs/{id}/download（§6.13：302 签名 URL）。 */
  @Get('mv/export-jobs/:jobId/download')
  @RequireCapabilities('mv_reports.export')
  async download(
    @Param('jobId', new ZodValidationPipe(UUID)) jobId: string,
    @Res() response: Response,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<void> {
    const url = await this.exportSvc.download(actorOf(auth), jobId, publicBaseUrl(response));
    response.redirect(302, url);
  }

  /** GET /mv/exports/{id}/file（302 目标：@Public + HMAC 签名门，§4.3）。 */
  @Get('mv/exports/:jobId/file')
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

  // ═══ 天气站点（§6.14） ═══

  /** GET /mv/weather-stations（§6.14：站点选择器数据面）。 */
  @Get('mv/weather-stations')
  @RequireCapabilities('mv.read')
  async weatherStations(): Promise<unknown> {
    return this.mv.listWeatherStations();
  }
}

/** 302 目标基址：取请求 host（反代场景由部署侧覆盖绝对 URL——R7 部署锚）。 */
function publicBaseUrl(response: Response): string {
  const req = response.req as
    { headers: { host?: string; 'x-forwarded-proto'?: string | string[] } } | undefined;
  const host = req?.headers.host ?? 'localhost';
  const forwarded = req?.headers['x-forwarded-proto'];
  const proto = typeof forwarded === 'string' ? forwarded : 'http';
  return `${proto}://${host}`;
}
