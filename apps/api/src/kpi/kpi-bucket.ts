/**
 * M11 能耗桶计算纯函数（modules/M11-kpi-dashboard.md §2.2/§2.3；IMPL-22 / DAT-246）。
 *
 * 口径（§2.2 与 M3 §10.2 B1 同语义的 cagg 推广）：
 * - 桶能耗（点位）= last(本桶) − last(上一可用桶)——对 telemetry_1h.last 按 point_id
 *   做 LAG 差分（SQL LAG 语义：跨缺失行取上一可用行——累计表缺口段的走字量并入
 *   下一可用桶差值，缺失桶本身 null 不插值）；
 * - 状态判据封闭集：ok（有样本/Δ≥0/无坏样）/ uncertain（有坏样）/ reset（Δ<0，
 *   不计入且重算起点）/ gap（无样本或点位首桶）；
 * - coverage = (ok+uncertain) ÷ 应有桶数（点位级全集最小值，楼宇级同式）；
 * - 日桶 = 该本地日（Asia/Shanghai）内 1h 桶二段聚合（服务端 SQL 只取三列后进程内
 *   完成——§5.2 实现 notes）；进行中桶 partial 标注（real-time 语义）。
 *
 * 时区定夺：Asia/Shanghai 自 1991 年起无夏令时（IANA tzdb 无现代转换），本地日界
 * 按固定 UTC+8 算术实现（与 algo 报告周期口径一致，algo.md §3）。
 */

/** Asia/Shanghai 固定偏移（无现代 DST 转换，见头注）。 */
export const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;

/** cagg 行（§5.2 实现 notes：SQL 只取 point_id/bucket/last/bad_count）。 */
export interface KpiHourRow {
  readonly point_id: number;
  readonly bucket: Date;
  readonly last: number | null;
  readonly bad_count: number;
}

/** 点位 × 桶判定结果（渲染与统计共用的原子粒度）。 */
export interface PointBucket {
  readonly point_id: number;
  readonly bucket: Date;
  readonly kwh: number | null;
  readonly status: 'ok' | 'uncertain' | 'reset' | 'gap';
}

/** 应有桶数（hour 桶；含首尾不完整小时，§2.3 窗口语义）。 */
export function expectedHourBuckets(from: Date, to: Date): number {
  return Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 3_600_000));
}

/**
 * 点位级 LAG 差分 + 状态打标（§2.2 判据表逐行）。
 *
 * 输入行须含窗口前一桶（调用方以 from − 1h 起查——首桶差值基线，M9 pointDayStats
 * preStartDate 同款）；首可用行无前驱 → gap（点位首桶语义）。
 */
export function diffPointBuckets(rows: readonly KpiHourRow[]): PointBucket[] {
  const sorted = [...rows].sort(
    (a, b) => a.bucket.getTime() - b.bucket.getTime() || a.point_id - b.point_id,
  );
  const out: PointBucket[] = [];
  const lastSeen = new Map<number, number>();
  for (const row of sorted) {
    const prev = lastSeen.get(row.point_id);
    if (prev === undefined || row.last === null) {
      // 点位首桶（无前驱可用读数）或本桶无有效读数 → gap；差值基线维持/建立
      if (row.last !== null) lastSeen.set(row.point_id, row.last);
      out.push({ point_id: row.point_id, bucket: row.bucket, kwh: null, status: 'gap' });
      continue;
    }
    lastSeen.set(row.point_id, row.last);
    const delta = row.last - prev;
    if (delta < 0) {
      // reset：不计入，起算点重置（后续桶从本桶 last 重新差分——lastSeen 已更新）
      out.push({ point_id: row.point_id, bucket: row.bucket, kwh: null, status: 'reset' });
    } else if (row.bad_count > 0) {
      out.push({
        point_id: row.point_id,
        bucket: row.bucket,
        kwh: round3(delta),
        status: 'uncertain',
      });
    } else {
      out.push({ point_id: row.point_id, bucket: row.bucket, kwh: round3(delta), status: 'ok' });
    }
  }
  return out;
}

/** 点位级 coverage：窗口内 (ok+uncertain) ÷ 应有桶数；全集最小值由调用方取。 */
export function pointCoverage(
  buckets: readonly PointBucket[],
  pointIds: readonly number[],
  from: Date,
  to: Date,
  interval: 'hour' | 'day' = 'hour',
): number {
  if (pointIds.length === 0) return 0;
  if (interval === 'day') {
    const expected = expectedDayBuckets(from, to);
    let min = 1;
    for (const pointId of pointIds) {
      const days = new Set<number>();
      for (const b of buckets) {
        if (b.point_id !== pointId) continue;
        if (b.status !== 'ok' && b.status !== 'uncertain') continue;
        days.add(localDayBucket(b.bucket).getTime());
      }
      min = Math.min(min, expected === 0 ? 0 : days.size / expected);
    }
    return clamp01(min);
  }
  const expected = expectedHourBuckets(from, to);
  let min = 1;
  for (const pointId of pointIds) {
    const usable = buckets.filter(
      (b) => b.point_id === pointId && (b.status === 'ok' || b.status === 'uncertain'),
    ).length;
    min = Math.min(min, expected === 0 ? 0 : usable / expected);
  }
  return clamp01(min);
}

/** 应有日桶数：窗口触达的本地日数（§2.3 day 桶 = 本地日界）。 */
export function expectedDayBuckets(from: Date, to: Date): number {
  const fromLocal = from.getTime() + SHANGHAI_OFFSET_MS;
  const toLocal = to.getTime() + SHANGHAI_OFFSET_MS;
  const first = Math.floor(fromLocal / 86_400_000);
  const last = Math.ceil(toLocal / 86_400_000) - 1;
  return Math.max(1, last - first + 1);
}

/**
 * 楼宇/分组级桶聚合（趋势端点消费形状）。
 *
 * 聚合桶状态优先级：gap（零贡献点桶）> reset（任一贡献点位 reset）>
 * uncertain（任一 uncertain）> ok——reset/uncertain 的点位级不计入/计入语义
 * 在点位层完成，聚合层只保留「本桶含重置/坏样」的图表标注信息（§2.2 处置列）。
 */
export interface AggregateBucket {
  readonly bucket: Date;
  readonly total_kwh: number | null;
  readonly status: 'ok' | 'uncertain' | 'reset' | 'gap';
  readonly partial: boolean;
  readonly groups: ReadonlyMap<string, number | null>;
}

export interface AggregateOptions {
  /** group_by=none → 单一合计（groups 空）；否则 key → kwh（null=该组本桶无数据）。 */
  readonly groupBy: 'none' | 'system_type' | 'equipment_type';
  /** point_id → 组键（'unclassified' 由调用方解析）。 */
  readonly groupOf: ReadonlyMap<number, string>;
  readonly groupKeys: readonly string[];
  readonly now: Date;
  /** 桶宽（hour 聚合 = 1h；day 聚合时传入 localDayBucket）。 */
  readonly bucketOf?: (hourStart: Date) => Date;
  readonly bucketSpanMs?: number;
}

export function aggregateBuckets(
  pointBuckets: readonly PointBucket[],
  from: Date,
  to: Date,
  options: AggregateOptions,
): AggregateBucket[] {
  const bucketOf = options.bucketOf ?? ((d: Date) => d);
  const span = options.bucketSpanMs ?? 3_600_000;
  const byBucket = new Map<number, PointBucket[]>();
  for (const b of pointBuckets) {
    if (b.bucket.getTime() < from.getTime() || b.bucket.getTime() >= to.getTime()) continue;
    const key = bucketOf(b.bucket).getTime();
    const list = byBucket.get(key);
    if (list === undefined) byBucket.set(key, [b]);
    else list.push(b);
  }
  const starts = [...byBucket.keys()].sort((a, b) => a - b);
  return starts.map((start) => {
    const items = byBucket.get(start) ?? [];
    const contributing = items.filter((b) => b.status === 'ok' || b.status === 'uncertain');
    const hasReset = items.some((b) => b.status === 'reset');
    const status =
      contributing.length === 0 && !hasReset
        ? 'gap' // 全 gap（或空桶）：无任何可用贡献
        : hasReset
          ? 'reset'
          : items.some((b) => b.status === 'uncertain')
            ? 'uncertain'
            : 'ok';
    const total =
      status === 'gap' || contributing.length === 0
        ? null
        : round3(contributing.reduce((sum, b) => sum + (b.kwh ?? 0), 0));
    const groups = new Map<string, number | null>();
    if (options.groupBy !== 'none') {
      for (const key of options.groupKeys) {
        const groupItems = items.filter((b) => options.groupOf.get(b.point_id) === key);
        const groupContribing = groupItems.filter(
          (b) => b.status === 'ok' || b.status === 'uncertain',
        );
        groups.set(
          key,
          groupContribing.length === 0
            ? null
            : round3(groupContribing.reduce((sum, b) => sum + (b.kwh ?? 0), 0)),
        );
      }
    }
    const partial =
      options.now.getTime() >= start &&
      options.now.getTime() < start + span &&
      to.getTime() > options.now.getTime();
    return { bucket: new Date(start), total_kwh: total, status, partial, groups };
  });
}

/** 本地日桶起点（Asia/Shanghai 日界，固定 +8——见头注）。 */
export function localDayBucket(hourStart: Date): Date {
  const shifted = hourStart.getTime() + SHANGHAI_OFFSET_MS;
  const dayStart = Math.floor(shifted / 86_400_000) * 86_400_000;
  return new Date(dayStart - SHANGHAI_OFFSET_MS);
}

/** 本地月起点（overview 缺省窗「本月至今」，§5.1）。 */
export function localMonthStart(now: Date): Date {
  const shifted = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  return new Date(Date.UTC(y, m, 1) - SHANGHAI_OFFSET_MS);
}

/** §2.3 自动规则：≤7 天 hour，>7 天 day。 */
export function autoInterval(from: Date, to: Date): 'hour' | 'day' {
  return to.getTime() - from.getTime() <= 7 * 86_400_000 ? 'hour' : 'day';
}

/** 结构端点窗口合计（§5.3：窗口级拆分，不分桶；unclassified 恒末位）。 */
export interface StructureItem {
  readonly key: string;
  readonly kwh: number | null;
  readonly share_pct: number | null;
}

export function structureOf(
  pointBuckets: readonly PointBucket[],
  groupOf: ReadonlyMap<number, string>,
  groupKeys: readonly string[],
): { total_kwh: number | null; items: StructureItem[] } {
  const sums = new Map<string, number>();
  for (const key of groupKeys) sums.set(key, 0);
  let any = false;
  for (const b of pointBuckets) {
    if (b.status !== 'ok' && b.status !== 'uncertain') continue;
    const key = groupOf.get(b.point_id);
    if (key === undefined) continue;
    sums.set(key, (sums.get(key) ?? 0) + (b.kwh ?? 0));
    any = true;
  }
  if (!any) {
    return {
      total_kwh: null,
      items: groupKeys.map((key) => ({ key, kwh: null, share_pct: null })),
    };
  }
  const total = round3([...sums.values()].reduce((s, v) => s + v, 0));
  const items = orderedItems(groupKeys, sums).map(({ key, kwh }) => ({
    key,
    kwh,
    share_pct: total > 0 ? round1((kwh / total) * 100) : null,
  }));
  return { total_kwh: total, items };
}

/** unclassified 恒末位；其余按 kWh 降序（§5.3 图表读序）。 */
function orderedItems(
  groupKeys: readonly string[],
  sums: ReadonlyMap<string, number>,
): { key: string; kwh: number }[] {
  const classified = groupKeys
    .filter((k) => k !== 'unclassified')
    .map((key) => ({ key, kwh: round3(sums.get(key) ?? 0) }))
    .sort((a, b) => b.kwh - a.kwh);
  if (!groupKeys.includes('unclassified')) return classified;
  return [...classified, { key: 'unclassified', kwh: round3(sums.get('unclassified') ?? 0) }];
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, Math.round(v * 1000) / 1000));
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
