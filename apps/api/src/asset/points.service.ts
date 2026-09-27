/**
 * 点位服务（modules M1-asset §3.4–§3.6）：跨层级检索/详情/语义白名单 PATCH/启停。
 *
 * 纪律落点：
 * - 读侧全字段暴露（除 tenant_id，§2.4）；写侧四组分治：语义白名单本服务、启停专用
 *   端点本服务、物理层编辑 §3.10（DAT-151，本卡不接）、闸门 M8（IMPL-18）；
 * - 语义 PATCH 路由隔离守卫在控制器（point.field_not_allowed 400，details.allowed
 *   定向 M8/§3.10/§3.6）——本服务只收白名单内字段；
 * - If-Match 弱校验（W/"<updated_at>"，ms 粒度比对）→ 失配 409 common.conflict；
 * - 启停重复置同态幂等 200（不 UPDATE——updated_at 不前进，仅日志，§5）；
 *   reason 必填入结构化日志（不入 config_audit，field 封闭集为闸门参数）；
 * - batch-status 207 逐项（整单不回滚，§8.3）；ids≤100 去重（schema 层）；
 * - 列表 latest 快照复用 IMPL-12 TSDB 只读仓储（DISTINCT ON 批量；无数据 → null）。
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { PoolClient } from 'pg';
import {
  QUANTITY_TYPES,
  type Page,
  type Point,
  type PointBatchStatus,
  type PointBatchStatusItem,
  type PointDetail,
  type PointListItem,
  type PointSearchQuery,
  type PointSemanticsPatch,
} from '@thermio/shared-types';
import { TENANT_DB } from '../infrastructure/db/db.tokens.js';
import type { TenantDb } from '../infrastructure/db/tenant-db.js';
import { LOGGER } from '../infrastructure/logger.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { TELEMETRY_STORE } from '../telemetry/telemetry.tokens.js';
import { type TelemetryStore } from '../telemetry/tsdb-read.repository.js';
import { TelemetryStoreUnavailableError } from '../telemetry/telemetry-store.error.js';
import {
  POINT_KEYSET_COLUMNS,
  decodeAssetCursor,
  encodeAssetCursor,
  keysetPredicate,
} from './asset-cursor.js';
import {
  assertBuildingInScope,
  bigintValue,
  isoOrNull,
  loadBuildingScope,
  numericToNumber,
  requireRow,
  type AssetActor,
  type BuildingScope,
} from './asset-shared.js';
import { loadEquipment } from './equipments.service.js';

/** pg 行（bigint id → string；numeric → string|null；jsonb → object|null）。 */
export interface PointRow {
  id: string;
  building_id: string;
  equipment_id: string | null;
  source_type: string;
  gateway_id: string | null;
  protocol_address: Record<string, unknown> | null;
  raw_name: string;
  sample_interval_s: number | null;
  quantity_type: string | null;
  display_name: string | null;
  description: string | null;
  unit_raw: string | null;
  unit_std: string | null;
  direction: string;
  is_controllable: boolean;
  clamp_min: string | null;
  clamp_max: string | null;
  write_rate_limit_per_hour: number | null;
  control_mode: string;
  stale_timeout_s: number;
  valid_range_min: string | null;
  valid_range_max: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const SELECT_COLUMNS = `p.id, p.building_id, p.equipment_id, p.source_type, p.gateway_id,
       p.protocol_address, p.raw_name, p.sample_interval_s, p.quantity_type, p.display_name,
       p.description, p.unit_raw, p.unit_std, p.direction, p.is_controllable, p.clamp_min,
       p.clamp_max, p.write_rate_limit_per_hour, p.control_mode, p.stale_timeout_s,
       p.valid_range_min, p.valid_range_max, p.status, p.created_at, p.updated_at`;

@Injectable()
export class PointsService {
  constructor(
    @Inject(TENANT_DB) private readonly tenantDb: TenantDb | null,
    @Inject(LOGGER) rootLogger: Logger,
    @Inject(TELEMETRY_STORE) private readonly telemetry: TelemetryStore,
  ) {
    this.logger = rootLogger.child({ component: 'asset-points' });
  }

  private readonly logger: Logger;

  /** GET /equipments/{equipment_id}/points（(raw_name,id) 升序 + latest 快照，§3.4）。 */
  async listByEquipment(
    actor: AssetActor,
    equipmentId: string,
    filters: { quantity_type?: string | undefined; direction?: string | undefined },
    limit: number,
    cursor: string | undefined,
  ): Promise<Page<PointListItem>> {
    const db = this.requireDb();
    const rows = await db.withTenant(actor.tenant_id, async (tx) => {
      await loadEquipment(tx, actor, equipmentId); // 父设备 load-for-user（越权 404）
      const where: string[] = ['p.tenant_id = $1', 'p.equipment_id = $2'];
      const params: unknown[] = [actor.tenant_id, equipmentId];
      let next = 3;
      if (filters.quantity_type !== undefined) {
        where.push(`p.quantity_type = $${String(next)}::text`);
        params.push(filters.quantity_type);
        next += 1;
      }
      if (filters.direction !== undefined) {
        where.push(`p.direction = $${String(next)}::text`);
        params.push(filters.direction);
        next += 1;
      }
      if (cursor !== undefined) {
        const decoded = decodeAssetCursor(cursor, 1);
        const predicate = keysetPredicate(POINT_KEYSET_COLUMNS, decoded, next, ['', '::bigint']);
        where.push(predicate.sql);
        params.push(...predicate.params);
      }
      const result = await tx.query<PointRow>(
        `SELECT ${SELECT_COLUMNS}
         FROM point p
         WHERE ${where.join(' AND ')}
         ORDER BY p.raw_name ASC, p.id ASC
         LIMIT ${String(limit + 1)}`,
        params,
      );
      return result.rows;
    });
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const lastRow = page.at(-1);
    return {
      items: await this.withLatest(page),
      next_cursor:
        hasMore && lastRow !== undefined
          ? encodeAssetCursor({ k: [lastRow.raw_name], id: lastRow.id })
          : null,
    };
  }

  /** GET /points 跨层级检索（UC-M1-2；白名单筛选 §3.4 表——白名单外键已被 schema 拒）。 */
  async search(actor: AssetActor, query: PointSearchQuery): Promise<Page<Point>> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const scope = await loadBuildingScope(tx, actor);
      const where: string[] = ['p.tenant_id = $1'];
      const params: unknown[] = [actor.tenant_id];
      let next = 2;
      if (scope !== null) {
        where.push(`p.building_id = ANY($${String(next)}::uuid[])`);
        params.push([...scope]);
        next += 1;
      }
      if (query.building_id !== undefined) {
        // 过滤值经 load-for-user 校验（§6：越权/不存在 → 404，不泄露存在性）
        await assertBuildingVisible(tx, actor, scope, query.building_id);
        where.push(`p.building_id = $${String(next)}`);
        params.push(query.building_id);
        next += 1;
      }
      if (query.equipment_id !== undefined) {
        await assertEquipmentVisible(tx, actor, scope, query.equipment_id);
        where.push(`p.equipment_id = $${String(next)}`);
        params.push(query.equipment_id);
        next += 1;
      }
      if (query.gateway_id !== undefined) {
        await assertGatewayVisible(tx, actor, scope, query.gateway_id);
        where.push(`p.gateway_id = $${String(next)}`);
        params.push(query.gateway_id);
        next += 1;
      }
      for (const [field, value] of [
        ['quantity_type', query.quantity_type],
        ['direction', query.direction],
        ['control_mode', query.control_mode],
        ['status', query.status],
      ] as const) {
        if (value !== undefined) {
          where.push(`p.${field} = $${String(next)}::text`);
          params.push(value);
          next += 1;
        }
      }
      if (query.is_controllable !== undefined) {
        where.push(`p.is_controllable = $${String(next)}`);
        params.push(query.is_controllable === 'true');
        next += 1;
      }
      if (query.keyword !== undefined) {
        where.push(
          `(p.raw_name ILIKE $${String(next)}::text OR p.display_name ILIKE $${String(next)}::text)`,
        );
        params.push(`%${escapeLike(query.keyword.trim())}%`);
        next += 1;
      }
      if (query.cursor !== undefined) {
        const decoded = decodeAssetCursor(query.cursor, 1);
        const predicate = keysetPredicate(POINT_KEYSET_COLUMNS, decoded, next, ['', '::bigint']);
        where.push(predicate.sql);
        params.push(...predicate.params);
      }
      const result = await tx.query<PointRow>(
        `SELECT ${SELECT_COLUMNS}
         FROM point p
         WHERE ${where.join(' AND ')}
         ORDER BY p.raw_name ASC, p.id ASC
         LIMIT ${String(query.limit + 1)}`,
        params,
      );
      const page = result.rows.slice(0, query.limit);
      const hasMore = result.rows.length > query.limit;
      const lastRow = page.at(-1);
      return {
        items: page.map(toPoint),
        next_cursor:
          hasMore && lastRow !== undefined
            ? encodeAssetCursor({ k: [lastRow.raw_name], id: lastRow.id })
            : null,
      };
    });
  }

  /** GET /points/{point_id}（详情 + 面包屑上下文，§3.4）。 */
  async detail(actor: AssetActor, pointId: number): Promise<PointDetail> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const row = await loadPoint(tx, actor, pointId);
      const result = await tx.query<ContextRow>(
        `SELECT jsonb_build_object('id', b.id, 'name', b.name) AS building,
                CASE WHEN eq.id IS NULL THEN NULL
                     ELSE jsonb_build_object('id', eq.id, 'name', eq.name) END AS equipment,
                CASE WHEN sy.id IS NULL THEN NULL
                     ELSE jsonb_build_object('id', sy.id, 'name', sy.name) END AS system,
                CASE WHEN gw.id IS NULL THEN NULL
                     ELSE jsonb_build_object('id', gw.id, 'name', gw.name) END AS gateway
         FROM point p
         JOIN building b ON b.tenant_id = p.tenant_id AND b.id = p.building_id
         LEFT JOIN equipment eq ON eq.tenant_id = p.tenant_id AND eq.id = p.equipment_id
         LEFT JOIN hvac_system sy ON sy.tenant_id = eq.tenant_id AND sy.id = eq.system_id
         LEFT JOIN gateway gw ON gw.tenant_id = p.tenant_id AND gw.id = p.gateway_id
         WHERE p.tenant_id = $1 AND p.id = $2`,
        [actor.tenant_id, pointId],
      );
      const ctx = result.rows[0];
      if (ctx === undefined) throw new ReasonCodeException('asset.not_found', '资源不存在');
      return {
        ...toPoint(row),
        context: {
          building: ctx.building,
          system: ctx.system,
          equipment: ctx.equipment,
          gateway: ctx.gateway,
        },
      };
    });
  }

  /**
   * PATCH /points/{point_id}（语义白名单五字段；控制器已完成路由隔离守卫与 schema 校验）。
   */
  async semanticsPatch(
    actor: AssetActor,
    pointId: number,
    body: PointSemanticsPatch,
    ifMatch: string | undefined,
  ): Promise<Point> {
    if (body.quantity_type != null) assertQuantityTypeKnown(body.quantity_type);
    const fields = Object.entries(body).filter(([, value]) => value !== undefined);
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const row = await loadPoint(tx, actor, pointId);
      assertIfMatch(ifMatch, row.updated_at);
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const [field, value] of fields) {
        params.push(value ?? null);
        sets.push(`${field} = $${String(params.length)}`);
      }
      params.push(actor.tenant_id, pointId);
      const result = await tx.query<PointRow>(
        `UPDATE point SET ${sets.join(', ')}
         WHERE tenant_id = $${String(params.length - 1)} AND id = $${String(params.length)}
         RETURNING ${SELECT_COLUMNS.replace(/\bp\./g, '')}`,
        params,
      );
      this.logger.info({
        msg: 'point_semantics_updated',
        tenant_id: actor.tenant_id,
        building_id: row.building_id,
        point_id: pointId,
        actor: actor.user_id,
        fields: fields.map(([field]) => field),
      });
      return toPoint(requireRow(result.rows, 'point'));
    });
  }

  /** PATCH /points/{point_id}/status（重复置同态幂等 200，仅日志不留新痕）。 */
  async statusPatch(
    actor: AssetActor,
    pointId: number,
    status: 'active' | 'disabled',
    reason: string,
  ): Promise<Point> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const row = await loadPoint(tx, actor, pointId);
      return applyStatusChange(tx, this.logger, actor, row, status, reason);
    });
  }

  /** POST /points/batch-status（207 逐项；整单不回滚）。 */
  async batchStatus(
    actor: AssetActor,
    body: PointBatchStatus,
  ): Promise<{ items: PointBatchStatusItem[] }> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const items: PointBatchStatusItem[] = [];
      for (const pointId of body.ids) {
        try {
          const row = await loadPoint(tx, actor, pointId);
          await applyStatusChange(tx, this.logger, actor, row, body.status, body.reason);
          items.push({ point_id: pointId, ok: true });
        } catch (error) {
          // 逐项失败不中断整单（§3.6：越权/不存在项报 asset.not_found）
          const reasonCode =
            error instanceof ReasonCodeException ? error.reasonCode : 'common.internal_error';
          items.push({ point_id: pointId, ok: false, error: { reason_code: reasonCode } });
        }
      }
      return { items };
    });
  }

  /** latest 快照批量装配（TSDB 不可用 → 全 null 降级 + WARN——列表主资源是点位档案）。 */
  private async withLatest(rows: readonly PointRow[]): Promise<PointListItem[]> {
    const points = rows.map(toPoint);
    if (rows.length === 0) return points.map((point) => ({ point, latest: null }));
    try {
      const latest = await this.telemetry.latestBatch(points.map((point) => point.id));
      return points.map((point) => ({ point, latest: latest.get(point.id) ?? null }));
    } catch (error) {
      if (error instanceof TelemetryStoreUnavailableError) {
        this.logger.warn({ msg: 'latest_snapshot_degraded', detail: error.message });
        return points.map((point) => ({ point, latest: null }));
      }
      throw error;
    }
  }

  private requireDb(): TenantDb {
    if (this.tenantDb === null) {
      throw new ReasonCodeException('common.internal_error', '资产域未接线');
    }
    return this.tenantDb;
  }
}

/** 面包屑上下文行（jsonb 列 pg 已解析为对象）。 */
interface ContextRow {
  building: { id: string; name: string };
  system: { id: string; name: string } | null;
  equipment: { id: string; name: string } | null;
  gateway: { id: string; name: string } | null;
}

/** load-for-user 读单行（含楼宇归属校验；越权/不存在同 404）。 */
export async function loadPoint(
  tx: PoolClient,
  actor: AssetActor,
  pointId: number,
): Promise<PointRow> {
  const result = await tx.query<PointRow>(
    `SELECT ${SELECT_COLUMNS} FROM point p WHERE p.tenant_id = $1 AND p.id = $2`,
    [actor.tenant_id, pointId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ReasonCodeException('asset.not_found', '资源不存在', { entity: 'point' });
  }
  const scope = await loadBuildingScope(tx, actor);
  assertBuildingInScope(scope, row.building_id);
  return row;
}

/** 同态幂等：值未变不 UPDATE（updated_at 不前进），仅追加日志（§5 状态图注记）。 */
async function applyStatusChange(
  tx: PoolClient,
  logger: Logger,
  actor: AssetActor,
  row: PointRow,
  status: 'active' | 'disabled',
  reason: string,
): Promise<Point> {
  if (row.status === status) {
    logger.info(statusLog(actor, row, status, reason, 'point_status_idempotent'));
    return toPoint(row);
  }
  const result = await tx.query<PointRow>(
    `UPDATE point SET status = $3
     WHERE tenant_id = $1 AND id = $2
     RETURNING ${SELECT_COLUMNS.replace(/\bp\./g, '')}`,
    [actor.tenant_id, row.id, status],
  );
  logger.info(statusLog(actor, row, status, reason, 'point_status_changed'));
  return toPoint(requireRow(result.rows, 'point status'));
}

function statusLog(
  actor: AssetActor,
  row: PointRow,
  status: 'active' | 'disabled',
  reason: string,
  msg: string,
): Record<string, unknown> {
  // §5 留痕：pino 字段口径（tenant_id/building_id/point_id/actor/old/new/reason）
  return {
    msg,
    tenant_id: actor.tenant_id,
    building_id: row.building_id,
    point_id: bigintValue(row.id),
    actor: actor.user_id,
    old: row.status,
    new: status,
    reason,
  };
}

export function toPoint(row: PointRow): Point {
  return {
    id: bigintValue(row.id),
    building_id: row.building_id,
    equipment_id: row.equipment_id,
    source_type: row.source_type as Point['source_type'],
    gateway_id: row.gateway_id,
    protocol_address: row.protocol_address,
    raw_name: row.raw_name,
    sample_interval_s: row.sample_interval_s,
    quantity_type: (row.quantity_type ?? null) as Point['quantity_type'],
    display_name: row.display_name,
    description: row.description,
    unit_raw: row.unit_raw,
    unit_std: row.unit_std,
    direction: row.direction as Point['direction'],
    is_controllable: row.is_controllable,
    clamp_min: numericToNumber(row.clamp_min),
    clamp_max: numericToNumber(row.clamp_max),
    write_rate_limit_per_hour: row.write_rate_limit_per_hour,
    control_mode: row.control_mode as Point['control_mode'],
    stale_timeout_s: row.stale_timeout_s,
    valid_range_min: numericToNumber(row.valid_range_min),
    valid_range_max: numericToNumber(row.valid_range_max),
    status: row.status as Point['status'],
    created_at: isoOrNull(row.created_at) ?? '',
    updated_at: isoOrNull(row.updated_at) ?? '',
  };
}

/** If-Match 弱校验（W/"<updated_at>"，ms 粒度；失配 409，形状非法 422）。 */
function assertIfMatch(header: string | undefined, current: Date): void {
  if (header === undefined) return;
  const match = /^W\/"(.*)"$/.exec(header) ?? /^"(.*)"$/.exec(header);
  if (match === null) {
    throw new ReasonCodeException('common.validation_failed', 'If-Match 头格式不合法', {
      field: 'if-match',
    });
  }
  const given = Date.parse(match[1] ?? '');
  if (Number.isNaN(given) || current.getTime() !== given) {
    throw new ReasonCodeException('common.conflict', '资源已被其他修改覆盖', {
      current_updated_at: current.toISOString(),
    });
  }
}

function assertQuantityTypeKnown(value: string): void {
  if (!(QUANTITY_TYPES as readonly string[]).includes(value)) {
    throw new ReasonCodeException('point.quantity_type_unknown', '量类型不在受支持清单', {
      field: 'quantity_type',
    });
  }
}

async function assertBuildingVisible(
  tx: PoolClient,
  actor: AssetActor,
  scope: BuildingScope,
  buildingId: string,
): Promise<void> {
  const result = await tx.query(`SELECT 1 FROM building WHERE tenant_id = $1 AND id = $2`, [
    actor.tenant_id,
    buildingId,
  ]);
  if (result.rows.length !== 1) {
    throw new ReasonCodeException('asset.not_found', '资源不存在', { entity: 'building' });
  }
  assertBuildingInScope(scope, buildingId);
}

async function assertEquipmentVisible(
  tx: PoolClient,
  actor: AssetActor,
  scope: BuildingScope,
  equipmentId: string,
): Promise<void> {
  const result = await tx.query<{ building_id: string }>(
    `SELECT s.building_id FROM equipment e
     JOIN hvac_system s ON s.tenant_id = e.tenant_id AND s.id = e.system_id
     WHERE e.tenant_id = $1 AND e.id = $2`,
    [actor.tenant_id, equipmentId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ReasonCodeException('asset.not_found', '资源不存在', { entity: 'equipment' });
  }
  assertBuildingInScope(scope, row.building_id);
}

async function assertGatewayVisible(
  tx: PoolClient,
  actor: AssetActor,
  scope: BuildingScope,
  gatewayId: string,
): Promise<void> {
  const result = await tx.query<{ building_id: string }>(
    `SELECT building_id FROM gateway WHERE tenant_id = $1 AND id = $2`,
    [actor.tenant_id, gatewayId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ReasonCodeException('gateway.not_found', '资源不存在', { entity: 'gateway' });
  }
  assertBuildingInScope(scope, row.building_id, 'gateway.not_found');
}

function escapeLike(value: string): string {
  return value.replaceAll('%', '\\%').replaceAll('_', '\\_');
}
