/**
 * TSDB 只读仓储（IMPL-12）：telemetry hypertable 点查 + 双 cagg 桶查。
 *
 * 纯类不绑 Nest DI（与 KafkaPublisher 同款纪律）：SQL 来自 telemetry-sql 纯函数，
 * 生命周期由 TelemetryGateway 持有的 pg.Pool 驱动；连接类错误归一
 * TelemetryStoreUnavailableError（→503），其余 pg 错误原样上抛（→500 兜底）。
 */
import type { Logger } from 'pino';
import type { TelemetryAggregateSample, TelemetryRawSample } from '@thermio/shared-types';
import type { Pool, QueryResultRow } from 'pg';
import {
  buildAggregateQuery,
  buildLatestBatchQuery,
  buildLatestQuery,
  buildRawQuery,
  type IntervalWindow,
} from './telemetry-sql.js';
import { TelemetryStoreUnavailableError, isPgConnectivityError } from './telemetry-store.error.js';

/** raw 行（ddl.md §11.1：double precision → number，timestamptz → Date）。 */
interface RawRow extends QueryResultRow {
  ts: Date;
  value: number | null;
  value_text: string | null;
  quality: number;
}

/** 批量 latest 行（IMPL-11 列表快照；DISTINCT ON 保留每点最近一行）。 */
interface LatestBatchRow extends RawRow {
  point_id: string | number;
}

/** 聚合桶行（ddl.md §11.2；stddev_samp 单样本桶为 NULL）。 */
interface AggregateRow extends QueryResultRow {
  bucket: Date;
  avg: number | null;
  min: number | null;
  max: number | null;
  last: number | null;
  stddev: number | null;
  sample_count: number;
  bad_count: number;
  quality_mask: number;
}

/** TSDB 读出口（真连 / 停用两形由 TelemetryModule 工厂决定）。 */
export interface TelemetryStore {
  latest(pointId: number): Promise<TelemetryRawSample | null>;
  /** 批量 latest（IMPL-11 点位列表快照）：point_id → 最近行；无数据点位不出现在映射。 */
  latestBatch(pointIds: readonly number[]): Promise<Map<number, TelemetryRawSample>>;
  listRaw(window: IntervalWindow): Promise<TelemetryRawSample[]>;
  listAggregate(
    interval: '5min' | '1h',
    window: IntervalWindow,
  ): Promise<TelemetryAggregateSample[]>;
}

export class TsdbReadRepository implements TelemetryStore {
  constructor(
    private readonly pool: Pool,
    private readonly logger: Logger,
  ) {}

  async latest(pointId: number): Promise<TelemetryRawSample | null> {
    const query = buildLatestQuery(pointId);
    const rows = await this.run<RawRow>(query.text, query.values);
    const first = rows[0];
    return first === undefined ? null : toRawSample(first);
  }

  async latestBatch(pointIds: readonly number[]): Promise<Map<number, TelemetryRawSample>> {
    if (pointIds.length === 0) return new Map();
    const query = buildLatestBatchQuery(pointIds);
    const rows = await this.run<LatestBatchRow>(query.text, query.values);
    const latest = new Map<number, TelemetryRawSample>();
    for (const row of rows) {
      latest.set(Number(row.point_id), toRawSample(row));
    }
    return latest;
  }

  async listRaw(window: IntervalWindow): Promise<TelemetryRawSample[]> {
    const query = buildRawQuery(window);
    const rows = await this.run<RawRow>(query.text, query.values);
    return rows.map(toRawSample);
  }

  async listAggregate(
    interval: '5min' | '1h',
    window: IntervalWindow,
  ): Promise<TelemetryAggregateSample[]> {
    const query = buildAggregateQuery(interval, window);
    const rows = await this.run<AggregateRow>(query.text, query.values);
    return rows.map(toAggregateSample);
  }

  /** 连接类错误 → 不可用载体；其余原样上抛（程序缺陷，500 兜底）。 */
  private async run<R extends QueryResultRow>(
    text: string,
    values: readonly unknown[],
  ): Promise<R[]> {
    try {
      const result = await this.pool.query<R>(text, [...values]);
      return result.rows;
    } catch (err: unknown) {
      if (isPgConnectivityError(err) || err instanceof TelemetryStoreUnavailableError) {
        this.logger.warn({ msg: 'tsdb_read_unavailable', err });
        throw new TelemetryStoreUnavailableError('TSDB 只读连接不可用', err);
      }
      throw err;
    }
  }
}

function toRawSample(row: RawRow): TelemetryRawSample {
  return {
    ts: row.ts.toISOString(),
    value: row.value,
    value_text: row.value_text,
    quality: row.quality,
  };
}

function toAggregateSample(row: AggregateRow): TelemetryAggregateSample {
  return {
    bucket: row.bucket.toISOString(),
    avg: row.avg,
    min: row.min,
    max: row.max,
    last: row.last,
    stddev: row.stddev,
    sample_count: row.sample_count,
    bad_count: row.bad_count,
    quality_mask: row.quality_mask,
  };
}

/** 停用形态：任何调用显式报不可用（不静默、不伪空结果）。 */
export function disabledTelemetryStore(reason: string): TelemetryStore {
  const unavailable = (): Promise<never> =>
    Promise.reject(new TelemetryStoreUnavailableError(reason));
  return {
    latest: unavailable,
    latestBatch: unavailable,
    listRaw: unavailable,
    listAggregate: unavailable,
  };
}
