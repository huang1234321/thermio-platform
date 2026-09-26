/**
 * PG 点位档案存在性读（IMPL-12）：
 * POINT_NOT_FOUND 与 POINT_NO_DATA 的判别依据——点位登记真相源在 PG
 * （DATA-MODEL §2/§3.3），TSDB 只知有无数据行、不知点位是否登记。
 *
 * RLS 纪律（ddl.md §5.2）：point 表 FORCE RLS，thermio_api 策略键
 * tenant_id = app_current_tenant()——每检查一个事务内 SET LOCAL app.tenant_id，
 * 未设上下文 fail-closed（全表不可见）。租户值来自 PG_TENANT_ID（IMPL-10
 * 会话解析落地前的显式 dev 形态，config 启动期强制校验 uuid）。
 *
 * IMPL-11（资产与接入管理）落码时本服务被完整资产仓储吸收/替代。
 */
import type { Logger } from 'pino';
import type { Pool } from 'pg';
import { TelemetryStoreUnavailableError, isPgConnectivityError } from './telemetry-store.error.js';

/** 点位档案读出口（真连 / 停用两形由 TelemetryModule 工厂决定）。 */
export interface PointRegistry {
  exists(pointId: number): Promise<boolean>;
}

export class PointLookupService implements PointRegistry {
  constructor(
    private readonly pool: Pool,
    private readonly tenantId: string,
    private readonly logger: Logger,
  ) {}

  async exists(pointId: number): Promise<boolean> {
    const client = await this.pool.connect().catch((err: unknown) => {
      this.logger.warn({ msg: 'pg_lookup_unavailable', err });
      throw new TelemetryStoreUnavailableError('PG 点位档案连接不可用', err);
    });
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', this.tenantId]);
      const result = await client.query<{ exists: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM point WHERE id = $1) AS exists',
        [pointId],
      );
      await client.query('COMMIT');
      return result.rows[0]?.exists === true;
    } catch (err: unknown) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (isPgConnectivityError(err) || err instanceof TelemetryStoreUnavailableError) {
        throw new TelemetryStoreUnavailableError('PG 点位档案查询不可用', err);
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

/** 停用形态：显式报不可用（不静默把「查不了」当「不存在」）。 */
export function disabledPointRegistry(reason: string): PointRegistry {
  return {
    exists(): Promise<boolean> {
      return Promise.reject(new TelemetryStoreUnavailableError(reason));
    },
  };
}
