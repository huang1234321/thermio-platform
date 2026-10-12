/**
 * M&V 基线生命周期与报告服务（modules/M9-mv-report.md §4/§6；IMPL-21 / DAT-242）。
 *
 * 纪律落点：
 * - 读写全部经 TenantDb.withTenant；楼宇授权 load-for-user（admin 全量），
 *   越权/不存在同响应 404 mv.*_not_found（SEC-AZ-02/03）；
 * - 状态机守卫（§4.1/§4.2）：PATCH/DELETE 仅 draft、activate 仅 draft（三重门槛 §3.5）、
 *   retire 仅 active、approve 仅 pending（条件 UPDATE 单赢家）、DELETE 报告仅未审批；
 * - 不可变纪律：active/retired 的口径字段只读（PATCH 拒绝）；
 * - supersede 原子换代：单事务先退后进（语句序即锁序，EXCLUDE 立即检查满足）；
 *   EXCLUDE 并发窄窗兜底（23P01 → mv.baseline_overlap{cause:db_constraint}）；
 * - 生成/导出异步面在 MvGenerateService / MvExportService（§5 执行契约）。
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { PoolClient } from 'pg';
import type { MvModelParams } from '@thermio/shared-types';
import {
  MV_CI_LEVEL,
  MV_DAY_BAD_RATIO_MAX,
  MV_LATE_BUFFER_DAYS,
  MV_DAY_HOURS_MIN,
  MV_PERIOD_WEATHER_MIN,
  MV_UNCERTAINTY_RATIO_MAX,
  MV_WEATHER_HOURS_MIN,
  MV_WINDOW_COVERAGE_MIN,
  MV_MIN_BASELINE_DAYS,
  MV_FIT_CVRMSE_MAX,
  MV_FIT_NMBE_MAX,
  type MvBaselineActivate,
  type MvBaselineCreate,
  type MvBaselineDetail,
  type MvBaselineList,
  type MvBaselinePatch,
  type MvBaselineSummary,
  type MvReportApproveResponse,
  type MvReportDetail,
  type MvReportList,
  type MvReportSummary,
  type MvReportsQuery,
  type MvBaselinesQuery,
  type MvValidationResult,
  type MvWeatherStationsResponse,
} from '@thermio/shared-types';
import { TENANT_DB } from '../infrastructure/db/db.tokens.js';
import type { TenantDb } from '../infrastructure/db/tenant-db.js';
import { LOGGER } from '../infrastructure/logger.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { loadBuildingScope } from '../asset/asset-shared.js';
import {
  assertBaselinePeriodLength,
  guardTsdb,
  baselineSummary,
  effectiveSpec,
  loadBaselineForUser,
  mapBaselineRow,
  parseDaterange,
  runValidation,
  shiftDate,
  type BaselineRecord,
  type MvActor,
} from './mv-shared.js';
import { MV_TSDB } from './mv.tokens.js';
import type { MvTsdbStore } from './mv-tsdb.repository.js';
import { decodeMvCursor, encodeMvCursor, mvKeysetPredicate, toEpochMicros } from './mv-cursor.js';
import { MvMetrics } from './mv.metrics.js';
import {
  assembleDayEnergy,
  assembleWeatherByDay,
  buildingCodeOf,
  buildReportNo,
  computeReport,
  enumerateDates,
} from './mv-calc.js';

const BASELINE_LIST_COLUMNS = `b.id, b.building_id, b.method, b.baseline_period::text AS baseline_period,
       b.model_type, b.model_params, b.weather_source, b.status, b.validation_result,
       b.activated_by, b.activated_at, b.retired_by, b.retired_at, b.created_at`;

@Injectable()
export class MvService {
  private readonly logger: Logger;
  /** 报告详情 series 重算的 TSDB 读失败降级标记（结构化日志，不阻断 PG 面读取）。 */
  private readonly tsdb: MvTsdbStore | null;

  constructor(
    @Inject(TENANT_DB) private readonly db: TenantDb | null,
    @Inject(LOGGER) rootLogger: Logger,
    @Inject(MV_TSDB) tsdb: MvTsdbStore | null,
    @Inject(MvMetrics) private readonly metrics: MvMetrics,
  ) {
    this.logger = rootLogger.child({ component: 'mv' });
    this.tsdb = tsdb;
  }

  private requireDb(): TenantDb {
    if (this.db === null) throw new ReasonCodeException('common.internal_error', '数据库未接线');
    return this.db;
  }

  private requireTsdb(): MvTsdbStore {
    if (this.tsdb === null) {
      throw new ReasonCodeException(
        'telemetry.store_unavailable',
        'TSDB 只读连接未配置（TSDB_READ_URL 为空）',
      );
    }
    return this.tsdb;
  }

  // ═══════════ §6.1 基线列表 ═══════════

  async listBaselines(actor: MvActor, query: MvBaselinesQuery): Promise<MvBaselineList> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const scope = await loadBuildingScope(tx, actor);
      const params: unknown[] = [actor.tenant_id, query.limit + 1];
      const predicates: string[] = ['b.tenant_id = $1'];
      if (query.building_id !== undefined) {
        // load-for-user：越权楼宇与不存在同响应（§6.1）
        if (scope !== null && !scope.has(query.building_id)) {
          throw new ReasonCodeException('asset.not_found', '资源不存在', { entity: 'building' });
        }
        const check = await tx.query(`SELECT 1 FROM building WHERE tenant_id = $1 AND id = $2`, [
          actor.tenant_id,
          query.building_id,
        ]);
        if (check.rowCount === 0) {
          throw new ReasonCodeException('asset.not_found', '资源不存在', { entity: 'building' });
        }
        params.push(query.building_id);
        predicates.push(`b.building_id = $${String(params.length)}`);
      } else if (scope !== null) {
        // 列表强制注入楼宇过滤（§1.5，M7 §5）
        params.push([...scope]);
        predicates.push(`b.building_id = ANY($${String(params.length)}::uuid[])`);
      }
      if (query.status !== undefined) {
        params.push(query.status);
        predicates.push(`b.status = $${String(params.length)}`);
      }
      if (query.cursor !== undefined) {
        const cursor = decodeMvCursor(query.cursor, 1);
        const keyset = mvKeysetPredicate(
          '(extract(epoch FROM b.created_at) * 1e6)::bigint',
          'b.id::text',
          cursor,
          params.length + 1,
        );
        predicates.push(keyset.sql);
        params.push(...keyset.params);
      }
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${BASELINE_LIST_COLUMNS}
         FROM mv_baseline b
         WHERE ${predicates.join(' AND ')}
         ORDER BY b.created_at DESC, b.id DESC
         LIMIT $2`,
        params,
      );
      const rows = result.rows.map(mapBaselineRow);
      const items = rows
        .slice(0, query.limit)
        .map(baselineSummary)
        .map((item) => ({
          ...item,
          method: item.method as MvBaselineSummary['method'],
          status: item.status as MvBaselineSummary['status'],
          model_type: item.model_type as MvBaselineSummary['model_type'],
        }));
      return {
        items,
        next_cursor:
          rows.length > query.limit
            ? encodeMvCursor({
                k: [toEpochMicros(rows[query.limit - 1]?.created_at as Date)],
                id: (rows[query.limit - 1] as BaselineRecord).id,
              })
            : null,
      };
    });
  }

  // ═══════════ §6.4 基线详情/创建/编辑/删除 ═══════════

  async baselineDetail(actor: MvActor, baselineId: string): Promise<MvBaselineDetail> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const { record } = await loadBaselineForUser(tx, actor, baselineId);
      const points = await tx.query<{
        point_id: string;
        name: string;
        local_id: string | null;
        unit: string | null;
      }>(
        `SELECT bp.point_id, COALESCE(p.display_name, p.raw_name) AS name, NULL::text AS local_id, p.unit_std AS unit
         FROM mv_baseline_point bp JOIN point p ON p.tenant_id = bp.tenant_id AND p.id = bp.point_id
         WHERE bp.baseline_id = $1
         ORDER BY bp.point_id`,
        [record.id],
      );
      const reports = await tx.query<{ count: string }>(
        `SELECT count(*) AS count FROM mv_report WHERE tenant_id = $1 AND baseline_id = $2`,
        [actor.tenant_id, record.id],
      );
      const summary = baselineSummary(record);
      return {
        ...summary,
        method: summary.method as MvBaselineDetail['method'],
        status: summary.status as MvBaselineDetail['status'],
        model_type: summary.model_type as MvBaselineDetail['model_type'],
        model_params: record.model_params,
        validation_result: record.validation_result,
        metering_points: points.rows.map((row) => ({
          point_id: Number(row.point_id),
          name: row.name,
          local_id: row.local_id,
          unit: row.unit,
        })),
        report_count: Number(reports.rows[0]?.count ?? 0),
        activated_by: record.activated_by,
        retired_by: record.retired_by,
        retired_at: record.retired_at?.toISOString() ?? null,
      };
    });
  }

  /** 创建（admin；§6.4）：422 族校验（点位/站点/期域）→ 建行 + 计量边界 + 首跑校核。 */
  async createBaseline(actor: MvActor, body: MvBaselineCreate): Promise<MvBaselineDetail> {
    const db = this.requireDb();
    const tsdb = this.requireTsdb();
    assertBaselinePeriodLength(body.baseline_period);

    const spec = effectiveSpec(null, body.model_spec);

    const created = await db.withTenant(actor.tenant_id, async (tx) => {
      // 楼宇 load-for-user（§2.1：building_id 必填，选项 C 整楼度量）
      const scope = await loadBuildingScope(tx, actor);
      if (scope !== null && !scope.has(body.building_id)) {
        throw new ReasonCodeException('asset.not_found', '资源不存在', { entity: 'building' });
      }
      const building = await tx.query<{ id: string }>(
        `SELECT id FROM building WHERE tenant_id = $1 AND id = $2`,
        [actor.tenant_id, body.building_id],
      );
      if (building.rowCount === 0) {
        throw new ReasonCodeException('asset.not_found', '资源不存在', { entity: 'building' });
      }
      // 计量边界校验（§2.2：非空/属楼宇/energy 量型/active）
      await assertMeteringPoints(tx, actor.tenant_id, body.building_id, body.metering_point_ids);
      // 天气站点校验（§2.1：近 90 天有观测）
      const lastObs = await guardTsdb(() => tsdb.stationRecentObservation(body.weather_source));
      if (lastObs === null) {
        throw new ReasonCodeException('mv.weather_station_invalid', '天气站点近 90 天无观测', {
          station_id: body.weather_source,
          last_obs_ts: null,
        });
      }

      const insert = await tx.query<{ id: string }>(
        `INSERT INTO mv_baseline
           (tenant_id, building_id, method, baseline_period, model_type, weather_source)
         VALUES ($1, $2, $3, daterange($4, $5), $6, $7)
         RETURNING id`,
        [
          actor.tenant_id,
          body.building_id,
          body.method,
          body.baseline_period.start,
          body.baseline_period.end,
          body.model_type,
          body.weather_source,
        ],
      );
      const baselineId = insert.rows[0]?.id as string;
      await insertMeteringPoints(tx, actor.tenant_id, baselineId, body.metering_point_ids);
      return baselineId;
    });

    // 首跑校核（§4.1 创建留痕：validation_result = 首次校核结果）——行已落，
    // 校核失败（TSDB 不可用）不回滚行，以 unfit/NULL 形态呈现，:validate 可重跑。
    try {
      const run = await this.runValidationFor(actor, created, spec);
      await db.withTenant(actor.tenant_id, async (tx) => {
        await tx.query(
          `UPDATE mv_baseline SET validation_result = $2, model_params = $3
           WHERE tenant_id = $1 AND id = $4 AND status = 'draft'`,
          [
            actor.tenant_id,
            JSON.stringify(run.validation),
            JSON.stringify(run.modelParams),
            created,
          ],
        );
      });
    } catch (err) {
      this.logger.warn({ msg: 'mv_baseline_initial_validation_failed', baseline_id: created, err });
    }
    return this.baselineDetail(actor, created);
  }

  /** PATCH 仅 draft（§4.1 不可变纪律）；口径四项可改，改后 model_params.spec 同步。 */
  async patchBaseline(
    actor: MvActor,
    baselineId: string,
    body: MvBaselinePatch,
  ): Promise<MvBaselineDetail> {
    const db = this.requireDb();
    const tsdb = this.requireTsdb();
    await db.withTenant(actor.tenant_id, async (tx) => {
      const { record } = await loadBaselineForUser(tx, actor, baselineId);
      if (record.status !== 'draft') {
        throw new ReasonCodeException('mv.baseline_state_invalid', '仅 draft 基线可编辑', {
          current_status: record.status,
          allowed: ['draft'],
        });
      }
      if (body.baseline_period !== undefined) {
        assertBaselinePeriodLength(body.baseline_period);
      }
      if (body.weather_source !== undefined && body.weather_source !== record.weather_source) {
        const station = body.weather_source;
        const lastObs = await guardTsdb(() => tsdb.stationRecentObservation(station));
        if (lastObs === null) {
          throw new ReasonCodeException('mv.weather_station_invalid', '天气站点近 90 天无观测', {
            station_id: station,
            last_obs_ts: null,
          });
        }
      }
      if (body.metering_point_ids !== undefined) {
        await assertMeteringPoints(
          tx,
          actor.tenant_id,
          record.building_id,
          body.metering_point_ids,
        );
      }
      await tx.query(
        `UPDATE mv_baseline SET
           baseline_period = COALESCE(daterange($3, $4), baseline_period),
           weather_source = COALESCE($5, weather_source),
           model_params = $6::jsonb
         WHERE tenant_id = $1 AND id = $2`,
        [
          actor.tenant_id,
          baselineId,
          body.baseline_period?.start ?? null,
          body.baseline_period?.end ?? null,
          body.weather_source ?? null,
          JSON.stringify(mergeSpec(record, body.model_spec)),
        ],
      );
      if (body.metering_point_ids !== undefined) {
        await tx.query(`DELETE FROM mv_baseline_point WHERE baseline_id = $1`, [baselineId]);
        await insertMeteringPoints(tx, actor.tenant_id, baselineId, body.metering_point_ids);
      }
      // 口径已改：旧校核结果失效，显式 :validate 重跑（§4.1）
      await tx.query(
        `UPDATE mv_baseline SET validation_result = NULL WHERE tenant_id = $1 AND id = $2`,
        [actor.tenant_id, baselineId],
      );
    });
    return this.baselineDetail(actor, baselineId);
  }

  /** DELETE 仅 draft（§4.1）；应用层同事务显式删计量边界（零级联纪律，0011 注）。 */
  async deleteBaseline(actor: MvActor, baselineId: string): Promise<void> {
    const db = this.requireDb();
    await db.withTenant(actor.tenant_id, async (tx) => {
      const { record } = await loadBaselineForUser(tx, actor, baselineId);
      if (record.status !== 'draft') {
        throw new ReasonCodeException('mv.baseline_state_invalid', '仅 draft 基线可删除', {
          current_status: record.status,
          allowed: ['draft'],
        });
      }
      const reports = await tx.query<{ count: string }>(
        `SELECT count(*) AS count FROM mv_report WHERE tenant_id = $1 AND baseline_id = $2`,
        [actor.tenant_id, baselineId],
      );
      if (Number(reports.rows[0]?.count ?? 0) > 0) {
        throw new ReasonCodeException('mv.baseline_state_invalid', '基线已有报告，不可删除', {
          current_status: record.status,
          allowed: [],
        });
      }
      await tx.query(`DELETE FROM mv_baseline_point WHERE baseline_id = $1`, [baselineId]);
      await tx.query(`DELETE FROM mv_baseline WHERE tenant_id = $1 AND id = $2`, [
        actor.tenant_id,
        baselineId,
      ]);
    });
  }

  // ═══════════ §6.5 :validate（重跑校核，仅 draft） ═══════════

  async validateBaseline(actor: MvActor, baselineId: string): Promise<MvValidationResult> {
    const db = this.requireDb();
    await db.withTenant(actor.tenant_id, async (tx) => {
      const { record } = await loadBaselineForUser(tx, actor, baselineId);
      if (record.status !== 'draft') {
        throw new ReasonCodeException(
          'mv.baseline_state_invalid',
          '口径已冻结（active/retired 不可校核）',
          { current_status: record.status, allowed: ['draft'] },
        );
      }
    });
    const run = await this.runValidationFor(actor, baselineId, undefined);
    await db.withTenant(actor.tenant_id, async (tx) => {
      await tx.query(
        `UPDATE mv_baseline SET validation_result = $2, model_params = $3
         WHERE tenant_id = $1 AND id = $4 AND status = 'draft'`,
        [
          actor.tenant_id,
          JSON.stringify(run.validation),
          JSON.stringify(run.modelParams),
          baselineId,
        ],
      );
    });
    return run.validation;
  }

  // ═══════════ §6.6 :activate / §6.7 :retire ═══════════

  async activateBaseline(
    actor: MvActor,
    baselineId: string,
    body: MvBaselineActivate,
  ): Promise<{ id: string; status: 'active'; superseded: string[] }> {
    const db = this.requireDb();
    // 激活门槛①②：数据窗 + 拟合（§3.5 三重门槛的前两重，激活时点新鲜复核）
    const run = await this.runValidationFor(actor, baselineId, undefined);
    if (
      run.validation.window.period_days < MV_MIN_BASELINE_DAYS ||
      run.validation.window.coverage < MV_WINDOW_COVERAGE_MIN
    ) {
      throw new ReasonCodeException('mv.window_insufficient', '数据窗完整日或完整率不足', {
        window: run.validation.window,
      });
    }
    const fit = run.validation.fit;
    const fitMetrics = fit?.metrics ?? null;
    if (
      fit === null ||
      fitMetrics === null ||
      !fit.qualified ||
      fitMetrics.cvrmse_pct > MV_FIT_CVRMSE_MAX ||
      Math.abs(fitMetrics.nmbe_pct) > MV_FIT_NMBE_MAX
    ) {
      throw new ReasonCodeException('mv.fit_unqualified', '模型拟合未达标（CVRMSE/NMBE 线）', {
        metrics: fitMetrics,
        thresholds: { cvrmse_max_pct: MV_FIT_CVRMSE_MAX, nmbe_max_pct: MV_FIT_NMBE_MAX },
      });
    }

    return db.withTenant(actor.tenant_id, async (tx) => {
      const { record } = await loadBaselineForUser(tx, actor, baselineId);
      if (record.status !== 'draft') {
        throw new ReasonCodeException('mv.baseline_state_invalid', '仅 draft 基线可激活', {
          current_status: record.status,
          allowed: ['draft'],
        });
      }
      // 门槛③：重叠前置校验（§4.1）——冲突 active 清单
      const conflicts = await tx.query<{ id: string }>(
        `SELECT id FROM mv_baseline
         WHERE tenant_id = $1 AND status = 'active' AND id <> $2
           AND baseline_period && daterange($3, $4)`,
        [
          actor.tenant_id,
          baselineId,
          parseDaterange(record.baseline_period).start,
          parseDaterange(record.baseline_period).end,
        ],
      );
      const conflictIds = conflicts.rows.map((row) => row.id);
      if (body.supersede !== undefined) {
        // supersede 显式替代：目标须为冲突清单成员且 active（§6.6）
        if (!conflictIds.includes(body.supersede)) {
          throw new ReasonCodeException(
            'common.validation_failed',
            'supersede 目标不是当前冲突的 active 基线',
            { field: 'supersede', conflicts: conflictIds },
          );
        }
      } else if (conflictIds.length > 0) {
        throw new ReasonCodeException('mv.baseline_overlap', '与现行基线基线期重叠', {
          cause: 'precheck',
          conflicts: conflictIds,
        });
      }

      try {
        // 先退后进（§4.4 锁序：语句序满足 EXCLUDE 立即检查）
        if (body.supersede !== undefined) {
          await tx.query(
            `UPDATE mv_baseline SET status = 'retired', retired_by = $3, retired_at = now()
             WHERE tenant_id = $1 AND id = $2 AND status = 'active'`,
            [actor.tenant_id, body.supersede, actor.user_id],
          );
        }
        const activated = await tx.query(
          `UPDATE mv_baseline
             SET status = 'active', activated_by = $3, activated_at = now(),
                 validation_result = $4, model_params = $5
           WHERE tenant_id = $1 AND id = $2 AND status = 'draft'
           RETURNING id`,
          [
            actor.tenant_id,
            baselineId,
            actor.user_id,
            JSON.stringify(run.validation),
            JSON.stringify(run.modelParams),
          ],
        );
        if (activated.rowCount === 0) {
          throw new ReasonCodeException('mv.baseline_state_invalid', '仅 draft 基线可激活', {
            current_status: record.status,
            allowed: ['draft'],
          });
        }
        this.metrics.lifecycleEvents.inc({ event: 'mv_baseline_activated' });
        this.logger.info({
          msg: 'mv_baseline_activated',
          baseline_id: baselineId,
          superseded: body.supersede ?? null,
          actor: actor.user_id,
        });
        return {
          id: baselineId,
          status: 'active' as const,
          superseded: body.supersede !== undefined ? [body.supersede] : [],
        };
      } catch (err) {
        if (isExclusionViolation(err)) {
          throw new ReasonCodeException('mv.baseline_overlap', '与现行基线基线期重叠（并发兜底）', {
            cause: 'db_constraint',
          });
        }
        throw err;
      }
    });
  }

  async retireBaseline(
    actor: MvActor,
    baselineId: string,
  ): Promise<{ id: string; status: 'retired' }> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      await loadBaselineForUser(tx, actor, baselineId);
      const result = await tx.query(
        `UPDATE mv_baseline SET status = 'retired', retired_by = $3, retired_at = now()
         WHERE tenant_id = $1 AND id = $2 AND status = 'active'
         RETURNING id`,
        [actor.tenant_id, baselineId, actor.user_id],
      );
      if (result.rowCount === 0) {
        throw new ReasonCodeException('mv.baseline_state_invalid', '仅 active 基线可停用', {
          current_status: 'retired 或 draft',
          allowed: ['active'],
        });
      }
      this.logger.info({
        msg: 'mv_baseline_retired',
        baseline_id: baselineId,
        actor: actor.user_id,
      });
      return { id: baselineId, status: 'retired' as const };
    });
  }

  // ═══════════ §6.8/§6.9 报告列表/详情 ═══════════

  async listReports(actor: MvActor, query: MvReportsQuery): Promise<MvReportList> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const scope = await loadBuildingScope(tx, actor);
      const params: unknown[] = [actor.tenant_id, query.limit + 1];
      const predicates: string[] = ['r.tenant_id = $1'];
      if (query.building_id !== undefined) {
        if (scope !== null && !scope.has(query.building_id)) {
          throw new ReasonCodeException('mv.report_not_found', '资源不存在');
        }
        params.push(query.building_id);
        predicates.push(`b.building_id = $${String(params.length)}`);
      } else if (scope !== null) {
        params.push([...scope]);
        predicates.push(`b.building_id = ANY($${String(params.length)}::uuid[])`);
      }
      if (query.baseline_id !== undefined) {
        params.push(query.baseline_id);
        predicates.push(`r.baseline_id = $${String(params.length)}`);
      }
      if (query.approved !== undefined) {
        params.push(query.approved);
        predicates.push(`(r.approved_by IS NOT NULL) = $${String(params.length)}`);
      }
      if (query.degraded !== undefined) {
        params.push(query.degraded);
        predicates.push(`(r.weather_adjusted_saving_kwh IS NULL) = $${String(params.length)}`);
      }
      if (query.cursor !== undefined) {
        const cursor = decodeMvCursor(query.cursor, 1);
        const keyset = mvKeysetPredicate(
          '(extract(epoch FROM r.generated_at) * 1e6)::bigint',
          'r.id::text',
          cursor,
          params.length + 1,
        );
        predicates.push(keyset.sql);
        params.push(...keyset.params);
      }
      const result = await tx.query<Record<string, unknown>>(
        `SELECT r.id, r.baseline_id, r.report_period::text AS report_period,
                r.baseline_energy_kwh, r.actual_energy_kwh, r.weather_adjusted_saving_kwh,
                r.generated_at, r.approved_by, r.approved_at
         FROM mv_report r JOIN mv_baseline b ON b.tenant_id = r.tenant_id AND b.id = r.baseline_id
         WHERE ${predicates.join(' AND ')}
         ORDER BY r.generated_at DESC, r.id DESC
         LIMIT $2`,
        params,
      );
      const rows = result.rows;
      const items = rows.slice(0, query.limit).map(mapReportSummary);
      const last = rows[query.limit - 1];
      return {
        items,
        next_cursor:
          rows.length > query.limit && last !== undefined
            ? encodeMvCursor({
                k: [toEpochMicros(last.generated_at as Date)],
                id: last.id as string,
              })
            : null,
      };
    });
  }

  /**
   * 报告详情（§6.9）：冻结列直读 + 派生面（status/degraded/raw_saving/report_no/
   * late_buffer）+ series/calib 重算（model_params 冻结值直接复用，不复拟合 §3.6）。
   * series 重算 TSDB 读失败 → 空 series 降级（结算列不依赖 TSDB，§6.9 交付说明）。
   */
  async reportDetail(actor: MvActor, reportId: string): Promise<MvReportDetail> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const loaded = await loadReportForUser(tx, actor, reportId);
      const { report, baseline, buildingName } = loaded;
      const period = parseDaterange(report.report_period as string);
      const series = await this.recomputeSeries(actor, baseline, period);
      const generatedAt = report.generated_at as Date;
      const lateBuffer =
        generatedAt.getTime() - Date.parse(`${period.end}T00:00:00Z`) <
        MV_LATE_BUFFER_DAYS * 86_400_000;
      return {
        ...mapReportSummary(report),
        baseline_energy_kwh: Number(report.baseline_energy_kwh),
        actual_energy_kwh: Number(report.actual_energy_kwh),
        confidence_interval:
          (report.confidence_interval as MvReportDetail['confidence_interval']) ?? null,
        imputed_days: series.imputedDays,
        late_buffer: lateBuffer,
        requested_by: report.requested_by as string,
        approved_by: (report.approved_by as string | null) ?? null,
        report_no: buildReportNo(
          buildingCodeOf(buildingName, baseline.building_id),
          period,
          report.id as string,
        ),
        series: [...series.points],
        calib: {
          model_params: baseline.model_params,
          validation: baseline.validation_result,
        },
      };
    });
  }

  // ═══════════ §6.10 DELETE / §6.11 :approve ═══════════

  async deleteReport(actor: MvActor, reportId: string): Promise<void> {
    const db = this.requireDb();
    await db.withTenant(actor.tenant_id, async (tx) => {
      await loadReportForUser(tx, actor, reportId);
      // 0011 FK RESTRICT + 成功任务 CHECK 的唯一一致读法：删报告行前清理引用它的
      // 历史任务行（当前在飞任务不指向未审批旧报告；§4.2 删除重出口径不变）
      await tx.query(`DELETE FROM mv_generation_job WHERE tenant_id = $1 AND report_id = $2`, [
        actor.tenant_id,
        reportId,
      ]);
      const result = await tx.query(
        `DELETE FROM mv_report WHERE tenant_id = $1 AND id = $2 AND approved_by IS NULL`,
        [actor.tenant_id, reportId],
      );
      if (result.rowCount === 0) {
        throw new ReasonCodeException('mv.report_state_invalid', '已审批报告锁定不可删', {
          current_status: 'approved',
          allowed: ['pending_approval'],
        });
      }
      this.logger.info({ msg: 'mv_report_deleted', report_id: reportId, actor: actor.user_id });
    });
  }

  /** approve 条件 UPDATE 单赢家（§4.4）；重复 approve / 非 pending → 409（审批不幂等）。 */
  async approveReport(actor: MvActor, reportId: string): Promise<MvReportApproveResponse> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      await loadReportForUser(tx, actor, reportId);
      const result = await tx.query<{ id: string; approved_by: string; approved_at: Date }>(
        `UPDATE mv_report SET approved_by = $3, approved_at = now()
         WHERE tenant_id = $1 AND id = $2 AND approved_by IS NULL
         RETURNING id, approved_by, approved_at`,
        [actor.tenant_id, reportId, actor.user_id],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new ReasonCodeException('mv.report_state_invalid', '报告已审批或不可审批', {
          current_status: 'approved',
          allowed: ['pending_approval'],
        });
      }
      this.metrics.lifecycleEvents.inc({ event: 'mv_report_approved' });
      this.logger.info({ msg: 'mv_report_approved', report_id: reportId, actor: actor.user_id });
      return {
        id: row.id,
        status: 'approved' as const,
        approved_by: row.approved_by,
        approved_at: row.approved_at.toISOString(),
      };
    });
  }

  // ═══════════ §6.14 天气站点 ═══════════

  async listWeatherStations(): Promise<MvWeatherStationsResponse> {
    const tsdb = this.requireTsdb();
    return guardTsdb(async () => ({ items: await tsdb.listStations() }));
  }

  // ═══════════ 内部 ═══════════

  private async runValidationFor(
    actor: MvActor,
    baselineId: string,
    specOverride?: { t_cool_c?: number; t_heat_c?: number; weekend_dummy?: boolean },
  ) {
    const db = this.requireDb();
    const tsdb = this.requireTsdb();
    const loaded = await db.withTenant(actor.tenant_id, async (tx) => {
      const { record } = await loadBaselineForUser(tx, actor, baselineId);
      const points = await tx.query<{ point_id: string }>(
        `SELECT point_id FROM mv_baseline_point WHERE baseline_id = $1 ORDER BY point_id`,
        [baselineId],
      );
      return {
        record,
        pointIds: points.rows.map((row) => Number(row.point_id)),
      };
    });
    return guardTsdb(() =>
      runValidation(tsdb, {
        period: parseDaterange(loaded.record.baseline_period),
        pointIds: loaded.pointIds,
        stationId: loaded.record.weather_source,
        spec: effectiveSpec(loaded.record.model_params, specOverride),
      }),
    );
  }

  /** 详情 series 重算（§6.9 交付口径：冻结模型 + 当前 TSDB 数据，确定性复算）。 */
  private async recomputeSeries(
    actor: MvActor,
    baseline: BaselineRecord,
    period: { start: string; end: string },
  ): Promise<{ points: MvReportDetail['series']; imputedDays: number }> {
    if (baseline.model_params?.coefficients === null || baseline.model_params === null) {
      return { points: [], imputedDays: 0 };
    }
    try {
      const db = this.requireDb();
      const tsdb = this.requireTsdb();
      const pointIds = await db.withTenant(actor.tenant_id, async (tx) => {
        const points = await tx.query<{ point_id: string }>(
          `SELECT point_id FROM mv_baseline_point WHERE baseline_id = $1`,
          [baseline.id],
        );
        return points.rows.map((row) => Number(row.point_id));
      });
      const periodDates = enumerateDates(period.start, period.end);
      const preStart = shiftDate(period.start, -1);
      const [pointStats, weatherStats] = await Promise.all([
        tsdb.pointDayStats(pointIds, preStart, period.end),
        tsdb.weatherDayStats(
          baseline.weather_source,
          period.start,
          period.end,
          baseline.model_params.spec.t_cool_c,
          baseline.model_params.spec.t_heat_c,
        ),
      ]);
      const energy = assembleDayEnergy(periodDates, pointIds, pointStats, {
        dayHoursMin: MV_DAY_HOURS_MIN,
        badRatioMax: MV_DAY_BAD_RATIO_MAX,
        preStartDate: preStart,
      });
      const weatherByDay = assembleWeatherByDay(weatherStats, MV_WEATHER_HOURS_MIN);
      const model = {
        coefficients: baseline.model_params.coefficients,
        sigma_kwh: baseline.model_params.sigma_kwh ?? 0,
        n_obs: baseline.model_params.n_obs,
        xtx_inv: baseline.model_params.xtx_inv ?? [],
        fit_daily_mean_kwh: baseline.model_params.fit_daily_mean_kwh ?? 0,
        fit_mean_row: baseline.model_params.fit_mean_row ?? [1, 0, 0, 0],
        metrics: { cvrmse_pct: baseline.model_params.metrics?.cvrmse_pct ?? 0 },
        spec: {
          t_cool_c: baseline.model_params.spec.t_cool_c,
          t_heat_c: baseline.model_params.spec.t_heat_c,
          weekend_dummy: baseline.model_params.spec.weekend_dummy,
        },
      };
      const result = computeReport({
        periodDates,
        energyByDay: energy.energyByDay,
        weatherByDay,
        model,
        ciLevel: MV_CI_LEVEL,
        periodWeatherMin: MV_PERIOD_WEATHER_MIN,
        uncertaintyRatioMax: MV_UNCERTAINTY_RATIO_MAX,
      });
      return { points: [...result.series], imputedDays: result.imputed_days };
    } catch (err) {
      this.logger.warn({ msg: 'mv_report_series_recompute_failed', report_period: period, err });
      return { points: [], imputedDays: 0 };
    }
  }
}

// ---------------------------------------------------------------------------
// 内部装载器与映射
// ---------------------------------------------------------------------------

export interface ReportRecord {
  readonly id: string;
  readonly baseline_id: string;
  readonly report_period: string;
  readonly baseline_energy_kwh: string;
  readonly actual_energy_kwh: string;
  readonly weather_adjusted_saving_kwh: string | null;
  readonly confidence_interval: unknown;
  readonly generated_at: Date;
  readonly approved_by: string | null;
  readonly approved_at: Date | null;
  readonly requested_by: string;
}

export function mapReportSummary(row: Record<string, unknown>): MvReportSummary {
  const period = parseDaterange(row.report_period as string);
  const baseline = Number(row.baseline_energy_kwh);
  const actual = Number(row.actual_energy_kwh);
  const adjusted =
    row.weather_adjusted_saving_kwh === null || row.weather_adjusted_saving_kwh === undefined
      ? null
      : Number(row.weather_adjusted_saving_kwh);
  return {
    id: row.id as string,
    baseline_id: row.baseline_id as string,
    report_period: period,
    status:
      row.approved_by !== null && row.approved_by !== undefined ? 'approved' : 'pending_approval',
    degraded: adjusted === null,
    weather_adjusted_saving_kwh: adjusted,
    raw_saving_kwh: baseline - actual,
    generated_at: (row.generated_at as Date).toISOString(),
    approved_at:
      row.approved_at === null || row.approved_at === undefined
        ? null
        : (row.approved_at as Date).toISOString(),
  };
}

/** 报告 load-for-user（经 baseline → building 解析，§1.5）。 */
export async function loadReportForUser(
  tx: PoolClient,
  actor: MvActor,
  reportId: string,
): Promise<{
  report: Record<string, unknown>;
  baseline: BaselineRecord;
  buildingName: string | null;
}> {
  const scope = await loadBuildingScope(tx, actor);
  const result = await tx.query<Record<string, unknown>>(
    `SELECT r.id, r.baseline_id, r.report_period::text AS report_period,
            r.baseline_energy_kwh, r.actual_energy_kwh, r.weather_adjusted_saving_kwh,
            r.confidence_interval, r.generated_at, r.approved_by, r.approved_at, r.requested_by
     FROM mv_report r
     WHERE r.tenant_id = $1 AND r.id = $2`,
    [actor.tenant_id, reportId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ReasonCodeException('mv.report_not_found', '资源不存在', { entity: 'report' });
  }
  const baselineResult = await tx.query<Record<string, unknown>>(
    `SELECT b.id, b.building_id, b.method, b.baseline_period::text AS baseline_period, b.model_type, b.model_params, b.weather_source, b.status, b.validation_result, b.activated_by, b.activated_at, b.retired_by, b.retired_at, b.created_at
     FROM mv_baseline b
     WHERE b.tenant_id = $1 AND b.id = $2`,
    [actor.tenant_id, row.baseline_id],
  );
  const baselineRow = baselineResult.rows[0];
  if (baselineRow === undefined) {
    throw new ReasonCodeException('mv.report_not_found', '资源不存在', { entity: 'report' });
  }
  const baseline = mapBaselineRow(baselineRow);
  if (scope !== null && !scope.has(baseline.building_id)) {
    throw new ReasonCodeException('mv.report_not_found', '资源不存在', { entity: 'report' });
  }
  const building = await tx.query<{ name: string }>(
    `SELECT name FROM building WHERE tenant_id = $1 AND id = $2`,
    [actor.tenant_id, baseline.building_id],
  );
  return {
    report: row,
    baseline,
    buildingName: building.rows[0]?.name ?? null,
  };
}

/** 计量边界校验（§2.2）：属楼宇 / energy 量型 / active；违例 → 422 offenders 全集。 */
async function assertMeteringPoints(
  tx: PoolClient,
  tenantId: string,
  buildingId: string,
  pointIds: readonly number[],
): Promise<void> {
  const result = await tx.query<{
    point_id: string;
    building_id: string | null;
    quantity_type: string | null;
    status: string | null;
  }>(
    `SELECT p.id AS point_id, p.building_id, p.quantity_type, p.status
     FROM point p
     WHERE p.tenant_id = $1 AND p.id = ANY($2::bigint[])`,
    [tenantId, pointIds],
  );
  const found = new Map(result.rows.map((row) => [Number(row.point_id), row]));
  const offenders: { point_id: number; reason: string }[] = [];
  for (const pointId of pointIds) {
    const row = found.get(pointId);
    if (row === undefined) {
      offenders.push({ point_id: pointId, reason: 'not_found' });
    } else if (row.building_id !== buildingId) {
      offenders.push({ point_id: pointId, reason: 'building_mismatch' });
    } else if (row.quantity_type !== 'energy') {
      offenders.push({ point_id: pointId, reason: 'quantity_type_not_energy' });
    } else if (row.status !== 'active') {
      offenders.push({ point_id: pointId, reason: 'point_not_active' });
    }
  }
  if (offenders.length > 0) {
    throw new ReasonCodeException('mv.metering_points_invalid', '计量边界点位集非法', {
      offenders,
    });
  }
}

async function insertMeteringPoints(
  tx: PoolClient,
  tenantId: string,
  baselineId: string,
  pointIds: readonly number[],
): Promise<void> {
  const values: unknown[] = [tenantId, baselineId];
  const tuples = pointIds.map((pointId) => {
    values.push(pointId);
    return `($1, $2, $${String(values.length)})`;
  });
  await tx.query(
    `INSERT INTO mv_baseline_point (tenant_id, baseline_id, point_id) VALUES ${tuples.join(', ')}`,
    values,
  );
}

/** PATCH 的 spec 合并（保留拟合族字段，仅换输入 spec——拟合族待 :validate 刷新）。 */
function mergeSpec(
  record: BaselineRecord,
  overrides?: {
    t_cool_c?: number | undefined;
    t_heat_c?: number | undefined;
    weekend_dummy?: boolean | undefined;
  },
): MvModelParams | null {
  const current = record.model_params;
  if (current === null) {
    const spec = effectiveSpec(null, overrides);
    return {
      model_type: record.model_type as MvModelParams['model_type'],
      model_version: 1,
      spec,
      coefficients: null,
      stderrs: null,
      sigma_kwh: null,
      n_obs: 0,
      metrics: null,
      xtx_inv: null,
      fit_daily_mean_kwh: null,
      fit_mean_row: null,
      fitted_days: 0,
      season_coverage: 'partial',
      fit_run_at: null,
    };
  }
  return {
    ...current,
    spec: effectiveSpec(current, overrides),
  };
}

/** PG 排除约束冲突（mv_baseline_no_active_overlap 并发窄窗，§2.1）。 */
export function isExclusionViolation(err: unknown): boolean {
  return err !== null && typeof err === 'object' && (err as { code?: unknown }).code === '23P01';
}
