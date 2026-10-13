/**
 * M11 能耗与 KPI 看板服务（modules/M11-kpi-dashboard.md §2/§5.1–§5.5/§5.9；
 * IMPL-22 / DAT-246）。
 *
 * 纪律落点：
 * - 只读消费路径（§0 边界 1）：一切能耗数值取自 telemetry_1h cagg（tsdb_api 只读），
 *   桶差分/判据在进程内（kpi-bucket.ts）；不自建时序查询、不直查原始遥测；
 * - 同源不另立口径（§0 边界 2）：S1 = PRD §7 逐字；S3 = M6 §4.5 同式同窗
 *   （SQL 语义共享不复制端点）；期能耗 = M3 §10.2 B1 同语义桶级推广；
 * - 楼宇归属：显式 building_id 先归属校验（越界/不存在 404 asset.not_found，
 *   SEC-AZ-03）；无 building_id = 授权楼宇合并聚合（scope 强制注入）；
 * - 基准缺失显式化（AC-8）：无配置 → missing；mv_baseline 源 → unlinked 待接入
 *   不伪算（§2.5 接口语义）；fixed/序列源 → ok + 口径来源标签；
 * - 时间窗（§2.3）：跨度 ≤731 天；>7 天必须 day（矛盾 422 kpi.range_invalid）；
 *   Asia/Shanghai 本地日界（固定 +8，1991 起无 DST）。
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { PoolClient } from 'pg';
import {
  KPI_SPAN_MAX_DAYS,
  type KpiBenchmark,
  type KpiBenchmarkConfig,
  type KpiBenchmarkConfigPut,
  type KpiEnergyStructure,
  type KpiEnergyTrend,
  type KpiOverview,
  type KpiOverviewQuery,
  type KpiStructureQuery,
  type KpiTrendBucket,
  type KpiTrendQuery,
} from '@thermio/shared-types';
import { TENANT_DB } from '../infrastructure/db/db.tokens.js';
import type { TenantDb } from '../infrastructure/db/tenant-db.js';
import { LOGGER } from '../infrastructure/logger.js';
import { getRequestContext } from '../infrastructure/request-context.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { loadBuildingScope, type BuildingScope } from '../asset/asset-shared.js';
import {
  aggregateBuckets,
  autoInterval,
  diffPointBuckets,
  localDayBucket,
  localMonthStart,
  pointCoverage,
  structureOf,
  type AggregateBucket,
  type KpiHourRow,
  type PointBucket,
} from './kpi-bucket.js';
import { KPI_TSDB } from './kpi.tokens.js';
import type { KpiTsdbStore } from './kpi-tsdb.repository.js';

/** 请求侧身份（AuthContext 的 kpi 域消费面）。 */
export interface KpiActor {
  readonly tenant_id: string;
  readonly user_id: string;
  readonly role: 'admin' | 'operator' | 'viewer';
}

/** 能耗点位集成员（§2.1：quantity_type='energy' 且在用；组维度两跳解析，§2.4）。 */
interface EnergyPoint {
  readonly point_id: number;
  readonly building_id: string;
  readonly system_type: string | null;
  readonly equipment_type: string | null;
}

interface ScopeContext {
  readonly scope: BuildingScope;
  /** 显式楼宇 = 单成员；合并 = null（SQL 不加楼宇谓词，scope 已注入）。 */
  readonly buildingId: string | null;
}

interface PointSet {
  readonly points: readonly EnergyPoint[];
  readonly areas: ReadonlyMap<string, number | null>;
}

interface BenchmarkResolution {
  readonly benchmark: KpiBenchmark;
  /** 序列型源（ok 时）对齐实际窗桶的基准序列；其余 null（§5.2）。 */
  readonly series: { bucket: string; value_kwh: number | null }[] | null;
}

const GROUP_UNCLASSIFIED = 'unclassified';
const MISSING_BENCHMARK: KpiBenchmark = {
  status: 'missing',
  source: 'none',
  source_label: null,
  baseline_kwh: null,
  deviation_pct: null,
  unlinked_reason: null,
};

@Injectable()
export class KpiService {
  private readonly logger: Logger;

  constructor(
    @Inject(TENANT_DB) private readonly db: TenantDb | null,
    @Inject(LOGGER) rootLogger: Logger,
    @Inject(KPI_TSDB) private readonly tsdb: KpiTsdbStore | null,
  ) {
    this.logger = rootLogger.child({ component: 'kpi' });
  }

  private requireDb(): TenantDb {
    if (this.db === null) throw new ReasonCodeException('common.internal_error', '数据库未接线');
    return this.db;
  }

  private requireTsdb(): KpiTsdbStore {
    if (this.tsdb === null) {
      throw new ReasonCodeException(
        'telemetry.store_unavailable',
        'TSDB 只读连接未配置（TSDB_READ_URL 为空）',
      );
    }
    return this.tsdb;
  }

  // ═══════════ §5.1 GET /kpi/overview ═══════════

  async overview(actor: KpiActor, query: KpiOverviewQuery): Promise<KpiOverview> {
    const db = this.requireDb();
    const ctx = await db.withTenant(actor.tenant_id, async (tx) => {
      return this.resolveScope(tx, actor, query.building_id);
    });
    const now = new Date();
    const from = query.from !== undefined ? new Date(query.from) : localMonthStart(now);
    const to = query.to !== undefined ? new Date(query.to) : now;
    this.assertWindow(from, to);
    const pointSet = await this.loadPointSet(actor, ctx);
    const interval = autoInterval(from, to);

    // 能耗面（§2.2/§2.6：期能耗 + coverage + eui + linked）
    let energy: KpiOverview['energy'] = {
      total_kwh: null,
      coverage: 0,
      eui_kwh_m2: null,
      linked: pointSet.points.length > 0,
    };
    if (pointSet.points.length > 0) {
      const tsdb = this.requireTsdb();
      const pointBuckets = await this.fetchWindowBuckets(tsdb, pointSet, from, to);
      const total = sumValid(pointBuckets);
      energy = {
        total_kwh: total,
        coverage: pointCoverage(pointBuckets, pointIdsOf(pointSet), from, to, interval),
        eui_kwh_m2: euiOf(total, pointSet),
        linked: true,
      };
    }

    // KPI 卡同源消费面（§2.6）：S1/S3/saving + 基准
    const [acceptance, hitRate, saving, benchmark] = await Promise.all([
      this.proposalAcceptance(actor, ctx, from, to),
      this.fddHitRate(actor, ctx),
      this.savingCard(actor, ctx, from, to),
      this.resolveBenchmark(actor, ctx, pointSet, from, to, interval, energy.total_kwh).then(
        (r) => r.benchmark,
      ),
    ]);

    return {
      building_id: ctx.buildingId,
      window: { from: from.toISOString(), to: to.toISOString() },
      energy,
      benchmark,
      proposal_acceptance: acceptance,
      fdd_hit_rate: hitRate,
      saving,
      freshness: {
        includes_realtime: to.getTime() > now.getTime() - 3_600_000,
        data_as_of: now.toISOString(),
      },
    };
  }

  // ═══════════ §5.2 GET /kpi/energy/trend ═══════════

  async trend(actor: KpiActor, query: KpiTrendQuery): Promise<KpiEnergyTrend> {
    const from = new Date(query.from);
    const to = new Date(query.to);
    this.assertWindow(from, to);
    const interval = this.parseIntervalOption(query.interval, autoInterval(from, to));
    const groupBy = this.parseGroupOption(query.group_by, 'none');
    this.assertWindow(from, to, interval);
    const db = this.requireDb();
    const ctx = await db.withTenant(actor.tenant_id, async (tx) => {
      return this.resolveScope(tx, actor, query.building_id);
    });
    const pointSet = await this.loadPointSet(actor, ctx);
    if (pointSet.points.length === 0) {
      // §2.1：量型未登记/表未接入 → 200 空集（linked 语义经 overview；趋势面空桶集不报错）
      return {
        interval,
        group_by: groupBy,
        buckets: [],
        coverage: 0,
        benchmark: MISSING_BENCHMARK,
        benchmark_series: null,
      };
    }
    const tsdb = this.requireTsdb();
    const pointBuckets = await this.fetchWindowBuckets(tsdb, pointSet, from, to);
    const { groupOf, groupKeys } = groupsOf(pointSet.points, groupBy);
    const aggregate = aggregateBuckets(pointBuckets, from, to, {
      groupBy,
      groupOf,
      groupKeys,
      now: new Date(),
      ...(interval === 'day' ? { bucketOf: localDayBucket, bucketSpanMs: 86_400_000 } : {}),
    });
    const { benchmark, series } = await this.resolveBenchmark(
      actor,
      ctx,
      pointSet,
      from,
      to,
      interval,
      sumValid(pointBuckets),
    );
    return {
      interval,
      group_by: groupBy,
      buckets: aggregate.map((b) => toTrendBucket(b, groupBy)),
      coverage: pointCoverage(pointBuckets, pointIdsOf(pointSet), from, to, interval),
      benchmark,
      benchmark_series: series,
    };
  }

  // ═══════════ §5.3 GET /kpi/energy/structure ═══════════

  async structure(actor: KpiActor, query: KpiStructureQuery): Promise<KpiEnergyStructure> {
    const groupBy = this.parseStructureGroup(query.group_by);
    const from = new Date(query.from);
    const to = new Date(query.to);
    this.assertWindow(from, to);
    const db = this.requireDb();
    const ctx = await db.withTenant(actor.tenant_id, async (tx) => {
      return this.resolveScope(tx, actor, query.building_id);
    });
    const pointSet = await this.loadPointSet(actor, ctx);
    if (pointSet.points.length === 0) {
      return {
        group_by: groupBy,
        window: { from: from.toISOString(), to: to.toISOString() },
        total_kwh: null,
        coverage: 0,
        items: [],
      };
    }
    const tsdb = this.requireTsdb();
    const pointBuckets = await this.fetchWindowBuckets(tsdb, pointSet, from, to);
    const { groupOf, groupKeys } = groupsOf(pointSet.points, groupBy);
    const result = structureOf(pointBuckets, groupOf, groupKeys);
    return {
      group_by: groupBy,
      window: { from: from.toISOString(), to: to.toISOString() },
      total_kwh: result.total_kwh,
      coverage: pointCoverage(pointBuckets, pointIdsOf(pointSet), from, to, autoInterval(from, to)),
      items: result.items,
    };
  }

  // ═══════════ §5.5 GET/PUT /kpi/benchmark-config ═══════════

  async benchmarkConfig(actor: KpiActor, buildingId: string): Promise<KpiBenchmarkConfig> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      await this.resolveScope(tx, actor, buildingId);
      const row = await tx.query<{
        source: string;
        params: { kwh_per_day?: number } | null;
        updated_by_name: string | null;
        updated_at: Date | null;
      }>(
        `SELECT c.source, c.params, u.display_name AS updated_by_name, c.updated_at
         FROM kpi_benchmark_config c
         LEFT JOIN app_user u ON u.tenant_id = c.tenant_id AND u.id = c.updated_by
         WHERE c.tenant_id = $1 AND c.building_id = $2`,
        [actor.tenant_id, buildingId],
      );
      const found = row.rows[0];
      if (found === undefined) {
        // 无配置 = source:'none' 缺省形状，不 404（§5.5）
        return {
          building_id: buildingId,
          source: 'none',
          params: {},
          updated_by_name: null,
          updated_at: null,
        };
      }
      return {
        building_id: buildingId,
        source: found.source as KpiBenchmarkConfig['source'],
        params: normalizeParams(found.source, found.params),
        updated_by_name: found.updated_by_name,
        updated_at: found.updated_at === null ? null : new Date(found.updated_at).toISOString(),
      };
    });
  }

  async putBenchmarkConfig(
    actor: KpiActor,
    buildingId: string,
    body: KpiBenchmarkConfigPut,
  ): Promise<KpiBenchmarkConfig> {
    // source/params 匹配校验（§5.5）：fixed 必带 kwh_per_day；非 fixed 不带 params
    if (body.source === 'fixed' && body.params.kwh_per_day === undefined) {
      throw new ReasonCodeException(
        'kpi.benchmark_config_invalid',
        'fixed 源必填 params.kwh_per_day',
        {
          field: 'params.kwh_per_day',
        },
      );
    }
    if (body.source !== 'fixed' && body.params.kwh_per_day !== undefined) {
      throw new ReasonCodeException('kpi.benchmark_config_invalid', '非 fixed 源不接受 params', {
        field: 'params',
      });
    }
    const params = body.source === 'fixed' ? { kwh_per_day: body.params.kwh_per_day } : {};
    const db = this.requireDb();
    await db.withTenant(actor.tenant_id, async (tx) => {
      await this.resolveScope(tx, actor, buildingId);
      await tx.query(
        `INSERT INTO kpi_benchmark_config (tenant_id, building_id, source, params, updated_by)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (tenant_id, building_id)
           DO UPDATE SET source = EXCLUDED.source, params = EXCLUDED.params,
                         updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [actor.tenant_id, buildingId, body.source, JSON.stringify(params), actor.user_id],
      );
      // 变更留结构化日志（§3.3 审计承载定夺——不入 config_audit 封闭集）
      const context = getRequestContext();
      this.logger.info({
        msg: 'kpi_benchmark_config_updated',
        ...(context !== null ? { request_id: context.request_id } : {}),
        tenant_id: actor.tenant_id,
        building_id: buildingId,
        actor: actor.user_id,
        source: body.source,
        params,
      });
    });
    return this.benchmarkConfig(actor, buildingId);
  }

  // ═══════════ 内部：scope / 点位集 / 窗口 ═══════════

  /** 楼宇归属（§5.1 语义）：显式值先校验（404 asset.not_found）；缺省 = 授权合并。 */
  private async resolveScope(
    tx: PoolClient,
    actor: KpiActor,
    buildingId: string | undefined,
  ): Promise<ScopeContext> {
    const scope = await loadBuildingScope(tx, actor);
    if (buildingId !== undefined) {
      const visible = await tx.query<{ id: string }>(
        `SELECT id FROM building WHERE tenant_id = $1 AND id = $2::uuid`,
        [actor.tenant_id, buildingId],
      );
      if (visible.rows.length === 0 || (scope !== null && !scope.has(buildingId))) {
        throw new ReasonCodeException('asset.not_found', '资源不存在', { entity: 'building' });
      }
      return { scope, buildingId };
    }
    return { scope, buildingId: null };
  }

  /** 能耗点位集（§2.1：quantity_type='energy' 且在用）+ 涉及楼宇面积。 */
  private async loadPointSet(actor: KpiActor, ctx: ScopeContext): Promise<PointSet> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const params: unknown[] = [actor.tenant_id];
      let buildingPredicate = '';
      if (ctx.buildingId !== null) {
        buildingPredicate = ' AND p.building_id = $2::uuid';
        params.push(ctx.buildingId);
      } else if (ctx.scope !== null) {
        buildingPredicate = ' AND p.building_id = ANY($2::uuid[])';
        params.push([...ctx.scope]);
      }
      const points = await tx.query<{
        point_id: string;
        building_id: string;
        system_type: string | null;
        equipment_type: string | null;
      }>(
        `SELECT p.id::text AS point_id, p.building_id, s.system_type, e.equipment_type
         FROM point p
         LEFT JOIN equipment e ON e.tenant_id = p.tenant_id AND e.id = p.equipment_id
         LEFT JOIN hvac_system s ON s.tenant_id = e.tenant_id AND s.id = e.system_id
         WHERE p.tenant_id = $1 AND p.quantity_type = 'energy'
           AND p.status = 'active'${buildingPredicate}
         ORDER BY p.id`,
        params,
      );
      const buildingIds = [...new Set(points.rows.map((r) => r.building_id))];
      const areas = new Map<string, number | null>();
      if (buildingIds.length > 0) {
        const areaRows = await tx.query<{ id: string; gross_area_m2: string | null }>(
          `SELECT id, gross_area_m2 FROM building WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
          [actor.tenant_id, buildingIds],
        );
        for (const row of areaRows.rows) {
          areas.set(row.id, row.gross_area_m2 === null ? null : Number(row.gross_area_m2));
        }
      }
      return {
        points: points.rows.map((r) => ({
          point_id: Number(r.point_id),
          building_id: r.building_id,
          system_type: r.system_type,
          equipment_type: r.equipment_type,
        })),
        areas,
      };
    });
  }

  /** 时间窗守卫（§2.3）：from<to、跨度 ≤731 天、interval 与跨度匹配。 */
  private assertWindow(from: Date, to: Date, interval?: 'hour' | 'day'): void {
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
      throw new ReasonCodeException('kpi.range_invalid', 'from/to 非法（from 须早于 to）', {
        field: 'from/to',
      });
    }
    const spanDays = (to.getTime() - from.getTime()) / 86_400_000;
    if (spanDays > KPI_SPAN_MAX_DAYS) {
      throw new ReasonCodeException('kpi.range_invalid', '跨度超过 731 天上限', {
        field: 'from/to',
        max_days: KPI_SPAN_MAX_DAYS,
      });
    }
    if (interval === 'hour' && spanDays > 7) {
      throw new ReasonCodeException('kpi.range_invalid', '跨度 >7 天必须 day 粒度', {
        field: 'interval',
        rule: 'span > 7d requires interval=day',
      });
    }
  }

  private parseIntervalOption(value: string | undefined, fallback: 'hour' | 'day'): 'hour' | 'day' {
    if (value === undefined) return fallback;
    if (value === 'hour' || value === 'day') return value;
    throw new ReasonCodeException('kpi.range_invalid', 'interval 白名单外', {
      field: 'interval',
      allowed: ['hour', 'day'],
    });
  }

  private parseGroupOption(
    value: string | undefined,
    fallback: 'none' | 'system_type' | 'equipment_type',
  ): 'none' | 'system_type' | 'equipment_type' {
    if (value === undefined) return fallback;
    if (value === 'none' || value === 'system_type' || value === 'equipment_type') return value;
    throw new ReasonCodeException('kpi.range_invalid', 'group_by 白名单外', {
      field: 'group_by',
      allowed: ['none', 'system_type', 'equipment_type'],
    });
  }

  private parseStructureGroup(value: string | undefined): 'system_type' | 'equipment_type' {
    if (value === undefined) return 'system_type';
    if (value === 'system_type' || value === 'equipment_type') return value;
    throw new ReasonCodeException('kpi.range_invalid', 'group_by 白名单外', {
      field: 'group_by',
      allowed: ['system_type', 'equipment_type'],
    });
  }

  /** 窗口桶原料：含 from−1h 差值基线（§2.2 LAG 语义）。 */
  private async fetchWindowBuckets(
    tsdb: KpiTsdbStore,
    pointSet: PointSet,
    from: Date,
    to: Date,
  ): Promise<PointBucket[]> {
    const rows: KpiHourRow[] = await tsdb.hourRows(
      pointIdsOf(pointSet),
      new Date(from.getTime() - 3_600_000),
      to,
    );
    // 基线桶（from 前）只作差分底料，不入窗口统计
    return diffPointBuckets(rows).filter((b) => b.bucket.getTime() >= from.getTime());
  }

  // ═══════════ 内部：KPI 卡同源面（§2.6） ═══════════

  /** S1 逐字（PRD §7）：approved(含 executed/failed) ÷ (approved+rejected)，窗口内决策。 */
  private async proposalAcceptance(
    actor: KpiActor,
    ctx: ScopeContext,
    from: Date,
    to: Date,
  ): Promise<KpiOverview['proposal_acceptance']> {
    try {
      const db = this.requireDb();
      return await db.withTenant(actor.tenant_id, async (tx) => {
        const params: unknown[] = [actor.tenant_id];
        appendRange(params, from, to);
        const bldg = appendBuildingPredicate(params, ctx, 's.building_id');
        const result = await tx.query<{ approved: number; rejected: number; expired: number }>(
          `SELECT count(*) FILTER (WHERE pr.status IN ('approved','executed','failed'))::int AS approved,
                  count(*) FILTER (WHERE pr.status = 'rejected')::int AS rejected,
                  count(*) FILTER (WHERE pr.status = 'expired')::int AS expired
           FROM proposal pr
           JOIN equipment e ON e.tenant_id = pr.tenant_id AND e.id = pr.equipment_id
           JOIN hvac_system s ON s.tenant_id = e.tenant_id AND s.id = e.system_id
           WHERE pr.tenant_id = $1
             AND (
               (pr.decided_at IS NOT NULL AND pr.decided_at >= $2::timestamptz AND pr.decided_at < $3::timestamptz)
               OR (pr.status = 'expired' AND pr.expires_at >= $4::timestamptz AND pr.expires_at < $5::timestamptz)
             )${bldg}`,
          params,
        );
        const row = result.rows[0] ?? { approved: 0, rejected: 0, expired: 0 };
        const decided = row.approved + row.rejected;
        return {
          rate: decided === 0 ? null : round3(row.approved / decided),
          decided,
          approved: row.approved,
          expired: row.expired,
          unavailable: false,
        };
      });
    } catch (err) {
      // 统计源异常 → 卡「暂不可用」，不阻塞他卡（PRD 卡 R5）
      this.logger.warn({ msg: 'kpi_proposal_stats_unavailable', err });
      return { rate: null, decided: 0, approved: 0, expired: 0, unavailable: true };
    }
  }

  /** S3 抽检口径 = M6 §4.5 同式（7×24h 滚动；fdd overview 同一 SQL 语义共享）。 */
  private async fddHitRate(
    actor: KpiActor,
    ctx: ScopeContext,
  ): Promise<KpiOverview['fdd_hit_rate']> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const windowFrom = new Date(Date.now() - 7 * 24 * 3_600_000);
      const params: unknown[] = [actor.tenant_id, windowFrom.toISOString()];
      const bldg = appendBuildingPredicate(params, ctx, 's.building_id');
      const result = await tx.query<{ reviewed: number; confirmed: number }>(
        `SELECT count(*) FILTER (WHERE f.review_result IS NOT NULL)::int AS reviewed,
                count(*) FILTER (WHERE f.review_result = 'confirmed')::int AS confirmed
         FROM fdd_finding f
         JOIN equipment e ON e.tenant_id = f.tenant_id AND e.id = f.equipment_id
         JOIN hvac_system s ON s.tenant_id = e.tenant_id AND s.id = e.system_id
         WHERE f.tenant_id = $1 AND f.first_detected_at >= $2::timestamptz${bldg}`,
        params,
      );
      const row = result.rows[0] ?? { reviewed: 0, confirmed: 0 };
      return {
        hit_rate: row.reviewed === 0 ? null : round3(row.confirmed / row.reviewed),
        reviewed: row.reviewed,
        confirmed: row.confirmed,
      };
    });
  }

  /** 节能量卡（§2.6）：当期 mv_report 天气归一化节能量；linked = M9 域已有报告。 */
  private async savingCard(
    actor: KpiActor,
    ctx: ScopeContext,
    from: Date,
    to: Date,
  ): Promise<KpiOverview['saving']> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const params: unknown[] = [
        actor.tenant_id,
        from.toISOString().slice(0, 10),
        to.toISOString().slice(0, 10),
      ];
      const bldg = appendBuildingPredicate(params, ctx, 'b.building_id');
      const result = await tx.query<{ kwh: string | null }>(
        `SELECT r.weather_adjusted_saving_kwh::text AS kwh
         FROM mv_report r
         JOIN mv_baseline b ON b.tenant_id = r.tenant_id AND b.id = r.baseline_id
         WHERE r.tenant_id = $1 AND r.report_period && daterange($2::date, $3::date)${bldg}
         ORDER BY r.generated_at DESC LIMIT 1`,
        params,
      );
      const row = result.rows[0];
      if (row !== undefined) {
        return { kwh: row.kwh === null ? null : Number(row.kwh), linked: true };
      }
      const linked = await tx.query<{ exists: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM mv_report WHERE tenant_id = $1) AS exists`,
        [actor.tenant_id],
      );
      return { kwh: null, linked: linked.rows[0]?.exists === true };
    });
  }

  // ═══════════ 内部：基准（§2.5/§5.2） ═══════════

  private async resolveBenchmark(
    actor: KpiActor,
    ctx: ScopeContext,
    pointSet: PointSet,
    from: Date,
    to: Date,
    interval: 'hour' | 'day',
    actualTotal: number | null,
  ): Promise<BenchmarkResolution> {
    // 基准配置 per building（§2.5）——合并聚合（无 building_id）无单一基准口径 → missing
    if (ctx.buildingId === null) return { benchmark: MISSING_BENCHMARK, series: null };
    const db = this.requireDb();
    const config = await db.withTenant(actor.tenant_id, async (tx) => {
      const row = await tx.query<{ source: string; params: { kwh_per_day?: number } | null }>(
        `SELECT source, params FROM kpi_benchmark_config
         WHERE tenant_id = $1 AND building_id = $2`,
        [actor.tenant_id, ctx.buildingId as string],
      );
      return row.rows[0] ?? null;
    });
    if (config === null || config.source === 'none') {
      return { benchmark: MISSING_BENCHMARK, series: null };
    }
    if (config.source === 'mv_baseline') {
      // M9 基线推算：接口语义先行（待接入），不伪算（§2.5/§8——H6 收口后走修订接线）
      return {
        benchmark: {
          status: 'unlinked',
          source: 'mv_baseline',
          source_label: null,
          baseline_kwh: null,
          deviation_pct: null,
          unlinked_reason: 'mv_baseline_pending',
        },
        series: null,
      };
    }
    if (config.source === 'fixed') {
      const kwhPerDay = config.params?.kwh_per_day;
      if (kwhPerDay === undefined) return { benchmark: MISSING_BENCHMARK, series: null };
      const baseline = round3(kwhPerDay * ((to.getTime() - from.getTime()) / 86_400_000));
      // fixed 不给序列（前端按日恒值绘制，§5.2——避免伪造数据点）
      return {
        benchmark: finishBenchmark(
          'fixed',
          `定额基准（${String(kwhPerDay)} kWh/日）`,
          baseline,
          actualTotal,
        ),
        series: null,
      };
    }
    // 序列源：上一等长窗口 / 去年同期窗口实际（数据不足段 gap 不外推，§2.5）
    const source = config.source as 'previous_period' | 'same_period_last_year';
    const ref = referenceWindow(source, from, to);
    if (pointSet.points.length === 0) return { benchmark: MISSING_BENCHMARK, series: null };
    const tsdb = this.requireTsdb();
    const refBuckets = await this.fetchWindowBuckets(tsdb, pointSet, ref.from, ref.to);
    const baseline = sumValid(refBuckets);
    const label =
      source === 'previous_period' ? '环比基准（上一等长窗口实际）' : '同期同比（去年同期实际）';
    const benchmark = finishBenchmark(source, label, baseline, actualTotal);
    // 序列对齐实际窗桶（§4.3 benchmark_series；缺失段 null 不外推）
    const spanMs = interval === 'day' ? 86_400_000 : 3_600_000;
    const bucketOf = interval === 'day' ? localDayBucket : (d: Date) => d;
    const refAggregate = aggregateBuckets(refBuckets, ref.from, ref.to, {
      groupBy: 'none',
      groupOf: new Map(),
      groupKeys: [],
      now: new Date(0), // 历史参考窗，partial 标注无意义
      ...(interval === 'day' ? { bucketOf: localDayBucket, bucketSpanMs: spanMs } : {}),
    });
    const byStart = new Map<number, number | null>(
      refAggregate.map((b) => [bucketOf(b.bucket).getTime(), b.total_kwh]),
    );
    const shift = ref.from.getTime() - from.getTime(); // 参考窗在实际窗之前 → 负值
    const series: { bucket: string; value_kwh: number | null }[] = [];
    for (let t = bucketOf(from).getTime(); t < to.getTime(); t += spanMs) {
      // 对齐方向：实际桶 t ↔ 参考桶 t + shift（更早）；DEF-1 修复——原 t − shift
      // 符号反向，探针键落到参考窗之后恒 miss（序列全 null）
      series.push({
        bucket: new Date(t).toISOString(),
        value_kwh: byStart.get(t + shift) ?? null,
      });
    }
    return { benchmark, series };
  }
}

// ---------------------------------------------------------------------------
// 纯辅助
// ---------------------------------------------------------------------------

/** 楼宇谓词（显式楼宇 / scope 注入 / admin 全量；fdd buildingFilter 同语义）。 */
function appendBuildingPredicate(params: unknown[], ctx: ScopeContext, column: string): string {
  if (ctx.buildingId !== null) {
    params.push(ctx.buildingId);
    return ` AND ${column} = $${String(params.length)}::uuid`;
  }
  if (ctx.scope !== null) {
    params.push([...ctx.scope]);
    return ` AND ${column} = ANY($${String(params.length)}::uuid[])`;
  }
  return '';
}

function appendRange(params: unknown[], from: Date, to: Date): unknown[] {
  params.push(from.toISOString(), to.toISOString(), from.toISOString(), to.toISOString());
  return params;
}

function pointIdsOf(pointSet: PointSet): number[] {
  return pointSet.points.map((p) => p.point_id);
}

function groupsOf(
  points: readonly EnergyPoint[],
  groupBy: 'none' | 'system_type' | 'equipment_type',
): { groupOf: Map<number, string>; groupKeys: string[] } {
  const groupOf = new Map<number, string>();
  if (groupBy === 'none') return { groupOf, groupKeys: [] };
  const keys = new Set<string>();
  for (const p of points) {
    const key =
      groupBy === 'system_type'
        ? (p.system_type ?? GROUP_UNCLASSIFIED)
        : (p.equipment_type ?? GROUP_UNCLASSIFIED);
    groupOf.set(p.point_id, key);
    keys.add(key);
  }
  return { groupOf, groupKeys: [...keys] };
}

function toTrendBucket(
  b: AggregateBucket,
  groupBy: 'none' | 'system_type' | 'equipment_type',
): KpiTrendBucket {
  return {
    bucket: b.bucket.toISOString(),
    total_kwh: b.total_kwh,
    status: b.status,
    partial: b.partial,
    groups: groupBy === 'none' ? [] : [...b.groups.entries()].map(([key, kwh]) => ({ key, kwh })),
  };
}

function sumValid(buckets: readonly PointBucket[]): number | null {
  const valid = buckets.filter((b) => b.status === 'ok' || b.status === 'uncertain');
  if (valid.length === 0) return null;
  return round3(valid.reduce((sum, b) => sum + (b.kwh ?? 0), 0));
}

function euiOf(total: number | null, pointSet: PointSet): number | null {
  if (total === null || pointSet.areas.size === 0) return null;
  let areaSum = 0;
  for (const area of pointSet.areas.values()) {
    // 面积缺失 → 卡不渲染（§2.6 真实可溯纪律，不以部分面积冒算）
    if (area === null) return null;
    areaSum += area;
  }
  if (areaSum <= 0) return null;
  return round3(total / areaSum);
}

function normalizeParams(
  source: string,
  params: { kwh_per_day?: number } | null,
): KpiBenchmarkConfig['params'] {
  if (source === 'fixed' && params?.kwh_per_day !== undefined) {
    return { kwh_per_day: params.kwh_per_day };
  }
  return {};
}

function referenceWindow(
  source: 'previous_period' | 'same_period_last_year',
  from: Date,
  to: Date,
): { from: Date; to: Date } {
  const span = to.getTime() - from.getTime();
  if (source === 'previous_period') {
    return { from: new Date(from.getTime() - span), to: from };
  }
  // 同期同比：整年偏移 365 天（保持桶对齐；闰年差 1 天为可接受口径，页面标注来源）
  return {
    from: new Date(from.getTime() - 365 * 86_400_000),
    to: new Date(to.getTime() - 365 * 86_400_000),
  };
}

function finishBenchmark(
  source: KpiBenchmark['source'],
  label: string,
  baseline: number | null,
  actualTotal: number | null,
): KpiBenchmark {
  return {
    status: 'ok',
    source,
    source_label: label,
    baseline_kwh: baseline,
    deviation_pct:
      baseline !== null && baseline > 0 && actualTotal !== null
        ? round1(((actualTotal - baseline) / baseline) * 100)
        : null,
    unlinked_reason: null,
  };
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
