/**
 * 告警域共享件（IMPL-13，M4-alarm.md §2.3/§1.4）：
 * - 多态来源解析（point/equipment/system/gateway → name + building_id）四路 UNION
 *   （单租户单楼量级可承受，M4 §2.3 定夺；区域中心阶段重评）；
 * - AlarmEvent 行 → AlarmEventView 映射（含代表行/子计数/抑制摘要装配形状）；
 * - load-for-user 复用资产域 loadBuildingScope（同一 user_building_scope 语义）。
 */
import type { PoolClient } from 'pg';
import type {
  AlarmCategory,
  AlarmEventStatus,
  AlarmEventView,
  AlarmScope,
  AlarmSeverity,
} from '@thermio/shared-types';
import type { AssetActor } from '../asset/asset-shared.js';

export type AlarmActor = AssetActor;

/** §2.3 四路 UNION（$1 = tenant_id 参数位；name/building_id 供过滤与展示）。 */
export const SOURCE_UNION_SQL = `
  SELECT 'point' AS source_type, p.id::text AS source_id,
         coalesce(p.display_name, p.raw_name) AS name, p.building_id
    FROM point p WHERE p.tenant_id = $1
  UNION ALL
  SELECT 'equipment' AS source_type, e.id::text AS source_id, e.name AS name, s.building_id
    FROM equipment e
    JOIN hvac_system s ON s.tenant_id = e.tenant_id AND s.id = e.system_id
   WHERE e.tenant_id = $1
  UNION ALL
  SELECT 'system' AS source_type, s.id::text AS source_id, s.name AS name, s.building_id
    FROM hvac_system s WHERE s.tenant_id = $1
  UNION ALL
  SELECT 'gateway' AS source_type, g.id::text AS source_id, g.name AS name, g.building_id
    FROM gateway g WHERE g.tenant_id = $1`;

/** 列表/详情主查询的 alarm_event 投影（opened_at_us 为游标排序键）。 */
export const ALARM_SELECT_COLUMNS = `a.id, a.category, a.rule_id, a.source_type, a.source_id,
  a.severity, a.status, a.message, a.root_group_id, a.opened_at, a.acked_at, a.acked_by,
  a.closed_at, a.closed_by, a.close_reason,
  ((extract(epoch FROM a.opened_at) * 1000000)::bigint)::text AS opened_at_us`;

/** pg 行形状（bigint/numeric 以 string 返回）。 */
export interface AlarmEventRow {
  readonly id: string;
  readonly category: string;
  readonly rule_id: string | null;
  readonly source_type: string;
  readonly source_id: string;
  readonly severity: string;
  readonly status: string;
  readonly message: string;
  readonly root_group_id: string | null;
  readonly opened_at: Date;
  readonly acked_at: Date | null;
  readonly acked_by: string | null;
  readonly closed_at: Date | null;
  readonly closed_by: string | null;
  readonly close_reason: string | null;
  readonly opened_at_us: string;
}

export interface SourceResolveRow {
  readonly source_type: string;
  readonly source_id: string;
  readonly name: string | null;
  readonly building_id: string;
}

/** 单一来源解析（详情/规则目标校验用；不存在返回 null）。 */
export async function resolveSource(
  tx: PoolClient,
  tenantId: string,
  sourceType: string,
  sourceId: string,
): Promise<SourceResolveRow | null> {
  const result = await tx.query<SourceResolveRow>(
    `SELECT source_type, source_id, name, building_id FROM (${SOURCE_UNION_SQL}) src
     WHERE src.source_type = $2 AND src.source_id = $3`,
    [tenantId, sourceType, sourceId],
  );
  return result.rows[0] ?? null;
}

/**
 * 根因折叠可见性行（§3.1 折叠规则）：grp_root_id = 组内 MIN(id)（引擎保证根先于子，
 * §5.5）；root_status 供「根已 closed/suppressed → open/acked 子告警上浮」判定。
 */
export interface FoldRow extends AlarmEventRow {
  readonly source_name: string | null;
  readonly building_id: string | null;
  readonly grp_root_id: string | null;
  readonly root_status: string | null;
}

/** FoldRow → AlarmEventView（child counts 与抑制摘要由调用方二次装配）。 */
export function foldRowToView(row: FoldRow): AlarmEventView {
  const isRoot = row.root_group_id === null || row.grp_root_id === row.id;
  return {
    id: Number(row.id),
    category: row.category as AlarmCategory,
    rule_id: row.rule_id,
    source_type: row.source_type as AlarmScope,
    source_id: row.source_id,
    source_name: row.source_name,
    building_id: row.building_id ?? '',
    severity: row.severity as AlarmSeverity,
    status: row.status as AlarmEventStatus,
    message: row.message,
    root_group_id: row.root_group_id,
    is_root: isRoot,
    child_count_active: null,
    child_count_suppressed: null,
    suppression: null,
    opened_at: row.opened_at.toISOString(),
    acked_at: row.acked_at?.toISOString() ?? null,
    acked_by: row.acked_by,
    closed_at: row.closed_at?.toISOString() ?? null,
    closed_by: row.closed_by,
    close_reason: row.close_reason,
  };
}

/** 组代表行的子计数（§3.1：+N 子告警角标；suppressed 单列）。 */
export interface ChildCountRow {
  readonly root_group_id: string;
  readonly child_active: string;
  readonly child_suppressed: string;
}

export async function loadChildCounts(
  tx: PoolClient,
  tenantId: string,
  rootGroupIds: readonly string[],
): Promise<Map<string, { active: number; suppressed: number }>> {
  const map = new Map<string, { active: number; suppressed: number }>();
  if (rootGroupIds.length === 0) return map;
  const result = await tx.query<ChildCountRow>(
    `SELECT e.root_group_id,
            count(*) FILTER (WHERE e.status IN ('open','acked')) AS child_active,
            count(*) FILTER (WHERE e.status = 'suppressed') AS child_suppressed
     FROM alarm_event e
     JOIN (SELECT root_group_id AS gid, MIN(id) AS root_id
             FROM alarm_event WHERE tenant_id = $1 AND root_group_id IS NOT NULL
            GROUP BY root_group_id) grp ON grp.gid = e.root_group_id AND grp.root_id <> e.id
     WHERE e.tenant_id = $1 AND e.root_group_id = ANY($2::uuid[])
     GROUP BY e.root_group_id`,
    [tenantId, [...rootGroupIds]],
  );
  for (const row of result.rows) {
    map.set(row.root_group_id, {
      active: Number(row.child_active),
      suppressed: Number(row.child_suppressed),
    });
  }
  return map;
}

/** 生效中抑制摘要（§3.1：status=suppressed 行附带）。 */
export interface ActiveSuppressionRow {
  readonly alarm_event_id: string;
  readonly until_at: Date;
  readonly reason: string;
}

export async function loadActiveSuppressions(
  tx: PoolClient,
  tenantId: string,
  alarmIds: readonly number[],
): Promise<Map<number, { until_at: string; reason: string }>> {
  const map = new Map<number, { until_at: string; reason: string }>();
  if (alarmIds.length === 0) return map;
  const result = await tx.query<ActiveSuppressionRow>(
    `SELECT alarm_event_id, until_at, reason FROM alarm_suppression
     WHERE tenant_id = $1 AND alarm_event_id = ANY($2::bigint[]) AND ended_at IS NULL`,
    [tenantId, alarmIds.map(String)],
  );
  for (const row of result.rows) {
    map.set(Number(row.alarm_event_id), {
      until_at: row.until_at.toISOString(),
      reason: row.reason,
    });
  }
  return map;
}
