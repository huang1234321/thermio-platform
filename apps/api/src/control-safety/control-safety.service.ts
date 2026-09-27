/**
 * M8 控制安全业务面（M8-safety-ui.md §2–§6，IMPL-18 / DAT-164）。
 *
 * - 清单行实体（§2.2）：point 闸门字段 + 资产链 + system_fuse 联动位（§10-U2：
 *   列表查询 join control_fuse）；
 * - 闸门编辑（§4）：服务端复核三码 + C1 逐字段 config_audit（仅变更字段落行，
 *   同事务）；R8 语义扩展——is_controllable=true 时频率上限必填（GATE_RATE_INVALID）；
 * - 模式切换（§5）：前进一档（跳档拒绝 cause=skip）/ 回退跨档自由；supervised/
 *   auto 前提点位已入白名单；熔断期间前进封锁（cause=fuse_open〔R6〕）；C2 落档；
 * - 变更历史（§6）：field/actor_type/时间窗 + at DESC keyset 分页。
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { PoolClient } from 'pg';
import {
  type ConfigAuditItem,
  type ConfigAuditListQuery,
  type ConfigAuditListResponse,
  type ControlMode,
  type ControlModeChangeRequest,
  type ControlModeChangeResponse,
  type ControlPointItem,
  type ControlPointsListQuery,
  type ControlPointsListResponse,
  type GatePatchRequest,
  type GatePatchResponse,
} from '@thermio/shared-types';
import { LOGGER } from '../infrastructure/logger.js';
import { TENANT_DB } from '../infrastructure/db/db.tokens.js';
import type { TenantDb } from '../infrastructure/db/tenant-db.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { loadBuildingScope, type AssetActor } from '../asset/asset-shared.js';

/** 模式前进序（flows.md §5 状态机：advisory → supervised → auto，一次一档）。 */
const MODE_RANK: Readonly<Record<ControlMode, number>> = { advisory: 0, supervised: 1, auto: 2 };

interface PointGateRow {
  readonly point_id: string;
  readonly building_id: string;
  readonly raw_name: string;
  readonly display_name: string | null;
  readonly quantity_type: string | null;
  readonly unit_std: string | null;
  readonly equipment_id: string | null;
  readonly equipment_name: string | null;
  readonly equipment_type: string | null;
  readonly system_id: string | null;
  readonly system_name: string | null;
  readonly system_type: string | null;
  readonly is_controllable: boolean;
  readonly clamp_min: string | null;
  readonly clamp_max: string | null;
  readonly write_rate_limit_per_hour: number | null;
  readonly control_mode: string;
  readonly point_status: string;
  readonly direction: string;
  readonly valid_range_min: string | null;
  readonly valid_range_max: string | null;
  readonly created_at: Date;
  readonly fuse_status: string | null;
}

const POINT_SELECT = `
  pt.id AS point_id, pt.building_id, pt.raw_name, pt.display_name,
  pt.quantity_type, pt.unit_std,
  eq.id AS equipment_id, eq.name AS equipment_name, eq.equipment_type,
  sy.id AS system_id, sy.name AS system_name, sy.system_type,
  pt.is_controllable, pt.clamp_min, pt.clamp_max, pt.write_rate_limit_per_hour,
  pt.control_mode, pt.status AS point_status, pt.direction,
  pt.valid_range_min, pt.valid_range_max, pt.created_at,
  cf.status AS fuse_status
  FROM point pt
  LEFT JOIN equipment eq ON eq.tenant_id = pt.tenant_id AND eq.id = pt.equipment_id
  LEFT JOIN hvac_system sy ON sy.tenant_id = eq.tenant_id AND sy.id = eq.system_id
  LEFT JOIN control_fuse cf ON cf.tenant_id = sy.tenant_id AND cf.system_id = sy.id
`;

function num(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function itemOf(row: PointGateRow): ControlPointItem {
  return {
    point_id: Number(row.point_id),
    raw_name: row.raw_name,
    display_name: row.display_name,
    quantity_type: row.quantity_type,
    unit_std: row.unit_std,
    equipment:
      row.equipment_id !== null
        ? {
            id: row.equipment_id,
            name: row.equipment_name ?? row.equipment_id,
            equipment_type: row.equipment_type ?? 'unknown',
          }
        : null,
    system:
      row.system_id !== null
        ? {
            id: row.system_id,
            name: row.system_name ?? row.system_id,
            system_type: row.system_type ?? 'unknown',
          }
        : null,
    building_id: row.building_id,
    gate: {
      is_controllable: row.is_controllable,
      clamp_min: num(row.clamp_min),
      clamp_max: num(row.clamp_max),
      write_rate_limit_per_hour: row.write_rate_limit_per_hour,
    },
    control_mode: row.control_mode as ControlMode,
    point_status: row.point_status as 'active' | 'disabled',
    direction: row.direction as ControlPointItem['direction'],
    system_fuse: (row.fuse_status ?? 'closed') as 'closed' | 'open',
  };
}

@Injectable()
export class ControlSafetyService {
  private readonly logger: Logger;

  constructor(
    @Inject(LOGGER) rootLogger: Logger,
    @Inject(TENANT_DB) private readonly tenantDb: TenantDb | null,
  ) {
    this.logger = rootLogger.child({ component: 'control-safety-m8' });
  }

  // -------------------------------------------------------------------
  // GET /control/points（§3 清单页数据源）
  // -------------------------------------------------------------------
  async listPoints(
    actor: AssetActor,
    query: ControlPointsListQuery,
  ): Promise<ControlPointsListResponse> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const scope = await loadBuildingScope(tx, actor);
      const where: string[] = ['1=1'];
      const params: unknown[] = [];
      if (scope !== null) {
        params.push([...scope]);
        where.push(`pt.building_id = ANY($${String(params.length)}::uuid[])`);
      }
      if (query.building_id !== undefined) {
        params.push(query.building_id);
        where.push(`pt.building_id = $${String(params.length)}::uuid`);
      }
      if (query.system_id !== undefined) {
        params.push(query.system_id);
        where.push(`sy.id = $${String(params.length)}::uuid`);
      }
      if (query.equipment_id !== undefined) {
        params.push(query.equipment_id);
        where.push(`eq.id = $${String(params.length)}::uuid`);
      }
      if (query.control_mode !== undefined) {
        params.push(query.control_mode);
        where.push(`pt.control_mode = $${String(params.length)}::text`);
      }
      if (query.is_controllable !== undefined) {
        params.push(query.is_controllable);
        where.push(`pt.is_controllable = $${String(params.length)}::boolean`);
      }
      if (query.keyword !== undefined && query.keyword.length > 0) {
        params.push(`${query.keyword}%`);
        where.push(
          `(pt.raw_name ILIKE $${String(params.length)} OR pt.display_name ILIKE $${String(params.length)})`,
        );
      }
      const limit = query.limit;
      if (query.cursor !== undefined) {
        params.push(query.cursor);
        where.push(`pt.created_at < $${String(params.length)}::timestamptz`);
      }
      params.push(limit + 1);
      const rows = await tx.query<PointGateRow>(
        `SELECT ${POINT_SELECT}
         WHERE ${where.join(' AND ')}
         ORDER BY pt.created_at DESC, pt.id DESC
         LIMIT $${String(params.length)}`,
        params,
      );
      const items = rows.rows.slice(0, limit).map(itemOf);
      const last = rows.rows[limit - 1];
      return {
        items,
        next_cursor:
          rows.rows.length > limit && last !== undefined ? last.created_at.toISOString() : null,
      };
    });
  }

  // -------------------------------------------------------------------
  // PATCH /points/{id}/gate（§4 闸门参数编辑 + C1 审计）
  // -------------------------------------------------------------------
  async patchGate(
    actor: AssetActor,
    pointId: number,
    body: GatePatchRequest,
  ): Promise<GatePatchResponse> {
    if (body.reason.trim().length === 0) {
      throw new ReasonCodeException('point.gate_reason_required', '变更原因必填', {
        field: 'reason',
      });
    }
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const scope = await loadBuildingScope(tx, actor);
      const row = await this.loadPointForUser(tx, actor.tenant_id, pointId, scope);

      // ── 服务端复核（§4.1 表；overview §4 M8 码）──
      const next = {
        is_controllable: body.is_controllable ?? row.is_controllable,
        clamp_min: body.clamp_min !== undefined ? body.clamp_min : num(row.clamp_min),
        clamp_max: body.clamp_max !== undefined ? body.clamp_max : num(row.clamp_max),
        write_rate_limit_per_hour:
          body.write_rate_limit_per_hour !== undefined
            ? body.write_rate_limit_per_hour
            : row.write_rate_limit_per_hour,
      };
      // GATE_CLAMP_RANGE_INVALID：min ≥ max 或与 valid_range 矛盾（双侧同现才判矛盾）
      if (next.clamp_min !== null && next.clamp_max !== null && next.clamp_min >= next.clamp_max) {
        throw new ReasonCodeException(
          'point.gate_clamp_range_invalid',
          'clamp_min 必须小于 clamp_max',
          {
            field: 'clamp_min',
          },
        );
      }
      const validMin = num(row.valid_range_min);
      const validMax = num(row.valid_range_max);
      if (
        (next.clamp_min !== null && validMax !== null && next.clamp_min > validMax) ||
        (next.clamp_max !== null && validMin !== null && next.clamp_max < validMin) ||
        (next.clamp_max !== null && validMax !== null && next.clamp_max > validMax) ||
        (next.clamp_min !== null && validMin !== null && next.clamp_min < validMin)
      ) {
        throw new ReasonCodeException(
          'point.gate_clamp_range_invalid',
          '值域与数据质量判据范围（valid_range）矛盾',
          {
            field: 'clamp',
            valid_range: { min: validMin, max: validMax },
          },
        );
      }
      // GATE_CONTROLLABLE_REQUIRES_CLAMP：开白名单必须先有值域
      if (next.is_controllable && (next.clamp_min === null || next.clamp_max === null)) {
        throw new ReasonCodeException(
          'point.gate_controllable_requires_clamp',
          '开启白名单必须先配置值域',
          {
            field: 'clamp_min',
          },
        );
      }
      // GATE_RATE_INVALID（R8 语义扩展〔DAT-132〕）：可控点必填频率上限
      if (next.is_controllable && next.write_rate_limit_per_hour === null) {
        throw new ReasonCodeException(
          'point.gate_rate_invalid',
          '可控点必须配置频率上限（write_rate_limit_per_hour）',
          {
            field: 'write_rate_limit_per_hour',
            hint: '列空时运行时兜底默认 6 次/h，但可控点登记必须显式（control-safety §3.3〔R8〕）',
          },
        );
      }

      // ── 落库 + C1 逐字段 config_audit（仅变更字段；同事务）──
      await tx.query(
        `UPDATE point
           SET is_controllable = $3, clamp_min = $4, clamp_max = $5,
               write_rate_limit_per_hour = $6, updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [
          actor.tenant_id,
          pointId,
          next.is_controllable,
          next.clamp_min,
          next.clamp_max,
          next.write_rate_limit_per_hour,
        ],
      );
      const auditIds: number[] = [];
      const changes: Array<[string, unknown, unknown]> = [
        ['is_controllable', row.is_controllable, next.is_controllable],
        ['clamp_min', num(row.clamp_min), next.clamp_min],
        ['clamp_max', num(row.clamp_max), next.clamp_max],
        [
          'write_rate_limit_per_hour',
          row.write_rate_limit_per_hour,
          next.write_rate_limit_per_hour,
        ],
      ];
      for (const [field, oldValue, newValue] of changes) {
        if (oldValue === newValue) continue;
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO config_audit
             (tenant_id, point_id, field, old_value, new_value, actor_type, actor_ref, reason)
           VALUES ($1, $2, $3, $4, $5, 'human', $6, $7) RETURNING id`,
          [
            actor.tenant_id,
            pointId,
            field,
            JSON.stringify(oldValue ?? null),
            JSON.stringify(newValue ?? null),
            actor.user_id,
            body.reason,
          ],
        );
        auditIds.push(Number(inserted.rows[0]?.id));
      }
      const fresh = await this.loadPointRow(tx, actor.tenant_id, pointId);
      return { point: itemOf(fresh), config_audit_ids: auditIds };
    });
  }

  // -------------------------------------------------------------------
  // POST /points/{id}/control-mode（§5 模式切换 + C2 审计）
  // -------------------------------------------------------------------
  async changeMode(
    actor: ActorForMode,
    pointId: number,
    body: ControlModeChangeRequest,
  ): Promise<ControlModeChangeResponse> {
    if (body.reason.trim().length === 0) {
      throw new ReasonCodeException('point.gate_reason_required', '变更原因必填', {
        field: 'reason',
      });
    }
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const scope = await loadBuildingScope(tx, actor);
      const row = await this.loadPointForUser(tx, actor.tenant_id, pointId, scope);
      const current = row.control_mode as ControlMode;
      const target = body.target_mode;

      if (target === current) {
        throw new ReasonCodeException('point.control_mode_same', '目标模式与当前模式相同', {
          current_mode: current,
          target_mode: target,
        });
      }
      // CONTROL_MODE_POINT_NOT_CONTROLLABLE：supervised/auto 前提（overview M8）
      if (target !== 'advisory' && !row.is_controllable) {
        throw new ReasonCodeException(
          'point.control_mode_point_not_controllable',
          'supervised/auto 前提：点位已入受控白名单',
          {
            current_mode: current,
            target_mode: target,
          },
        );
      }
      // 前进方向判定：跳档拒绝（cause=skip）；熔断期间前进封锁（cause=fuse_open〔R6〕）
      if (MODE_RANK[target] > MODE_RANK[current]) {
        if (MODE_RANK[target] - MODE_RANK[current] > 1) {
          throw new ReasonCodeException(
            'point.control_mode_transition_invalid',
            '一次只能前进一档',
            {
              current_mode: current,
              target_mode: target,
              cause: 'skip',
            },
          );
        }
        if (row.fuse_status === 'open') {
          throw new ReasonCodeException(
            'point.control_mode_transition_invalid',
            '系统熔断中：前进已被封锁（解除后仍需逐档前进）',
            {
              current_mode: current,
              target_mode: target,
              cause: 'fuse_open',
            },
          );
        }
      }

      await tx.query(
        `UPDATE point SET control_mode = $3, updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [actor.tenant_id, pointId, target],
      );
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO config_audit
           (tenant_id, point_id, field, old_value, new_value, actor_type, actor_ref, reason)
         VALUES ($1, $2, 'control_mode', $3, $4, 'human', $5, $6) RETURNING id`,
        [
          actor.tenant_id,
          pointId,
          JSON.stringify(current),
          JSON.stringify(target),
          actor.user_id,
          body.reason,
        ],
      );
      const fresh = await this.loadPointRow(tx, actor.tenant_id, pointId);
      return { point: itemOf(fresh), config_audit_id: Number(inserted.rows[0]?.id) };
    });
  }

  // -------------------------------------------------------------------
  // GET /config-audit（§6 变更历史检索）
  // -------------------------------------------------------------------
  async configAudit(
    actor: AssetActor,
    query: ConfigAuditListQuery,
  ): Promise<ConfigAuditListResponse> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const scope = await loadBuildingScope(tx, actor);
      const where: string[] = ['ca.tenant_id = $1'];
      const params: unknown[] = [actor.tenant_id];
      if (scope !== null) {
        params.push([...scope]);
        where.push(`pt.building_id = ANY($${String(params.length)}::uuid[])`);
      }
      if (query.point_id !== undefined) {
        params.push(query.point_id);
        where.push(`ca.point_id = $${String(params.length)}::bigint`);
      }
      if (query.field !== undefined) {
        params.push(query.field);
        where.push(`ca.field = $${String(params.length)}::text`);
      }
      if (query.actor_type !== undefined) {
        params.push(query.actor_type);
        where.push(`ca.actor_type = $${String(params.length)}::text`);
      }
      if (query.from !== undefined) {
        params.push(query.from);
        where.push(`ca.at >= $${String(params.length)}::timestamptz`);
      }
      if (query.to !== undefined) {
        params.push(query.to);
        where.push(`ca.at <= $${String(params.length)}::timestamptz`);
      }
      if (query.cursor !== undefined) {
        params.push(query.cursor);
        where.push(`ca.at < $${String(params.length)}::timestamptz`);
      }
      params.push(query.limit + 1);
      const rows = await tx.query<ConfigAuditRow>(
        `SELECT ca.id, ca.point_id, ca.field, ca.old_value, ca.new_value,
                ca.actor_type, ca.actor_ref, ca.reason, ca.at,
                pt.raw_name AS point_raw_name, pt.display_name AS point_display_name,
                au.display_name AS actor_name
         FROM config_audit ca
         JOIN point pt ON pt.tenant_id = ca.tenant_id AND pt.id = ca.point_id
         LEFT JOIN app_user au ON au.tenant_id = ca.tenant_id AND au.id::text = ca.actor_ref
         WHERE ${where.join(' AND ')}
         ORDER BY ca.at DESC, ca.id DESC
         LIMIT $${String(params.length)}`,
        params,
      );
      const items = rows.rows.slice(0, query.limit).map(configAuditItemOf);
      const last = rows.rows[query.limit - 1];
      return {
        items,
        next_cursor:
          rows.rows.length > query.limit && last !== undefined ? last.at.toISOString() : null,
      };
    });
  }

  // -------------------------------------------------------------------
  // 共享件
  // -------------------------------------------------------------------

  private async loadPointRow(
    tx: PoolClient,
    tenantId: string,
    pointId: number,
  ): Promise<PointGateRow> {
    const result = await tx.query<PointGateRow>(
      `SELECT ${POINT_SELECT} WHERE pt.tenant_id = $1 AND pt.id = $2`,
      [tenantId, pointId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new ReasonCodeException('asset.not_found', '资源不存在', { entity: 'point' });
    }
    return row;
  }

  /** load-for-user（SEC-AZ-02/03：不存在/越租户/越楼宇同 404）。 */
  private async loadPointForUser(
    tx: PoolClient,
    tenantId: string,
    pointId: number,
    scope: Set<string> | null,
  ): Promise<PointGateRow> {
    const row = await this.loadPointRow(tx, tenantId, pointId);
    if (scope !== null && !scope.has(row.building_id)) {
      throw new ReasonCodeException('asset.not_found', '资源不存在', { entity: 'point' });
    }
    return row;
  }

  private requireDb(): TenantDb {
    if (this.tenantDb === null)
      throw new ReasonCodeException('common.internal_error', '数据库未接线');
    return this.tenantDb;
  }
}

interface ConfigAuditRow {
  readonly id: string;
  readonly point_id: string;
  readonly field: ConfigAuditItem['field'];
  readonly old_value: unknown;
  readonly new_value: unknown;
  readonly actor_type: 'human' | 'system';
  readonly actor_ref: string | null;
  readonly reason: string | null;
  readonly at: Date;
  readonly point_raw_name: string;
  readonly point_display_name: string | null;
  readonly actor_name: string | null;
}

function configAuditItemOf(row: ConfigAuditRow): ConfigAuditItem {
  return {
    id: Number(row.id),
    point_id: Number(row.point_id),
    point_raw_name: row.point_raw_name,
    point_display_name: row.point_display_name,
    field: row.field,
    old_value: row.old_value ?? null,
    new_value: row.new_value ?? null,
    actor_type: row.actor_type,
    actor_ref: row.actor_ref,
    actor_name: row.actor_name,
    reason: row.reason,
    at: row.at.toISOString(),
  };
}

type ActorForMode = AssetActor;
