/**
 * proposal 过期沉降后台任务（M5-proposal.md §4.2，control-safety §1：60s sweeper）。
 *
 * - pending AND expires_at ≤ now → expired（系统动作，decided_by 保持 NULL——与人工
 *   决策可区分，UC-M5-5 检索口径）；
 * - 幂等（条件 UPDATE）；与 approve 竞态由同一条件 UPDATE 单赢家纪律收敛
 *   （sweeper 先赢 → approve 得 409 proposal.expired，§8.5）；
 * - 租户枚举经 AUTH_DB internal_read 旁路（0007 迁移；系统任务无会话租户），
 *   每租户 withTenant 独立事务（ddl.md §5.2）；
 * - DB 未接线时停用（骨架形态，同 kafka 纪律）；单实例 MVP 形态（多副本去重
 *   扫描无害——条件 UPDATE 幂等）。
 */
import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { Logger } from 'pino';
import type { Pool } from 'pg';
import { AUTH_DB_POOL, TENANT_DB } from '../infrastructure/db/db.tokens.js';
import type { TenantDb } from '../infrastructure/db/tenant-db.js';
import { LOGGER } from '../infrastructure/logger.js';
import type { AppConfig } from '../config.js';
import { APP_CONFIG } from '../infrastructure/core.module.js';

@Injectable()
export class ExpirySweeperService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger: Logger;
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    @Inject(TENANT_DB) private readonly tenantDb: TenantDb | null,
    @Inject(AUTH_DB_POOL) private readonly authPool: Pool | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) rootLogger: Logger,
  ) {
    this.logger = rootLogger.child({ component: 'proposal-expiry-sweeper' });
  }

  onModuleInit(): void {
    if (this.tenantDb === null || this.authPool === null) {
      this.logger.warn({ msg: 'proposal_expiry_sweeper_disabled', hint: 'DB 未接线' });
      return;
    }
    const interval = this.config.PROPOSAL_EXPIRY_SWEEP_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.sweep().catch((err: unknown) => {
        this.logger.error({ msg: 'proposal_expiry_sweep_failed', err });
      });
    }, interval);
    this.timer.unref();
    this.logger.info({ msg: 'proposal_expiry_sweeper_started', interval_ms: interval });
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  /** 单轮扫描（exported for e2e 直调；并发重入保护）。 */
  async sweep(): Promise<number> {
    if (this.sweeping || this.tenantDb === null || this.authPool === null) return 0;
    this.sweeping = true;
    try {
      const tenants = await this.authPool.query<{ id: string }>(
        `SELECT id FROM tenant ORDER BY created_at, id`,
      );
      let settled = 0;
      for (const tenant of tenants.rows) {
        const result = await this.tenantDb.withTenant(tenant.id, async (tx) => {
          const updated = await tx.query(`UPDATE proposal SET status = 'expired'
            WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= now()`);
          return updated.rowCount === null ? 0 : updated.rowCount;
        });
        settled += result;
        if (result > 0) {
          this.logger.info({
            msg: 'proposal_expired_settled',
            tenant_id: tenant.id,
            count: result,
          });
        }
      }
      return settled;
    } finally {
      this.sweeping = false;
    }
  }
}
