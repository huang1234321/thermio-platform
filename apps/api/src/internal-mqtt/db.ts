/**
 * 内部端点 DB 访问层（ddl.md §5.1/§5.2 角色纪律）：
 *
 * - AUTH_DB（thermio_auth 角色）：EMQX 不带租户上下文，认证/事件解析必须跨租户查表
 *   —— 显式旁路只读角色（internal_read 策略仅放行 device_credential/gateway 的 SELECT）；
 * - TENANT_DB（thermio_api 角色）：gateway.status 写路径。每事务
 *   set_config('app.tenant_id', …, true)（= SET LOCAL，连接池安全，事务结束自动失效），
 *   禁止会话级 SET 防串号；漏设上下文 = RLS 零可见（fail-closed）。
 *
 * 端口收敛为最小 query/withTenant 面，pg.Pool 是唯一实现——测试以假实现替换 token。
 */
import { type InjectionToken, Logger as NestLogger } from '@nestjs/common';
import { Pool, type PoolClient, type QueryResult } from 'pg';

/** pg 行形状下界（调用方自行窄化；type alias 才有隐式索引签名，interface 不满足约束）。 */
export type PgRow = Record<string, unknown>;

export interface DbQueryPort {
  query<TRow extends PgRow>(
    sql: string,
    params: readonly unknown[],
  ): Promise<Pick<QueryResult<TRow>, 'rows' | 'rowCount'>>;
}

export interface TenantDbPort {
  /** 事务内带租户上下文执行；异常回滚后原样抛出。 */
  withTenant<TReturn>(
    tenantId: string,
    work: (db: DbQueryPort) => Promise<TReturn>,
  ): Promise<TReturn>;
}

export const AUTH_DB: InjectionToken<DbQueryPort> = Symbol('AUTH_DB');
export const TENANT_DB: InjectionToken<TenantDbPort> = Symbol('TENANT_DB');

/** pg 参数化专用通道（DB-QRY-01）：值只进 params，永不拼进 SQL 文本。 */
class PgQueryAdapter implements DbQueryPort {
  constructor(
    private readonly executor: Pool | PoolClient,
    private readonly onQueryError: (err: unknown) => void,
  ) {}

  query<TRow extends PgRow>(
    sql: string,
    params: readonly unknown[],
  ): Promise<Pick<QueryResult<TRow>, 'rows' | 'rowCount'>> {
    return this.executor.query<TRow>(sql, params as unknown[]).catch((err: unknown) => {
      this.onQueryError(err);
      throw err;
    });
  }
}

/** 连接生命周期持有者：shutdown 时统一 end（Nest 关停钩子由模块层调用）。 */
export class PgPoolHolder {
  readonly pool: Pool;
  private readonly nestLogger = new NestLogger('InternalMqttDb');

  constructor(config: {
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly user: string;
    readonly password: string;
  }) {
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      max: 5, // 内部端点低频路径，小池即可
      connectionTimeoutMillis: 3_000,
    });
    this.pool.on('error', (err) => {
      // 池级后台错误（idle 连接被 DB 掐断等）：留痕不退出，下一次 query 自会重连。
      this.nestLogger.error(`pg pool background error: ${String(err)}`);
    });
  }

  asQueryPort(): DbQueryPort {
    return new PgQueryAdapter(this.pool, (err) => {
      this.nestLogger.error(`internal endpoint query failed: ${String(err)}`);
    });
  }

  asTenantDb(): TenantDbPort {
    const pool = this.pool;
    return {
      async withTenant<TReturn>(
        tenantId: string,
        work: (db: DbQueryPort) => Promise<TReturn>,
      ): Promise<TReturn> {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          // SET LOCAL 的参数化等价形（true = 事务局部，ddl.md §5.2 纪律）。
          await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
          const result = await work(new PgQueryAdapter(client, () => {}));
          await client.query('COMMIT');
          return result;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      },
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
