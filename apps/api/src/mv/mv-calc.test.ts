/**
 * M&V 计算锚点复算测试（M9-mv-report.md §3 全口径 / §14 计算验收锚点；DAT-242）。
 *
 * 构造已知系数合成数据 → 拟合/报告量逐项复算断言（±容差）：
 * - §3.4 OLS 系数恢复（零噪声精确恢复 + 确定性噪声容差恢复）、CVRMSE/NMBE 线；
 * - §3.6 CI 复算冻结复现（(X'X)⁻¹ + σ 冻结后，报告期换设计矩阵复算半宽）；
 * - §3.2 复位守卫 / 24h 覆盖 / 坏样门槛 / 首日差值（preStart 载体）；
 * - §3.6 双口径并列与降级（天气覆盖率分流）、插补计数；
 * - t 分位数对照标准 t 表锚点。
 */
import { describe, expect, it } from 'vitest';
import {
  assembleDayEnergy,
  assembleWeatherByDay,
  buildReportNo,
  buildingCodeOf,
  computeReport,
  designRow,
  enumerateDates,
  fitOls,
  predictDay,
  tQuantile,
  type DayWeather,
  type FitSample,
  type FrozenModel,
  type OlsSpec,
  type PointDayStat,
} from './mv-calc.js';

/** 确定性伪随机（mulberry32）：合成数据可复现。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** fail-fast 判空（空断言禁用纪律：抛错优于静默穿透）。 */
function req<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`预期非空：${what}`);
  return value;
}

const SPEC: OlsSpec = { t_cool_c: 26, t_heat_c: 18, weekend_dummy: true };
const TRUE_BETA = { b0: 4021.5, b1: 812.4, b2: 936.1, b3: -640.2 };

/** 合成基线期样本：CDD/HDD 季节形态 + 周末哑变量（§3.4 模型形式唯一）。 */
function syntheticSamples(days: number, noiseSeed: number | null): FitSample[] {
  const rand = rng(noiseSeed ?? 1);
  const out: FitSample[] = [];
  for (let i = 0; i < days; i += 1) {
    const date = new Date(Date.UTC(2026, 0, 1 + i));
    const doy = i;
    const tMean = 18 + 12 * Math.sin(((doy - 100) / 365) * 2 * Math.PI);
    // 小时均温 → 度日（与 §3.3 公式一致：/24 口径）
    let cdd = 0;
    let hdd = 0;
    for (let h = 0; h < 24; h += 1) {
      const tHour = tMean + 3 * Math.sin(((h - 6) / 24) * 2 * Math.PI);
      cdd += Math.max(0, tHour - SPEC.t_cool_c) / 24;
      hdd += Math.max(0, SPEC.t_heat_c - tHour) / 24;
    }
    const weekend = [0, 6].includes(date.getUTCDay());
    const noise = noiseSeed === null ? 0 : (rand() - 0.5) * 2 * 400;
    const e =
      TRUE_BETA.b0 +
      TRUE_BETA.b1 * cdd +
      TRUE_BETA.b2 * hdd +
      TRUE_BETA.b3 * (weekend ? 1 : 0) +
      noise;
    out.push({ e, cdd, hdd, weekend });
  }
  return out;
}

describe('§3.4 日粒度 OLS 拟合', () => {
  it('shouldRecoverExactCoefficients_onNoiseFreeSyntheticData', () => {
    const f = req(fitOls(syntheticSamples(365, null), SPEC), 'fit');
    expect(f.coefficients.b0).toBeCloseTo(TRUE_BETA.b0, 6);
    expect(f.coefficients.b1).toBeCloseTo(TRUE_BETA.b1, 6);
    expect(f.coefficients.b2).toBeCloseTo(TRUE_BETA.b2, 6);
    expect(f.coefficients.b3).toBeCloseTo(TRUE_BETA.b3, 6);
    expect(f.metrics.r2).toBeCloseTo(1, 8);
    expect(f.metrics.cvrmse_pct).toBeCloseTo(0, 6);
    expect(f.metrics.nmbe_pct).toBeCloseTo(0, 6);
  });

  it('shouldRecoverCoefficientsWithinTolerance_onNoisyData_andReportMetrics', () => {
    const fn = req(fitOls(syntheticSamples(365, 42), SPEC), 'fit');
    // 噪声 U(−400, 400)：σ ≈ 231 → 系数容差 3–4×stderr 量级
    expect(Math.abs(fn.coefficients.b0 - TRUE_BETA.b0)).toBeLessThan(80);
    expect(Math.abs(fn.coefficients.b1 - TRUE_BETA.b1)).toBeLessThan(60);
    expect(Math.abs(fn.coefficients.b2 - TRUE_BETA.b2)).toBeLessThan(60);
    expect(Math.abs((fn.coefficients.b3 ?? 0) - TRUE_BETA.b3)).toBeLessThan(80);
    // CVRMSE 线：σ/Ē ≈ 3%，30% 合格线内
    expect(fn.metrics.cvrmse_pct).toBeGreaterThan(1);
    expect(fn.metrics.cvrmse_pct).toBeLessThan(30);
    expect(Math.abs(fn.metrics.nmbe_pct)).toBeLessThan(1); // 含截距 ≈ 0（§3.4）
    expect(fn.stderrs.b0).toBeGreaterThan(0);
    expect(fn.n_obs).toBe(365);
    // (X'X)⁻¹ 对称性（数值健全）
    for (let i = 0; i < 4; i += 1) {
      for (let j = 0; j < 4; j += 1) {
        expect(Math.abs((fn.xtx_inv[i]?.[j] ?? 0) - (fn.xtx_inv[j]?.[i] ?? 0))).toBeLessThan(1e-6);
      }
    }
  });

  it('shouldReturnNull_whenSamplesDoNotExceedParamCount', () => {
    expect(fitOls(syntheticSamples(4, null), SPEC)).toBeNull();
    // 周末哑变量关闭 → 3 参数模型，4 样本（设计满秩）可拟
    const manual: FitSample[] = [
      { e: 3000, cdd: 0, hdd: 0, weekend: false },
      { e: 4000, cdd: 1, hdd: 0, weekend: false },
      { e: 5000, cdd: 0, hdd: 1, weekend: false },
      { e: 6000, cdd: 1, hdd: 1, weekend: false },
    ].map((s) => ({ ...s, e: 3000 + 812.4 * s.cdd + 936.1 * s.hdd }));
    const fit3 = fitOls(manual, { ...SPEC, weekend_dummy: false });
    expect(fit3).not.toBeNull();
    expect(req(fit3, 'fit3').coefficients.b3).toBeNull();
  });
});

describe('t 分位数（CI 载体）', () => {
  it('shouldMatchStandardTableValues_atKnownAnchors', () => {
    expect(tQuantile(0.9, 5)).toBeCloseTo(2.015, 3);
    expect(tQuantile(0.95, 10)).toBeCloseTo(2.2281, 3);
    expect(tQuantile(0.99, 30)).toBeCloseTo(2.7497, 3); // t_{0.995,30} 双侧 99%
    // ν → ∞ 收敛正态：z_{0.84} = 0.99446（68% 双侧 = 1σ）
    expect(tQuantile(0.68, 100_000)).toBeCloseTo(0.99446, 3);
    expect(tQuantile(0.68, 328)).toBeGreaterThan(tQuantile(0.68, 100_000));
  });
});

describe('§3.6 报告计算（冻结模型复算）', () => {
  const fitted = req(fitOls(syntheticSamples(365, 42), SPEC), 'fit');
  const model: FrozenModel = {
    coefficients: fitted.coefficients,
    sigma_kwh: fitted.sigma_kwh,
    n_obs: fitted.n_obs,
    xtx_inv: fitted.xtx_inv,
    fit_daily_mean_kwh: fitted.fit_daily_mean_kwh,
    fit_mean_row: fitted.fit_mean_row,
    metrics: { cvrmse_pct: fitted.metrics.cvrmse_pct },
    spec: SPEC,
  };

  // 报告期：基线期后 30 天（2027-01-01 起），同形态合成天气
  const periodDates = enumerateDates('2027-01-01', '2027-01-31');
  const weatherByDay = new Map<string, DayWeather>();
  const energyByDay = new Map<string, number>();
  const rand = rng(7);
  periodDates.forEach((date, i) => {
    const tMean = 6 + 4 * Math.sin(i / 5); // 冬季形态：HDD 主导
    let cdd = 0;
    let hdd = 0;
    for (let h = 0; h < 24; h += 1) {
      const tHour = tMean + 3 * Math.sin(((h - 6) / 24) * 2 * Math.PI);
      cdd += Math.max(0, tHour - SPEC.t_cool_c) / 24;
      hdd += Math.max(0, SPEC.t_heat_c - tHour) / 24;
    }
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    weatherByDay.set(date, { cdd, hdd, weekend });
    // 实际能耗 = 基线预测 − 800（真实节能）+ 小噪声
    const noise = (rand() - 0.5) * 200;
    energyByDay.set(date, predictDay(model, { cdd, hdd, weekend }) - 800 + noise);
  });

  it('shouldComputeBothCalibers_andMatchManualCiRecomputation', () => {
    const result = computeReport({
      periodDates,
      energyByDay,
      weatherByDay,
      model,
      ciLevel: 0.68,
      periodWeatherMin: 0.95,
      uncertaintyRatioMax: 0.5,
    });
    expect(result.weather_adjusted_saving_kwh).not.toBeNull();
    // 口径 B 节能量 ≈ 800×30 ± 噪声和随机游走（冬季口径 A 为负属正常——天气归一化的意义）
    expect(result.weather_adjusted_saving_kwh).toBeGreaterThan(21_000);
    expect(result.weather_adjusted_saving_kwh).toBeLessThan(27_000);
    // 结构恒等式（紧容差）：口径 A 基线 = Ē_fit × |R|；actual = Σ实测
    expect(result.baseline_energy_kwh).toBeCloseTo(model.fit_daily_mean_kwh * 30, 6);
    // actual = Σ实测
    const sumActual = [...energyByDay.values()].reduce((a, b) => a + b, 0);
    expect(result.actual_energy_kwh).toBeCloseTo(sumActual, 6);
    expect(result.imputed_days).toBe(0);
    expect(result.series).toHaveLength(30);

    // CI 独立复算（测试侧重算 1′X_R(X′X)⁻¹X_R′1，与实现解耦）
    const ci = req(result.confidence_interval, 'ci');
    const rows = periodDates.map((date) => {
      const w = weatherByDay.get(date) as DayWeather;
      return designRow(w.cdd, w.hdd, w.weekend, SPEC);
    });
    const sumRow = rows.reduce<number[]>(
      (acc, r) => acc.map((v, i) => v + (r[i] ?? 0)),
      [0, 0, 0, 0],
    );
    const xtxInv = model.xtx_inv;
    let qForm = 0;
    for (let i = 0; i < 4; i += 1) {
      for (let j = 0; j < 4; j += 1) {
        qForm += (sumRow[i] ?? 0) * (xtxInv[i]?.[j] ?? 0) * (sumRow[j] ?? 0);
      }
    }
    const dof = model.n_obs - 4;
    const expectedHalf = tQuantile(0.68, dof) * Math.sqrt(model.sigma_kwh ** 2 * qForm);
    expect(ci.half_width_kwh).toBeCloseTo(expectedHalf, 6);
    expect(ci.lower_kwh).toBeCloseTo(
      (result.weather_adjusted_saving_kwh as number) - expectedHalf,
      6,
    );
    expect(ci.upper_kwh).toBeCloseTo(
      (result.weather_adjusted_saving_kwh as number) + expectedHalf,
      6,
    );
    // 警示线判定 = 公式逐字（冬季外推使半宽放大，uncertainty_high 可为 true——
    // 警示不阻断，呈现由 UI 承担；此处钉死判定恒等式本身）
    expect(ci.uncertainty_high).toBe(
      ci.half_width_kwh > 0.5 * Math.abs(req(result.weather_adjusted_saving_kwh, 'saving')),
    );
  });

  it('shouldDegradeToCaliberAOnly_whenWeatherCoverageBelowThreshold', () => {
    // 拔掉 3 天天气（30 天 × 90% < 95% 门槛）→ 降级：口径 B 与 CI 均 NULL
    const degraded = new Map(weatherByDay);
    degraded.delete('2027-01-05');
    degraded.delete('2027-01-06');
    degraded.delete('2027-01-07');
    const result = computeReport({
      periodDates,
      energyByDay,
      weatherByDay: degraded,
      model,
      ciLevel: 0.68,
      periodWeatherMin: 0.95,
      uncertaintyRatioMax: 0.5,
    });
    expect(result.weather_coverage_pct).toBeCloseTo(0.9, 6);
    expect(result.weather_adjusted_saving_kwh).toBeNull();
    expect(result.confidence_interval).toBeNull();
    // 口径 A 恒出（双口径并列，不静默出单口径）；冬季未归一化口径为负——口径差异的实证
    expect(Number.isFinite(result.raw_saving_kwh)).toBe(true);
    expect(result.raw_saving_kwh).not.toBeCloseTo(result.weather_adjusted_saving_kwh ?? 0, -2);
  });

  it('shouldImputeGapDays_withModelPredictionOrDailyMean_andCountExplicitly', () => {
    const withGaps = new Map(energyByDay);
    withGaps.delete('2027-01-10'); // 天气可用 → 模型预测插补
    withGaps.delete('2027-01-11');
    const noWeather = new Map(weatherByDay);
    noWeather.delete('2027-01-12'); // 天气缺失日 → 样本日均插补（该日能量也缺）
    withGaps.delete('2027-01-12');
    const result = computeReport({
      periodDates,
      energyByDay: withGaps,
      weatherByDay: noWeather,
      model,
      ciLevel: 0.68,
      periodWeatherMin: 0.95,
      uncertaintyRatioMax: 0.5,
    });
    expect(result.imputed_days).toBe(3);
    expect(req(result.confidence_interval, 'ci').imputed_days).toBe(3);
    // 插补值：模型预测（01-10/11）+ Ē_fit（01-12）
    const w10 = weatherByDay.get('2027-01-10') as DayWeather;
    const point10 = req(
      result.series.find((p) => p.date === '2027-01-10'),
      'p10',
    );
    expect(point10.actual_kwh).toBeCloseTo(predictDay(model, w10), 6);
    const point12 = req(
      result.series.find((p) => p.date === '2027-01-12'),
      'p12',
    );
    expect(point12.actual_kwh).toBeCloseTo(model.fit_daily_mean_kwh, 6);
  });

  it('shouldFlagUncertaintyHigh_whenHalfWidthExceedsHalfOfSaving', () => {
    // 构造小节能量：实际 ≈ 基线 → saving ≈ 0 → 半宽必超 0.5×|saving|
    const tiny = new Map(
      [...energyByDay].map(([date, v]) => [date, v + 800] as const), // 抵消构造节能
    );
    const result = computeReport({
      periodDates,
      energyByDay: tiny,
      weatherByDay,
      model,
      ciLevel: 0.68,
      periodWeatherMin: 0.95,
      uncertaintyRatioMax: 0.5,
    });
    expect(Math.abs(req(result.weather_adjusted_saving_kwh, 'saving'))).toBeLessThan(
      req(result.confidence_interval, 'ci').half_width_kwh * 2,
    );
    expect(req(result.confidence_interval, 'ci').uncertainty_high).toBe(true);
  });
});

describe('§3.2 日能耗装配（复位守卫/覆盖/坏样/首日差值）', () => {
  const pointIds = [101, 102];
  const periodDates = enumerateDates('2026-03-01', '2026-03-05');
  const preStart = '2026-02-28';

  function stat(
    pointId: number,
    date: string,
    last: number | null,
    overrides?: Partial<PointDayStat>,
  ): PointDayStat {
    return {
      point_id: pointId,
      date,
      hours: 24,
      samples: 240,
      bad_samples: 0,
      day_last: last,
      ...overrides,
    };
  }

  it('shouldComputeDailyDiffsIncludingFirstDay_viaPreStartLast', () => {
    // 累计表：101 从 1000 起每日 +100；102 从 500 起每日 +50
    const stats: PointDayStat[] = [
      stat(101, preStart, 1000),
      stat(101, '2026-03-01', 1100),
      stat(101, '2026-03-02', 1200),
      stat(101, '2026-03-03', 1300),
      stat(101, '2026-03-04', 1400),
      stat(102, preStart, 500),
      stat(102, '2026-03-01', 550),
      stat(102, '2026-03-02', 600),
      stat(102, '2026-03-03', 650),
      stat(102, '2026-03-04', 700),
    ];
    const outcome = assembleDayEnergy(periodDates, pointIds, stats, {
      dayHoursMin: 24,
      badRatioMax: 0.05,
      preStartDate: preStart,
    });
    expect(outcome.complete_days).toBe(4);
    expect(outcome.energyByDay.get('2026-03-01')).toBeCloseTo(150, 8); // 首日差值
    expect(outcome.energyByDay.get('2026-03-04')).toBeCloseTo(150, 8);
    expect(outcome.gaps).toHaveLength(0);
  });

  it('shouldGuardMeterReset_asGapWithCause', () => {
    const stats: PointDayStat[] = [
      stat(101, preStart, 1000),
      stat(101, '2026-03-01', 1100),
      stat(101, '2026-03-02', 900), // 复位：倒退
      stat(101, '2026-03-03', 1300),
      stat(101, '2026-03-04', 1400),
      stat(102, preStart, 500),
      stat(102, '2026-03-01', 550),
      stat(102, '2026-03-02', 600),
      stat(102, '2026-03-03', 650),
      stat(102, '2026-03-04', 700),
    ];
    const outcome = assembleDayEnergy(periodDates, pointIds, stats, {
      dayHoursMin: 24,
      badRatioMax: 0.05,
      preStartDate: preStart,
    });
    // 复位日整楼不完整（零假设：不静默绕零）
    expect(outcome.energyByDay.has('2026-03-02')).toBe(false);
    expect(outcome.complete_days).toBe(3);
    expect(outcome.gaps).toHaveLength(1);
    expect(outcome.gaps[0]).toMatchObject({
      from: '2026-03-02',
      to: '2026-03-02',
      days: 1,
      points_affected: ['point:101'],
      cause: 'reset',
    });
  });

  it('shouldFlagHoursAndBadRatioGaps_separately', () => {
    const stats: PointDayStat[] = [
      stat(101, preStart, 1000),
      stat(101, '2026-03-01', 1100),
      stat(101, '2026-03-02', 1200, { hours: 23 }), // 缺 1 桶 → hours
      stat(101, '2026-03-03', 1300),
      stat(101, '2026-03-04', 1400, { samples: 240, bad_samples: 20 }), // 8.3% > 5%
      stat(102, preStart, 500),
      stat(102, '2026-03-01', 550),
      stat(102, '2026-03-02', 600),
      stat(102, '2026-03-03', 650),
      stat(102, '2026-03-04', 700),
    ];
    const outcome = assembleDayEnergy(periodDates, pointIds, stats, {
      dayHoursMin: 24,
      badRatioMax: 0.05,
      preStartDate: preStart,
    });
    expect(outcome.energyByDay.has('2026-03-02')).toBe(false);
    expect(outcome.energyByDay.has('2026-03-04')).toBe(false);
    const causes = outcome.gaps.map((g) => g.cause).sort();
    expect(causes).toEqual(['bad_ratio', 'hours']);
  });

  it('shouldReportGapWhenPreviousDayLastMissing', () => {
    // 前日无数据 → 当日差值不可算 → 缺口（cause=hours）
    const stats: PointDayStat[] = [
      stat(101, '2026-03-01', 1100),
      stat(101, '2026-03-02', 1200),
      stat(101, '2026-03-03', 1300),
      stat(101, '2026-03-04', 1400),
      stat(102, preStart, 500),
      stat(102, '2026-03-01', 550),
      stat(102, '2026-03-02', 600),
      stat(102, '2026-03-03', 650),
      stat(102, '2026-03-04', 700),
    ];
    const outcome = assembleDayEnergy(periodDates, pointIds, stats, {
      dayHoursMin: 24,
      badRatioMax: 0.05,
      preStartDate: preStart,
    });
    expect(outcome.energyByDay.has('2026-03-01')).toBe(false);
    expect(outcome.complete_days).toBe(3);
  });
});

describe('§3.3 度日装配与编号', () => {
  it('shouldDropInvalidWeatherDays_belowHourThreshold', () => {
    const byDay = assembleWeatherByDay(
      [
        { date: '2026-07-01', hours: 24, cdd: 5.2, hdd: 0 },
        { date: '2026-07-02', hours: 19, cdd: 4.1, hdd: 0 }, // < 20 → 无效
        { date: '2026-07-03', hours: 20, cdd: 3.9, hdd: 0 },
      ],
      20,
    );
    expect(byDay.size).toBe(2);
    expect(byDay.has('2026-07-02')).toBe(false);
    // 2026-07-04 周六（UTC）→ weekend 哑变量
    expect(
      assembleWeatherByDay([{ date: '2026-07-04', hours: 24, cdd: 1, hdd: 0 }], 20).get(
        '2026-07-04',
      )?.weekend,
    ).toBe(true);
  });

  it('shouldBuildDeterministicReportNo_andBuildingCode', () => {
    expect(
      buildReportNo(
        'TZ-Park',
        { start: '2026-07-01', end: '2026-09-30' },
        'aabbccdd-0000-0000-0000-000000000000',
      ),
    ).toBe('MV-TZ-Park-2026-07-01-2026-09-30-aabbccdd');
    expect(buildingCodeOf('总部大厦 A 座', '0b7a8a3e-6f2c-4d1e-9a1b-3c5d7e9f0a1b')).toBe(
      '总部大厦A座',
    );
    expect(buildingCodeOf('---', '0b7a8a3e-6f2c-4d1e-9a1b-3c5d7e9f0a1b')).toBe('0b7a8a3e');
  });
});
