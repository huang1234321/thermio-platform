/**
 * M&V TSDB 只读仓储（M9-mv-report.md §3.2/§3.3/§6.14；IMPL-21 / DAT-242）。
 *
 * 双查询面（ddl.md §5.4 tsdb_api 授权恰好覆盖，零新增授权）：
 * - telemetry_1h cagg（materialized_only=false，近窗实时合并）→ 点×日聚合
 *   （24 桶覆盖 / 坏样 / 末桶 last——§3.2 E_d 管线原料）；
 * - weather_actual → 度日（§3.3）/ 站点清单（§6.14）/ 站点近 90 天观测校验（§2.1）。
 *
 * 纯类不绑 Nest DI（TsdbReadRepository 同款纪律）：生命周期由 MvModule 持有的
 * pg.Pool 驱动；连接类错误归一 TelemetryStoreUnavailableError（→503），其余 pg
 * 错误原样上抛（→500 兜底）。日边界 = UTC（M3 monitor 同款口径，边界口径见
 * 交付说明）。e2e 以 MV_TSDB token 覆写为内存 fake。
 */
import type { Logger } from 'pino';
import type { Pool, QueryResultRow } from 'pg';
import type { MvWeatherStation } from '@thermio/shared-types';
import {
  TelemetryStoreUnavailableError,
  isPgConnectivityError,
} from '../telemetry/telemetry-store.error.js';
import type { PointDayStat, WeatherDayStat } from './mv-calc.js';

/** M&V 侧 TSDB 读出口（真连 / 停用两形由 MvModule 工厂决定）。 */
export interface MvTsdbStore {
  /** 点×日统计（[fromDate, toDate) UTC 日粒度；含 fromDate 前一日的调用方自查）。 */
  pointDayStats(
    pointIds: readonly number[],
    fromDate: string,
    toDate: string,
  ): Promise<PointDayStat[]>;
  /** 站点×日度日与有效小时数（[fromDate, toDate)，§3.3 口径 /24）。 */
  weatherDayStats(
    stationId: string,
    fromDate: string,
    toDate: string,
    tCoolC: number,
    tHeatC: number,
  ): Promise<WeatherDayStat[]>;
  /** 站点清单 + 近 90 天日覆盖率（§6.14 选择器数据面）。 */
  listStations(): Promise<MvWeatherStation[]>;
  /** 站点近 90 天最近观测（§2.1 weather_source 校验；无 → null）。 */
  stationRecentObservation(stationId: string): Promise<string | null>;
}

interface PointDayRow extends QueryResultRow {
  point_id: string | number;
  date: string;
  hours: number;
  samples: number;
  bad_samples: number;
  day_last: number | null;
}

interface WeatherDayRow extends QueryResultRow {
  date: string;
  hours: number;
  cdd: number | null;
  hdd: number | null;
}

interface StationRow extends QueryResultRow {
  station_id: string;
  source: string;
  last_obs_at: Date;
  coverage_90d: string | number;
}

export class MvTsdbRepository implements MvTsdbStore {
  constructor(
    private readonly pool: Pool,
    private readonly logger: Logger,
  ) {}

  async pointDayStats(
    pointIds: readonly number[],
    fromDate: string,
    toDate: string,
  ): Promise<PointDayStat[]> {
    const result = await this.query<PointDayRow>(
      `SELECT point_id,
              to_char((bucket AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS date,
              count(*) FILTER (WHERE last IS NOT NULL) AS hours,
              COALESCE(sum(sample_count), 0)::int AS samples,
              COALESCE(sum(bad_count), 0)::int AS bad_samples,
              last(last, bucket) AS day_last
       FROM telemetry_1h
       WHERE point_id = ANY($1::bigint[]) AND bucket >= $2::timestamptz AND bucket < $3::timestamptz
       GROUP BY point_id, date
       ORDER BY point_id, date`,
      [pointIds, `${fromDate}T00:00:00Z`, `${toDate}T00:00:00Z`],
    );
    return result.map((row) => ({
      point_id: Number(row.point_id), // bigint → number（id 量级安全）
      date: row.date,
      hours: row.hours,
      samples: row.samples,
      bad_samples: row.bad_samples,
      day_last: row.day_last,
    }));
  }

  async weatherDayStats(
    stationId: string,
    fromDate: string,
    toDate: string,
    tCoolC: number,
    tHeatC: number,
  ): Promise<WeatherDayStat[]> {
    const result = await this.query<WeatherDayRow>(
      `WITH hourly AS (
         SELECT time_bucket(INTERVAL '1 hour', obs_ts) AS h, avg(temp_c) AS t
         FROM weather_actual
         WHERE station_id = $1 AND temp_c IS NOT NULL
           AND obs_ts >= $2::timestamptz AND obs_ts < $3::timestamptz
         GROUP BY h
       )
       SELECT to_char((h AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS date,
              count(*) AS hours,
              sum(greatest(0, t - $4::double precision)) / 24.0 AS cdd,
              sum(greatest(0, $5::double precision - t)) / 24.0 AS hdd
       FROM hourly
       GROUP BY date
       ORDER BY date`,
      [stationId, `${fromDate}T00:00:00Z`, `${toDate}T00:00:00Z`, tCoolC, tHeatC],
    );
    return result.map((row) => ({
      date: row.date,
      hours: row.hours,
      cdd: row.cdd === null ? 0 : row.cdd,
      hdd: row.hdd === null ? 0 : row.hdd,
    }));
  }

  async listStations(): Promise<MvWeatherStation[]> {
    const result = await this.query<StationRow>(
      `WITH last_obs AS (
         SELECT station_id, max(source) AS source, max(obs_ts) AS last_obs_at
         FROM weather_actual GROUP BY station_id
       ),
       hourly AS (
         SELECT station_id, (time_bucket(INTERVAL '1 hour', obs_ts) AT TIME ZONE 'UTC')::date AS day,
                count(*) AS hours
         FROM weather_actual
         WHERE obs_ts >= now() - INTERVAL '90 days' AND temp_c IS NOT NULL
         GROUP BY station_id, day
         HAVING count(*) >= 20
       )
       SELECT l.station_id, l.source, l.last_obs_at,
              COALESCE(h.valid_days, 0)::double precision / 90.0 AS coverage_90d
       FROM last_obs l
       LEFT JOIN (
         SELECT station_id, count(*) AS valid_days FROM hourly GROUP BY station_id
       ) h ON h.station_id = l.station_id
       ORDER BY l.station_id`,
    );
    return result.map((row) => ({
      station_id: row.station_id,
      source: row.source,
      last_obs_at: new Date(row.last_obs_at).toISOString(),
      coverage_90d: Number(row.coverage_90d),
    }));
  }

  async stationRecentObservation(stationId: string): Promise<string | null> {
    const result = await this.query<{ last_obs_at: Date | null }>(
      `SELECT max(obs_ts) AS last_obs_at FROM weather_actual
       WHERE station_id = $1 AND obs_ts >= now() - INTERVAL '90 days'`,
      [stationId],
    );
    const row = result[0];
    return row?.last_obs_at === undefined || row.last_obs_at === null
      ? null
      : new Date(row.last_obs_at).toISOString();
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
      this.logger.error({ msg: 'mv_tsdb_query_failed', err });
      throw err;
    }
  }
}

/** 停用形态（TSDB_READ_URL 为空）：调用即 503 载体，与 TELEMETRY_STORE 同纪律。 */
export function disabledMvTsdbStore(reason: string): MvTsdbStore {
  const unavailable = (): never => {
    throw new TelemetryStoreUnavailableError(reason);
  };
  return {
    pointDayStats: unavailable,
    weatherDayStats: unavailable,
    listStations: unavailable,
    stationRecentObservation: unavailable,
  };
}
