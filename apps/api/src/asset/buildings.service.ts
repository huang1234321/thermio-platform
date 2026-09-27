/**
 * 楼宇服务（modules M1-asset §3.1）：CRUD + keyword 检索 + 游标分页。
 *
 * 纪律落点：
 * - 全部读写经 TenantDb.withTenant（ddl.md §5.2）；显式 tenant_id 谓词（双保险）；
 * - load-for-user：operator/viewer 只见授权楼宇（SEC-AZ-02），越权/不存在同 404
 *   `asset.not_found`（SEC-AZ-03 文案不区分）；
 * - MVP 无乐观并发（R4：DDL 无版本列，last-write-wins）；
 * - building_type 枚举治理在服务层（`asset.building_type_unknown` 422，非通用码）。
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import {
  BUILDING_TYPES,
  type Building,
  type BuildingCreate,
  type BuildingListQuery,
  type BuildingListResponse,
  type BuildingUpdate,
} from '@thermio/shared-types';
import { TENANT_DB } from '../infrastructure/db/db.tokens.js';
import type { TenantDb } from '../infrastructure/db/tenant-db.js';
import { LOGGER } from '../infrastructure/logger.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import {
  BUILDING_KEYSET_COLUMNS,
  decodeAssetCursor,
  encodeAssetCursor,
  isMicrosecondKey,
  keysetPredicate,
} from './asset-cursor.js';
import {
  assertBuildingInScope,
  isoOrNull,
  loadBuildingScope,
  numericToNumber,
  requireRow,
  type AssetActor,
} from './asset-shared.js';

/** pg 行（numeric 以 string 返回；timestamptz 为 Date）。 */
interface BuildingRow {
  id: string;
  name: string;
  address: string | null;
  geo_lat: string | null;
  geo_lon: string | null;
  building_type: string | null;
  gross_area_m2: string | null;
  climate_zone: string | null;
  created_at: Date;
  /** 排序键投影：epoch 微秒字符串（keyset 游标专用）。 */
  created_at_us: string;
}

const SELECT_COLUMNS = `b.id, b.name, b.address, b.geo_lat, b.geo_lon, b.building_type,
       b.gross_area_m2, b.climate_zone, b.created_at,
       ((extract(epoch FROM b.created_at) * 1000000)::bigint)::text AS created_at_us`;

/** INSERT/UPDATE RETURNING 投影（裸列名 + 同款 created_at_us 计算列）。 */
const RETURNING_COLUMNS = `id, name, address, geo_lat, geo_lon, building_type,
       gross_area_m2, climate_zone, created_at,
       ((extract(epoch FROM created_at) * 1000000)::bigint)::text AS created_at_us`;

@Injectable()
export class BuildingsService {
  constructor(
    @Inject(TENANT_DB) private readonly tenantDb: TenantDb | null,
    @Inject(LOGGER) rootLogger: Logger,
  ) {
    this.logger = rootLogger.child({ component: 'asset-buildings' });
  }

  private readonly logger: Logger;

  /** GET /buildings（?keyword&limit&cursor；(created_at,id) 升序）。 */
  async list(actor: AssetActor, query: BuildingListQuery): Promise<BuildingListResponse> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const scope = await loadBuildingScope(tx, actor);
      const where: string[] = ['b.tenant_id = $1'];
      const params: unknown[] = [actor.tenant_id];
      let next = 2;
      if (scope !== null) {
        where.push(`b.id = ANY($${String(next)}::uuid[])`);
        params.push([...scope]);
        next += 1;
      }
      if (query.keyword !== undefined) {
        where.push(
          `(b.name ILIKE $${String(next)}::text OR b.address ILIKE $${String(next)}::text)`,
        );
        params.push(`%${escapeLike(query.keyword.trim())}%`);
        next += 1;
      }
      if (query.cursor !== undefined) {
        const cursor = decodeAssetCursor(query.cursor, 1);
        if (!isMicrosecondKey(cursor.k[0] ?? '')) throw invalidCursor();
        const predicate = keysetPredicate(BUILDING_KEYSET_COLUMNS, cursor, next, ['::bigint', '']);
        where.push(predicate.sql);
        params.push(...predicate.params);
        next += 2;
      }
      const result = await tx.query<BuildingRow>(
        `SELECT ${SELECT_COLUMNS}
         FROM building b
         WHERE ${where.join(' AND ')}
         ORDER BY b.created_at ASC, b.id ASC
         LIMIT ${String(query.limit + 1)}`,
        params,
      );
      return pageOf(result.rows, query.limit);
    });
  }

  /** POST /buildings（201 完整实体，API-DSN-06）。 */
  async create(actor: AssetActor, body: BuildingCreate): Promise<Building> {
    assertBuildingTypeKnown(body.building_type ?? null);
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const row = await tx.query<BuildingRow>(
        `INSERT INTO building (tenant_id, name, address, geo_lat, geo_lon, building_type,
                               gross_area_m2, climate_zone)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${RETURNING_COLUMNS}`,
        [
          actor.tenant_id,
          body.name,
          body.address ?? null,
          body.geo_lat ?? null,
          body.geo_lon ?? null,
          body.building_type ?? null,
          body.gross_area_m2 ?? null,
          body.climate_zone ?? null,
        ],
      );
      this.logger.info({
        msg: 'building_created',
        tenant_id: actor.tenant_id,
        actor: actor.user_id,
        building_id: row.rows[0]?.id,
      });
      return toBuilding(requireRow(row.rows, 'building INSERT'));
    });
  }

  /** GET /buildings/{id}（load-for-user：越权与不存在同 404）。 */
  async get(actor: AssetActor, buildingId: string): Promise<Building> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const row = await loadBuilding(tx, actor, buildingId);
      return toBuilding(row);
    });
  }

  /** PATCH /buildings/{id}（last-write-wins，R4）。 */
  async update(actor: AssetActor, buildingId: string, body: BuildingUpdate): Promise<Building> {
    assertBuildingTypeKnown(body.building_type ?? null);
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      await loadBuilding(tx, actor, buildingId);
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const [field, value] of Object.entries(body)) {
        params.push(value ?? null);
        sets.push(`${field} = $${String(params.length)}`);
      }
      params.push(actor.tenant_id, buildingId);
      const result = await tx.query<BuildingRow>(
        `UPDATE building SET ${sets.join(', ')}
         WHERE tenant_id = $${String(params.length - 1)} AND id = $${String(params.length)}
         RETURNING ${RETURNING_COLUMNS}`,
        params,
      );
      this.logger.info({
        msg: 'building_updated',
        tenant_id: actor.tenant_id,
        actor: actor.user_id,
        building_id: buildingId,
        fields: Object.keys(body),
      });
      return toBuilding(requireRow(result.rows, 'building UPDATE'));
    });
  }

  private requireDb(): TenantDb {
    if (this.tenantDb === null) {
      throw new ReasonCodeException('common.internal_error', '资产域未接线');
    }
    return this.tenantDb;
  }
}

/** load-for-user 读单行：RLS 可见 + 楼宇归属校验，两道都不过 → 同一 404。 */
export async function loadBuilding(
  tx: Parameters<Parameters<TenantDb['withTenant']>[1]>[0],
  actor: AssetActor,
  buildingId: string,
): Promise<BuildingRow> {
  const result = await tx.query<BuildingRow>(
    `SELECT ${SELECT_COLUMNS} FROM building b WHERE b.tenant_id = $1 AND b.id = $2`,
    [actor.tenant_id, buildingId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ReasonCodeException('asset.not_found', '资源不存在', { entity: 'building' });
  }
  const scope = await loadBuildingScope(tx, actor);
  assertBuildingInScope(scope, buildingId);
  return row;
}

export function toBuilding(row: BuildingRow): Building {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    geo_lat: numericToNumber(row.geo_lat),
    geo_lon: numericToNumber(row.geo_lon),
    building_type: (row.building_type ?? null) as Building['building_type'],
    gross_area_m2: numericToNumber(row.gross_area_m2),
    climate_zone: row.climate_zone,
    created_at: isoOrNull(row.created_at) ?? '',
  };
}

function assertBuildingTypeKnown(value: string | null): void {
  if (value !== null && !(BUILDING_TYPES as readonly string[]).includes(value)) {
    throw new ReasonCodeException('asset.building_type_unknown', '楼宇类型不在受支持清单', {
      field: 'building_type',
    });
  }
}

/** limit+1 探测分页（users.service 同款：探测行只决定有无下一页）。 */
function pageOf(rows: BuildingRow[], limit: number): BuildingListResponse {
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const lastRow = page.at(-1);
  return {
    items: page.map(toBuilding),
    next_cursor:
      hasMore && lastRow !== undefined
        ? encodeAssetCursor({ k: [lastRow.created_at_us], id: lastRow.id })
        : null,
  };
}

function escapeLike(value: string): string {
  return value.replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function invalidCursor(): ReasonCodeException {
  return new ReasonCodeException('common.validation_failed', '游标不合法或已过期', {
    field: 'cursor',
  });
}
