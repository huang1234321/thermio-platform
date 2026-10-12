/**
 * M&V 域契约形状与参数常量钉死测试（M9-mv-report.md §1.7/§3.1；IMPL-21 / DAT-242）。
 *
 * 常量即口径：门槛/平衡点/保留期等默认值是详设 §3.1 的机械落码——改值必须
 * 显式改本快照（发版动作，platform §12 同机制）。
 */
import { describe, expect, it } from 'vitest';
import {
  MV_DAY_BAD_RATIO_MAX,
  MV_DAY_HOURS_MIN,
  MV_EXPORT_CONCURRENCY,
  MV_EXPORT_RETENTION_DAYS,
  MV_FIT_CVRMSE_MAX,
  MV_FIT_NMBE_MAX,
  MV_GENERATION_CONCURRENCY,
  MV_LATE_BUFFER_DAYS,
  MV_MAX_BASELINE_DAYS,
  MV_MIN_BASELINE_DAYS,
  MV_PERIOD_ENERGY_MIN,
  MV_PERIOD_WEATHER_MIN,
  MV_REPORT_PERIOD_MAX_DAYS,
  MV_T_COOL_C,
  MV_T_HEAT_C,
  MV_UNCERTAINTY_RATIO_MAX,
  MV_WEATHER_HOURS_MIN,
  MV_WINDOW_COVERAGE_MIN,
  MV_CI_LEVEL,
  MvBaselineCreateSchema,
  MvBaselinesQuerySchema,
  MvGenerateRequestSchema,
  MvModelParamsSchema,
  MvReportsQuerySchema,
  MvValidationResultSchema,
} from './mv.js';

describe('M&V 计算参数常量（§3.1/§1.7 快照钉死）', () => {
  it('shouldPinTheSpecValues_exactlyAsDesigned', () => {
    expect({
      MV_MIN_BASELINE_DAYS,
      MV_MAX_BASELINE_DAYS,
      MV_DAY_HOURS_MIN,
      MV_DAY_BAD_RATIO_MAX,
      MV_WINDOW_COVERAGE_MIN,
      MV_WEATHER_HOURS_MIN,
      MV_PERIOD_WEATHER_MIN,
      MV_PERIOD_ENERGY_MIN,
      MV_T_COOL_C,
      MV_T_HEAT_C,
      MV_FIT_CVRMSE_MAX,
      MV_FIT_NMBE_MAX,
      MV_CI_LEVEL,
      MV_UNCERTAINTY_RATIO_MAX,
      MV_LATE_BUFFER_DAYS,
      MV_GENERATION_CONCURRENCY,
      MV_EXPORT_CONCURRENCY,
      MV_EXPORT_RETENTION_DAYS,
      MV_REPORT_PERIOD_MAX_DAYS,
    }).toMatchInlineSnapshot(`
      {
        "MV_CI_LEVEL": 0.68,
        "MV_DAY_BAD_RATIO_MAX": 0.05,
        "MV_DAY_HOURS_MIN": 24,
        "MV_EXPORT_CONCURRENCY": 2,
        "MV_EXPORT_RETENTION_DAYS": 30,
        "MV_FIT_CVRMSE_MAX": 30,
        "MV_FIT_NMBE_MAX": 10,
        "MV_GENERATION_CONCURRENCY": 2,
        "MV_LATE_BUFFER_DAYS": 5,
        "MV_MAX_BASELINE_DAYS": 731,
        "MV_MIN_BASELINE_DAYS": 90,
        "MV_PERIOD_ENERGY_MIN": 0.9,
        "MV_PERIOD_WEATHER_MIN": 0.95,
        "MV_REPORT_PERIOD_MAX_DAYS": 731,
        "MV_T_COOL_C": 26,
        "MV_T_HEAT_C": 18,
        "MV_UNCERTAINTY_RATIO_MAX": 0.5,
        "MV_WEATHER_HOURS_MIN": 20,
        "MV_WINDOW_COVERAGE_MIN": 0.9,
      }
    `);
  });
});

describe('M&V wire 形状', () => {
  it('shouldRejectUnknownQueryParams_whitelistDiscipline', () => {
    expect(MvBaselinesQuerySchema.safeParse({ status: 'draft', sort: 'name' }).success).toBe(false);
    expect(MvReportsQuerySchema.safeParse({ building_id: 'x', foo: 1 }).success).toBe(false);
    // 白名单内 + 默认 limit
    const ok = MvBaselinesQuerySchema.parse({ status: 'active' });
    expect(ok.limit).toBe(50);
  });

  it('shouldRejectInvertedPeriods_andAcceptHalfOpenRanges', () => {
    expect(
      MvGenerateRequestSchema.safeParse({
        baseline_id: '0b7a8a3e-6f2c-4d1e-9a1b-3c5d7e9f0a1b',
        period: { start: '2026-07-01', end: '2026-07-01' },
      }).success,
    ).toBe(false);
    expect(
      MvGenerateRequestSchema.safeParse({
        baseline_id: '0b7a8a3e-6f2c-4d1e-9a1b-3c5d7e9f0a1b',
        period: { start: '2026-07-01', end: '2026-10-01' },
      }).success,
    ).toBe(true);
  });

  it('shouldDefaultCreateFields_toOptionCSingleModelForm', () => {
    const parsed = MvBaselineCreateSchema.parse({
      building_id: '0b7a8a3e-6f2c-4d1e-9a1b-3c5d7e9f0a1b',
      baseline_period: { start: '2026-01-01', end: '2026-06-01' },
      metering_point_ids: [1, 2],
      weather_source: 'ST-5837',
    });
    expect(parsed.method).toBe('ipmvp_option_c');
    expect(parsed.model_type).toBe('ols_daily_cdd_hdd');
    expect(parsed.model_spec).toEqual({});
  });

  it('shouldValidateModelParamsJsonbShape_fitFieldsNullable', () => {
    // 拟合不可行形态：spec 持久、拟合族 null（§3.4 注）
    const unfit = MvModelParamsSchema.safeParse({
      model_type: 'ols_daily_cdd_hdd',
      model_version: 1,
      spec: { t_cool_c: 26, t_heat_c: 18, weekend_dummy: true },
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
    });
    expect(unfit.success).toBe(true);
  });

  it('shouldValidateTheDetailSpecExample_verbatimFromDesign', () => {
    // §3.5 validation_result 示例逐字解析（jsonb 形状与详设对齐锚）
    const example = {
      validated_at: '2026-10-13T08:00:00Z',
      window: {
        period_days: 342,
        complete_days: 328,
        coverage: 0.96,
        required: { min_days: 90, min_coverage: 0.9 },
        gaps: [
          {
            from: '2026-06-01',
            to: '2026-06-08',
            days: 8,
            points_affected: ['point:1024'],
            cause: 'reset',
          },
        ],
      },
      fit: {
        n_obs: 328,
        coefficients: { b0: 4021.5, b1: 812.4, b2: 936.1, b3: -640.2 },
        metrics: { r2: 0.82, adj_r2: 0.81, rmse_kwh: 1795.4, cvrmse_pct: 21.3, nmbe_pct: 0.0 },
        qualified: true,
        thresholds: { cvrmse_max_pct: 30, nmbe_max_pct: 10 },
      },
      weather: { station_id: 'ST-5837', valid_days: 331, coverage: 0.97 },
    };
    expect(MvValidationResultSchema.safeParse(example).success).toBe(true);
  });
});
