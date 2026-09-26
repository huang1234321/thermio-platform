/**
 * 遥测查询契约测试（IMPL-12 / DAT-115）：
 * - interval 路由枚举闭合（raw 走 hypertable、5min/1h 走 cagg 的类型面）；
 * - 跨度/分页默认值钉死（platform.md §12 治理：改默认值 = 改本测试）；
 * - 请求/响应 schema 的正负路径（TS-02：类型不裸穿越信任边界）。
 */
import { describe, expect, it } from 'vitest';
import {
  AggregateTelemetryPageSchema,
  PointLatestSchema,
  RawTelemetryPageSchema,
  Rfc3339Schema,
  TELEMETRY_PAGE_LIMIT_DEFAULT,
  TELEMETRY_PAGE_LIMIT_MAX,
  TELEMETRY_SPAN_LIMIT_DAYS,
  TelemetryIntervalSchema,
  TelemetryQuerySchema,
} from './telemetry.js';

describe('遥测 interval 与上限常量（§12 治理面）', () => {
  it('shouldCloseTheIntervalSet_toRawAndTwoCaggGrains', () => {
    expect(TelemetryIntervalSchema.parse('raw')).toBe('raw');
    expect(TelemetryIntervalSchema.parse('5min')).toBe('5min');
    expect(TelemetryIntervalSchema.parse('1h')).toBe('1h');
    expect(TelemetryIntervalSchema.safeParse('15min').success).toBe(false);
  });

  it('shouldPinSpanLimits_alignedWithTheAdr005RetentionLadder', () => {
    // 阶梯单调：raw 最短（排障窗）、1h 最长（对标/KPI 层）；
    // 5min 档必须落在其 cagg 保留期（5 年）之内。
    expect(TELEMETRY_SPAN_LIMIT_DAYS.raw).toBe(31);
    expect(TELEMETRY_SPAN_LIMIT_DAYS['5min']).toBe(730);
    expect(TELEMETRY_SPAN_LIMIT_DAYS['1h']).toBe(3650);
    expect(TELEMETRY_SPAN_LIMIT_DAYS.raw).toBeLessThan(TELEMETRY_SPAN_LIMIT_DAYS['5min']);
    expect(TELEMETRY_SPAN_LIMIT_DAYS['5min']).toBeLessThan(TELEMETRY_SPAN_LIMIT_DAYS['1h']);
    expect(TELEMETRY_SPAN_LIMIT_DAYS['5min']).toBeLessThan(5 * 365);
  });

  it('shouldPinPageLimitDefaults_toTheDsn03Ladder', () => {
    expect(TELEMETRY_PAGE_LIMIT_DEFAULT).toBe(50);
    expect(TELEMETRY_PAGE_LIMIT_MAX).toBe(200);
  });
});

describe('TelemetryQuerySchema（请求入参）', () => {
  it('shouldApplyDocumentedDefaults_whenOnlyRequiredPartsGiven', () => {
    const parsed = TelemetryQuerySchema.parse({});
    expect(parsed.interval).toBe('raw');
    expect(parsed.limit).toBe(TELEMETRY_PAGE_LIMIT_DEFAULT);
    expect(parsed.from).toBeUndefined();
    expect(parsed.to).toBeUndefined();
    expect(parsed.cursor).toBeUndefined();
  });

  it('shouldCoerceLimitFromQueryString_andRejectBeyondTheCap', () => {
    expect(TelemetryQuerySchema.parse({ limit: '100' }).limit).toBe(100);
    expect(TelemetryQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
    expect(TelemetryQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
  });

  it('shouldAcceptRfc3339WithOffsetOrZ_andRejectNaiveDates', () => {
    expect(Rfc3339Schema.parse('2026-09-26T10:00:00Z')).toBeTruthy();
    expect(Rfc3339Schema.parse('2026-09-26T10:00:00+08:00')).toBeTruthy();
    expect(Rfc3339Schema.safeParse('2026-09-26 10:00:00').success).toBe(false);
    expect(Rfc3339Schema.safeParse('not-a-date').success).toBe(false);
  });
});

describe('遥测响应 schema', () => {
  it('shouldRoundTripTheLatestShape_withNullableValueAndText', () => {
    const latest = PointLatestSchema.parse({
      point_id: 9,
      ts: '2026-09-26T02:03:04.567Z',
      value: null,
      value_text: 'running',
      quality: 0,
    });
    expect(latest.point_id).toBe(9);
    expect(latest.value).toBeNull();
    // 数值量的 value_text 为空、枚态量的 value 为空（ddl.md §11.1 两列语义）
    expect(
      PointLatestSchema.parse({
        point_id: 9,
        ts: '2026-09-26T02:03:04.567Z',
        value: 7.5,
        value_text: null,
        quality: 3,
      }).quality,
    ).toBe(3);
    expect(PointLatestSchema.safeParse({ point_id: 9, ts: 'oops', value: 1 }).success).toBe(false);
  });

  it('shouldKeepRawAndAggregatePagesDiscriminable_byIntervalLiteral', () => {
    const rawPage = RawTelemetryPageSchema.safeParse({
      point_id: 9,
      interval: 'raw',
      from: '2026-09-25T00:00:00Z',
      to: '2026-09-26T00:00:00Z',
      items: [{ ts: '2026-09-25T00:01:00Z', value: 7.5, value_text: null, quality: 0 }],
      next_cursor: null,
    });
    expect(rawPage.success).toBe(true);

    const aggPage = AggregateTelemetryPageSchema.safeParse({
      point_id: 9,
      interval: '5min',
      from: '2026-09-25T00:00:00Z',
      to: '2026-09-26T00:00:00Z',
      items: [
        {
          bucket: '2026-09-25T00:00:00Z',
          avg: 7.5,
          min: 7.4,
          max: 7.6,
          last: 7.6,
          stddev: 0.1,
          sample_count: 5,
          bad_count: 1,
          quality_mask: 4,
        },
      ],
      next_cursor: null,
    });
    expect(aggPage.success).toBe(true);

    // 判别面：raw 页不得混入 bucket 桶形 / 聚合页不得混入 ts 样本形
    expect(RawTelemetryPageSchema.safeParse({ ...rawPage.data, interval: '5min' }).success).toBe(
      false,
    );
  });
});
