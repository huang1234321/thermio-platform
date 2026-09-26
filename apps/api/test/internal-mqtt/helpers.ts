/**
 * internal-mqtt 测试共用工装：日志捕获 + 假 DB 端口 + 全局过滤器挂载。
 *
 * 假 DB 断言的是「发出去的 SQL 文本与参数」——单调卫语句的真实语义已在
 * 设计自测经 PG16 验证（emqx.md §9）；这里钉死的是：卫语句 SQL 形状不被改坏、
 * 参数走绑定通道、rowCount 语义正确驱动 applied/stale 分支。
 */
import type { INestApplication } from '@nestjs/common';
import type { Logger } from 'pino';
import { pino } from 'pino';
import type { QueryResult } from 'pg';
import { HttpExceptionFilter } from '../../src/infrastructure/errors/http-exception.filter.js';
import { MetricsService } from '../../src/infrastructure/metrics/metrics.service.js';
import type { DbQueryPort, PgRow, TenantDbPort } from '../../src/internal-mqtt/db.js';

/** 捕获全部日志行的 pino 实例（CODE-LOG-01 审查项的测试面）。 */
export function createCapturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = pino({ level: 'trace' }, { write: (chunk: string) => lines.push(chunk) });
  return { logger, lines };
}

/** 独立挂载 InternalMqttModule 的测试里补上全局异常过滤器（生产在 AppModule 注册）。 */
export function applyProductionGlobals(
  app: INestApplication,
  logger: Logger,
  metrics: MetricsService,
): void {
  app.useGlobalFilters(new HttpExceptionFilter(logger, metrics));
}

export interface RecordedQuery {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** 可编程假查询端口：dispatch 返回行集（测试中可整体换掉）；记录全部调用。 */
export class FakeDbQuery implements DbQueryPort {
  readonly calls: RecordedQuery[] = [];

  /** 覆盖 rowCount（UPDATE 语义：0=未命中，1=命中；与行集长度解耦）。 */
  rowCountOverride: number | null = null;

  constructor(
    public dispatch: (sql: string, params: readonly unknown[]) => PgRow[] | Promise<PgRow[]>,
  ) {}

  async query<TRow extends PgRow>(
    sql: string,
    params: readonly unknown[],
  ): Promise<Pick<QueryResult<TRow>, 'rows' | 'rowCount'>> {
    this.calls.push({ sql, params });
    const rows = await this.dispatch(sql, params);
    return {
      rows: rows as TRow[],
      rowCount: this.rowCountOverride ?? rows.length,
    };
  }
}

/** 租户写端口假实现：记录租户上下文，事务体内回放可编程假查询端口。 */
export class FakeTenantDb implements TenantDbPort {
  readonly tenantIds: string[] = [];
  /** 每个事务体内可用的假查询端口（外部预编程/断言）。 */
  readonly inner: FakeDbQuery;

  constructor(inner?: FakeDbQuery) {
    this.inner = inner ?? new FakeDbQuery(() => []);
  }

  async withTenant<TReturn>(
    tenantId: string,
    work: (db: DbQueryPort) => Promise<TReturn>,
  ): Promise<TReturn> {
    this.tenantIds.push(tenantId);
    return work(this.inner);
  }
}

/** argon2 假校验器：按 (hash, password) 对显式编程，未命中一律 mismatched。 */
export class FakePasswordVerifier {
  readonly calls: { hash: string; password: string }[] = [];

  constructor(
    public pairs: { hash: string; password: string; outcome: string }[],
    private readonly fallback: string = 'mismatched',
  ) {}

  verify(hash: string, password: string): Promise<string> {
    this.calls.push({ hash, password });
    const hit = this.pairs.find((p) => p.hash === hash && p.password === password);
    return Promise.resolve(hit?.outcome ?? this.fallback);
  }
}
