/**
 * M3 监控聚合服务（M3-monitor §3，IMPL-14）：监控总览 KPI / 设备工况检索与详情 /
 * 批量最新值 / SSE 点集可见性。
 *
 * 编排形态（§3.2 实现注记：BFF 聚合读，不新建底层数据访问）：
 * - PG（TenantDb，RLS 每事务 SET LOCAL）：资产档案 + 告警计数（R11 equipment 维度
 *   source 联合）+ 网关在线计数；
 * - TSDB（TELEMETRY_STORE 只读）：latest 批量（run_state/key_points/负荷率）+
 *   能量窗口首末差值（§3.1）；
 * - 场景（scenes）：scene DDL（R3）未落 → 恒 []，形状先钉死；
 * - FDD（fdd）：IMPL-16 未交付 → 恒空集，形状先钉死（§3.3 契约引用）。
 *
 * 纪律：楼宇级授权 load-for-user（admin 隐式全量）；越权/不存在同 404 同文案
 * （SEC-AZ-02/03）；KPI 慢变量走本端点 60s 轮询，不占 SSE（§3.1）。
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger as PinoLogger } from 'pino';
import {
  STREAM_LIMITS,
  type AlarmSeverity,
  type EquipmentConditionCard,
  type EquipmentConditionDetail,
  type EquipmentConditionListResponse,
  type MonitorEquipmentListQuery,
  type MonitorOverview,
  type PointLatestBatchResponse,
  type TelemetryRawSample,
} from '@thermio/shared-types';
import { TENANT_DB } from '../infrastructure/db/db.tokens.js';
import type { TenantDb } from '../infrastructure/db/tenant-db.js';
import { LOGGER } from '../infrastructure/logger.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import type { PoolClient } from 'pg';
import {
  type AssetActor,
  type BuildingScope,
  assertBuildingInScope,
  loadBuildingScope,
} from '../asset/asset-shared.js';
import { decodeAssetCursor, encodeAssetCursor } from '../asset/asset-cursor.js';
import { loadEquipment, toEquipment } from '../asset/equipments.service.js';
import { PointsService } from '../asset/points.service.js';
import { SOURCE_UNION_SQL } from '../alarm/alarm-shared.js';
import { TELEMETRY_STORE } from '../telemetry/telemetry.tokens.js';
import type { TelemetryStore } from '../telemetry/tsdb-read.repository.js';
import { TelemetryStoreUnavailableError } from '../telemetry/telemetry-store.error.js';
import {
  evaluateRunState,
  foldOpenBySeverity,
  pickKeyPoints,
  ratedCoolingCapacityKw,
  sumEnergyDeltas,
  weightedLoadRate,
  withKeyPointLatest,
  worstSeverity,
} from './run-state.js';

/** §3.2 检索单页上限内的一次性扫描护栏（run_state 过滤在应用层求值后才能收页）。 */
const EQUIPMENT_SCAN_CAP = 2_000;

/** §3.2 关键点位量类型白名单（run_state 求值 + 值卡）。 */
const KEY_POINT_QUANTITY_TYPES = ['run_status', 'chw_supply_temp', 'power'] as const;

interface EquipmentListRow {
  id: string;
  system_id: string;
  equipment_type: string;
  name: string;
  local_id: string | null;
  vendor_model: string | null;
  rated_params: Record<string, unknown> | null;
  commission_date: string | null;
}

interface KeyPointRow {
  point_id: string;
  equipment_id: string;
  display_name: string | null;
  quantity_type: string | null;
  unit_std: string | null;
}

interface LoadRateRow {
  point_id: string;
  equipment_id: string;
  rated_params: Record<string, unknown> | null;
}

@Injectable()
export class MonitorService {
  constructor(
    @Inject(TENANT_DB) private readonly tenantDb: TenantDb | null,
    @Inject(TELEMETRY_STORE) private readonly store: TelemetryStore,
    @Inject(PointsService) private readonly points: PointsService,
    @Inject(LOGGER) rootLogger: PinoLogger,
  ) {
    this.logger = rootLogger.child({ component: 'monitor' });
  }

  private readonly logger: PinoLogger;

  // -------------------------------------------------------------------
  // GET /monitor/overview（§3.1）
  // -------------------------------------------------------------------

  async overview(actor: AssetActor, buildingId?: string): Promise<MonitorOverview> {
    const db = this.requireDb();
    const snapshot = await db.withTenant(actor.tenant_id, async (tx) => {
      const scope = await loadBuildingScope(tx, actor);
      const building = await this.resolveBuilding(tx, actor, scope, buildingId);
      const alarms = await this.buildingAlarmCounts(tx, actor.tenant_id, building.id);
      // alarms 形状 = {open_total, open_by_severity}（§3.1）
      const gateways = await this.buildingGatewayCounts(tx, actor.tenant_id, building.id);
      const energyPointIds = await this.pointIdsByQuantity(
        tx,
        actor.tenant_id,
        building.id,
        'energy',
      );
      const loadRateRows = await this.loadRateRows(tx, actor.tenant_id, building.id);
      const runStatusLatest = await this.equipmentRunStatusLatest(
        tx,
        actor.tenant_id,
        loadRateRows.map((row) => row.equipment_id),
      );
      return { building, alarms, gateways, energyPointIds, loadRateRows, runStatusLatest };
    });

    // TSDB 读（read replica 纪律继承；窗口 = UTC 日/月边界，边界口径见交付说明）
    const now = new Date();
    const todayStart = utcDayStart(now);
    const monthStart = utcMonthStart(now);
    const [todayEndpoints, periodEndpoints, latest] = await Promise.all([
      this.guarded(() =>
        this.store.windowEndpoints(snapshot.energyPointIds, todayStart, now.toISOString()),
      ),
      this.guarded(() =>
        this.store.windowEndpoints(snapshot.energyPointIds, monthStart, now.toISOString()),
      ),
      this.guarded(() =>
        this.store.latestBatch(snapshot.loadRateRows.map((row) => Number(row.point_id))),
      ),
    ]);

    // 负荷率：容量加权（拍板 3——仅运行机组，铭牌制冷量权重，无铭牌等权）
    const loadUnits = snapshot.loadRateRows
      .filter((row) => {
        const runStatus = snapshot.runStatusLatest.get(row.equipment_id);
        return runStatus !== undefined && runStatus.value_text === '1';
      })
      .flatMap((row) => {
        const sample = latest.get(Number(row.point_id));
        if (sample === undefined || sample.value === null) return [];
        return [{ pct: sample.value, weight: ratedCoolingCapacityKw(row.rated_params) ?? 1 }];
      });

    return {
      building: snapshot.building,
      scenes: [], // scene DDL（R3）未落——端点形状先钉死，落码后接 scene 表元数据
      kpi: {
        energy_today_kwh:
          snapshot.energyPointIds.length > 0 ? sumEnergyDeltas(todayEndpoints) : null,
        energy_period_kwh:
          snapshot.energyPointIds.length > 0 ? sumEnergyDeltas(periodEndpoints) : null,
        saving_period_kwh: null, // M9（M&V）交付前恒 null 占位（§3.1/§10.2 B1）
        load_rate_pct: snapshot.loadRateRows.length > 0 ? weightedLoadRate(loadUnits) : null,
        load_rate_linked: snapshot.loadRateRows.length > 0,
        alarms: snapshot.alarms,
      },
      gateways: snapshot.gateways,
    };
  }

  // -------------------------------------------------------------------
  // GET /monitor/equipments（§3.2 检索）
  // -------------------------------------------------------------------

  async equipments(
    actor: AssetActor,
    query: MonitorEquipmentListQuery,
  ): Promise<EquipmentConditionListResponse> {
    const db = this.requireDb();
    const snapshot = await db.withTenant(actor.tenant_id, async (tx) => {
      const scope = await loadBuildingScope(tx, actor);
      await this.assertBuilding(tx, actor, scope, query.building_id);

      const where: string[] = ['e.tenant_id = $1', 's.building_id = $2'];
      const params: unknown[] = [actor.tenant_id, query.building_id];
      let next = 3;
      if (query.system_id !== undefined) {
        where.push(`e.system_id = $${String(next)}::uuid`);
        params.push(query.system_id);
        next += 1;
      }
      if (query.equipment_type !== undefined) {
        where.push(`e.equipment_type = $${String(next)}::text`);
        params.push(query.equipment_type);
        next += 1;
      }
      if (query.keyword !== undefined) {
        where.push(
          `(e.name ILIKE $${String(next)}::text OR e.local_id ILIKE $${String(next)}::text)`,
        );
        params.push(`%${escapeLike(query.keyword.trim())}%`);
        next += 1;
      }
      const equipmentRows = await tx.query<EquipmentListRow>(
        `SELECT e.id, e.system_id, e.equipment_type, e.name, e.local_id,
                e.vendor_model, e.rated_params, e.commission_date
         FROM equipment e
         JOIN hvac_system s ON s.tenant_id = e.tenant_id AND s.id = e.system_id
         WHERE ${where.join(' AND ')}
         ORDER BY e.name ASC, e.id ASC
         LIMIT ${String(EQUIPMENT_SCAN_CAP + 1)}`,
        params,
      );
      const equipments = equipmentRows.rows.slice(0, EQUIPMENT_SCAN_CAP);
      const truncated = equipmentRows.rows.length > EQUIPMENT_SCAN_CAP;
      if (truncated) {
        this.logger.warn({ msg: 'monitor_equipment_scan_capped', cap: EQUIPMENT_SCAN_CAP });
      }

      const equipmentIds = equipments.map((row) => row.id);
      const keyPoints =
        equipmentIds.length > 0
          ? await tx.query<KeyPointRow>(
              `SELECT p.id AS point_id, p.equipment_id, p.display_name, p.quantity_type, p.unit_std
               FROM point p
               WHERE p.tenant_id = $1 AND p.equipment_id = ANY($2::uuid[])
                 AND p.status = 'active'
                 AND p.quantity_type = ANY($3::text[])
               ORDER BY p.equipment_id, p.raw_name ASC, p.id ASC`,
              [actor.tenant_id, equipmentIds, [...KEY_POINT_QUANTITY_TYPES]],
            )
          : { rows: [] as KeyPointRow[] };
      const alarmRows = await this.equipmentAlarmSeverities(tx, actor.tenant_id, equipmentIds);
      return { equipments, keyPoints: keyPoints.rows, alarmRows, truncated };
    });

    // TSDB latest 批量（run_state + key_points 值卡）
    const keyPointIds = snapshot.keyPoints.map((row) => Number(row.point_id));
    const latest = await this.guarded(() => this.store.latestBatch(keyPointIds));

    // 装配工况卡（run_state 应用层求值——§3.2：running 优先，fault = open 告警且非 running）
    const alarmSeveritiesByEquipment = new Map<string, string[]>();
    for (const row of snapshot.alarmRows) {
      const list = alarmSeveritiesByEquipment.get(row.equipment_id) ?? [];
      list.push(row.severity);
      alarmSeveritiesByEquipment.set(row.equipment_id, list);
    }
    const pointsByEquipment = new Map<string, KeyPointRow[]>();
    for (const row of snapshot.keyPoints) {
      const list = pointsByEquipment.get(row.equipment_id) ?? [];
      list.push(row);
      pointsByEquipment.set(row.equipment_id, list);
    }

    const cards: EquipmentConditionCard[] = snapshot.equipments.map((equipment) => {
      const points = pointsByEquipment.get(equipment.id) ?? [];
      const keyPoints = pickKeyPoints(
        points.map((point) => ({
          point_id: Number(point.point_id),
          display_name: point.display_name,
          quantity_type: point.quantity_type,
          unit_std: point.unit_std,
        })),
      );
      const runStatusPoint = points.find((point) => point.quantity_type === 'run_status');
      const runStatusLatest =
        runStatusPoint === undefined ? undefined : latest.get(Number(runStatusPoint.point_id));
      const severities = alarmSeveritiesByEquipment.get(equipment.id) ?? [];
      return {
        equipment: toEquipment(equipment),
        run_state: evaluateRunState(runStatusLatest ?? null, severities.length > 0),
        alarm_worst: worstSeverity(severities),
        key_points: withKeyPointLatest(keyPoints, latest),
      };
    });

    // run_state 过滤在求值后收页（§3.2 白名单筛选项；扫描护栏见 EQUIPMENT_SCAN_CAP）
    const filtered =
      query.run_state === undefined
        ? cards
        : cards.filter((card) => card.run_state === query.run_state);

    // 游标分页（固定排序 (name, id) 升序，不开放排序参数——API-DSN-04）
    const anchor = query.cursor === undefined ? null : decodeAssetCursor(query.cursor, 1);
    let page = filtered;
    if (anchor !== null) {
      const [anchorName, anchorId] = [anchor.k[0] ?? '', anchor.id];
      page = page.filter(
        (card) =>
          card.equipment.name > anchorName ||
          (card.equipment.name === anchorName && card.equipment.id > anchorId),
      );
    }
    const items = page.slice(0, query.limit);
    const hasMore = page.length > query.limit;
    const last = items.at(-1);
    return {
      items,
      next_cursor:
        hasMore && last !== undefined
          ? encodeAssetCursor({ k: [last.equipment.name], id: last.equipment.id })
          : null,
    };
  }

  // -------------------------------------------------------------------
  // GET /monitor/equipments/{equipment_id}（§3.3 详情）
  // -------------------------------------------------------------------

  async equipmentDetail(actor: AssetActor, equipmentId: string): Promise<EquipmentConditionDetail> {
    const db = this.requireDb();
    const snapshot = await db.withTenant(actor.tenant_id, async (tx) => {
      const equipment = await loadEquipment(tx, actor, equipmentId);
      const alarmRows = await this.equipmentAlarmSeverities(tx, actor.tenant_id, [equipmentId]);
      const topAlarms = await this.equipmentTopOpenAlarms(tx, actor.tenant_id, equipmentId);
      return { equipment, alarmRows, topAlarms };
    });
    // 点位列表（含 latest 快照）复用 M1 §3.4 装配（PointsService.listByEquipment，
    // 内部再走 loadEquipment 越权校验 + TELEMETRY_STORE latest 批量）
    const pointsPage = await this.points.listByEquipment(actor, equipmentId, {}, 5000, undefined);

    const runStatusPoint = pointsPage.items.find(
      (item) => item.point.quantity_type === 'run_status',
    );
    const openBySeverity = foldOpenBySeverity(snapshot.alarmRows);

    return {
      equipment: toEquipment(snapshot.equipment),
      run_state: evaluateRunState(runStatusPoint?.latest ?? null, snapshot.alarmRows.length > 0),
      points: pointsPage.items as EquipmentConditionDetail['points'],
      alarms: {
        open_by_severity: openBySeverity,
        items: snapshot.topAlarms,
      },
      fdd: { open_total: 0, items: [] }, // IMPL-16（M6）未交付——契约形状先钉死（§3.3/§10.2）
    };
  }

  // -------------------------------------------------------------------
  // GET /points/latest?point_ids=（§3.6 批量最新值，R6）
  // -------------------------------------------------------------------

  async pointLatestBatch(
    actor: AssetActor,
    pointIds: readonly number[],
  ): Promise<PointLatestBatchResponse> {
    const latest = await this.visibleLatest(actor, pointIds, 'asset.not_found');
    return {
      items: pointIds.map((pointId) => {
        const sample = latest.get(pointId);
        return {
          point_id: pointId,
          ts: sample?.ts ?? null,
          value: sample?.value ?? null,
          value_text: sample?.value_text ?? null,
          quality: sample?.quality ?? null,
        };
      }),
    };
  }

  // -------------------------------------------------------------------
  // SSE 点集可见性（§3.5 前置；platform §10 整单 400 point.not_found）
  // -------------------------------------------------------------------

  async assertStreamPoints(actor: AssetActor, pointIds: readonly number[]): Promise<void> {
    await this.visibleLatest(actor, pointIds, 'point.not_found');
  }

  /** 可见点 latest 批量：任一点不存在/越权 → 整单失败（code 由调用方选）。 */
  private async visibleLatest(
    actor: AssetActor,
    pointIds: readonly number[],
    reasonCode: 'asset.not_found' | 'point.not_found',
  ): Promise<Map<number, TelemetryRawSample>> {
    const unique = [...new Set(pointIds)];
    if (unique.length === 0) {
      throw new ReasonCodeException('common.validation_failed', 'point_ids 不能为空', {
        field: 'point_ids',
      });
    }
    if (unique.length > STREAM_LIMITS.max_point_ids_per_request) {
      throw new ReasonCodeException('stream.limit_exceeded', '订阅点数超出上限', {
        limit: STREAM_LIMITS.max_point_ids_per_request,
        count: unique.length,
      });
    }
    const db = this.requireDb();
    const visibility = await db.withTenant(actor.tenant_id, async (tx) => {
      const visible = await loadBuildingScope(tx, actor);
      const pointRows = await tx.query<{ id: string; building_id: string }>(
        `SELECT id, building_id FROM point WHERE tenant_id = $1 AND id = ANY($2::bigint[])`,
        [actor.tenant_id, unique],
      );
      return { scope: visible, rows: pointRows.rows };
    });

    // 不存在 ∪ 越权（不泄露存在性：同码同 details 形状，SEC-AZ-02/03）
    const buildingById = new Map(visibility.rows.map((row) => [row.id, row.building_id]));
    const { scope } = visibility;
    const offending = unique.filter((pointId) => {
      const buildingId = buildingById.get(String(pointId));
      return buildingId === undefined || (scope !== null && !scope.has(buildingId));
    });
    if (offending.length > 0) {
      throw new ReasonCodeException(
        reasonCode,
        reasonCode === 'point.not_found' ? '订阅点集含不存在或越权点位' : '点位不存在',
        { point_ids: offending },
      );
    }
    return this.guarded(() => this.store.latestBatch(unique));
  }

  // -------------------------------------------------------------------
  // 内部查询件
  // -------------------------------------------------------------------

  /** 楼宇解析：缺省 = 可见集首楼（created_at, id 序）；不存在/越权 → 404 同码同文案。 */
  private async resolveBuilding(
    tx: PoolClient,
    actor: AssetActor,
    scope: BuildingScope,
    buildingId: string | undefined,
  ): Promise<{ id: string; name: string }> {
    if (buildingId !== undefined) {
      const result = await tx.query<{ id: string; name: string }>(
        `SELECT id, name FROM building WHERE tenant_id = $1 AND id = $2`,
        [actor.tenant_id, buildingId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new ReasonCodeException('asset.not_found', '资源不存在', { entity: 'building' });
      }
      assertBuildingInScope(scope, buildingId);
      return row;
    }
    const scopeClause = scope === null ? '' : ' AND id = ANY($2::uuid[])';
    const params: unknown[] = scope === null ? [actor.tenant_id] : [actor.tenant_id, [...scope]];
    const result = await tx.query<{ id: string; name: string }>(
      `SELECT id, name FROM building WHERE tenant_id = $1${scopeClause} ORDER BY created_at ASC, id ASC LIMIT 1`,
      params,
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new ReasonCodeException('asset.not_found', '资源不存在', { entity: 'building' });
    }
    return row;
  }

  private async assertBuilding(
    tx: PoolClient,
    actor: AssetActor,
    scope: BuildingScope,
    buildingId: string,
  ): Promise<void> {
    await this.resolveBuilding(tx, actor, scope, buildingId);
  }

  /** 楼宇在用告警五级计数（§3.1 alarms；source 联合 → building 归属，M4 只读聚合）。 */
  private async buildingAlarmCounts(
    tx: PoolClient,
    tenantId: string,
    buildingId: string,
  ): Promise<{ open_total: number; open_by_severity: Record<AlarmSeverity, number> }> {
    const result = await tx.query<{ severity: string; count: number }>(
      `WITH src AS (${SOURCE_UNION_SQL})
       SELECT a.severity, count(*)::int AS count
       FROM alarm_event a
       JOIN src ON src.source_type = a.source_type AND src.source_id = a.source_id
       WHERE a.tenant_id = $1 AND a.status = 'open' AND src.building_id = $2::uuid
       GROUP BY a.severity`,
      [tenantId, buildingId],
    );
    const openBySeverity = foldOpenBySeverity(result.rows);
    const openTotal = result.rows.reduce((sum, row) => sum + row.count, 0);
    return { open_total: openTotal, open_by_severity: openBySeverity };
  }

  private async buildingGatewayCounts(
    tx: PoolClient,
    tenantId: string,
    buildingId: string,
  ): Promise<{ online: number; total: number }> {
    const result = await tx.query<{ online: number; total: number }>(
      `SELECT count(*) FILTER (WHERE g.status = 'online')::int AS online, count(*)::int AS total
       FROM gateway g WHERE g.tenant_id = $1 AND g.building_id = $2::uuid`,
      [tenantId, buildingId],
    );
    return result.rows[0] ?? { online: 0, total: 0 };
  }

  private async pointIdsByQuantity(
    tx: PoolClient,
    tenantId: string,
    buildingId: string,
    quantityType: 'energy' | 'load_rate',
  ): Promise<number[]> {
    const result = await tx.query<{ id: string }>(
      `SELECT p.id FROM point p
       WHERE p.tenant_id = $1 AND p.building_id = $2::uuid
         AND p.quantity_type = $3::text AND p.status = 'active'`,
      [tenantId, buildingId, quantityType],
    );
    return result.rows.map((row) => Number(row.id));
  }

  private async loadRateRows(
    tx: PoolClient,
    tenantId: string,
    buildingId: string,
  ): Promise<LoadRateRow[]> {
    const result = await tx.query<LoadRateRow>(
      `SELECT p.id AS point_id, p.equipment_id, e.rated_params
       FROM point p
       JOIN equipment e ON e.tenant_id = p.tenant_id AND e.id = p.equipment_id
       WHERE p.tenant_id = $1 AND p.building_id = $2::uuid
         AND p.quantity_type = 'load_rate' AND p.status = 'active'`,
      [tenantId, buildingId],
    );
    return result.rows;
  }

  /** 机组 run_status latest（负荷率「仅运行机组」判定输入；value_text '1' = running）。 */
  private async equipmentRunStatusLatest(
    tx: PoolClient,
    tenantId: string,
    equipmentIds: readonly string[],
  ): Promise<Map<string, TelemetryRawSample>> {
    const map = new Map<string, TelemetryRawSample>();
    if (equipmentIds.length === 0) return map;
    const pointRows = await tx.query<{ id: string; equipment_id: string }>(
      `SELECT p.id, p.equipment_id FROM point p
       WHERE p.tenant_id = $1 AND p.equipment_id = ANY($2::uuid[])
         AND p.quantity_type = 'run_status' AND p.status = 'active'
       ORDER BY p.equipment_id, p.raw_name ASC, p.id ASC`,
      [tenantId, [...equipmentIds]],
    );
    if (pointRows.rows.length === 0) return map;
    const firstByEquipment = new Map<string, string>();
    for (const row of pointRows.rows) {
      if (!firstByEquipment.has(row.equipment_id)) {
        firstByEquipment.set(row.equipment_id, row.id);
      }
    }
    const latest = await this.guarded(() =>
      this.store.latestBatch([...firstByEquipment.values()].map(Number)),
    );
    for (const [equipmentId, pointId] of firstByEquipment) {
      const sample = latest.get(Number(pointId));
      if (sample !== undefined) map.set(equipmentId, sample);
    }
    return map;
  }

  /** 设备在用告警 severity 计数（R11 equipment 维度：equipment ∪ 其点位）。 */
  private async equipmentAlarmSeverities(
    tx: PoolClient,
    tenantId: string,
    equipmentIds: readonly string[],
  ): Promise<Array<{ equipment_id: string; severity: string; count: number }>> {
    if (equipmentIds.length === 0) return [];
    const result = await tx.query<{ equipment_id: string; severity: string; count: number }>(
      `SELECT e.id AS equipment_id, a.severity, count(*)::int AS count
       FROM equipment e
       JOIN alarm_event a ON a.tenant_id = e.tenant_id AND a.status = 'open' AND (
         (a.source_type = 'equipment' AND a.source_id = e.id::text)
         OR (a.source_type = 'point' AND a.source_id IN (
              SELECT p.id::text FROM point p WHERE p.tenant_id = e.tenant_id AND p.equipment_id = e.id)))
       WHERE e.tenant_id = $1 AND e.id = ANY($2::uuid[])
       GROUP BY e.id, a.severity`,
      [tenantId, [...equipmentIds]],
    );
    return result.rows;
  }

  /** top 20 在用告警（§3.3 alarms.items；severity 严重度序 → opened_at 倒序）。 */
  private async equipmentTopOpenAlarms(
    tx: PoolClient,
    tenantId: string,
    equipmentId: string,
  ): Promise<EquipmentConditionDetail['alarms']['items']> {
    const result = await tx.query<{
      id: string;
      severity: string;
      message: string;
      opened_at: Date;
    }>(
      `SELECT a.id::text AS id, a.severity, a.message, a.opened_at
       FROM alarm_event a
       WHERE a.tenant_id = $1 AND a.status = 'open' AND (
         (a.source_type = 'equipment' AND a.source_id = $2::text)
         OR (a.source_type = 'point' AND a.source_id IN (
              SELECT p.id::text FROM point p WHERE p.tenant_id = $1 AND p.equipment_id = $2::uuid)))
       ORDER BY CASE a.severity WHEN 'critical' THEN 5 WHEN 'major' THEN 4 WHEN 'minor' THEN 3
                                 WHEN 'warning' THEN 2 ELSE 1 END DESC,
                a.opened_at DESC, a.id DESC
       LIMIT 20`,
      [tenantId, equipmentId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      severity: row.severity as AlarmSeverity,
      rule_summary: row.message, // M4 事件摘要（rule_summary 字段语义 = 告警摘要文案）
      opened_at: row.opened_at.toISOString(),
    }));
  }

  /** 存储不可用 → 503 信封（telemetry 域显式降级口径）；其余异常原样上抛。 */
  private async guarded<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (err: unknown) {
      if (err instanceof TelemetryStoreUnavailableError) {
        this.logger.warn({ msg: 'telemetry_store_unavailable', err: err.message });
        throw new ReasonCodeException(
          'telemetry.store_unavailable',
          '遥测存储暂不可用（未配置或不可达）',
        );
      }
      throw err;
    }
  }

  private requireDb(): TenantDb {
    if (this.tenantDb === null) {
      throw new ReasonCodeException('common.internal_error', '监控域未接线');
    }
    return this.tenantDb;
  }
}

/** LIKE 转义（buildings.service 同款：用户输入中的 %/_ 不作通配）。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** UTC 日界（§3.1「当日」——MVP 以 UTC 日界为准，楼宇时区归 P1 本地化批次）。 */
function utcDayStart(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
}

/** UTC 月界（「当期」= 当月累计）。 */
function utcMonthStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}
