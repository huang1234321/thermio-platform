/**
 * M&V 域共享件：daterange 编解码、行映射、load-for-user、数据窗校核运行器
 * （M9-mv-report.md §2/§3.5；IMPL-21 / DAT-242）。
 */
import type { PoolClient } from 'pg';
import {
  MV_DAY_BAD_RATIO_MAX,
  MV_DAY_HOURS_MIN,
  MV_FIT_CVRMSE_MAX,
  MV_FIT_NMBE_MAX,
  MV_MAX_BASELINE_DAYS,
  MV_MIN_BASELINE_DAYS,
  MV_MODEL_TYPES,
  MV_T_COOL_C,
  MV_T_HEAT_C,
  MV_WEATHER_HOURS_MIN,
  MV_WINDOW_COVERAGE_MIN,
  MV_WEEKEND_DUMMY,
  type MvModelParams,
  type MvValidationResult,
  type Role,
} from '@thermio/shared-types';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { TelemetryStoreUnavailableError } from '../telemetry/telemetry-store.error.js';
import { loadBuildingScope, type BuildingScope } from '../asset/asset-shared.js';
import {
  assembleDayEnergy,
  assembleWeatherByDay,
  enumerateDates,
  fitOls,
  type OlsSpec,
} from './mv-calc.js';
import type { MvTsdbStore } from './mv-tsdb.repository.js';

/** 请求侧身份（AuthContext 的 M&V 域消费面）。 */
export interface MvActor {
  readonly tenant_id: string;
  readonly user_id: string;
  readonly role: Role;
}

// ---------------------------------------------------------------------------
// daterange 编解码（pg 文本协议 ↔ {start, end}）
// ---------------------------------------------------------------------------

const DATERANGE_PATTERN = /^\[("?\d{4}-\d{2}-\d{2}"?),("?\d{4}-\d{2}-\d{2}"?)\)$/;

/** pg daterange 文本（'[start,end)'）→ {start, end}；infinite/空域抛错（域内不出现）。 */
export function parseDaterange(value: string): { start: string; end: string } {
  const match = DATERANGE_PATTERN.exec(value);
  if (match === null) throw new Error(`无法解析 daterange：${value}`);
  const strip = (raw: string | undefined): string => (raw ?? '').replace(/"/g, '');
  return { start: strip(match[1]), end: strip(match[2]) };
}

// ---------------------------------------------------------------------------
// 行映射
// ---------------------------------------------------------------------------

export interface BaselineRecord {
  readonly id: string;
  readonly building_id: string;
  readonly method: string;
  readonly baseline_period: string;
  readonly model_type: string;
  readonly model_params: MvModelParams | null;
  readonly weather_source: string;
  readonly status: 'draft' | 'active' | 'retired';
  readonly validation_result: MvValidationResult | null;
  readonly activated_by: string | null;
  readonly activated_at: Date | null;
  readonly retired_by: string | null;
  readonly retired_at: Date | null;
  readonly created_at: Date;
}

export function mapBaselineRow(row: Record<string, unknown>): BaselineRecord {
  return {
    id: row.id as string,
    building_id: row.building_id as string,
    method: row.method as string,
    baseline_period: row.baseline_period as string,
    model_type: row.model_type as string,
    model_params: (row.model_params as MvModelParams | null) ?? null,
    weather_source: row.weather_source as string,
    status: row.status as BaselineRecord['status'],
    validation_result: (row.validation_result as MvValidationResult | null) ?? null,
    activated_by: (row.activated_by as string | null) ?? null,
    activated_at: (row.activated_at as Date | null) ?? null,
    retired_by: (row.retired_by as string | null) ?? null,
    retired_at: (row.retired_at as Date | null) ?? null,
    created_at: row.created_at as Date,
  };
}

export function baselineSummary(record: BaselineRecord): {
  id: string;
  building_id: string;
  method: string;
  baseline_period: { start: string; end: string };
  status: string;
  weather_source: string;
  model_type: string;
  season_coverage: 'full' | 'partial' | null;
  activated_at: string | null;
  created_at: string;
} {
  return {
    id: record.id,
    building_id: record.building_id,
    method: record.method,
    baseline_period: parseDaterange(record.baseline_period),
    status: record.status,
    weather_source: record.weather_source,
    model_type: record.model_type,
    season_coverage: record.model_params?.season_coverage ?? null,
    activated_at: record.activated_at?.toISOString() ?? null,
    created_at: record.created_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// load-for-user（SEC-AZ-02/03：越权与不存在同响应）
// ---------------------------------------------------------------------------

export async function loadBaselineForUser(
  tx: PoolClient,
  actor: MvActor,
  baselineId: string,
): Promise<{ record: BaselineRecord; scope: BuildingScope }> {
  const scope = await loadBuildingScope(tx, actor);
  const result = await tx.query<Record<string, unknown>>(
    `SELECT * FROM mv_baseline WHERE tenant_id = $1 AND id = $2`,
    [actor.tenant_id, baselineId],
  );
  const row = result.rows[0];
  if (row === undefined || (scope !== null && !scope.has(row.building_id as string))) {
    throw new ReasonCodeException('mv.baseline_not_found', '资源不存在');
  }
  return { record: mapBaselineRow(row), scope };
}

/** 经 baseline 解析楼宇归属的报告/任务 load-for-user（§1.5）。 */
export async function loadBuildingScopeForActor(
  tx: PoolClient,
  actor: MvActor,
): Promise<BuildingScope> {
  return loadBuildingScope(tx, actor);
}

// ---------------------------------------------------------------------------
// §3.5 数据窗校核运行器（create 首跑 / :validate 重跑 / :activate 复核共用）
// ---------------------------------------------------------------------------

export interface ValidationRun {
  readonly validation: MvValidationResult;
  readonly modelParams: MvModelParams | null;
  readonly periodDays: number;
}

/** 默认模型 spec（§3.1 参数表；PATCH 部分覆盖的合并基线）。 */
export function effectiveSpec(
  modelParams: MvModelParams | null,
  overrides?: Partial<MvSpecInput>,
): MvModelSpecResolved {
  const base: MvSpecInput = {
    t_cool_c: modelParams?.spec.t_cool_c ?? MV_T_COOL_C,
    t_heat_c: modelParams?.spec.t_heat_c ?? MV_T_HEAT_C,
    weekend_dummy: modelParams?.spec.weekend_dummy ?? MV_WEEKEND_DUMMY,
  };
  const merged = { ...base, ...overrides };
  return {
    t_cool_c: merged.t_cool_c ?? MV_T_COOL_C,
    t_heat_c: merged.t_heat_c ?? MV_T_HEAT_C,
    weekend_dummy: merged.weekend_dummy ?? MV_WEEKEND_DUMMY,
  };
}

export interface MvSpecInput {
  t_cool_c?: number | undefined;
  t_heat_c?: number | undefined;
  weekend_dummy?: boolean | undefined;
}
export interface MvModelSpecResolved {
  readonly t_cool_c: number;
  readonly t_heat_c: number;
  readonly weekend_dummy: boolean;
}

/**
 * 数据窗校验 + 拟合（§3.2–§3.5 全管线）。TSDB 不可用抛 TelemetryStoreUnavailableError
 * （调用方决定 503 或 job failed{stage:query}）；拟合不可行（样本 ≤ p 或奇异）时
 * modelParams 拟合族为 null、validation.fit 为 null——不阻断 draft 存续。
 */
export async function runValidation(
  tsdb: MvTsdbStore,
  input: {
    period: { start: string; end: string };
    pointIds: readonly number[];
    stationId: string;
    spec: MvModelSpecResolved;
    now?: Date;
  },
): Promise<ValidationRun> {
  const now = input.now ?? new Date();
  const periodDates = enumerateDates(input.period.start, input.period.end);
  const preStart = shiftDate(input.period.start, -1);

  const [pointStats, weatherStats] = await Promise.all([
    tsdb.pointDayStats(input.pointIds, preStart, input.period.end),
    tsdb.weatherDayStats(
      input.stationId,
      input.period.start,
      input.period.end,
      input.spec.t_cool_c,
      input.spec.t_heat_c,
    ),
  ]);

  const energy = assembleDayEnergy(periodDates, input.pointIds, pointStats, {
    dayHoursMin: MV_DAY_HOURS_MIN,
    badRatioMax: MV_DAY_BAD_RATIO_MAX,
    preStartDate: preStart,
  });
  const weatherByDay = assembleWeatherByDay(weatherStats, MV_WEATHER_HOURS_MIN);

  // 拟合样本 = 能量完整日 ∩ 天气有效日（§3.4）
  const samples = periodDates
    .filter((date) => energy.energyByDay.has(date) && weatherByDay.has(date))
    .map((date) => {
      const weather = weatherByDay.get(date);
      return {
        e: energy.energyByDay.get(date) as number,
        cdd: weather?.cdd ?? 0,
        hdd: weather?.hdd ?? 0,
        weekend: weather?.weekend ?? false,
      };
    });

  const spec: OlsSpec = {
    t_cool_c: input.spec.t_cool_c,
    t_heat_c: input.spec.t_heat_c,
    weekend_dummy: input.spec.weekend_dummy,
  };
  const fit = fitOls(samples, spec);
  const seasonCoverage =
    periodDates.length >= 365 && fit !== null && fit.n_obs >= 365 * 0.9 ? 'full' : 'partial';

  const modelParams: MvModelParams | null =
    fit === null
      ? {
          model_type: MV_MODEL_TYPES[0],
          model_version: 1,
          spec: {
            t_cool_c: spec.t_cool_c,
            t_heat_c: spec.t_heat_c,
            weekend_dummy: spec.weekend_dummy,
          },
          coefficients: null,
          stderrs: null,
          sigma_kwh: null,
          n_obs: samples.length,
          metrics: null,
          xtx_inv: null,
          fit_daily_mean_kwh: null,
          fit_mean_row: null,
          fitted_days: 0,
          season_coverage: 'partial',
          fit_run_at: null,
        }
      : {
          model_type: MV_MODEL_TYPES[0],
          model_version: 1,
          spec: {
            t_cool_c: spec.t_cool_c,
            t_heat_c: spec.t_heat_c,
            weekend_dummy: spec.weekend_dummy,
          },
          coefficients: fit.coefficients,
          stderrs: fit.stderrs,
          sigma_kwh: fit.sigma_kwh,
          n_obs: fit.n_obs,
          metrics: fit.metrics,
          xtx_inv: fit.xtx_inv.map((row) => [...row]),
          fit_daily_mean_kwh: fit.fit_daily_mean_kwh,
          fit_mean_row: [...fit.fit_mean_row],
          fitted_days: energy.complete_days,
          season_coverage: seasonCoverage,
          fit_run_at: now.toISOString(),
        };

  const validWeatherDays = [...weatherByDay.keys()].filter((date) =>
    periodDates.includes(date),
  ).length;

  const validation: MvValidationResult = {
    validated_at: now.toISOString(),
    window: {
      period_days: energy.period_days,
      complete_days: energy.complete_days,
      coverage: energy.period_days > 0 ? energy.complete_days / energy.period_days : 0,
      required: { min_days: MV_MIN_BASELINE_DAYS, min_coverage: MV_WINDOW_COVERAGE_MIN },
      gaps: energy.gaps.map((gap) => ({
        from: gap.from,
        to: gap.to,
        days: gap.days,
        points_affected: [...gap.points_affected],
        cause: gap.cause,
      })),
    },
    fit:
      fit === null
        ? null
        : {
            n_obs: fit.n_obs,
            coefficients: fit.coefficients,
            metrics: fit.metrics,
            qualified:
              fit.metrics.cvrmse_pct <= MV_FIT_CVRMSE_MAX &&
              Math.abs(fit.metrics.nmbe_pct) <= MV_FIT_NMBE_MAX,
            thresholds: { cvrmse_max_pct: MV_FIT_CVRMSE_MAX, nmbe_max_pct: MV_FIT_NMBE_MAX },
          },
    weather: {
      station_id: input.stationId,
      valid_days: validWeatherDays,
      coverage: periodDates.length > 0 ? validWeatherDays / periodDates.length : 0,
    },
  };

  return { validation, modelParams, periodDays: periodDates.length };
}

/** 基线期长度域（§2.1：90–731 天；draft 创建/改期校验）。 */
export function assertBaselinePeriodLength(period: { start: string; end: string }): void {
  const days =
    (Date.parse(`${period.end}T00:00:00Z`) - Date.parse(`${period.start}T00:00:00Z`)) / 86_400_000;
  if (days < MV_MIN_BASELINE_DAYS || days > MV_MAX_BASELINE_DAYS) {
    throw new ReasonCodeException('common.validation_failed', '基线期长度须在 90–731 天', {
      field: 'baseline_period',
      days,
      min: MV_MIN_BASELINE_DAYS,
      max: MV_MAX_BASELINE_DAYS,
    });
  }
}

/** ISO 日期平移 N 天。 */
export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * TSDB 读守卫（telemetry.service.guarded 同款）：不可用 → 503 telemetry.store_unavailable；
 * 异步任务内不使用（那里 TelemetryStoreUnavailableError → job failed{stage:query}）。
 */
export async function guardTsdb<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    if (err instanceof TelemetryStoreUnavailableError) {
      throw new ReasonCodeException(
        'telemetry.store_unavailable',
        'TSDB 只读存储暂不可用（未配置或不可达）',
      );
    }
    throw err;
  }
}
