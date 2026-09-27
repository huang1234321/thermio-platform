/**
 * 系统服务（modules M1-asset §3.2）：楼宇下系统列表 + CRUD。
 *
 * 纪律落点：
 * - 父楼宇 load-for-user（越权/不存在 → 404 `asset.not_found` 同文案）；
 * - building_id 不可迁移（§2.2 更新写入 ✗——UpdateSchema 无该键）；
 * - system_type 枚举治理在服务层（`asset.system_type_unknown` 422）；改型是档案纠错，
 *   影响 FDD 匹配由变更者负责（§2.2 注记）；
 * - DDL 无 created_at（R9）：排序键 (system_type, name, id)。
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import {
  SYSTEM_TYPES,
  type HvacSystem,
  type SystemCreate,
  type SystemListQuery,
  type SystemListResponse,
  type SystemUpdate,
} from '@thermio/shared-types';
import { TENANT_DB } from '../infrastructure/db/db.tokens.js';
import type { TenantDb } from '../infrastructure/db/tenant-db.js';
import { LOGGER } from '../infrastructure/logger.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import {
  SYSTEM_KEYSET_COLUMNS,
  decodeAssetCursor,
  encodeAssetCursor,
  keysetPredicate,
} from './asset-cursor.js';
import {
  loadBuildingScope,
  assertBuildingInScope,
  requireRow,
  type AssetActor,
} from './asset-shared.js';
import { loadBuilding } from './buildings.service.js';
import type { PoolClient } from 'pg';

interface SystemRow {
  id: string;
  building_id: string;
  system_type: string;
  name: string;
}

const SELECT_COLUMNS = 's.id, s.building_id, s.system_type, s.name';

@Injectable()
export class SystemsService {
  constructor(
    @Inject(TENANT_DB) private readonly tenantDb: TenantDb | null,
    @Inject(LOGGER) rootLogger: Logger,
  ) {
    this.logger = rootLogger.child({ component: 'asset-systems' });
  }

  private readonly logger: Logger;

  /** GET /buildings/{building_id}/systems（(system_type,name,id) 升序）。 */
  async listByBuilding(
    actor: AssetActor,
    buildingId: string,
    query: SystemListQuery,
  ): Promise<SystemListResponse> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      await loadBuilding(tx, actor, buildingId);
      const where: string[] = ['s.tenant_id = $1', 's.building_id = $2'];
      const params: unknown[] = [actor.tenant_id, buildingId];
      let next = 3;
      if (query.system_type !== undefined) {
        where.push(`s.system_type = $${String(next)}::text`);
        params.push(query.system_type);
        next += 1;
      }
      if (query.cursor !== undefined) {
        const cursor = decodeAssetCursor(query.cursor, 2);
        const predicate = keysetPredicate(SYSTEM_KEYSET_COLUMNS, cursor, next, ['', '', '']);
        where.push(predicate.sql);
        params.push(...predicate.params);
        next += 3;
      }
      const result = await tx.query<SystemRow>(
        `SELECT ${SELECT_COLUMNS}
         FROM hvac_system s
         WHERE ${where.join(' AND ')}
         ORDER BY s.system_type ASC, s.name ASC, s.id ASC
         LIMIT ${String(query.limit + 1)}`,
        params,
      );
      const page = result.rows.slice(0, query.limit);
      const hasMore = result.rows.length > query.limit;
      const lastRow = page.at(-1);
      return {
        items: page.map(toSystem),
        next_cursor:
          hasMore && lastRow !== undefined
            ? encodeAssetCursor({ k: [lastRow.system_type, lastRow.name], id: lastRow.id })
            : null,
      };
    });
  }

  /** POST /systems（201）。 */
  async create(actor: AssetActor, body: SystemCreate): Promise<HvacSystem> {
    assertSystemTypeKnown(body.system_type);
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      await loadBuilding(tx, actor, body.building_id);
      const result = await tx.query<SystemRow>(
        `INSERT INTO hvac_system (tenant_id, building_id, system_type, name)
         VALUES ($1, $2, $3, $4)
         RETURNING ${SELECT_COLUMNS.replace(/\bs\./g, '')}`,
        [actor.tenant_id, body.building_id, body.system_type, body.name],
      );
      this.logger.info({
        msg: 'system_created',
        tenant_id: actor.tenant_id,
        actor: actor.user_id,
        building_id: body.building_id,
        system_id: requireRow(result.rows, 'hvac_system INSERT').id,
      });
      return toSystem(requireRow(result.rows, 'hvac_system'));
    });
  }

  /** GET /systems/{id}。 */
  async get(actor: AssetActor, systemId: string): Promise<HvacSystem> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      return toSystem(await loadSystem(tx, actor, systemId));
    });
  }

  /** PATCH /systems/{id}（{name?, system_type?}；building 不可迁移）。 */
  async update(actor: AssetActor, systemId: string, body: SystemUpdate): Promise<HvacSystem> {
    if (body.system_type !== undefined) assertSystemTypeKnown(body.system_type);
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      await loadSystem(tx, actor, systemId);
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const [field, value] of Object.entries(body)) {
        params.push(value);
        sets.push(`${field} = $${String(params.length)}`);
      }
      params.push(actor.tenant_id, systemId);
      const result = await tx.query<SystemRow>(
        `UPDATE hvac_system SET ${sets.join(', ')}
         WHERE tenant_id = $${String(params.length - 1)} AND id = $${String(params.length)}
         RETURNING ${SELECT_COLUMNS.replace(/\bs\./g, '')}`,
        params,
      );
      this.logger.info({
        msg: 'system_updated',
        tenant_id: actor.tenant_id,
        actor: actor.user_id,
        system_id: systemId,
        fields: Object.keys(body),
      });
      return toSystem(requireRow(result.rows, 'hvac_system'));
    });
  }

  private requireDb(): TenantDb {
    if (this.tenantDb === null) {
      throw new ReasonCodeException('common.internal_error', '资产域未接线');
    }
    return this.tenantDb;
  }
}

/** load-for-user 读单行（points/equipments 复用：父链归属校验）。 */
export async function loadSystem(
  tx: PoolClient,
  actor: AssetActor,
  systemId: string,
): Promise<SystemRow> {
  const result = await tx.query<SystemRow>(
    `SELECT ${SELECT_COLUMNS} FROM hvac_system s WHERE s.tenant_id = $1 AND s.id = $2`,
    [actor.tenant_id, systemId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ReasonCodeException('asset.not_found', '资源不存在', { entity: 'system' });
  }
  const scope = await loadBuildingScope(tx, actor);
  assertBuildingInScope(scope, row.building_id);
  return row;
}

export function toSystem(row: SystemRow): HvacSystem {
  return {
    id: row.id,
    building_id: row.building_id,
    system_type: row.system_type as HvacSystem['system_type'],
    name: row.name,
  };
}

function assertSystemTypeKnown(value: string): void {
  if (!(SYSTEM_TYPES as readonly string[]).includes(value)) {
    throw new ReasonCodeException('asset.system_type_unknown', '系统类型不在受支持清单', {
      field: 'system_type',
    });
  }
}
