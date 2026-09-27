/**
 * TelemetryService 编排单测（fake 仓储，不依赖真实库）：
 * 跨度分档校验 / 时间窗缺省 / interval 路由 / 游标分页 / 错误口径四态。
 * IMPL-12 验收要点 2（跨度超限 → 4xx + TELEMETRY_RANGE_INVALID）在此钉死。
 */
import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import {
  TELEMETRY_SPAN_LIMIT_DAYS,
  type TelemetryInterval,
  type TelemetryQuery,
} from '@thermio/shared-types';
import type { AppConfig } from '../src/config.js';
import { ReasonCodeException } from '../src/infrastructure/errors/reason-code.exception.js';
import { TelemetryStoreUnavailableError } from '../src/telemetry/telemetry-store.error.js';
import type { PointRegistry } from '../src/telemetry/point-lookup.service.js';
import type { TelemetryStore } from '../src/telemetry/tsdb-read.repository.js';
import { TelemetryService } from '../src/telemetry/telemetry.service.js';

const SILENT = pino({ level: 'silent' });

const CONFIG = {
  telemetrySpanLimitDays: { ...TELEMETRY_SPAN_LIMIT_DAYS },
} as AppConfig;

function query(overrides: Partial<TelemetryQuery> = {}): TelemetryQuery {
  return {
    from: undefined,
    to: undefined,
    interval: 'raw',
    limit: 50,
    cursor: undefined,
    ...overrides,
  };
}

function fakeRegistry(exists = true): PointRegistry {
  return { exists: vi.fn().mockResolvedValue(exists) };
}

/** fake 仓储：三个出口各挂独立 vi.fn，断言直接引用 mock（不经对象属性解引用）。 */
function fakeStore() {
  const latest = vi.fn().mockResolvedValue({
    ts: '2026-09-26T08:00:00Z',
    value: 7.5,
    value_text: null,
    quality: 0,
  });
  const listRaw = vi.fn().mockResolvedValue([]);
  const latestBatch = vi.fn().mockResolvedValue(new Map());
  const listAggregate = vi.fn().mockResolvedValue([]);
  const windowEndpoints = vi.fn().mockResolvedValue(new Map());
  const presentInWindow = vi.fn().mockResolvedValue(new Set<number>());
  const store: TelemetryStore = {
    latest,
    latestBatch,
    listRaw,
    listAggregate,
    windowEndpoints,
    presentInWindow,
  };
  return { store, latest, listRaw, listAggregate, presentInWindow };
}

function service(store: TelemetryStore, registry: PointRegistry): TelemetryService {
  return new TelemetryService(store, registry, CONFIG, SILENT);
}

describe('GET latest 编排', () => {
  it('shouldReturnTheNewestSample_withPointIdAttached', async () => {
    const fakes = fakeStore();
    const latest = await service(fakes.store, fakeRegistry()).latest(9);
    expect(latest).toEqual({
      point_id: 9,
      ts: '2026-09-26T08:00:00Z',
      value: 7.5,
      value_text: null,
      quality: 0,
    });
  });

  it('shouldMapRegisteredButEmpty_toPointNoData404', async () => {
    const fakes = fakeStore();
    fakes.latest.mockResolvedValue(null);
    await expect(service(fakes.store, fakeRegistry()).latest(9)).rejects.toMatchObject({
      reasonCode: 'point.no_data',
      meta: { http: 404 },
    });
  });

  it('shouldMapUnregistered_toAssetNotFound404_beforeTouchingTsdb', async () => {
    const fakes = fakeStore();
    await expect(service(fakes.store, fakeRegistry(false)).latest(9)).rejects.toMatchObject({
      reasonCode: 'asset.not_found',
      meta: { http: 404 },
    });
    expect(fakes.latest).not.toHaveBeenCalled();
  });
});

describe('跨度校验（验收要点 2：超限 → telemetry.range_invalid 422）', () => {
  const cases: ReadonlyArray<[TelemetryInterval, number]> = [
    ['raw', TELEMETRY_SPAN_LIMIT_DAYS.raw],
    ['5min', TELEMETRY_SPAN_LIMIT_DAYS['5min']],
    ['1h', TELEMETRY_SPAN_LIMIT_DAYS['1h']],
  ];

  it.each(cases)('shouldRejectSpanOneDayBeyondTheCap_forInterval(%s)', async (interval, cap) => {
    const to = new Date('2026-09-30T00:00:00Z');
    const from = new Date(to.getTime() - (cap + 1) * 24 * 3600 * 1000);
    const err = await service(fakeStore().store, fakeRegistry())
      .telemetry(9, query({ interval, from: from.toISOString(), to: to.toISOString() }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReasonCodeException);
    const exception = err as ReasonCodeException;
    expect(exception.reasonCode).toBe('telemetry.range_invalid');
    expect(exception.meta.http).toBe(422);
    expect(exception.reasonDetails).toMatchObject({
      interval,
      max_span_days: cap,
    });
  });

  it('shouldAcceptSpanExactlyAtTheCap', async () => {
    const to = new Date('2026-09-30T00:00:00Z');
    const from = new Date(to.getTime() - TELEMETRY_SPAN_LIMIT_DAYS.raw * 24 * 3600 * 1000);
    const fakes = fakeStore();
    const page = await service(fakes.store, fakeRegistry()).telemetry(
      9,
      query({ interval: 'raw', from: from.toISOString(), to: to.toISOString() }),
    );
    expect(page.items).toEqual([]);
  });

  it('shouldRejectReversedWindows_withRangeInvalid', async () => {
    await expect(
      service(fakeStore().store, fakeRegistry()).telemetry(
        9,
        query({ from: '2026-09-03T00:00:00Z', to: '2026-09-02T00:00:00Z' }),
      ),
    ).rejects.toMatchObject({ reasonCode: 'telemetry.range_invalid' });
  });

  it('shouldApplyTheDocumentedDefaultWindow_whenFromAndToMissing', async () => {
    const fakes = fakeStore();
    const before = Date.now();
    await service(fakes.store, fakeRegistry()).telemetry(9, query());
    const calls = fakes.listRaw.mock.calls;
    const window = calls[0]?.[0] as { from: string; to: string };
    const after = Date.now();
    expect(new Date(window.to).getTime() - new Date(window.from).getTime()).toBe(24 * 3600 * 1000);
    expect(new Date(window.to).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(window.to).getTime()).toBeLessThanOrEqual(after);
  });
});

describe('interval 路由与游标分页', () => {
  it('shouldCallListRaw_onlyForRaw', async () => {
    const fakes = fakeStore();
    await service(fakes.store, fakeRegistry()).telemetry(
      9,
      query({ interval: 'raw', from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' }),
    );
    expect(fakes.listRaw).toHaveBeenCalledTimes(1);
    expect(fakes.listAggregate).not.toHaveBeenCalled();
  });

  it('shouldCallListAggregateWithTheInterval_forCaggGrains', async () => {
    const fakes = fakeStore();
    await service(fakes.store, fakeRegistry()).telemetry(
      9,
      query({ interval: '5min', from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' }),
    );
    expect(fakes.listAggregate).toHaveBeenCalledWith(
      '5min',
      expect.objectContaining({ pointId: 9, fetchLimit: 51 }),
    );
    expect(fakes.listRaw).not.toHaveBeenCalled();
  });

  it('shouldTrimTheProbeRow_andEmitNextCursor_whenMoreRowsExist', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({
      ts: `2026-09-01T00:0${String(i)}:00Z`,
      value: i,
      value_text: null,
      quality: 0,
    }));
    const fakes = fakeStore();
    fakes.listRaw.mockResolvedValue(rows);
    const page = await service(fakes.store, fakeRegistry()).telemetry(
      9,
      query({
        interval: 'raw',
        limit: 3,
        from: '2026-09-01T00:00:00Z',
        to: '2026-09-02T00:00:00Z',
      }),
    );
    expect(page.items).toHaveLength(3);
    expect(page.next_cursor).not.toBeNull();
    if (page.next_cursor !== null) {
      expect(atob(page.next_cursor.replace(/-/g, '+').replace(/_/g, '/'))).toContain(
        '2026-09-01T00:02:00Z',
      );
    }
  });

  it('shouldReturnNullCursor_onTheLastPage', async () => {
    const rows = [{ ts: '2026-09-01T00:00:00Z', value: 1, value_text: null, quality: 0 }];
    const fakes = fakeStore();
    fakes.listRaw.mockResolvedValue(rows);
    const page = await service(fakes.store, fakeRegistry()).telemetry(
      9,
      query({
        interval: 'raw',
        limit: 50,
        from: '2026-09-01T00:00:00Z',
        to: '2026-09-02T00:00:00Z',
      }),
    );
    expect(page.items).toHaveLength(1);
    expect(page.next_cursor).toBeNull();
  });

  it('shouldNormalizeGarbageCursors_toValidationFailed', async () => {
    await expect(
      service(fakeStore().store, fakeRegistry()).telemetry(9, query({ cursor: '%%garbage%%' })),
    ).rejects.toMatchObject({ reasonCode: 'common.validation_failed' });
  });
});

describe('存储不可用（显式降级口径）', () => {
  it('shouldMapStoreUnavailable_toTelemetryStoreUnavailable503', async () => {
    const unavailable = (): Promise<never> =>
      Promise.reject(new TelemetryStoreUnavailableError('未配置'));
    const fakes = fakeStore();
    fakes.latest.mockImplementation(unavailable);
    fakes.listRaw.mockImplementation(unavailable);
    fakes.listAggregate.mockImplementation(unavailable);
    await expect(service(fakes.store, fakeRegistry()).latest(9)).rejects.toMatchObject({
      reasonCode: 'telemetry.store_unavailable',
      meta: { http: 503 },
    });
    await expect(
      service(fakes.store, fakeRegistry()).telemetry(
        9,
        query({ from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' }),
      ),
    ).rejects.toMatchObject({ reasonCode: 'telemetry.store_unavailable' });
  });

  it('shouldLetNonConnectivityErrorsEscape_forThe500Fallback', async () => {
    const fakes = fakeStore();
    fakes.latest.mockRejectedValue(new Error('syntax bug'));
    await expect(service(fakes.store, fakeRegistry()).latest(9)).rejects.toThrow('syntax bug');
  });
});
