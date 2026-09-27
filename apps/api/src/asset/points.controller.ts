/**
 * 点位端点（modules M1-asset §3.4–§3.6）：
 * - GET /equipments/{id}/points（列表 + latest 快照）、GET /points（跨层级检索）、
 *   GET /points/{id}（详情 + 面包屑）；
 * - PATCH /points/{id}（语义白名单，operator+，可选 If-Match）；
 * - PATCH /points/{id}/status + POST /points/batch-status（启停，admin）。
 *
 * **路由隔离守卫（IMPL-11 验收锚点，§3.5）**：语义 PATCH 含白名单外字段 →
 * 400 `point.field_not_allowed`（details.allowed 列白名单）——闸门字段定向 M8、
 * 物理层字段定向 §3.10（DAT-151）、status 定向 §3.6，其余 v1 无编辑路径。
 * 键层收窄必须先于 schema 校验（strict 会把白名单外键归入 422，语义不符）。
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
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  EquipmentPointsQuerySchema,
  POINT_SEMANTIC_FIELDS,
  PointBatchStatusSchema,
  PointSearchQuerySchema,
  PointSemanticsPatchSchema,
  PointStatusPatchSchema,
  type Page,
  type Point,
  type PointBatchStatus,
  type PointBatchStatusResponse,
  type PointDetail,
  type PointListItem,
  type PointSearchQuery,
  type PointSemanticsPatch,
} from '@thermio/shared-types';
import {
  ZodValidationPipe,
  zodFieldIssues,
} from '../infrastructure/validation/zod-validation.pipe.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { CapabilitiesGuard } from '../auth/capabilities.guard.js';
import { CurrentAuth, type AuthContext } from '../auth/auth-context.js';
import { RequireCapabilities } from '../auth/require-capabilities.decorator.js';
import { PointsService } from './points.service.js';
import { IdempotencyStore, idempotencyKey } from './idempotency.js';
import { actor } from './buildings.controller.js';

/** point 主键 bigint（非 uuid 族——§2.4 注记）。 */
const PointIdParam = z.coerce.number().int().positive();

const SEMANTIC_WHITELIST = new Set<string>(POINT_SEMANTIC_FIELDS);

@Controller()
@UseGuards(CapabilitiesGuard)
export class PointsController {
  constructor(
    @Inject(PointsService) private readonly points: PointsService,
    @Inject(IdempotencyStore) private readonly idempotency: IdempotencyStore,
  ) {}

  @Get('equipments/:equipmentId/points')
  @RequireCapabilities('assets.read')
  async listByEquipment(
    @Param('equipmentId', new ZodValidationPipe(z.uuid())) equipmentId: string,
    @Query() query: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<Page<PointListItem>> {
    const parsed = EquipmentPointsQuerySchema.parse(query);
    return this.points.listByEquipment(
      actor(auth),
      equipmentId,
      parsed,
      parsed.limit,
      parsed.cursor,
    );
  }

  @Get('points')
  @RequireCapabilities('assets.read')
  async search(
    @Query() query: PointSearchQuery,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<Page<Point>> {
    // 白名单外查询参数 → 422（strict schema，API-DSN-04：不静默忽略）
    return this.points.search(actor(auth), PointSearchQuerySchema.parse(query));
  }

  @Get('points/:pointId')
  @RequireCapabilities('assets.read')
  async detail(
    @Param('pointId', new ZodValidationPipe(PointIdParam)) pointId: number,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<PointDetail> {
    return this.points.detail(actor(auth), pointId);
  }

  @Patch('points/:pointId')
  @RequireCapabilities('points.semantics.write')
  async semanticsPatch(
    @Param('pointId', new ZodValidationPipe(PointIdParam)) pointId: number,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() raw: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<Point> {
    guardSemanticWhitelist(raw);
    const body = parseSemanticsPatch(raw);
    return this.points.semanticsPatch(actor(auth), pointId, body, ifMatch);
  }

  @Patch('points/:pointId/status')
  @RequireCapabilities('points.status.write')
  async statusPatch(
    @Param('pointId', new ZodValidationPipe(PointIdParam)) pointId: number,
    @Body(new ZodValidationPipe(PointStatusPatchSchema))
    body: { status: 'active' | 'disabled'; reason: string },
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<Point> {
    return this.points.statusPatch(actor(auth), pointId, body.status, body.reason);
  }

  @Post('points/batch-status')
  @RequireCapabilities('points.status.write')
  @HttpCode(207)
  async batchStatus(
    @Headers() headers: Record<string, unknown>,
    @Body(new ZodValidationPipe(PointBatchStatusSchema)) body: PointBatchStatus,
    @CurrentAuth() auth: AuthContext | undefined,
  ): Promise<PointBatchStatusResponse> {
    const who = actor(auth);
    const key = idempotencyKey(headers, who.tenant_id, who.user_id, 'POST /points/batch-status');
    if (key === null) return this.points.batchStatus(who, body);
    return this.idempotency.run(key, () => this.points.batchStatus(who, body));
  }
}

/**
 * 路由隔离守卫：白名单外**键** → 400 point.field_not_allowed（details.allowed 列
 * 白名单五字段）。闸门/物理/status 误投语义端点在此统一拦截定向。
 */
function guardSemanticWhitelist(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ReasonCodeException('common.validation_failed', '请求体必须是对象', {
      '(root)': '期望 JSON 对象',
    });
  }
  const offending = Object.keys(raw).filter((key) => !SEMANTIC_WHITELIST.has(key));
  if (offending.length > 0) {
    throw new ReasonCodeException('point.field_not_allowed', '字段不属于语义编辑白名单', {
      allowed: [...POINT_SEMANTIC_FIELDS],
      fields: offending,
    });
  }
  if (Object.keys(raw).length === 0) {
    throw new ReasonCodeException('common.validation_failed', '至少提供一个可更新字段');
  }
}

/** 白名单内键的值校验（类型/长度 → 422，全局过滤器归一 ZodError 同款 details）。 */
function parseSemanticsPatch(raw: unknown): PointSemanticsPatch {
  const result = PointSemanticsPatchSchema.safeParse(raw);
  if (!result.success) {
    throw new ReasonCodeException(
      'common.validation_failed',
      '请求参数校验失败',
      zodFieldIssues(result.error),
    );
  }
  return result.data;
}
