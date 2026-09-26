/**
 * interval 路由与游标单元测试（IMPL-12 验收要点 1：5min/1h 命中 cagg，
 * raw 才扫 hypertable；ddl.md §11 对象名逐字对照）。
 */
import { describe, expect, it } from 'vitest';
import {
  TELEMETRY_SOURCE_TABLES,
  buildAggregateQuery,
  buildLatestQuery,
  buildRawQuery,
} from '../src/telemetry/telemetry-sql.js';
import { decodeCursor, encodeCursor } from '../src/telemetry/telemetry-cursor.js';
import { withApplicationName } from '../src/telemetry/read-pools.js';

const WINDOW = {
  pointId: 9,
  from: '2026-09-01T00:00:00Z',
  to: '2026-09-02T00:00:00Z',
  after: null,
  fetchLimit: 51,
};

describe('interval → 物理对象路由（闭合映射）', () => {
  it('shouldTargetTheHypertable_onlyForRaw', () => {
    expect(TELEMETRY_SOURCE_TABLES.raw).toBe('telemetry');
    const sql = buildRawQuery(WINDOW).text;
    expect(sql).toContain('FROM telemetry\n');
    expect(sql).not.toContain('telemetry_5min');
    expect(sql).not.toContain('telemetry_1h');
  });

  it('shouldTargetTheCaggs_for5minAnd1h_neverTheHypertable', () => {
    expect(TELEMETRY_SOURCE_TABLES['5min']).toBe('telemetry_5min');
    expect(TELEMETRY_SOURCE_TABLES['1h']).toBe('telemetry_1h');

    const sql5 = buildAggregateQuery('5min', WINDOW).text;
    expect(sql5).toContain('FROM telemetry_5min\n');
    expect(sql5).not.toContain('FROM telemetry\n');

    const sql1h = buildAggregateQuery('1h', WINDOW).text;
    expect(sql1h).toContain('FROM telemetry_1h\n');
    expect(sql1h).not.toContain('FROM telemetry\n');
  });

  it('shouldSelectExactlyTheCaggColumnSet_fromDdlS112', () => {
    const sql = buildAggregateQuery('5min', WINDOW).text;
    expect(sql).toContain(
      'SELECT bucket, avg, min, max, last, stddev, sample_count, bad_count, quality_mask',
    );
  });
});

describe('查询形状（窗口/游标/探测位）', () => {
  it('shouldBindHalfOpenWindowAndAscOrdering_onRaw', () => {
    const { text, values } = buildRawQuery(WINDOW);
    expect(text).toContain('ts >= $2 AND ts < $3');
    expect(text).toContain('ORDER BY ts ASC');
    expect(values).toEqual([9, WINDOW.from, WINDOW.to, null, 51]);
  });

  it('shouldBindCursorAsStrictlyGreater_whenPaging', () => {
    const { values } = buildRawQuery({ ...WINDOW, after: '2026-09-01T00:05:00Z' });
    expect(values[3]).toBe('2026-09-01T00:05:00Z');
  });

  it('shouldOrderBucketsAscending_onAggregates', () => {
    expect(buildAggregateQuery('1h', WINDOW).text).toContain('ORDER BY bucket ASC');
  });

  it('shouldPointQueryLatestByDescTs', () => {
    const { text, values } = buildLatestQuery(9);
    expect(text).toContain('ORDER BY ts DESC');
    expect(values).toEqual([9]);
  });
});

describe('游标编解码', () => {
  it('shouldRoundTripTheAnchorTimestamp', () => {
    const encoded = encodeCursor({ ts: '2026-09-01T00:05:00Z' });
    expect(decodeCursor(encoded)).toEqual({ ts: '2026-09-01T00:05:00Z' });
  });

  it('shouldRejectGarbageCursors_toNull', () => {
    expect(decodeCursor('not-base64-!!!')).toBeNull();
    expect(decodeCursor(Buffer.from('{"nope":1}').toString('base64url'))).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
  });
});

describe('只读池标注（read-pools）', () => {
  it('shouldAppendApplicationName_withoutTouchingTheRestOfTheUrl', () => {
    const labeled = withApplicationName(
      'postgres://tsdb_api:pw@localhost:5433/thermio_ts?sslmode=disable',
      'thermio-api/tsdb-read',
    );
    expect(labeled).toContain('application_name=thermio-api%2Ftsdb-read');
    expect(labeled).toContain('sslmode=disable');
    expect(new URL(labeled).pathname).toBe('/thermio_ts');
  });

  it('shouldKeepTheExistingApplicationName_whenAppending', () => {
    const labeled = withApplicationName(
      'postgres://u@h:5432/db?application_name=ops',
      'thermio-api/pg-lookup',
    );
    expect(new URL(labeled).searchParams.get('application_name')).toBe('ops/thermio-api/pg-lookup');
  });
});
