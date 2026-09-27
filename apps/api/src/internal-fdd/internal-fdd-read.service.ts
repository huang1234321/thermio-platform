/**
 * FDD internal 读面 + 语义资产快照（algo.md §8.3 / §6.2；IMPL-17 并入项 / DAT-163）。
 *
 * - GET /internal/fdd/findings：报告聚合数据源（algo 无 PG 读权限，发现历史只能向
 *   中台要）；形状 = M6 §4.2 FddFindingListItem（列表不含 evidence，精瘦前提）；
 *   from/to = 活跃窗口谓词（M6 §5.2 一处定义两处消费：first < to ∧ effective_end
 *   为空 ∨ ≥ from）；默认排序 last_detected_at DESC, id DESC（keyset）；
 * - GET /internal/algo/asset-snapshot：point_id → 设备/量类型映射（DM §2 经中台
 *   API 的唯一通路读侧）；updated_since 增量以 point.updated_at 为游标——
 *   equipment 无 updated_at 列（DDL 缺口，非本卡迁移面）：equipments 恒全量带出
 *   （MVP 单楼量级可承受；algo 侧 merge 按主键覆盖，全量带出即正确超集）。
 *   跨租户读经 AUTH_DB internal_read 旁路（0007/0008），快照随行带 tenant_id。
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { TENANT_DB } from '../infrastructure/db/db.tokens.js';
import type { TenantDb } from '../infrastructure/db/tenant-db.js';
import {
  type AssetSnapshot,
  type FddFindingListItem,
  type FddFindingList,
  type InternalFddFindingsQuery,
} from '@thermio/shared-types';
import { AUTH_DB_POOL } from '../infrastructure/db/db.tokens.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { decodeProposalCursor, encodeProposalCursor } from '../proposal/proposal-cursor.js';
import { numericToNumber } from '../asset/asset-shared.js';

interface FindingRow {
  readonly id: string;
  readonly rule_key: string;
  readonly severity: string;
  readonly status: string;
  readonly title: string;
  readonly suggested_action: string | null;
  readonly algo_version: string;
  readonly first_detected_at: Date;
  readonly last_detected_at: Date;
  readonly resolved_at: Date | null;
  readonly created_at: Date;
  readonly building_id: string;
  readonly equipment_id: string;
  readonly equipment_name: string;
  readonly equipment_local_id: string | null;
  readonly equipment_type: string;
}

function findingItemOf(row: FindingRow): FddFindingListItem {
  return {
    id: row.id,
    building_id: row.building_id,
    equipment: {
      id: row.equipment_id,
      name: row.equipment_name,
      local_id: row.equipment_local_id,
      equipment_type: row.equipment_type,
    },
    rule_key: row.rule_key,
    severity: row.severity as FddFindingListItem['severity'],
    status: row.status as FddFindingListItem['status'],
    title: row.title,
    suggested_action: row.suggested_action,
    algo_version: row.algo_version,
    first_detected_at: row.first_detected_at.toISOString(),
    last_detected_at: row.last_detected_at.toISOString(),
    resolved_at: row.resolved_at === null ? null : row.resolved_at.toISOString(),
    ignored_at: null, // 列集未落（M6 §3.3 提案）——恒 null
    review: null,
    created_at: row.created_at.toISOString(),
  };
}

@Injectable()
export class InternalFddReadService {
  constructor(
    @Inject(AUTH_DB_POOL) private readonly authPool: Pool | null,
    @Inject(TENANT_DB) private readonly tenantDb: TenantDb | null,
  ) {}

  /** GET /internal/fdd/findings（活跃窗口谓词 + keyset last_detected_at DESC）。 */
  async listFindings(query: InternalFddFindingsQuery): Promise<FddFindingList> {
    // 租户由目标实体解析（platform §11-5）：building_id → tenant（0008 旁路），
    // 列表查询回 withTenant 正常路径（RLS 域内，越权面最小）
    const tenantId = await this.resolveTenantByBuilding(query.building_id);
    if (this.tenantDb === null) {
      throw new ReasonCodeException('common.internal_error', '数据库未接线');
    }
    return this.tenantDb.withTenant(tenantId, async (tx) => {
      const params: unknown[] = [query.building_id];
      let next = 2;
      // 活跃窗口（M6 §5.2 原文谓词；ignored_at 列未落（M6 §3.3 提案）恒 NULL，
      // 谓词按现存列收敛为 resolved_at）
      const where: string[] = ['s.building_id = $1::uuid'];
      if (query.to !== undefined) {
        where.push(`f.first_detected_at < $${String(next)}::timestamptz`);
        params.push(query.to);
        next += 1;
      }
      const effectiveFrom = query.from;
      if (effectiveFrom !== undefined) {
        where.push(`(f.resolved_at IS NULL OR f.resolved_at >= $${String(next)}::timestamptz)`);
        params.push(effectiveFrom);
        next += 1;
      }
      if (query.cursor !== undefined) {
        const cursor = decodeProposalCursor(query.cursor, 1);
        const cursorTime = cursor.k[0];
        if (cursorTime === undefined) {
          throw new ReasonCodeException('common.validation_failed', '游标非法或已过期', {
            field: 'cursor',
          });
        }
        where.push(
          `((extract(epoch from f.last_detected_at) * 1000000)::bigint, f.id::text) < ($${String(next)}::bigint, $${String(next + 1)}::text)`,
        );
        params.push(cursorTime, cursor.id);
        next += 2;
      }
      const limit = query.limit;
      const result = await tx.query<FindingRow>(
        `SELECT f.id, f.rule_key, f.severity, f.status, f.title, f.suggested_action,
              f.algo_version, f.first_detected_at, f.last_detected_at, f.resolved_at,
              f.created_at,
              s.building_id, e.id AS equipment_id, e.name AS equipment_name,
              e.local_id AS equipment_local_id, e.equipment_type
       FROM fdd_finding f
       JOIN equipment e ON e.tenant_id = f.tenant_id AND e.id = f.equipment_id
       JOIN hvac_system s ON s.tenant_id = e.tenant_id AND s.id = e.system_id
       WHERE ${where.join(' AND ')}
       ORDER BY f.last_detected_at DESC, f.id DESC
       LIMIT ${String(limit + 1)}`,
        params,
      );
      const rows = result.rows;
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = hasMore ? rows[limit - 1] : undefined;
      return {
        items: page.map(findingItemOf),
        next_cursor:
          hasMore && last !== undefined
            ? encodeProposalCursor({
                k: [String(BigInt(Math.floor(last.last_detected_at.getTime() * 1000)))],
                id: last.id,
              })
            : null,
      };
    });
  }

  /** building_id → tenant_id（0008 internal_read 旁路）。 */
  private async resolveTenantByBuilding(buildingId: string): Promise<string> {
    const pool = this.requirePool();
    const result = await pool.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM building WHERE id = $1`,
      [buildingId],
    );
    const tenantId = result.rows[0]?.tenant_id;
    if (tenantId === undefined) {
      throw new ReasonCodeException('asset.not_found', '资源不存在', { entity: 'building' });
    }
    return tenantId;
  }

  /** GET /internal/algo/asset-snapshot（equipments 恒全量；points 按 updated_since 增量）。 */
  async assetSnapshot(updatedSince?: string): Promise<AssetSnapshot> {
    const pool = this.requirePool();
    const equipments = await pool.query<{
      id: string;
      tenant_id: string;
      equipment_type: string;
      system_id: string;
      name: string;
      local_id: string | null;
      rated_params: Record<string, unknown> | null;
    }>(
      `SELECT e.id, e.tenant_id, e.equipment_type, e.system_id, e.name, e.local_id, e.rated_params
       FROM equipment e ORDER BY e.id`,
    );
    const pointsParams: unknown[] = [];
    let pointsWhere = '';
    if (updatedSince !== undefined) {
      pointsParams.push(updatedSince);
      pointsWhere = 'WHERE p.updated_at > $1::timestamptz';
    }
    const points = await pool.query<{
      id: string;
      tenant_id: string;
      equipment_id: string | null;
      quantity_type: string | null;
      unit_std: string | null;
      valid_range_min: string | null;
      valid_range_max: string | null;
      is_controllable: boolean;
      clamp_min: string | null;
      clamp_max: string | null;
      control_mode: string;
    }>(
      `SELECT p.id, p.tenant_id, p.equipment_id, p.quantity_type, p.unit_std,
              p.valid_range_min, p.valid_range_max, p.is_controllable,
              p.clamp_min, p.clamp_max, p.control_mode
       FROM point p ${pointsWhere} ORDER BY p.id`,
      pointsParams,
    );
    const buildingOfSystem = new Map(
      (
        await pool.query<{ id: string; building_id: string }>(
          `SELECT id, building_id FROM hvac_system`,
        )
      ).rows.map((row) => [row.id, row.building_id]),
    );

    return {
      generated_at: new Date().toISOString(),
      equipments: equipments.rows.map((equipment) => ({
        equipment_id: equipment.id,
        equipment_type: equipment.equipment_type,
        system_id: equipment.system_id,
        building_id: buildingOfSystem.get(equipment.system_id) ?? null,
        tenant_id: equipment.tenant_id,
        local_id: equipment.local_id,
        name: equipment.name,
        rated_params: equipment.rated_params ?? {},
      })),
      points: points.rows.map((point) => ({
        point_id: Number(point.id),
        equipment_id: point.equipment_id,
        quantity_type: point.quantity_type,
        unit_std: point.unit_std,
        valid_range_min: numericToNumber(point.valid_range_min),
        valid_range_max: numericToNumber(point.valid_range_max),
        is_controllable: point.is_controllable,
        clamp_min: numericToNumber(point.clamp_min),
        clamp_max: numericToNumber(point.clamp_max),
        control_mode: point.control_mode,
      })),
    };
  }

  private requirePool(): Pool {
    if (this.authPool === null) {
      throw new ReasonCodeException('common.internal_error', '数据库未接线');
    }
    return this.authPool;
  }
}
