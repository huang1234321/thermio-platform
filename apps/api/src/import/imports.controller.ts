/**
 * 导入域端点（modules M2-import §3：端点全集 10 个，无增补）。
 *
 * - multipart（POST /imports）：memoryStorage 承载（≤5 MB 同步拦），file 部件
 *   缺失/空 → 422 import.file_invalid（同步拒绝、作业不入库，§5.3）；
 * - PATCH rows 白名单守卫：raw_name/unit_raw/is_write 为物理层字段（解析期定格）
 *   → 422 common.validation_failed（details 列白名单，M2-import §3.5——与 M1 的
 *   400 point.field_not_allowed 不同，导入域按详设落 common 码）；
 * - apply `Idempotency-Key` 必带（缺失 422）——键作用域 (tenant, job, key)、24h 窗、
 *   同键重放幂等 202（M2-import §8.1；IdempotencyStore 承载，O1 MVP 内存形态）；
 * - 守卫判定顺序（§4.2）：404（存在/归属）→ 403（能力 guard）→ 409（状态）→ 422（schema）。
 */
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import {
  IMPORT_ROW_PATCH_FIELDS,
  ImportCreateSchema,
  ImportJobListQuerySchema,
  ImportRowPatchSchema,
  ImportRowsQuerySchema,
  type ImportCreate,
  type ImportJob,
  type ImportRow,
  type ImportRowPatch,
  type ImportRowsQuery,
  type DryRunReport,
  type Page,
  type SelfCheckReport,
} from '@thermio/shared-types';
import {
  ZodValidationPipe,
  zodFieldIssues,
} from '../infrastructure/validation/zod-validation.pipe.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { CapabilitiesGuard } from '../auth/capabilities.guard.js';
import { CurrentAuth, type AuthContext } from '../auth/auth-context.js';
import { RequireCapabilities } from '../auth/require-capabilities.decorator.js';
import { actor } from '../asset/buildings.controller.js';
import { IdempotencyStore } from '../asset/idempotency.js';
import { ImportsService } from './imports.service.js';

/** 行主键 bigint（§2.2 注记：API integer）。 */
const RowIdParam = z.coerce.number().int().positive();

const PATCH_WHITELIST = new Set<string>(IMPORT_ROW_PATCH_FIELDS);

@Controller()
@UseGuards(CapabilitiesGuard)
export class ImportsController {
  constructor(
    @Inject(ImportsService) private readonly imports: ImportsService,
    @Inject(IdempotencyStore) private readonly idempotency: IdempotencyStore,
  ) {}

  // §3.1 上传（步骤 1）
  @Post('imports')
  @RequireCapabilities('imports.write')
  @UseInterceptors(FileInterceptor('file'))
  @HttpCode(202)
  async create(
    @UploadedFile() file: { buffer: Buffer; size: number; originalname?: string } | undefined,
    @Body() body: Record<string, unknown>,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<ImportJob> {
    const parts = ImportCreateSchema.safeParse(body);
    if (!parts.success) {
      throw new ReasonCodeException('common.validation_failed', '请求参数校验失败', {
        ...(parts.error.issues.length > 0 ? zodFieldIssues(parts.error) : {}),
        '(multipart)': '需包含 file（binary）、building_id、gateway_id 三部件',
      });
    }
    return this.imports.create(
      actor(auth),
      file === undefined
        ? null
        : {
            buffer: file.buffer,
            size: file.size,
            filename: file.originalname ?? 'point-table.xlsx',
          },
      parts.data satisfies ImportCreate,
    );
  }

  // §3.2 作业列表
  @Get('imports')
  @RequireCapabilities('imports.read')
  async list(
    @Query() query: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<Page<ImportJob>> {
    return this.imports.list(actor(auth), ImportJobListQuerySchema.parse(query));
  }

  // §3.3 作业详情
  @Get('imports/:jobId')
  @RequireCapabilities('imports.read')
  async detail(
    @Param('jobId', new ZodValidationPipe(z.uuid())) jobId: string,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<ImportJob> {
    return this.imports.detail(actor(auth), jobId);
  }

  // §3.4 行列表
  @Get('imports/:jobId/rows')
  @RequireCapabilities('imports.read')
  async rows(
    @Param('jobId', new ZodValidationPipe(z.uuid())) jobId: string,
    @Query() query: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<Page<ImportRow>> {
    return this.imports.rows(
      actor(auth),
      jobId,
      ImportRowsQuerySchema.parse(query) satisfies ImportRowsQuery,
    );
  }

  // §3.5 人工映射（步骤 3/4）
  @Patch('imports/:jobId/rows/:rowId')
  @RequireCapabilities('imports.write')
  async patchRow(
    @Param('jobId', new ZodValidationPipe(z.uuid())) jobId: string,
    @Param('rowId', new ZodValidationPipe(RowIdParam)) rowId: number,
    @Body() raw: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<ImportRow> {
    guardPatchWhitelist(raw);
    const body = ImportRowPatchSchema.safeParse(raw);
    if (!body.success) {
      throw new ReasonCodeException(
        'common.validation_failed',
        '请求参数校验失败',
        zodFieldIssues(body.error),
      );
    }
    return this.imports.patchRow(actor(auth), jobId, rowId, body.data satisfies ImportRowPatch);
  }

  // §3.6 自动映射（步骤 3）
  @Post('imports/:jobId/mapping/auto')
  @RequireCapabilities('imports.write')
  @HttpCode(202)
  async autoMapping(
    @Param('jobId', new ZodValidationPipe(z.uuid())) jobId: string,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<ImportJob> {
    return this.imports.autoMapping(actor(auth), jobId);
  }

  // §3.7 dry-run 校验（同步报告，200 非 202——overview：校验报告非受理）
  @Post('imports/:jobId/dry-run')
  @RequireCapabilities('imports.write')
  @HttpCode(200)
  async dryRun(
    @Param('jobId', new ZodValidationPipe(z.uuid())) jobId: string,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<DryRunReport> {
    return this.imports.dryRun(actor(auth), jobId);
  }

  // §3.8 apply（Idempotency-Key 必带）
  @Post('imports/:jobId/apply')
  @RequireCapabilities('imports.write')
  @HttpCode(202)
  async apply(
    @Param('jobId', new ZodValidationPipe(z.uuid())) jobId: string,
    @Headers() headers: Record<string, unknown>,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<ImportJob> {
    const who = actor(auth);
    // 幂等键检查（§8.1）：缺失 422；同键重放返回原 202 语义——重放不重跑守卫
    // （§4.2「同键重放幂等 202」与守卫链对已迁移状态的请求互斥，幂等子句优先），
    // 首执行在闭包内按守卫链跑全量预检（404 → 409 state → 409 offline → 409 conflict）。
    const rawKey = headers['idempotency-key'];
    if (typeof rawKey !== 'string' || rawKey.trim().length === 0) {
      throw new ReasonCodeException('common.validation_failed', 'apply 必带 Idempotency-Key', {
        field: 'Idempotency-Key',
      });
    }
    const scopedKey = `${who.tenant_id}:${jobId}:${rawKey.trim()}`; // (tenant, job, key) 24h 窗
    return this.idempotency.run(scopedKey, async () => {
      await this.imports.applyPrecheck(who, jobId);
      // 受理（登记事务条件 UPDATE 单赢家——异键竞态输家为无操作）
      const job = await this.imports.detail(who, jobId);
      void this.imports.executeApplySafely(who.tenant_id, jobId);
      return job;
    });
  }

  // §3.9 发起自检
  @Post('imports/:jobId/self-check')
  @RequireCapabilities('imports.write')
  @HttpCode(202)
  async selfCheck(
    @Param('jobId', new ZodValidationPipe(z.uuid())) jobId: string,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<ImportJob> {
    return this.imports.selfCheck(actor(auth), jobId);
  }

  // §3.10 自检报告
  @Get('imports/:jobId/self-check')
  @RequireCapabilities('imports.read')
  async selfCheckReport(
    @Param('jobId', new ZodValidationPipe(z.uuid())) jobId: string,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<SelfCheckReport> {
    return this.imports.selfCheckReport(actor(auth), jobId);
  }
}

/**
 * 白名单守卫：物理层字段（raw_name/unit_raw/is_write）与其他白名单外键 →
 * 422 common.validation_failed（details 列白名单 + 冒犯键，指向解析期与 M1 端点）。
 */
function guardPatchWhitelist(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ReasonCodeException('common.validation_failed', '请求体必须是对象', {
      '(root)': '期望 JSON 对象',
    });
  }
  const offending = Object.keys(raw).filter((key) => !PATCH_WHITELIST.has(key));
  if (offending.length > 0) {
    throw new ReasonCodeException(
      'common.validation_failed',
      '字段不属于映射白名单（物理层字段解析期定格）',
      {
        allowed: [...IMPORT_ROW_PATCH_FIELDS],
        fields: offending,
        hint: 'raw_name/unit_raw/is_write 修正请重新上传；点位语义编辑走 M1 PATCH /points/{id}',
      },
    );
  }
}
