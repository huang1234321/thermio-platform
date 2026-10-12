/**
 * M&V 计算核心（modules/M9-mv-report.md §3 数学真相源的落码，IMPL-21 / DAT-242）。
 *
 * 纯函数模块：不碰 DI / 不碰 PG / 不碰 TSDB——输入日序列，输出拟合与报告量。
 * §3 全口径在此成文：
 * - §3.2 日能耗 E_d = Σ_p ΔE(p,d)（末桶 last 差值；复位守卫 + 24h 覆盖 + 坏样门槛）；
 * - §3.3 度日 CDD/HDD（自天气小时序列，/24 口径）；
 * - §3.4 基线模型 = 日粒度 OLS（CDD/HDD + 周末哑变量，可关），度量 R²/调整R²/RMSE/
 *   CVRMSE/NMBE，(X'X)⁻¹ 与 σ 随 model_params 冻结；
 * - §3.6 报告：口径 A 恒出（Ē_fit × |R|）、口径 B 条件出（天气覆盖率 ≥95%）、
 *   CI = t_{0.84,n−p}·√(σ²·1′X_R(X′X)⁻¹X_R′1)、缺日插补（模型预测或样本日均）、
 *   不确定性警示线、补传缓冲标注。
 *
 * 数值实现：正规方程 + 全选主元 Gauss 消元（p ≤ 4 的线性方程组，条件数可控）；
 * t 分位数经正则化不完全 Beta（连分式）数值逆解——n_obs ≥ 90 时自由度充足，
 * 数值解与表值误差 < 1e-6（mv-calc.test.ts 对照 t 表锚点钉死）。
 */

/** 拟合样本日（能量完整日 ∩ 天气有效日，§3.4）。 */
export interface FitSample {
  readonly e: number;
  readonly cdd: number;
  readonly hdd: number;
  readonly weekend: boolean;
}

export interface OlsSpec {
  readonly t_cool_c: number;
  readonly t_heat_c: number;
  readonly weekend_dummy: boolean;
}

export interface OlsMetrics {
  readonly r2: number;
  readonly adj_r2: number;
  readonly rmse_kwh: number;
  readonly cvrmse_pct: number;
  readonly nmbe_pct: number;
}

export interface OlsFit {
  readonly coefficients: { b0: number; b1: number; b2: number; b3: number | null };
  readonly stderrs: { b0: number; b1: number; b2: number; b3: number | null };
  readonly sigma_kwh: number;
  readonly n_obs: number;
  readonly metrics: OlsMetrics;
  /** (X'X)⁻¹（p×p 行主序；CI 复算冻结载体，§3.6-5）。 */
  readonly xtx_inv: readonly (readonly number[])[];
  /** 拟合样本日均能耗 Ē_fit（口径 A 基线参照锚，§3.6-3）。 */
  readonly fit_daily_mean_kwh: number;
  /** 拟合样本均值设计行（缺天气日回退 Ē_fit 的方差贡献行，§3.6-4 注）。 */
  readonly fit_mean_row: readonly number[];
}

/** 参数数 p（周末哑变量开关决定 4/3，§3.4）。 */
export function paramCount(spec: OlsSpec): number {
  return spec.weekend_dummy ? 4 : 3;
}

/** 设计行 [1, CDD, HDD, W?]（§3.4 模型形式唯一）。 */
export function designRow(cdd: number, hdd: number, weekend: boolean, spec: OlsSpec): number[] {
  return spec.weekend_dummy ? [1, cdd, hdd, weekend ? 1 : 0] : [1, cdd, hdd];
}

/** 索引取值（fail-fast：维度错配即抛，优于静默 NaN 传播——noUncheckedIndexedAccess 纪律）。 */
function at<T>(values: readonly T[], index: number, what: string): T {
  const value = values[index];
  if (value === undefined) throw new Error(`矩阵索引越界：${what}[${String(index)}]`);
  return value;
}

/** 线性方程组求解（全选主元 Gauss 消元；奇异返回 null）。 */
function solveLinear(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m: number[][] = a.map((row, i) => [...row, b[i] ?? 0]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(at(at(m, row, 'm'), col, 'col')) > Math.abs(at(at(m, pivot, 'm'), col, 'col'))) {
        pivot = row;
      }
    }
    const pivotRow = at(m, pivot, 'm');
    if (Math.abs(at(pivotRow, col, 'col')) < 1e-12) return null;
    const colRow = at(m, col, 'm');
    m[col] = pivotRow;
    m[pivot] = colRow;
    // swap 后 m[col] = 原 pivot 行（主元行）；以其对角元归一
    const active = pivotRow;
    const div = at(active, col, 'div');
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const target = at(m, row, 'm');
      const factor = at(target, col, 'col') / div;
      if (factor === 0) continue;
      for (let k = col; k <= n; k += 1) {
        target[k] = (target[k] ?? 0) - factor * (active[k] ?? 0);
      }
    }
  }
  return m.map((row, i) => (row[n] ?? 0) / (row[i] ?? 1));
}

/** 矩阵求逆（Gauss-Jordan 增广；奇异返回 null）。 */
function invert(matrix: readonly (readonly number[])[]): number[][] | null {
  const n = matrix.length;
  const m: number[][] = matrix.map((row, i) => [
    ...row,
    ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  ]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(at(at(m, row, 'm'), col, 'col')) > Math.abs(at(at(m, pivot, 'm'), col, 'col'))) {
        pivot = row;
      }
    }
    const pivotRow = at(m, pivot, 'm');
    if (Math.abs(at(pivotRow, col, 'col')) < 1e-12) return null;
    const colRow = at(m, col, 'm');
    m[col] = pivotRow;
    m[pivot] = colRow;
    // swap 后 m[col] = 原 pivot 行（主元行）；以其对角元归一
    const active = pivotRow;
    const div = at(active, col, 'div');
    for (let k = col; k < 2 * n; k += 1) active[k] = (active[k] ?? 0) / div;
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const target = at(m, row, 'm');
      const factor = target[col] ?? 0;
      if (factor === 0) continue;
      for (let k = col; k < 2 * n; k += 1) {
        target[k] = (target[k] ?? 0) - factor * (active[k] ?? 0);
      }
    }
  }
  return m.map((row) => row.slice(n));
}

/** A′B（小矩阵乘）。 */
function matMul(a: readonly (readonly number[])[], b: readonly (readonly number[])[]): number[][] {
  const n = a.length;
  const k = (b[0] ?? []).length;
  const out: number[][] = Array.from({ length: n }, () => Array.from({ length: k }, () => 0));
  for (let i = 0; i < n; i += 1) {
    for (let t = 0; t < b.length; t += 1) {
      const left = a[i]?.[t] ?? 0;
      if (left === 0) continue;
      const outRow = at(out, i, 'out');
      const bRow = b[t] ?? [];
      for (let j = 0; j < k; j += 1) {
        outRow[j] = (outRow[j] ?? 0) + left * (bRow[j] ?? 0);
      }
    }
  }
  return out;
}

/** a′Ma（二次型标量）。 */
function quadraticForm(m: readonly (readonly number[])[], a: readonly number[]): number {
  const ma = matMul([a], m)[0] ?? [];
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += (ma[i] ?? 0) * (a[i] ?? 0);
  return sum;
}

function dot(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

/**
 * 日粒度 OLS 拟合（§3.4）。样本不足（n ≤ p）或设计矩阵奇异返回 null——
 * 调用方以 unfit 形态持久 spec（model_params 拟合族 null）。
 */
export function fitOls(samples: readonly FitSample[], spec: OlsSpec): OlsFit | null {
  const p = paramCount(spec);
  const n = samples.length;
  if (n <= p) return null;

  const rows = samples.map((s) => designRow(s.cdd, s.hdd, s.weekend, spec));
  const y = samples.map((s) => s.e);
  const firstRow = at(rows, 0, 'rows');
  const xtx = matMul(
    firstRow.map((_, i) => rows.map((r) => r[i] ?? 0)),
    rows,
  );
  const xty = firstRow.map((_, i) =>
    rows.reduce((sum, r, k) => sum + (r[i] ?? 0) * (y[k] ?? 0), 0),
  );
  const beta = solveLinear(xtx, xty);
  const xtxInv = invert(xtx);
  if (beta === null || xtxInv === null) return null;

  let sse = 0;
  let sumY = 0;
  let sumYY = 0;
  let nmbeNum = 0;
  for (let k = 0; k < n; k += 1) {
    const xk = rows[k] as number[];
    const yk = y[k] ?? 0;
    const pred = dot(xk, beta);
    sse += (yk - pred) ** 2;
    sumY += yk;
    sumYY += yk * yk;
    nmbeNum += pred - yk;
  }
  const meanY = sumY / n;
  const tss = sumYY - n * meanY * meanY;
  const dof = n - p;
  const sigma = Math.sqrt(sse / dof);
  const rmse = sigma;
  const r2 = tss > 0 ? 1 - sse / tss : 1;
  const adjR2 = tss > 0 ? 1 - ((1 - r2) * (n - 1)) / dof : 1;
  const cvrmsePct = meanY > 0 ? (rmse / meanY) * 100 : Number.POSITIVE_INFINITY;
  const nmbePct = sumY !== 0 ? (nmbeNum / sumY) * 100 : Number.NaN;

  const stderrDiag = xtxInv.map((row, i) => Math.sqrt(Math.max((row[i] ?? 0) * (sse / dof), 0)));
  const meanRow = at(rows, 0, 'rows').map(
    (_, i) => rows.reduce((sum, r) => sum + (r[i] ?? 0), 0) / n,
  );

  return {
    coefficients: {
      b0: beta[0] ?? 0,
      b1: beta[1] ?? 0,
      b2: beta[2] ?? 0,
      b3: spec.weekend_dummy ? (beta[3] ?? 0) : null,
    },
    stderrs: {
      b0: stderrDiag[0] ?? 0,
      b1: stderrDiag[1] ?? 0,
      b2: stderrDiag[2] ?? 0,
      b3: spec.weekend_dummy ? (stderrDiag[3] ?? 0) : null,
    },
    sigma_kwh: sigma,
    n_obs: n,
    metrics: {
      r2,
      adj_r2: adjR2,
      rmse_kwh: rmse,
      cvrmse_pct: cvrmsePct,
      nmbe_pct: Number.isNaN(nmbePct) ? 0 : nmbePct,
    },
    xtx_inv: xtxInv,
    fit_daily_mean_kwh: meanY,
    fit_mean_row: meanRow,
  };
}

// ---------------------------------------------------------------------------
// t 分位数（正则化不完全 Beta 的数值逆解；CI 的 t_{0.84, n−p} 载体）
// ---------------------------------------------------------------------------

/** Lanczos 对数 Gamma。 */
function logGamma(x: number): number {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = 0.99999999999980993;
  const t = x + 7.5;
  for (let i = 0; i < g.length; i += 1) a += (g[i] ?? 0) / (x + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** 正则化不完全 Beta I_x(a,b)（连分式，Numerical Recipes betacf）。 */
function betaInc(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const front = Math.exp(lbeta);
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betaCf(x, a, b)) / a;
  }
  return 1 - (front * betaCf(1 - x, b, a)) / b;
}

function betaCf(x: number, a: number, b: number): number {
  const maxIter = 200;
  const eps = 3e-12;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIter; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < eps) break;
  }
  return h;
}

/**
 * t 分布分位数（双侧置信水平 conf 的上/下界，如 conf=0.68 → p=(1+0.68)/2=0.84 单侧）。
 * x ≥ 0 侧 CDF(x) = 1 − ½·I_{ν/(ν+x²)}(ν/2, ½)——对 I 做二分逆解。
 */
export function tQuantile(conf: number, dof: number): number {
  const p = (1 + conf) / 2;
  const target = 2 * (1 - p); // I_z 目标值
  // I_z 随 z 单调增、随 x 单调减：I_z(mid) > target → x 偏小 → z 上界下压
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    const iz = betaInc(mid, dof / 2, 0.5);
    if (iz > target) hi = mid;
    else lo = mid;
  }
  const z = (lo + hi) / 2;
  return Math.sqrt((dof * (1 - z)) / z);
}

// ---------------------------------------------------------------------------
// §3.6 报告计算
// ---------------------------------------------------------------------------

/** 冻结基线模型（model_params 的计算消费面）。 */
export interface FrozenModel {
  readonly coefficients: { b0: number; b1: number; b2: number; b3: number | null };
  readonly sigma_kwh: number;
  readonly n_obs: number;
  readonly xtx_inv: readonly (readonly number[])[];
  readonly fit_daily_mean_kwh: number;
  readonly fit_mean_row: readonly number[];
  readonly metrics: { cvrmse_pct: number };
  readonly spec: OlsSpec;
}

/** 报告期日天气（有效日才有记录；§3.3）。 */
export interface DayWeather {
  readonly cdd: number;
  readonly hdd: number;
  readonly weekend: boolean;
}

export interface ReportComputation {
  readonly actual_energy_kwh: number;
  readonly baseline_energy_kwh: number;
  readonly raw_saving_kwh: number;
  readonly weather_adjusted_saving_kwh: number | null;
  readonly confidence_interval: {
    level: number;
    half_width_kwh: number;
    lower_kwh: number;
    upper_kwh: number;
    sigma_kwh: number;
    cvrmse_pct: number;
    n_obs: number;
    weather_coverage_pct: number;
    uncertainty_high: boolean;
    imputed_days: number;
  } | null;
  readonly imputed_days: number;
  readonly weather_coverage_pct: number;
  readonly series: readonly {
    date: string;
    baseline_pred_kwh: number | null;
    actual_kwh: number | null;
  }[];
}

/** 模型逐日预测 Ŝ_d（§3.6-4）。 */
export function predictDay(model: FrozenModel, weather: DayWeather): number {
  const row = designRow(weather.cdd, weather.hdd, weather.weekend, model.spec);
  const beta = [
    model.coefficients.b0,
    model.coefficients.b1,
    model.coefficients.b2,
    ...(model.coefficients.b3 !== null ? [model.coefficients.b3] : []),
  ];
  return dot(row, beta);
}

/**
 * §3.6 全口径：periodDates 全序日列表；energyByDay 仅完整日；weatherByDay 仅有效日。
 * 计算：
 * 1. actual = ΣE_d(完整) + ΣÊ_d(插补：天气可用 → 模型预测，否则 Ē_fit)；
 * 2. 口径 A：baseline_energy_kwh = Ē_fit × |R|；raw_saving = A − actual；
 * 3. 口径 B（覆盖率 ≥ MV_PERIOD_WEATHER_MIN）：adjusted_baseline = ΣŜ_d（缺天气日
 *    回退 Ē_fit，方差贡献行 = fit_mean_row）；CI = t·√(σ²·1′X_R(X′X)⁻¹X_R′1)；
 * 4. uncertainty_high = half_width > 0.5×|saving|（警示不阻断）。
 */
export function computeReport(input: {
  periodDates: readonly string[];
  energyByDay: ReadonlyMap<string, number>;
  weatherByDay: ReadonlyMap<string, DayWeather>;
  model: FrozenModel;
  ciLevel: number;
  periodWeatherMin: number;
  uncertaintyRatioMax: number;
}): ReportComputation {
  const { periodDates, energyByDay, weatherByDay, model } = input;
  const totalDays = periodDates.length;

  let actual = 0;
  let imputed = 0;
  let weatherValidDays = 0;
  const sumRow = new Array<number>(model.fit_mean_row.length).fill(0);
  let adjustedBaseline = 0;
  const series: { date: string; baseline_pred_kwh: number | null; actual_kwh: number | null }[] =
    [];

  for (const date of periodDates) {
    const weather = weatherByDay.get(date);
    if (weather !== undefined) weatherValidDays += 1;

    const measured = energyByDay.get(date);
    if (measured !== undefined) {
      actual += measured;
      series.push({ date, baseline_pred_kwh: null, actual_kwh: measured });
    } else {
      // 缺日插补（§3.6-2）：天气可用 → 模型预测；天气缺失日 → 样本日均
      const imputedValue =
        weather !== undefined ? predictDay(model, weather) : model.fit_daily_mean_kwh;
      actual += imputedValue;
      imputed += 1;
      series.push({ date, baseline_pred_kwh: null, actual_kwh: imputedValue });
    }

    // 口径 B 的 adjusted_baseline 与 CI 设计行（缺天气日回退 Ē_fit，行 = fit_mean_row）
    if (weather !== undefined) {
      const pred = predictDay(model, weather);
      adjustedBaseline += pred;
      const row = designRow(weather.cdd, weather.hdd, weather.weekend, model.spec);
      for (let i = 0; i < row.length; i += 1) sumRow[i] = (sumRow[i] ?? 0) + (row[i] ?? 0);
    } else {
      adjustedBaseline += model.fit_daily_mean_kwh;
      for (let i = 0; i < model.fit_mean_row.length; i += 1) {
        sumRow[i] = (sumRow[i] ?? 0) + (model.fit_mean_row[i] ?? 0);
      }
    }
  }

  const weatherCoverage = totalDays > 0 ? weatherValidDays / totalDays : 0;
  const baselineEnergy = model.fit_daily_mean_kwh * totalDays;
  const rawSaving = baselineEnergy - actual;

  if (weatherCoverage < input.periodWeatherMin) {
    // 降级（§3.6-4）：口径 B 与 CI 均 NULL——双口径并列，不静默出单口径
    return {
      actual_energy_kwh: actual,
      baseline_energy_kwh: baselineEnergy,
      raw_saving_kwh: rawSaving,
      weather_adjusted_saving_kwh: null,
      confidence_interval: null,
      imputed_days: imputed,
      weather_coverage_pct: weatherCoverage,
      series,
    };
  }

  const adjustedSaving = adjustedBaseline - actual;
  const p = model.fit_mean_row.length;
  const dof = model.n_obs - p;
  const variance = model.sigma_kwh ** 2 * quadraticForm(model.xtx_inv, sumRow);
  const halfWidth = dof > 0 ? tQuantile(input.ciLevel, dof) * Math.sqrt(Math.max(variance, 0)) : 0;
  const ci = {
    level: input.ciLevel,
    half_width_kwh: halfWidth,
    lower_kwh: adjustedSaving - halfWidth,
    upper_kwh: adjustedSaving + halfWidth,
    sigma_kwh: model.sigma_kwh,
    cvrmse_pct: model.metrics.cvrmse_pct,
    n_obs: model.n_obs,
    weather_coverage_pct: weatherCoverage,
    uncertainty_high: halfWidth > input.uncertaintyRatioMax * Math.abs(adjustedSaving),
    imputed_days: imputed,
  };

  // 双曲线序列的基线预测列（口径 B 出时逐日补齐；缺天气日保持 null）
  for (const point of series) {
    const weather = weatherByDay.get(point.date);
    if (weather !== undefined) {
      point.baseline_pred_kwh = predictDay(model, weather);
    }
  }

  return {
    actual_energy_kwh: actual,
    baseline_energy_kwh: baselineEnergy,
    raw_saving_kwh: rawSaving,
    weather_adjusted_saving_kwh: adjustedSaving,
    confidence_interval: ci,
    imputed_days: imputed,
    weather_coverage_pct: weatherCoverage,
    series,
  };
}

// ---------------------------------------------------------------------------
// §3.2/§3.3 日序列装配（TSDB 聚合行 → 完整日/缺口/度日）
// ---------------------------------------------------------------------------

/** TSDB 聚合返回的点×日统计（telemetry_1h 日聚合，§3.2）。 */
export interface PointDayStat {
  readonly point_id: number;
  readonly date: string; // 'YYYY-MM-DD'（UTC 日边界）
  readonly hours: number; // 当日有值 1h 桶数
  readonly samples: number;
  readonly bad_samples: number;
  readonly day_last: number | null;
}

export interface DayEnergyOutcome {
  /** 完整日 → 楼宇日能耗 E_d。 */
  readonly energyByDay: Map<string, number>;
  /** 缺口明细（按日期段 × 点位聚合计数，§3.5 形状）。 */
  readonly gaps: readonly {
    from: string;
    to: string;
    days: number;
    points_affected: readonly string[];
    cause: 'reset' | 'hours' | 'bad_ratio';
  }[];
  readonly complete_days: number;
  readonly period_days: number;
}

/**
 * §3.2 管线：逐点逐日 ΔE = L(d) − L(d−1)；点日完整 = 24 桶 ∧ 坏样 ≤5% ∧ 无复位 ∧
 * 前日末值存在；楼宇日完整 = 全部点位完整。stats 需包含 preStartDate（期起前一日，
 * L(d−1) 载体）——首日差值同样需要前日末桶 last。
 */
export function assembleDayEnergy(
  periodDates: readonly string[],
  pointIds: readonly number[],
  stats: readonly PointDayStat[],
  options: { dayHoursMin: number; badRatioMax: number; preStartDate: string },
): DayEnergyOutcome {
  const dateIndex = new Map(periodDates.map((date, i) => [date, i]));
  const previousDate = new Map<string, string>();
  if (periodDates.length > 0) {
    previousDate.set(periodDates[0] as string, options.preStartDate);
  }
  for (let i = 1; i < periodDates.length; i += 1) {
    previousDate.set(periodDates[i] as string, periodDates[i - 1] as string);
  }
  // point_id → date → stat
  const byPoint = new Map<number, Map<string, PointDayStat>>();
  for (const stat of stats) {
    let days = byPoint.get(stat.point_id);
    if (days === undefined) {
      days = new Map();
      byPoint.set(stat.point_id, days);
    }
    days.set(stat.date, stat);
  }

  const energyByDay = new Map<string, number>();
  const gapDays = new Map<string, { points: Set<number>; cause: string }>();
  for (const date of periodDates) {
    const prev = previousDate.get(date);
    let dayTotal = 0;
    let complete = true;
    for (const pointId of pointIds) {
      const dayStat = byPoint.get(pointId)?.get(date);
      const prevStat = prev === undefined ? undefined : byPoint.get(pointId)?.get(prev);
      const cause = pointDayGapCause(dayStat, prevStat, options);
      if (cause !== null || dayStat === undefined || prevStat === undefined) {
        complete = false;
        if (cause !== null) recordGap(date, pointId, cause);
        continue;
      }
      // cause === null 已含双方存在且 day_last 非 null 的判定
      dayTotal += (dayStat.day_last as number) - (prevStat.day_last as number);
    }
    if (complete) energyByDay.set(date, dayTotal);
  }

  function pointDayGapCause(
    dayStat: PointDayStat | undefined,
    prevStat: PointDayStat | undefined,
    opts: { dayHoursMin: number; badRatioMax: number },
  ): 'reset' | 'hours' | 'bad_ratio' | null {
    if (dayStat === undefined || dayStat.day_last === null) return 'hours';
    if (dayStat.hours < opts.dayHoursMin) return 'hours';
    if (dayStat.samples > 0 && dayStat.bad_samples / dayStat.samples > opts.badRatioMax) {
      return 'bad_ratio';
    }
    if (prevStat === undefined || prevStat.day_last === null) return 'hours';
    if (dayStat.day_last < prevStat.day_last) return 'reset';
    return null;
  }

  function recordGap(date: string, pointId: number, cause: string): void {
    let entry = gapDays.get(date);
    if (entry === undefined) {
      entry = { points: new Set(), cause };
      gapDays.set(date, entry);
    }
    entry.points.add(pointId);
    // 同日多因：hours < bad_ratio < reset 严重序（呈现取最严重因，缺口计数不重复）
    const order: Record<string, number> = { hours: 0, bad_ratio: 1, reset: 2 };
    if ((order[cause] ?? 0) > (order[entry.cause] ?? 0)) entry.cause = cause;
  }

  // 相邻同（点位集 ∪ cause）日聚合成日期段（§3.5 gaps 形状）
  const gaps: {
    from: string;
    to: string;
    days: number;
    points_affected: string[];
    cause: 'reset' | 'hours' | 'bad_ratio';
  }[] = [];
  const sortedDays = [...gapDays.entries()].sort(
    (a, b) => (dateIndex.get(a[0]) ?? 0) - (dateIndex.get(b[0]) ?? 0),
  );
  let current: {
    from: string;
    to: string;
    days: number;
    points: Set<number>;
    cause: string;
  } | null = null;
  for (const [date, entry] of sortedDays) {
    const key = `${entry.cause}|${[...entry.points].sort((a, b) => a - b).join(',')}`;
    const currentKey =
      current === null
        ? ''
        : `${current.cause}|${[...current.points].sort((a, b) => a - b).join(',')}`;
    const prev = previousDate.get(date);
    if (current !== null && key === currentKey && prev === current.to) {
      current.to = date;
      current.days += 1;
    } else {
      if (current !== null) {
        gaps.push({
          from: current.from,
          to: current.to,
          days: current.days,
          points_affected: [...current.points]
            .sort((a, b) => a - b)
            .map((p) => `point:${String(p)}`),
          cause: current.cause as 'reset' | 'hours' | 'bad_ratio',
        });
      }
      current = {
        from: date,
        to: date,
        days: 1,
        points: new Set(entry.points),
        cause: entry.cause,
      };
    }
  }
  if (current !== null) {
    gaps.push({
      from: current.from,
      to: current.to,
      days: current.days,
      points_affected: [...current.points].sort((a, b) => a - b).map((p) => `point:${String(p)}`),
      cause: current.cause as 'reset' | 'hours' | 'bad_ratio',
    });
  }

  return {
    energyByDay,
    gaps,
    complete_days: energyByDay.size,
    period_days: periodDates.length,
  };
}

/** TSDB 天气日聚合行（§3.3）。 */
export interface WeatherDayStat {
  readonly date: string;
  readonly hours: number;
  readonly cdd: number;
  readonly hdd: number;
}

/** §3.3：有效日（≥ weatherHoursMin 整点）→ 度日映射；周末哑变量按 UTC 星期六/日。 */
export function assembleWeatherByDay(
  stats: readonly WeatherDayStat[],
  weatherHoursMin: number,
): Map<string, DayWeather> {
  const out = new Map<string, DayWeather>();
  for (const stat of stats) {
    if (stat.hours < weatherHoursMin) continue;
    const weekday = new Date(`${stat.date}T00:00:00Z`).getUTCDay();
    out.set(stat.date, {
      cdd: stat.cdd,
      hdd: stat.hdd,
      weekend: weekday === 0 || weekday === 6,
    });
  }
  return out;
}

/** 期间日列表（[start, end) 半开，UTC 日粒度）。 */
export function enumerateDates(start: string, end: string): string[] {
  const out: string[] = [];
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  for (let ts = startMs; ts < endMs; ts += 86_400_000) {
    out.push(new Date(ts).toISOString().slice(0, 10));
  }
  return out;
}

/** 报告编号（§3.6）：MV-{building_code}-{start}-{end}-{short(report_id)}。 */
export function buildReportNo(
  buildingCode: string,
  period: { start: string; end: string },
  reportId: string,
): string {
  const short = reportId.replace(/-/g, '').slice(0, 8);
  return `MV-${buildingCode}-${period.start}-${period.end}-${short}`;
}

/**
 * 楼宇编码（报告编号用）：building 表无 code 列（ddl §4）——取名称 slug
 * （字母数字与 CJK），空则退 building_id 前 8 位。确定性、可读。
 */
export function buildingCodeOf(name: string | null, buildingId: string): string {
  const slug = (name ?? '').replace(/[^A-Za-z0-9一-鿿]/g, '').slice(0, 16);
  return slug.length > 0 ? slug : buildingId.replace(/-/g, '').slice(0, 8);
}

/** 今日（UTC ISO 日期）。 */
export function todayUtc(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}
