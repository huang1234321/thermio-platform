/**
 * 遥测查询 SQL 构造（纯函数，IMPL-12 验收要点 1 的测试对象）：
 * interval 路由——raw 才扫原始 hypertable `telemetry`，5min/1h 命中双 cagg
 * `telemetry_5min`/`telemetry_1h`（ddl.md §11），表名来自闭合映射不接受外部拼接。
 *
 * 查询形状（列名与 ddl.md §11.1/§11.2 逐字一致）：
 * - 窗口 [from, to)：起点含端点、终点不含——游标分页下页不重不漏；
 * - cursor 严格大于（> cursor）：同键去重，ASC 扫描天然翻页；
 * - LIMIT 由调用方传入 limit+1（多取一行探测 next_cursor，响应截回 limit）。
 * cagg 默认 real-time 聚合开：近窗（刷新策略 end_offset 之内）由 Timescale
 * 现场 合并原始表——这是 §11.2 声明的默认行为，查询入口仍是 cagg 视图。
 */
import type { TelemetryInterval } from '@thermio/shared-types';

/** interval → 物理对象（闭合映射：SQL 标识符不接收外部输入，杜绝注入面）。 */
export const TELEMETRY_SOURCE_TABLES = {
  raw: 'telemetry',
  '5min': 'telemetry_5min',
  '1h': 'telemetry_1h',
} as const satisfies Readonly<Record<TelemetryInterval, string>>;

/** raw 与聚合两形各自的排序列/时间列名。 */
export const TELEMETRY_TIME_COLUMN = { raw: 'ts', '5min': 'bucket', '1h': 'bucket' } as const;

/** 闭合映射兜底断言：两表名必须落在已授权对象内（tsdb_api 仅 SELECT，ddl.md §5.4）。 */
export function sourceTableFor(interval: TelemetryInterval): string {
  return TELEMETRY_SOURCE_TABLES[interval];
}

export interface IntervalWindow {
  readonly pointId: number;
  readonly from: string;
  readonly to: string;
  /** 游标锚点（上一页末行时间戳）；首页为 null。 */
  readonly after: string | null;
  /** 已含 +1 探测位的行数上限。 */
  readonly fetchLimit: number;
}

/** raw 行查询（hypertable 点查：point_id 等值 + ts 范围，命中 PK (point_id, ts) 前缀）。 */
export function buildRawQuery(window: IntervalWindow): { text: string; values: unknown[] } {
  return {
    text: `SELECT ts, value, value_text, quality
FROM telemetry
WHERE point_id = $1 AND ts >= $2 AND ts < $3 AND ($4::timestamptz IS NULL OR ts > $4)
ORDER BY ts ASC
LIMIT $5`,
    values: [window.pointId, window.from, window.to, window.after, window.fetchLimit],
  };
}

/** 5min/1h 桶查询（cagg 视图：point_id 等值 + bucket 范围，命中物化聚合索引）。 */
export function buildAggregateQuery(
  interval: '5min' | '1h',
  window: IntervalWindow,
): { text: string; values: unknown[] } {
  const table = TELEMETRY_SOURCE_TABLES[interval];
  return {
    text: `SELECT bucket, avg, min, max, last, stddev, sample_count, bad_count, quality_mask
FROM ${table}
WHERE point_id = $1 AND bucket >= $2 AND bucket < $3 AND ($4::timestamptz IS NULL OR bucket > $4)
ORDER BY bucket ASC
LIMIT $5`,
    values: [window.pointId, window.from, window.to, window.after, window.fetchLimit],
  };
}

/** latest 点查（每点最新一行：PK (point_id, ts) 上的反向索引扫描）。 */
export function buildLatestQuery(pointId: number): { text: string; values: unknown[] } {
  return {
    text: `SELECT ts, value, value_text, quality
FROM telemetry
WHERE point_id = $1
ORDER BY ts DESC
LIMIT 1`,
    values: [pointId],
  };
}
