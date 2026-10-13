/**
 * M&V 报告生成服务（modules/M9-mv-report.md §5 执行契约/§6.2；IMPL-21 / DAT-242）。
 *
 * 计算归属 = api 进程内异步（§5 R9 定夺：TS 应用族经 tsdb_api 只读消费 cagg +
 * 天气域，算法对 PG 零直连）。执行序列：(a) 同步前置（404/409/422 族，作业不入库）
 * → (b) 建作业 queued → setImmediate 异步执行 → (c) 前置复核（竞态兜底）→
 * (d) TSDB 双查询 → (e) §3.6 计算（冻结模型直接复用，不复拟合）→ (f) 落库事务
 * （删未审批旧行 → 插新行 → job succeeded；失败零报告行残留）→ (g) 指标 + 埋点。
 *
 * 幂等与并发（§4.4）：同（基线×期）在飞 partial UNIQUE 库级守卫——后到合并返回
 * 既有 job（202 同 id）；单任务硬超时 15 min（PRD §10 + 余量）；failed 不自动重试。
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { randomUUID } from 'node:crypto';
import {
  MV_CI_LEVEL,
  MV_DAY_BAD_RATIO_MAX,
  MV_DAY_HOURS_MIN,
  MV_GENERATION_CONCURRENCY,
  MV_PERIOD_ENERGY_MIN,
  MV_PERIOD_WEATHER_MIN,
  MV_REPORT_PERIOD_MAX_DAYS,
  MV_REPORT_PERIOD_MIN_DAYS,
  MV_UNCERTAINTY_RATIO_MAX,
  MV_WEATHER_HOURS_MIN,
  type MvGenerateRequest,
  type MvGenerateResponse,
  type MvGenerationJob,
  type MvJobFailure,
} from '@thermio/shared-types';
import { TENANT_DB } from '../infrastructure/db/db.tokens.js';
import type { TenantDb } from '../infrastructure/db/tenant-db.js';
import { LOGGER } from '../infrastructure/logger.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { buildingCodeOf, buildReportNo, computeReport, enumerateDates } from './mv-calc.js';
import {
  guardTsdb,
  loadBaselineForUser,
  loadBuildingScopeForActor,
  mapBaselineRow,
  parseDaterange,
  shiftDate,
  type MvActor,
} from './mv-shared.js';
import { MV_TSDB } from './mv.tokens.js';
import type { MvTsdbStore } from './mv-tsdb.repository.js';
import { MvMetrics } from './mv.metrics.js';
import { assembleDayEnergy, assembleWeatherByDay } from './mv-calc.js';

/** 单任务硬超时（§5：≤10min 目标 + 余量）。 */
const JOB_TIMEOUT_MS = 15 * 60 * 1000;

@Injectable()
export class MvGenerateService {
  private readonly logger: Logger;
  private readonly tsdb: MvTsdbStore | null;

  constructor(
    @Inject(TENANT_DB) private readonly db: TenantDb | null,
    @Inject(LOGGER) rootLogger: Logger,
    @Inject(MV_TSDB) tsdb: MvTsdbStore | null,
    @Inject(MvMetrics) private readonly metrics: MvMetrics,
  ) {
    this.logger = rootLogger.child({ component: 'mv-generate' });
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

  // ═══════════ §6.2 POST /mv/reports/generate（同步前置全过才 202） ═══════════

  async generate(actor: MvActor, body: MvGenerateRequest): Promise<MvGenerateResponse> {
    const db = this.requireDb();
    const tsdb = this.requireTsdb();
    const today = new Date().toISOString().slice(0, 10);

    // ① 404（越权/不存在同响应）+ 非 active 409
    const baseline = await db.withTenant(actor.tenant_id, async (tx) => {
      const { record } = await loadBaselineForUser(tx, actor, body.baseline_id);
      return record;
    });
    if (baseline.status !== 'active') {
      throw new ReasonCodeException('mv.baseline_not_active', '仅 active 基线可生成报告', {
        current_status: baseline.status,
      });
    }

    // ② 期值域 422（§1.2：起止颠倒由 zod；长度越界/期起早于基线期止/期止非已完成日）
    const days =
      (Date.parse(`${body.period.end}T00:00:00Z`) - Date.parse(`${body.period.start}T00:00:00Z`)) /
      86_400_000;
    const baselinePeriod = parseDaterange(baseline.baseline_period);
    if (
      days < MV_REPORT_PERIOD_MIN_DAYS ||
      days > MV_REPORT_PERIOD_MAX_DAYS ||
      body.period.start < baselinePeriod.end ||
      body.period.end >= today
    ) {
      throw new ReasonCodeException('mv.period_invalid', '报告期值域非法', {
        rules: {
          min_days: MV_REPORT_PERIOD_MIN_DAYS,
          max_days: MV_REPORT_PERIOD_MAX_DAYS,
          start_not_before_baseline_end: baselinePeriod.end,
          end_before_today: today,
        },
      });
    }

    // ③ 期能量完整率同步精确校验（AC-4 前置载体；拒绝则作业不入库）
    const periodDates = enumerateDates(body.period.start, body.period.end);
    const preStart = shiftDate(body.period.start, -1);
    const pointIds = await db.withTenant(actor.tenant_id, async (tx) => {
      const points = await tx.query<{ point_id: string }>(
        `SELECT point_id FROM mv_baseline_point WHERE baseline_id = $1`,
        [baseline.id],
      );
      return points.rows.map((row) => Number(row.point_id));
    });
    const pointStats = await guardTsdb(() =>
      tsdb.pointDayStats(pointIds, preStart, body.period.end),
    );
    const energy = assembleDayEnergy(periodDates, pointIds, pointStats, {
      dayHoursMin: MV_DAY_HOURS_MIN,
      badRatioMax: MV_DAY_BAD_RATIO_MAX,
      preStartDate: preStart,
    });
    const coverage = periodDates.length > 0 ? energy.complete_days / periodDates.length : 0;
    if (coverage < MV_PERIOD_ENERGY_MIN) {
      throw new ReasonCodeException('mv.period_data_insufficient', '报告期能量数据完整率不足', {
        coverage,
        required: MV_PERIOD_ENERGY_MIN,
        gaps: energy.gaps,
      });
    }

    // ④ 在飞合并（§4.4：同基线×期 queued/running → 202 同 id，幂等语义非报错）
    const inFlight = await db.withTenant(actor.tenant_id, async (tx) => {
      const result = await tx.query<{ id: string }>(
        `SELECT id FROM mv_generation_job
         WHERE tenant_id = $1 AND baseline_id = $2 AND report_period = daterange($3, $4)
           AND status IN ('queued','running')`,
        [actor.tenant_id, baseline.id, body.period.start, body.period.end],
      );
      return result.rows[0]?.id;
    });
    if (inFlight !== undefined) {
      return { job_id: inFlight, report_id: null, status: 'queued' };
    }

    // ⑤ period_locked（§4.4：已审批同基线×期 → 409，不静默覆盖）
    const locked = await db.withTenant(actor.tenant_id, async (tx) => {
      const result = await tx.query<{ id: string }>(
        `SELECT id FROM mv_report
         WHERE tenant_id = $1 AND baseline_id = $2 AND report_period = daterange($3, $4)
           AND approved_by IS NOT NULL`,
        [actor.tenant_id, baseline.id, body.period.start, body.period.end],
      );
      return result.rows[0]?.id;
    });
    if (locked !== undefined) {
      throw new ReasonCodeException('mv.report_period_locked', '该基线×报告期已有已审批报告', {
        report_id: locked,
      });
    }

    // ⑥ 并发限流（§1.7：每租户在飞 ≤2，超出 429）
    const inFlightCount = await db.withTenant(actor.tenant_id, async (tx) => {
      const result = await tx.query<{ count: string }>(
        `SELECT count(*) AS count FROM mv_generation_job
         WHERE tenant_id = $1 AND status IN ('queued','running')`,
        [actor.tenant_id],
      );
      return Number(result.rows[0]?.count ?? 0);
    });
    if (inFlightCount >= MV_GENERATION_CONCURRENCY) {
      throw new ReasonCodeException('common.rate_limited', '生成任务并发超限', {
        limit: MV_GENERATION_CONCURRENCY,
      });
    }

    // ⑦ 建作业（partial UNIQUE 窄窗兜底：并发插入失败 → 返回既有 job）
    const jobId = randomUUID();
    try {
      await db.withTenant(actor.tenant_id, async (tx) => {
        await tx.query(
          `INSERT INTO mv_generation_job (id, tenant_id, baseline_id, report_period, requested_by)
           VALUES ($1, $2, $3, daterange($4, $5), $6)`,
          [jobId, actor.tenant_id, baseline.id, body.period.start, body.period.end, actor.user_id],
        );
      });
    } catch (err) {
      if ((err as { code?: unknown }).code === '23505') {
        const merged = await db.withTenant(actor.tenant_id, async (tx) => {
          const result = await tx.query<{ id: string }>(
            `SELECT id FROM mv_generation_job
             WHERE tenant_id = $1 AND baseline_id = $2 AND report_period = daterange($3, $4)
               AND status IN ('queued','running')`,
            [actor.tenant_id, baseline.id, body.period.start, body.period.end],
          );
          return result.rows[0]?.id;
        });
        if (merged !== undefined) return { job_id: merged, report_id: null, status: 'queued' };
      }
      throw err;
    }

    const tenantId = actor.tenant_id;
    setImmediate(() => {
      this.executeJob(tenantId, jobId).catch((err: unknown) => {
        this.logger.error({ msg: 'mv_generation_worker_crashed', job_id: jobId, err });
      });
    });
    return { job_id: jobId, report_id: null, status: 'queued' };
  }

  // ═══════════ §6.3 GET /mv/generation-jobs/{id} ═══════════

  async jobDetail(actor: MvActor, jobId: string): Promise<MvGenerationJob> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT j.id, j.baseline_id, j.report_period::text AS report_period, j.status,
                j.failure, j.report_id, j.created_at, j.started_at, j.finished_at
         FROM mv_generation_job j
         WHERE j.tenant_id = $1 AND j.id = $2`,
        [actor.tenant_id, jobId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new ReasonCodeException('mv.report_not_found', '资源不存在', {
          entity: 'generation_job',
        });
      }
      // 授权楼宇经 baseline 解析（§6.3）
      const baseline = await tx.query<{ building_id: string }>(
        `SELECT building_id FROM mv_baseline WHERE tenant_id = $1 AND id = $2`,
        [actor.tenant_id, row.baseline_id],
      );
      const scope = await loadBuildingScopeForActor(tx, actor);
      const buildingId = baseline.rows[0]?.building_id;
      if (scope !== null && (buildingId === undefined || !scope.has(buildingId))) {
        throw new ReasonCodeException('mv.report_not_found', '资源不存在', {
          entity: 'generation_job',
        });
      }
      return {
        id: row.id as string,
        baseline_id: row.baseline_id as string,
        report_period: parseDaterange(row.report_period as string),
        status: row.status as MvGenerationJob['status'],
        failure: (row.failure as MvJobFailure | null) ?? null,
        report_id: (row.report_id as string | null) ?? null,
        created_at: (row.created_at as Date).toISOString(),
        started_at: row.started_at === null ? null : (row.started_at as Date).toISOString(),
        finished_at: row.finished_at === null ? null : (row.finished_at as Date).toISOString(),
      };
    });
  }

  // ═══════════ §5 异步执行器 ═══════════

  private async executeJob(tenantId: string, jobId: string): Promise<void> {
    const db = this.requireDb();
    const started = Date.now();
    await db.withTenant(tenantId, async (tx) => {
      await tx.query(
        `UPDATE mv_generation_job SET status = 'running', started_at = now()
         WHERE id = $1 AND status = 'queued'`,
        [jobId],
      );
    });
    try {
      await Promise.race([
        this.runComputation(tenantId, jobId),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => {
            reject(new JobTimeoutError());
          }, JOB_TIMEOUT_MS);
          timer.unref();
        }),
      ]);
      this.metrics.generationDuration.set((Date.now() - started) / 1000);
    } catch (err) {
      const failure = failureOf(err);
      await db.withTenant(tenantId, async (tx) => {
        await tx.query(
          `UPDATE mv_generation_job SET status = 'failed', failure = $2, finished_at = now()
           WHERE id = $1 AND status = 'running'`,
          [jobId, JSON.stringify(failure)],
        );
      });
      this.metrics.generationFailures.inc({ stage: failure.stage });
      this.logger.warn({ msg: 'mv_generation_failed', job_id: jobId, failure });
    }
  }

  private async runComputation(tenantId: string, jobId: string): Promise<void> {
    const db = this.requireDb();
    const tsdb = this.requireTsdb();

    // (c) 前置复核（§6.2：同步校验后数据被改动的窄窗竞态兜底）
    const context = await db.withTenant(tenantId, async (tx) => {
      const job = await tx.query<Record<string, unknown>>(
        `SELECT baseline_id, report_period::text AS report_period FROM mv_generation_job
         WHERE id = $1 AND status = 'running'`,
        [jobId],
      );
      const row = job.rows[0];
      if (row === undefined) throw new JobFailureError('precheck', 'job_not_running');
      const baseline = mapBaselineRow(
        (
          await tx.query<Record<string, unknown>>(
            `SELECT * FROM mv_baseline WHERE tenant_id = $1 AND id = $2`,
            [tenantId, row.baseline_id],
          )
        ).rows[0] as Record<string, unknown>,
      );
      const points = await tx.query<{ point_id: string }>(
        `SELECT point_id FROM mv_baseline_point WHERE baseline_id = $1`,
        [baseline.id],
      );
      const building = await tx.query<{ name: string }>(
        `SELECT name FROM building WHERE tenant_id = $1 AND id = $2`,
        [tenantId, baseline.building_id],
      );
      return {
        baseline,
        period: parseDaterange(row.report_period as string),
        pointIds: points.rows.map((p) => Number(p.point_id)),
        buildingName: building.rows[0]?.name ?? null,
      };
    });

    if (context.baseline.status !== 'active') {
      throw new JobFailureError('precheck', 'mv.baseline_not_active');
    }
    if (
      context.baseline.model_params === null ||
      context.baseline.model_params.coefficients === null ||
      context.baseline.model_params.xtx_inv === null ||
      context.baseline.model_params.fit_daily_mean_kwh === null ||
      context.baseline.model_params.fit_mean_row === null
    ) {
      throw new JobFailureError('precheck', 'mv.fit_unqualified');
    }

    // (d) TSDB 双查询（§3.2/§3.3）
    const periodDates = enumerateDates(context.period.start, context.period.end);
    const preStart = shiftDate(context.period.start, -1);
    const [pointStats, weatherStats] = await Promise.all([
      tsdb.pointDayStats(context.pointIds, preStart, context.period.end),
      tsdb.weatherDayStats(
        context.baseline.weather_source,
        context.period.start,
        context.period.end,
        context.baseline.model_params.spec.t_cool_c,
        context.baseline.model_params.spec.t_heat_c,
      ),
    ]);
    const energy = assembleDayEnergy(periodDates, context.pointIds, pointStats, {
      dayHoursMin: MV_DAY_HOURS_MIN,
      badRatioMax: MV_DAY_BAD_RATIO_MAX,
      preStartDate: preStart,
    });
    const coverage = periodDates.length > 0 ? energy.complete_days / periodDates.length : 0;
    if (coverage < MV_PERIOD_ENERGY_MIN) {
      // 复验失败：failed + 缺口明细，零报告行残留（AC-3/AC-4）
      throw new JobFailureError('query', 'mv.period_data_insufficient', {
        coverage,
        gaps: energy.gaps,
      });
    }
    const weatherByDay = assembleWeatherByDay(weatherStats, MV_WEATHER_HOURS_MIN);

    // (e) §3.6 计算（冻结模型直接复用）
    const params = context.baseline.model_params;
    const coefficients = params.coefficients as NonNullable<typeof params.coefficients>;
    const xtxInv = params.xtx_inv ?? [];
    const fitMeanRow = params.fit_mean_row ?? [1, 0, 0, 0];
    const result = computeReport({
      periodDates,
      energyByDay: energy.energyByDay,
      weatherByDay,
      model: {
        coefficients,
        sigma_kwh: params.sigma_kwh ?? 0,
        n_obs: params.n_obs,
        xtx_inv: xtxInv,
        fit_daily_mean_kwh: params.fit_daily_mean_kwh as number,
        fit_mean_row: fitMeanRow,
        metrics: { cvrmse_pct: params.metrics?.cvrmse_pct ?? 0 },
        spec: {
          t_cool_c: params.spec.t_cool_c,
          t_heat_c: params.spec.t_heat_c,
          weekend_dummy: params.spec.weekend_dummy,
        },
      },
      ciLevel: MV_CI_LEVEL,
      periodWeatherMin: MV_PERIOD_WEATHER_MIN,
      uncertaintyRatioMax: MV_UNCERTAINTY_RATIO_MAX,
    });

    // (f) 落库事务：删未审批旧行 → 插新行 → job succeeded（upsert 语义，§4.4）
    // R1 超时竞态门控（DAT-242 验收发现，随 DAT-246 捎带）：事务首步 SELECT status
    // FOR UPDATE——Promise.race 超时路径已把 job 置 failed 时，迟到的计算结果不再
    // 落报告行（否则残留「job failed + 报告行」的语义分裂，报告行可见但任务态断言失败）。
    const reportId = randomUUID();
    const reportNo = buildReportNo(
      buildingCodeOf(context.buildingName, context.baseline.building_id),
      context.period,
      reportId,
    );
    await db.withTenant(tenantId, async (tx) => {
      const gate = await tx.query<{ status: string }>(
        `SELECT status FROM mv_generation_job WHERE id = $1 FOR UPDATE`,
        [jobId],
      );
      if (gate.rows[0]?.status !== 'running') {
        throw new JobFailureError('commit', 'mv.generation_timeout_committed');
      }
      // 未审批旧行换代（§4.4 upsert）：先清引用旧报告的历史任务行（FK RESTRICT）
      await tx.query(
        `DELETE FROM mv_generation_job j
         USING mv_report r
         WHERE j.tenant_id = r.tenant_id AND j.report_id = r.id
           AND r.tenant_id = $1 AND r.baseline_id = $2
           AND r.report_period = daterange($3, $4) AND r.approved_by IS NULL`,
        [tenantId, context.baseline.id, context.period.start, context.period.end],
      );
      await tx.query(
        `DELETE FROM mv_report
         WHERE tenant_id = $1 AND baseline_id = $2 AND report_period = daterange($3, $4)
           AND approved_by IS NULL`,
        [tenantId, context.baseline.id, context.period.start, context.period.end],
      );
      await tx.query(
        `INSERT INTO mv_report
           (id, tenant_id, baseline_id, report_period, baseline_energy_kwh, actual_energy_kwh,
            weather_adjusted_saving_kwh, confidence_interval, requested_by)
         VALUES ($1, $2, $3, daterange($4, $5), $6, $7, $8, $9, $10)`,
        [
          reportId,
          tenantId,
          context.baseline.id,
          context.period.start,
          context.period.end,
          round3(result.baseline_energy_kwh),
          round3(result.actual_energy_kwh),
          result.weather_adjusted_saving_kwh === null
            ? null
            : round3(result.weather_adjusted_saving_kwh),
          result.confidence_interval === null ? null : JSON.stringify(result.confidence_interval),
          await requestedByOf(tx, tenantId, jobId),
        ],
      );
      await tx.query(
        `UPDATE mv_generation_job SET status = 'succeeded', report_id = $2, finished_at = now()
         WHERE id = $1 AND status = 'running'`,
        [jobId, reportId],
      );
    });

    this.metrics.lifecycleEvents.inc({ event: 'mv_report_generated' });
    this.logger.info({
      msg: 'mv_report_generated',
      job_id: jobId,
      report_id: reportId,
      report_no: reportNo,
      period_days: periodDates.length,
      degraded: result.weather_adjusted_saving_kwh === null,
    });
  }
}

/** 请求人留痕查询（job.requested_by 透传到报告行）。 */
async function requestedByOf(
  tx: import('pg').PoolClient,
  tenantId: string,
  jobId: string,
): Promise<string> {
  const result = await tx.query<{ requested_by: string }>(
    `SELECT requested_by FROM mv_generation_job WHERE tenant_id = $1 AND id = $2`,
    [tenantId, jobId],
  );
  return result.rows[0]?.requested_by as string;
}

class JobTimeoutError extends Error {
  readonly stage = 'timeout';
}

class JobFailureError extends Error {
  constructor(
    readonly stage: string,
    readonly code: string,
    readonly detail?: unknown,
  ) {
    super(code);
  }
}

function failureOf(err: unknown): MvJobFailure {
  if (err instanceof JobTimeoutError) {
    return { stage: 'timeout', code: 'mv.generation_timeout', message: '生成任务超时（15 min）' };
  }
  if (err instanceof JobFailureError) {
    return {
      stage: err.stage,
      code: err.code,
      message: `生成失败：${err.code}`,
      ...(err.detail !== undefined ? { detail: err.detail } : {}),
    };
  }
  if ((err as { name?: unknown }).name === 'TelemetryStoreUnavailableError') {
    return { stage: 'query', code: 'telemetry.store_unavailable', message: 'TSDB 查询不可用' };
  }
  return {
    stage: 'compute',
    code: 'common.internal_error',
    message: '生成任务内部错误',
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
