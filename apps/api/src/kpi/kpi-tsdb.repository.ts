/**
 * kpi 域 TSDB 只读仓储（M11-kpi-dashboard §2.2/§5.2 实现 notes；IMPL-22 / DAT-246）。
 *
 * 单查询面：telemetry_1h cagg（materialized_only=false，近窗实时合并，ddl §11.2）
 * → 点位×小时桶 (point_id, bucket, last, bad_count) 三列——LAG 差分与状态打标在
 * 进程内完成（kpi-bucket.ts）。只读边界纪律（M11 §1）：不自建时序查询、不直查
 * 原始遥测；tsdb_api 授权面恰好覆盖（ddl §5.4），零新增授权。
 *
 * 纯类不绑 Nest DI（MvTsdbRepository 同款纪律）；连接类错误归一
 * TelemetryStoreUnavailableError（→503），其余 pg 错误原样上抛。
 */
import type { Logger } from 'pino';
import type { Pool, QueryResultRow } from 'pg';
import {
  TelemetryStoreUnavailableError,
  isPgConnectivityError,
} from '../telemetry/telemetry-store.error.js';
import type { KpiHourRow } from './kpi-bucket.js';

/** kpi 侧 TSDB 读出口（真连 / 停用两形由 KpiModule 工厂决定）。 */
export interface KpiTsdbStore {
  /**
   * 点位×小时桶行（[from, to)，含 from 前一小时作差值基线——调用方以 from−1h
   * 传入；M9 pointDayStats preStartDate 同款）。空点位集 → 空数组。
   */
  hourRows(pointIds: readonly number[], from: Date, to: Date): Promise<KpiHourRow[]>;
}

interface HourRow extends QueryResultRow {
  point_id: string | number;
  bucket: Date;
  last: number | null;
  bad_count: number;
}

export class KpiTsdbRepository implements KpiTsdbStore {
  constructor(
    private readonly pool: Pool,
    private readonly logger: Logger,
  ) {}

  async hourRows(pointIds: readonly number[], from: Date, to: Date): Promise<KpiHourRow[]> {
    if (pointIds.length === 0) return [];
    const result = await this.query<HourRow>(
      `SELECT point_id, bucket, last, bad_count
       FROM telemetry_1h
       WHERE point_id = ANY($1::bigint[]) AND bucket >= $2::timestamptz AND bucket < $3::timestamptz
       ORDER BY point_id, bucket`,
      [pointIds, from.toISOString(), to.toISOString()],
    );
    return result.map((row) => ({
      point_id: Number(row.point_id), // bigint → number（id 量级安全，mv 同款）
      bucket: new Date(row.bucket),
      last: row.last === null ? null : row.last,
      bad_count: row.bad_count,
    }));
  }

  private async query<T extends QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<T[]> {
    try {
      const result = await this.pool.query(sql, params as unknown[] | undefined);
      return result.rows as T[];
    } catch (err) {
      if (isPgConnectivityError(err)) {
        throw new TelemetryStoreUnavailableError('TSDB 只读连接不可用', err);
      }
      this.logger.error({ msg: 'kpi_tsdb_query_failed', err });
      throw err;
    }
  }
}

/** 停用形态（TSDB_READ_URL 为空）：调用即 503 载体，与 MV_TSDB 同纪律。 */
export function disabledKpiTsdbStore(reason: string): KpiTsdbStore {
  return {
    hourRows: () => {
      throw new TelemetryStoreUnavailableError(reason);
    },
  };
}
