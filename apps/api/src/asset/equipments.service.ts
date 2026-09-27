/**
 * 设备服务（modules M1-asset §3.3）：系统下设备列表 + CRUD。
 *
 * 纪律落点：
 * - 父系统 load-for-user（经 loadSystem 的楼宇归属校验链）；
 * - local_id 同系统唯一 → `asset.local_id_duplicate` 409（**应用层校验**——DDL 无
 *   唯一约束（R3 提案补 partial unique index，MVP 不动 DDL），竞态窗口蓝本已accept）；
 * - equipment_type 枚举治理在服务层（`asset.equipment_type_unknown` 422）；
 * - rated_params 自由结构（≤16KB，zod 已校验）原样透传 jsonb；
 * - DDL 无 created_at（R9）：排序键 (equipment_type, name, id)。
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { PoolClient } from 'pg';
import {
  EQUIPMENT_TYPES,
  type Equipment,
  type EquipmentCreate,
  type EquipmentListQuery,
  type EquipmentListResponse,
  type EquipmentUpdate,
} from '@thermio/shared-types';
import { TENANT_DB } from '../infrastructure/db/db.tokens.js';
import type { TenantDb } from '../infrastructure/db/tenant-db.js';
import { LOGGER } from '../infrastructure/logger.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import {
  EQUIPMENT_KEYSET_COLUMNS,
  decodeAssetCursor,
  encodeAssetCursor,
  keysetPredicate,
} from './asset-cursor.js';
import { loadSystem } from './systems.service.js';
import { requireRow, type AssetActor } from './asset-shared.js';

interface EquipmentRow {
  id: string;
  system_id: string;
  equipment_type: string;
  name: string;
  local_id: string | null;
  vendor_model: string | null;
  rated_params: Record<string, unknown> | null;
  commission_date: string | null;
}

const SELECT_COLUMNS = `e.id, e.system_id, e.equipment_type, e.name, e.local_id,
       e.vendor_model, e.rated_params, e.commission_date`;

@Injectable()
export class EquipmentsService {
  constructor(
    @Inject(TENANT_DB) private readonly tenantDb: TenantDb | null,
    @Inject(LOGGER) rootLogger: Logger,
  ) {
    this.logger = rootLogger.child({ component: 'asset-equipments' });
  }

  private readonly logger: Logger;

  /** GET /systems/{system_id}/equipments（(equipment_type,name,id) 升序）。 */
  async listBySystem(
    actor: AssetActor,
    systemId: string,
    query: EquipmentListQuery,
  ): Promise<EquipmentListResponse> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      await loadSystem(tx, actor, systemId);
      const where: string[] = ['e.tenant_id = $1', 'e.system_id = $2'];
      const params: unknown[] = [actor.tenant_id, systemId];
      let next = 3;
      if (query.equipment_type !== undefined) {
        where.push(`e.equipment_type = $${String(next)}::text`);
        params.push(query.equipment_type);
        next += 1;
      }
      if (query.cursor !== undefined) {
        const cursor = decodeAssetCursor(query.cursor, 2);
        const predicate = keysetPredicate(EQUIPMENT_KEYSET_COLUMNS, cursor, next, ['', '', '']);
        where.push(predicate.sql);
        params.push(...predicate.params);
        next += 3;
      }
      const result = await tx.query<EquipmentRow>(
        `SELECT ${SELECT_COLUMNS}
         FROM equipment e
         WHERE ${where.join(' AND ')}
         ORDER BY e.equipment_type ASC, e.name ASC, e.id ASC
         LIMIT ${String(query.limit + 1)}`,
        params,
      );
      const page = result.rows.slice(0, query.limit);
      const hasMore = result.rows.length > query.limit;
      const lastRow = page.at(-1);
      return {
        items: page.map(toEquipment),
        next_cursor:
          hasMore && lastRow !== undefined
            ? encodeAssetCursor({ k: [lastRow.equipment_type, lastRow.name], id: lastRow.id })
            : null,
      };
    });
  }

  /** POST /equipments（201）。 */
  async create(actor: AssetActor, body: EquipmentCreate): Promise<Equipment> {
    assertEquipmentTypeKnown(body.equipment_type);
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      await loadSystem(tx, actor, body.system_id);
      if (body.local_id != null)
        await assertLocalIdFree(tx, actor.tenant_id, body.system_id, body.local_id);
      const result = await tx.query<EquipmentRow>(
        `INSERT INTO equipment (tenant_id, system_id, equipment_type, name, local_id,
                                vendor_model, rated_params, commission_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${SELECT_COLUMNS.replace(/\be\./g, '')}`,
        [
          actor.tenant_id,
          body.system_id,
          body.equipment_type,
          body.name,
          body.local_id ?? null,
          body.vendor_model ?? null,
          body.rated_params ?? null,
          body.commission_date ?? null,
        ],
      );
      this.logger.info({
        msg: 'equipment_created',
        tenant_id: actor.tenant_id,
        actor: actor.user_id,
        system_id: body.system_id,
        equipment_id: requireRow(result.rows, 'equipment INSERT').id,
      });
      return toEquipment(requireRow(result.rows, 'equipment'));
    });
  }

  /** GET /equipments/{id}。 */
  async get(actor: AssetActor, equipmentId: string): Promise<Equipment> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      return toEquipment(await loadEquipment(tx, actor, equipmentId));
    });
  }

  /** PATCH /equipments/{id}（system 不可迁移——UpdateSchema 无该键）。 */
  async update(actor: AssetActor, equipmentId: string, body: EquipmentUpdate): Promise<Equipment> {
    if (body.equipment_type !== undefined) assertEquipmentTypeKnown(body.equipment_type);
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const existing = await loadEquipment(tx, actor, equipmentId);
      if (body.local_id != null && body.local_id !== existing.local_id) {
        await assertLocalIdFree(tx, actor.tenant_id, existing.system_id, body.local_id);
      }
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const [field, value] of Object.entries(body)) {
        params.push(value ?? null);
        sets.push(`${field} = $${String(params.length)}`);
      }
      params.push(actor.tenant_id, equipmentId);
      const result = await tx.query<EquipmentRow>(
        `UPDATE equipment SET ${sets.join(', ')}
         WHERE tenant_id = $${String(params.length - 1)} AND id = $${String(params.length)}
         RETURNING ${SELECT_COLUMNS.replace(/\be\./g, '')}`,
        params,
      );
      this.logger.info({
        msg: 'equipment_updated',
        tenant_id: actor.tenant_id,
        actor: actor.user_id,
        equipment_id: equipmentId,
        fields: Object.keys(body),
      });
      return toEquipment(requireRow(result.rows, 'equipment'));
    });
  }

  private requireDb(): TenantDb {
    if (this.tenantDb === null) {
      throw new ReasonCodeException('common.internal_error', '资产域未接线');
    }
    return this.tenantDb;
  }
}

/** load-for-user 读单行（points 域复用：父链归属校验）。 */
export async function loadEquipment(
  tx: PoolClient,
  actor: AssetActor,
  equipmentId: string,
): Promise<EquipmentRow> {
  const result = await tx.query<EquipmentRow>(
    `SELECT ${SELECT_COLUMNS} FROM equipment e
     JOIN hvac_system s ON s.tenant_id = e.tenant_id AND s.id = e.system_id
     WHERE e.tenant_id = $1 AND e.id = $2`,
    [actor.tenant_id, equipmentId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ReasonCodeException('asset.not_found', '资源不存在', { entity: 'equipment' });
  }
  // 复用 loadSystem 的楼宇归属校验（equipment 经 system 链推导楼宇）
  await loadSystem(tx, actor, row.system_id);
  return row;
}

export function toEquipment(row: EquipmentRow): Equipment {
  return {
    id: row.id,
    system_id: row.system_id,
    equipment_type: row.equipment_type as Equipment['equipment_type'],
    name: row.name,
    local_id: row.local_id,
    vendor_model: row.vendor_model,
    rated_params: row.rated_params,
    commission_date: row.commission_date,
  };
}

function assertEquipmentTypeKnown(value: string): void {
  if (!(EQUIPMENT_TYPES as readonly string[]).includes(value)) {
    throw new ReasonCodeException('asset.equipment_type_unknown', '设备类型不在受支持清单', {
      field: 'equipment_type',
    });
  }
}

/** 同系统 local_id 占用检查（应用层校验，R3：DDL 无唯一索引，竞态窗口已accept）。 */
async function assertLocalIdFree(
  tx: PoolClient,
  tenantId: string,
  systemId: string,
  localId: string,
): Promise<void> {
  const result = await tx.query(
    `SELECT 1 FROM equipment WHERE tenant_id = $1 AND system_id = $2 AND local_id = $3`,
    [tenantId, systemId, localId],
  );
  if (result.rows.length > 0) {
    throw new ReasonCodeException('asset.local_id_duplicate', '同系统内现场编号已存在', {
      system_id: systemId,
      local_id: localId,
    });
  }
}
