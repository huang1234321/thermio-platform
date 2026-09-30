/**
 * FDD admin 面端点（modules/M6-fdd.md §5，IMPL-16 切片 / DAT-212；base /api/v1）。
 *
 * - 能力键（§5）：fdd.read（三角色浏览）/ fdd.write（operator+：抽检记录 + 忽略）；
 * - 查询白名单（API-DSN-04）：白名单外参数 → 422 common.validation_failed（strict zod）；
 * - ignore Idempotency-Key 必带（后果性写，API-DSN-01；缺失 422）；review 接受不要求
 *   （PUT 语义天然幂等，§5.4）；
 * - 错误码域（§4.6）：fdd.finding_not_found / fdd.report_not_found（404，越权同文案）/
 *   fdd.state_invalid（409）；楼宇参数越界复用 asset.not_found（§5.1）。
 */
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  FddFindingsQuerySchema,
  FddIgnoreRequestSchema,
  FddReportsQuerySchema,
  FddReviewRequestSchema,
} from '@thermio/shared-types';
import {
  ZodValidationPipe,
  zodFieldIssues,
} from '../infrastructure/validation/zod-validation.pipe.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { CapabilitiesGuard } from '../auth/capabilities.guard.js';
import { CurrentAuth, type AuthContext } from '../auth/auth-context.js';
import { RequireCapabilities } from '../auth/require-capabilities.decorator.js';
import { IdempotencyStore, idempotencyKey } from '../asset/idempotency.js';
import { FddService, type FddActor } from './fdd.service.js';

function actorOf(auth: AuthContext | undefined): FddActor {
  if (auth === undefined) {
    throw new ReasonCodeException('auth.forbidden', '权限不足');
  }
  return { tenant_id: auth.tenant_id, user_id: auth.user_id, role: auth.role };
}

@Controller()
@UseGuards(CapabilitiesGuard)
export class FddController {
  constructor(
    @Inject(FddService) private readonly fdd: FddService,
    @Inject(IdempotencyStore) private readonly idempotency: IdempotencyStore,
  ) {}

  /** GET /fdd/overview（§5.1：概览看板；building_id 缺省 = 全部授权楼宇聚合）。 */
  @Get('fdd/overview')
  @RequireCapabilities('fdd.read')
  async overview(
    @Query('building_id', new ZodValidationPipe(z.uuid().optional()))
    buildingId: string | undefined,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    return this.fdd.overview(actorOf(auth), buildingId);
  }

  /** GET /fdd/findings（§5.2：白名单筛选 + 活跃窗口 + keyset 分页）。 */
  @Get('fdd/findings')
  @RequireCapabilities('fdd.read')
  async listFindings(
    @Query() query: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    const parsed = FddFindingsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new ReasonCodeException('common.validation_failed', '查询参数非法', {
        issues: zodFieldIssues(parsed.error),
      });
    }
    return this.fdd.listFindings(actorOf(auth), parsed.data);
  }

  /** GET /fdd/findings/{id}（§5.3：详情自带 evidence，无独立证据端点）。 */
  @Get('fdd/findings/:findingId')
  @RequireCapabilities('fdd.read')
  async findingDetail(
    @Param('findingId', new ZodValidationPipe(z.uuid())) findingId: string,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    return this.fdd.findingDetail(actorOf(auth), findingId);
  }

  /** PUT /fdd/findings/{id}/review（§5.4：S3 记录入口，设置/覆写判定，任意 status）。 */
  @Put('fdd/findings/:findingId/review')
  @RequireCapabilities('fdd.write')
  async review(
    @Param('findingId', new ZodValidationPipe(z.uuid())) findingId: string,
    @Headers() headers: Record<string, unknown>,
    @Body() raw: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    const parsed = FddReviewRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ReasonCodeException('common.validation_failed', '请求体非法', {
        issues: zodFieldIssues(parsed.error),
      });
    }
    const who = actorOf(auth);
    const key = idempotencyKey(
      headers,
      who.tenant_id,
      who.user_id,
      `PUT /fdd/findings/${findingId}/review`,
    );
    if (key === null) return this.fdd.reviewFinding(who, findingId, parsed.data);
    return this.idempotency.run(key, () => this.fdd.reviewFinding(who, findingId, parsed.data));
  }

  /** POST /fdd/findings/{id}/ignore（§5.5：open → ignored；已 ignored 幂等 200）。 */
  @Post('fdd/findings/:findingId/ignore')
  @RequireCapabilities('fdd.write')
  @HttpCode(200)
  async ignore(
    @Param('findingId', new ZodValidationPipe(z.uuid())) findingId: string,
    @Headers() headers: Record<string, unknown>,
    @Body() raw: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    const parsed = FddIgnoreRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ReasonCodeException('common.validation_failed', '请求体非法', {
        issues: zodFieldIssues(parsed.error),
      });
    }
    // Idempotency-Key 必带（后果性写，API-DSN-01；沿 M2 apply 缺失 422 口径）
    const rawKey = headers['idempotency-key'];
    if (typeof rawKey !== 'string' || rawKey.trim().length === 0) {
      throw new ReasonCodeException('common.validation_failed', 'ignore 必带 Idempotency-Key', {
        field: 'Idempotency-Key',
      });
    }
    const who = actorOf(auth);
    const scopedKey = idempotencyKey(
      headers,
      who.tenant_id,
      who.user_id,
      `POST /fdd/findings/${findingId}/ignore`,
    );
    if (scopedKey === null) {
      throw new ReasonCodeException('common.internal_error', '幂等键拼装失败');
    }
    return this.idempotency.run(scopedKey, () =>
      this.fdd.ignoreFinding(who, findingId, parsed.data.reason),
    );
  }

  /** GET /fdd/reports（§5.6：周期报告列表）。 */
  @Get('fdd/reports')
  @RequireCapabilities('fdd.read')
  async listReports(
    @Query() query: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    const parsed = FddReportsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new ReasonCodeException('common.validation_failed', '查询参数非法', {
        issues: zodFieldIssues(parsed.error),
      });
    }
    return this.fdd.listReports(actorOf(auth), parsed.data);
  }

  /** GET /fdd/reports/{id}（§5.7：与列表项同 schema——报告无大字段）。 */
  @Get('fdd/reports/:reportId')
  @RequireCapabilities('fdd.read')
  async reportDetail(
    @Param('reportId', new ZodValidationPipe(z.uuid())) reportId: string,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<unknown> {
    return this.fdd.reportDetail(actorOf(auth), reportId);
  }
}
