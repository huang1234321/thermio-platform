/**
 * 租户上下文数据访问层（ddl.md §5.2 纪律，IMPL-10）：
 * - 每事务 `SET LOCAL app.tenant_id = '<uuid>'`——连接池安全（事务结束自动失效），
 *   **禁止会话级 SET** 防串号；本层是唯一入口，业务代码不自行开事务；
 * - `app_current_tenant()` 对未设置返回 NULL → RLS 策略判定为假 → **漏设上下文 = 查不到
 *   任何行（fail-closed）**；WITH CHECK 同时挡住跨租户写入（ddl.md §8 用例 2/3）；
 * - SET 不支持参数绑定：uuid 先过白名单校验再插值（防注入），非 uuid 直接拒绝。
 */
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { API_DB_POOL } from './db.tokens.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 在租户上下文内执行（每事务 SET LOCAL；fn 抛错即整体回滚）。 */
export type TenantWork<T> = (tx: PoolClient) => Promise<T>;

@Injectable()
export class TenantDb {
  constructor(@Inject(API_DB_POOL) private readonly pool: { connect(): Promise<PoolClient> }) {}

  /**
   * 以指定租户开事务执行 fn：BEGIN → SET LOCAL app.tenant_id → fn → COMMIT；
   * fn 抛错 → ROLLBACK 后原样上抛。RLS 由数据库强制（ADR-011 兜底承诺），
   * 本层只保证上下文设置正确，不做行级过滤。
   */
  async withTenant<T>(tenantId: string, fn: TenantWork<T>): Promise<T> {
    if (!UUID_PATTERN.test(tenantId)) {
      throw new Error('tenant_id 必须是 uuid（SET LOCAL 插值前置校验）');
    }
    const tx = await this.pool.connect();
    try {
      await tx.query('BEGIN');
      await tx.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
      const result = await fn(tx);
      await tx.query('COMMIT');
      return result;
    } catch (error) {
      await tx.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      tx.release();
    }
  }
}
