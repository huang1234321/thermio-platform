/**
 * M3 监控端点（modules M3-monitor.md §3，IMPL-14 api 包）：
 * - GET /monitor/overview（§3.1 总览 KPI）；
 * - GET /monitor/equipments（§3.2 检索）/ GET /monitor/equipments/{id}（§3.3 详情）；
 * - GET /points/latest?point_ids=（§3.6 批量最新值，R6——SSE 重连校准/首屏初始化）；
 * - GET /streams/telemetry（§3.5 SSE，streams.controller.ts）。
 *
 * 全模块单能力键 monitor.read（§1.5）；GET /points/latest 权限归 M1 assets.read 亦
 * 覆盖——两键 viewer+ 同集无行为差异，实现取 monitor.read（§3.6 注记）。
 *
 * 路由注册序纪律：MonitorModule 必须先于 AssetModule 导入——`points/latest` 需抢在
 * 资产域 `points/:pointId` 之前注册（express 按注册序匹配），e2e 有路由序回归钉。
 */
import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { MonitorEquipmentListQuerySchema, STREAM_LIMITS } from '@thermio/shared-types';
import {
  ZodValidationPipe,
  zodFieldIssues,
} from '../infrastructure/validation/zod-validation.pipe.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { CapabilitiesGuard } from '../auth/capabilities.guard.js';
import { CurrentAuth, type AuthContext } from '../auth/auth-context.js';
import { RequireCapabilities } from '../auth/require-capabilities.decorator.js';
import type { AssetActor } from '../asset/asset-shared.js';
import { MonitorService } from './monitor.service.js';

/** §3.1 总览参数：building_id 缺省 = 当前楼宇上下文（可见集首楼）。 */
const MonitorOverviewQuerySchema = z.object({
  building_id: z.uuid().optional(),
});

/** §3.6 批量 latest：csv → int[]（≤500 同 SSE 上限；越限码见服务层）。 */
export function parsePointIdsCsv(raw: string | undefined): number[] {
  if (raw === undefined || raw.trim().length === 0) {
    throw new ReasonCodeException('common.validation_failed', 'point_ids 不能为空', {
      field: 'point_ids',
    });
  }
  const values: number[] = [];
  for (const token of raw.split(',')) {
    const trimmed = token.trim();
    const parsed = z.coerce.number().int().positive().safeParse(trimmed);
    if (!parsed.success) {
      throw new ReasonCodeException('common.validation_failed', 'point_ids 含非法点位号', {
        field: 'point_ids',
        sample: trimmed.slice(0, 32),
      });
    }
    values.push(parsed.data);
    if (values.length > STREAM_LIMITS.max_point_ids_per_request) {
      throw new ReasonCodeException('stream.limit_exceeded', '订阅点数超出上限', {
        limit: STREAM_LIMITS.max_point_ids_per_request,
        count: values.length,
      });
    }
  }
  return values;
}

/** AuthContext → 监控域身份（与资产域同款收窄；无认证上下文 = 守卫被绕过，fail-closed）。 */
export function actorOf(auth: AuthContext | undefined): AssetActor {
  if (auth === undefined) {
    throw new ReasonCodeException('auth.forbidden', '权限不足');
  }
  return { tenant_id: auth.tenant_id, user_id: auth.user_id, role: auth.role };
}

@Controller()
@UseGuards(CapabilitiesGuard)
export class MonitorController {
  constructor(@Inject(MonitorService) private readonly monitor: MonitorService) {}

  @Get('monitor/overview')
  @RequireCapabilities('monitor.read')
  async overview(
    @Query(new ZodValidationPipe(MonitorOverviewQuerySchema)) query: { building_id?: string },
    @CurrentAuth() auth: AuthContext | undefined,
  ) {
    return this.monitor.overview(actorOf(auth), query.building_id);
  }

  @Get('monitor/equipments')
  @RequireCapabilities('monitor.read')
  async equipments(@Query() query: unknown, @CurrentAuth() auth: AuthContext | undefined) {
    const parsed = MonitorEquipmentListQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new ReasonCodeException('common.validation_failed', '查询参数非法', {
        issues: zodFieldIssues(parsed.error),
      });
    }
    return this.monitor.equipments(actorOf(auth), parsed.data);
  }

  @Get('monitor/equipments/:equipmentId')
  @RequireCapabilities('monitor.read')
  async equipmentDetail(
    @Param('equipmentId', new ZodValidationPipe(z.uuid())) equipmentId: string,
    @CurrentAuth() auth: AuthContext | undefined,
  ) {
    return this.monitor.equipmentDetail(actorOf(auth), equipmentId);
  }

  /** §3.6 批量最新值快照（无数据点 null 不 404；越权点整单 404 asset.not_found）。 */
  @Get('points/latest')
  @RequireCapabilities('monitor.read')
  async pointLatestBatch(
    @Query('point_ids') pointIdsRaw: string | undefined,
    @CurrentAuth() auth: AuthContext | undefined,
  ) {
    const pointIds = parsePointIdsCsv(pointIdsRaw);
    return this.monitor.pointLatestBatch(actorOf(auth), pointIds);
  }
}
