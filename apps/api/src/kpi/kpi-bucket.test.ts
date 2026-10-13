/**
 * M11 桶计算纯函数单测（M11-kpi-dashboard §2.2/§2.3；IMPL-22 / DAT-246）。
 *
 * 契约矩阵锚点（§5.9 用例 5/6）：表计清零序列（reset 不计入 + 重置点重差分）/
 * 缺数段（gap 不插值 + coverage 判据）——AC-7 口径一致性的进程内面。
 */
import { describe, expect, it } from 'vitest';
import {
  aggregateBuckets,
  autoInterval,
  diffPointBuckets,
  expectedDayBuckets,
  expectedHourBuckets,
  localDayBucket,
  localMonthStart,
  pointCoverage,
  structureOf,
  type KpiHourRow,
} from './kpi-bucket.js';

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 12, 0, 0, 0); // 2026-10-12 00:00Z（周一）

function row(pointId: number, hourOffset: number, last: number | null, bad = 0): KpiHourRow {
  return { point_id: pointId, bucket: new Date(T0 + hourOffset * H), last, bad_count: bad };
}

function at(hourOffset: number): string {
  return new Date(T0 + hourOffset * H).toISOString();
}

describe('diffPointBuckets（§2.2 判据表）', () => {
  it('shouldMarkOk_whenDeltaNonNegativeWithoutBadSamples', () => {
    const buckets = diffPointBuckets([row(1, 0, 100), row(1, 1, 150)]);
    expect(buckets[1]).toEqual({ point_id: 1, bucket: new Date(at(1)), kwh: 50, status: 'ok' });
  });

  it('shouldMarkUncertain_whenBucketContainsBadSamples', () => {
    const buckets = diffPointBuckets([row(1, 0, 100), row(1, 1, 150, 3)]);
    expect(buckets[1]?.status).toBe('uncertain');
    expect(buckets[1]?.kwh).toBe(50); // 计入（coverage 分母计「可用（含不确定）」）
  });

  it('shouldMarkGap_andKeepDiffBase_whenReadingMissing', () => {
    // 中间桶无行：缺失桶不在输出（无样本）；下一桶差值跨缺失段（累计表走字并入）
    const buckets = diffPointBuckets([row(1, 0, 100), row(1, 2, 300)]);
    expect(buckets.filter((b) => b.bucket.getTime() === T0 + 2 * H)).toEqual([
      { point_id: 1, bucket: new Date(at(2)), kwh: 200, status: 'ok' },
    ]);
  });

  it('shouldMarkGap_whenFirstBucketHasNoPredecessor', () => {
    const buckets = diffPointBuckets([row(1, 0, 100), row(1, 1, 150)]);
    expect(buckets[0]?.status).toBe('gap'); // 点位首桶（无前驱读数）
    expect(buckets[0]?.kwh).toBeNull();
  });

  it('shouldMarkGap_whenLastReadingNull', () => {
    const buckets = diffPointBuckets([row(1, 0, 100), row(1, 1, null), row(1, 2, 220)]);
    expect(buckets[1]?.status).toBe('gap');
    // 基线保持 100 → 桶 2 差值 120（桶 1 无读数不推进基线）
    expect(buckets[2]?.kwh).toBe(120);
  });

  it('shouldMarkReset_andRebase_whenDeltaNegative（§5.9 用例 5）', () => {
    // 300 → 500（+200 ok）→ 清零 20（reset 不计入）→ 260（从 20 重新差分 = 240）
    const buckets = diffPointBuckets([
      row(1, 0, 300),
      row(1, 1, 500),
      row(1, 2, 20),
      row(1, 3, 260),
    ]);
    expect(buckets[1]).toMatchObject({ status: 'ok', kwh: 200 });
    expect(buckets[2]).toMatchObject({ status: 'reset', kwh: null });
    expect(buckets[3]).toMatchObject({ status: 'ok', kwh: 240 }); // 重置点后重新差分
  });
});

describe('pointCoverage（§2.2 coverage 判据）', () => {
  it('shouldComputeOkPlusUncertainOverExpected（§5.9 用例 6）', () => {
    // 服务端语义：from−1h 为差值基线桶（不入窗口统计）；窗口 [T0, T0+6h) 应有 6 桶
    const from = new Date(T0);
    const to = new Date(T0 + 6 * H);
    const buckets = diffPointBuckets([
      row(1, -1, 0), // 基线桶
      row(1, 0, 10),
      row(1, 1, 20),
      row(1, 2, 30),
      row(1, 3, 42, 2), // uncertain（坏样计入 coverage 分母「可用（含不确定）」）
      // 桶 4/5 缺 → usable 4/6
    ]).filter((b) => b.bucket.getTime() >= T0);
    expect(pointCoverage(buckets, [1], from, to)).toBeCloseTo(4 / 6, 3);
  });

  it('shouldTakeMinAcrossPoints_atBuildingLevel', () => {
    const from = new Date(T0);
    const to = new Date(T0 + 4 * H);
    const buckets = [
      ...diffPointBuckets([row(1, -1, 0), row(1, 0, 10), row(1, 1, 20), row(1, 2, 30)]),
      ...diffPointBuckets([row(2, -1, 0), row(2, 0, 5)]), // 1/4
    ].filter((b) => b.bucket.getTime() >= T0);
    expect(pointCoverage(buckets, [1, 2], from, to)).toBeCloseTo(1 / 4, 3);
  });

  it('shouldCountLocalDays_forDayInterval', () => {
    // 窗口对齐本地日界（上海 10-12 0 点 → 10-15 0 点）：应有 3 个本地日桶
    const from = new Date(Date.UTC(2026, 9, 11, 16)); // 上海 10-12 00:00
    const to = new Date(Date.UTC(2026, 9, 14, 16)); // 上海 10-15 00:00
    const buckets = diffPointBuckets([
      row(1, -1, 0), // 基线桶（T0−1h）
      row(1, 0, 100), // 上海 10-12（ok）
      row(1, 24, 400), // 上海 10-13（ok）
      // 上海 10-14 全天缺 → 2/3
    ]).filter((b) => b.bucket.getTime() >= from.getTime());
    expect(pointCoverage(buckets, [1], from, to, 'day')).toBeCloseTo(2 / 3, 3);
  });
});

describe('aggregateBuckets（楼宇/分组级）', () => {
  const groupOf = new Map([
    [1, 'chilled_water'],
    [2, 'ahu'],
  ]);
  const options = {
    groupBy: 'system_type' as const,
    groupOf,
    groupKeys: ['chilled_water', 'ahu', 'unclassified'],
    now: new Date(T0 + 10 * 24 * H),
  };

  it('shouldSumContributingOnly_andPreserveGroupBreakdown', () => {
    const buckets = diffPointBuckets([
      row(1, 0, 100),
      row(1, 1, 150), // +50 ok
      row(2, 0, 0),
      row(2, 1, 100), // +100 ok
    ]);
    const aggregate = aggregateBuckets(buckets, new Date(T0 + H), new Date(T0 + 2 * H), options);
    expect(aggregate).toHaveLength(1);
    expect(aggregate[0]?.total_kwh).toBe(150);
    expect(aggregate[0]?.groups.get('chilled_water')).toBe(50);
    expect(aggregate[0]?.groups.get('ahu')).toBe(100);
    expect(aggregate[0]?.groups.get('unclassified')).toBeNull();
    expect(aggregate[0]?.status).toBe('ok');
  });

  it('shouldMarkReset_andNullTotal_whenAllPointsMissing', () => {
    // 全 gap 桶 → total null（不插值）；任一 reset → reset 标注（§2.2 图表标记语义）
    const gapOnly = diffPointBuckets([row(1, 1, 100)]); // 首桶 gap
    const aggregate = aggregateBuckets(gapOnly, new Date(T0 + H), new Date(T0 + 2 * H), options);
    expect(aggregate[0]?.status).toBe('gap');
    expect(aggregate[0]?.total_kwh).toBeNull();

    const withReset = diffPointBuckets([
      row(1, 0, 100),
      row(1, 1, 50), // reset
      row(2, 0, 0),
      row(2, 1, 70), // ok +70
    ]);
    const aggregate2 = aggregateBuckets(withReset, new Date(T0 + H), new Date(T0 + 2 * H), options);
    expect(aggregate2[0]?.status).toBe('reset');
    expect(aggregate2[0]?.total_kwh).toBe(70); // reset 点不计入，其余照计
  });

  it('shouldFlagPartial_forCurrentBucket_only', () => {
    const buckets = diffPointBuckets([row(1, 0, 0), row(1, 1, 10)]);
    const now = new Date(T0 + 1.5 * H);
    const aggregate = aggregateBuckets(buckets, new Date(T0), new Date(T0 + 2 * H), {
      ...options,
      now,
    });
    const partialMap = new Map(aggregate.map((b) => [b.bucket.getTime(), b.partial]));
    expect(partialMap.get(T0 + 1 * H)).toBe(true); // now 落在本桶
    expect(partialMap.get(T0 + 0 * H)).toBe(false);
  });

  it('shouldRollUpToLocalDays_forDayInterval', () => {
    // 窗口 [T0+10h, T0+24h)：10h = 上海 10-12 18:00（当日桶）→ 20h = 上海 10-13 04:00
    // （次日桶）——日桶边界 = 上海午夜（UTC-8h）
    const buckets = diffPointBuckets([row(1, 0, 0), row(1, 10, 100), row(1, 20, 400)]).filter(
      (b) => b.bucket.getTime() >= T0 + 10 * H,
    );
    const aggregate = aggregateBuckets(buckets, new Date(T0 + 10 * H), new Date(T0 + 24 * H), {
      groupBy: 'none',
      groupOf: new Map(),
      groupKeys: [],
      now: new Date(T0 + 30 * 24 * H),
      bucketOf: localDayBucket,
      bucketSpanMs: 86_400_000,
    });
    expect(aggregate).toHaveLength(2);
    expect(aggregate[0]?.bucket.getTime()).toBe(Date.UTC(2026, 9, 11, 16)); // 上海 10-12 日界
    expect(aggregate[0]?.total_kwh).toBe(100);
    expect(aggregate[1]?.bucket.getTime()).toBe(Date.UTC(2026, 9, 12, 16)); // 上海 10-13 日界
    expect(aggregate[1]?.total_kwh).toBe(300);
  });
});

describe('structureOf（§5.3 窗口级拆分）', () => {
  it('shouldSortByKwhDesc_withUnclassifiedLast', () => {
    const buckets = diffPointBuckets([
      row(1, 0, 0),
      row(1, 1, 100), // chilled_water +100
      row(2, 0, 0),
      row(2, 1, 300), // ahu +300
      row(3, 0, 0),
      row(3, 1, 100, 5), // unclassified +100（uncertain 计入）
    ]);
    const groupOf = new Map([
      [1, 'chilled_water'],
      [2, 'ahu'],
      [3, 'unclassified'],
    ]);
    const result = structureOf(
      buckets.filter((b) => b.bucket.getTime() >= T0 + H),
      groupOf,
      ['ahu', 'chilled_water', 'unclassified'],
    );
    expect(result.total_kwh).toBe(500);
    // kWh 降序 + unclassified 恒末位（§5.3）
    expect(result.items.map((i) => i.key)).toEqual(['ahu', 'chilled_water', 'unclassified']);
    expect(result.items[0]?.share_pct).toBe(60);
    expect(result.items[2]?.share_pct).toBe(20);
  });

  it('shouldReturnNullTotal_whenNoUsableBuckets', () => {
    const gaps = diffPointBuckets([row(1, 1, 50)]); // 首桶 gap
    const result = structureOf(gaps, new Map([[1, 'ahu']]), ['ahu']);
    expect(result.total_kwh).toBeNull();
    expect(result.items[0]?.share_pct).toBeNull();
  });
});

describe('时间窗规则（§2.3）', () => {
  it('shouldPickHourWithin7d_andDayBeyond', () => {
    const from = new Date(T0);
    expect(autoInterval(from, new Date(T0 + 7 * 86_400_000))).toBe('hour'); // ≤7 天含边界
    expect(autoInterval(from, new Date(T0 + 7 * 86_400_000 + H))).toBe('day');
  });

  it('shouldAlignLocalDayBoundary_atShanghaiMidnight（固定 +8）', () => {
    // UTC 2026-10-12 16:00 = 上海 10-13 00:00 → 日桶起点 = UTC 10-12 16:00
    expect(localDayBucket(new Date(Date.UTC(2026, 9, 12, 16))).getTime()).toBe(
      Date.UTC(2026, 9, 12, 16),
    );
    expect(localDayBucket(new Date(Date.UTC(2026, 9, 12, 15, 59))).getTime()).toBe(
      Date.UTC(2026, 9, 11, 16),
    );
  });

  it('shouldComputeLocalMonthStart_forOverviewDefault（上海日界）', () => {
    // 上海 2026-10-13 → 本月起点 = UTC 2026-09-30 16:00
    expect(localMonthStart(new Date(Date.UTC(2026, 9, 12, 18))).getTime()).toBe(
      Date.UTC(2026, 8, 30, 16),
    );
  });

  it('shouldCountExpectedBuckets', () => {
    expect(expectedHourBuckets(new Date(T0), new Date(T0 + 6 * H))).toBe(6);
    // 上海日界跨 3 个本地日
    expect(
      expectedDayBuckets(new Date(Date.UTC(2026, 9, 12, 10)), new Date(Date.UTC(2026, 9, 14, 2))),
    ).toBe(3);
  });
});
