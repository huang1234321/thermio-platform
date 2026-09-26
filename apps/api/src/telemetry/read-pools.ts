/**
 * 只读连接池构造（ADR-005 read replica 纪律的 dev 形态）：
 * - 独立只读账号：TSDB 用 tsdb_api（ddl.md §5.4 仅 SELECT）、PG 用 thermio_api 的
 *   存在性读——写路径永不经过这两个池（platform.md §1：api 不进 TSDB 写路径）；
 * - 连接池标注：application_name 附加到连接串，pg_stat_activity 里与未来的
 *   写池/其他服务可区分；池实例配 pino child logger；
 * - 配置位：TSDB_READ_URL / PG_URL 即生产 replica/主库读位的落点——单楼无 replica
 *   时 dev 显式降级 = 指向单实例（本卡口径；生产 replica 随 IMPL-20 prod compose 定形）。
 */
import { Pool } from 'pg';

/** 池标注后缀（追加在调用方传入的 application_name 之后，保留原值）。 */
export const TSDB_READ_APP_NAME = 'thermio-api/tsdb-read';
export const PG_READ_APP_NAME = 'thermio-api/pg-lookup';

/** 向连接串附加 application_name（URL 查询参数级合并，原串其余部分不动）。 */
export function withApplicationName(rawUrl: string, appName: string): string {
  const url = new URL(rawUrl);
  const existing = url.searchParams.get('application_name');
  url.searchParams.set('application_name', existing === null ? appName : `${existing}/${appName}`);
  return url.toString();
}

export interface ReadPoolOptions {
  readonly url: string;
  readonly max: number;
  readonly appName: string;
}

/** 构造只读池（懒连接：首次查询才建连，dev 栈后起不阻断服务启动）。 */
export function createReadPool(options: ReadPoolOptions): Pool {
  return new Pool({
    connectionString: withApplicationName(options.url, options.appName),
    max: options.max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // 遥测读不追逐语句超时以外的东西；5s 连接超时覆盖 dev 栈未起场景（→503 降级）
    statement_timeout: 30_000,
  });
}
