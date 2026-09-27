/**
 * dev-only mock 执行沉降器（IMPL-17 范围：approved → executed|failed 归 IMPL-18，
 * 本卡 mock——admin 确认/驳回闭环演练的执行环节载体，蓝本 IMPL-17 验收要点原文
 * 「执行环节 mock，等 IMPL-18 接通」）。
 *
 * - PROPOSAL_MOCK_EXECUTOR=on 才启用（默认 off；生产/验收栈不得开启）；
 * - 周期扫描 approved 超过 delay 的行 → 置 executed + 合成 execution_result
 *   （五闸门全 pass 的时间线、三值链、回读一致）+ executed_at + 一条
 *   control_audit 行（actor_type='system'，actor_ref='mock-executor'——诚实标注）；
 * - 条件 UPDATE 单赢家（幂等；与 IMPL-18 接通后真实仲裁链互斥由开关承担：
 *   开关开着就不该同时部署 IMPL-18 执行器）。
 */
import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { Logger } from 'pino';
import type { Pool } from 'pg';
import { AUTH_DB_POOL, TENANT_DB } from '../infrastructure/db/db.tokens.js';
import type { TenantDb } from '../infrastructure/db/tenant-db.js';
import { LOGGER } from '../infrastructure/logger.js';
import type { AppConfig } from '../config.js';
import { APP_CONFIG } from '../infrastructure/core.module.js';

/** 合成 execution_result（M5 §2.3 读投影可整体消费的形状）。 */
function syntheticResult(actionValue: number): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    phase: 'executed',
    gates: [
      { gate: 1, name: 'whitelist', outcome: 'pass', detail: null },
      { gate: 2, name: 'clamp', outcome: 'pass', detail: null },
      { gate: 3, name: 'rate', outcome: 'pass', detail: null },
      { gate: 4, name: 'conflict', outcome: 'pass', detail: { superseded_by: null } },
      { gate: 5, name: 'fuse', outcome: 'pass', detail: null },
    ],
    clamped: false,
    effective_value: actionValue,
    verify: {
      readings: [{ at: now, value: actionValue, quality: 'good', match: true }],
      retries_write: 0,
    },
    cmds: [
      { cmd_id: `mock-${String(Date.now())}`, kind: 'write', at: now, ack: 'accepted' },
      { cmd_id: `mock-${String(Date.now() + 1)}`, kind: 'read', at: now, ack: 'accepted' },
    ],
    reason_code: null,
    outcome: 'executed',
    mocked: true,
  };
}

@Injectable()
export class MockExecutionSettlerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger: Logger;
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    @Inject(TENANT_DB) private readonly tenantDb: TenantDb | null,
    @Inject(AUTH_DB_POOL) private readonly authPool: Pool | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) rootLogger: Logger,
  ) {
    this.logger = rootLogger.child({ component: 'proposal-mock-executor' });
  }

  onModuleInit(): void {
    if (this.config.PROPOSAL_MOCK_EXECUTOR !== 'on') return;
    if (this.tenantDb === null || this.authPool === null) {
      this.logger.warn({ msg: 'proposal_mock_executor_disabled', hint: 'DB 未接线' });
      return;
    }
    this.timer = setInterval(
      () => {
        void this.settle().catch((err: unknown) => {
          this.logger.error({ msg: 'proposal_mock_settle_failed', err });
        });
      },
      Math.max(250, this.config.PROPOSAL_MOCK_EXECUTOR_DELAY_MS),
    );
    this.timer.unref();
    this.logger.warn({
      msg: 'proposal_mock_executor_enabled',
      hint: 'dev-only（IMPL-18 接通前闭环演练）；生产/验收栈不得开启',
    });
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  /** 单轮沉降（exported for e2e 直调）。 */
  async settle(): Promise<number> {
    if (this.sweeping || this.tenantDb === null || this.authPool === null) return 0;
    this.sweeping = true;
    try {
      const tenants = await this.authPool.query<{ id: string }>(
        `SELECT id FROM tenant ORDER BY created_at, id`,
      );
      const delayMs = this.config.PROPOSAL_MOCK_EXECUTOR_DELAY_MS;
      let settledCount = 0;
      for (const tenant of tenants.rows) {
        settledCount += await this.tenantDb.withTenant(tenant.id, async (tx) => {
          const due = await tx.query<{
            id: string;
            point_id: string;
            action: { value?: unknown };
            previous_value: number | null;
          }>(
            `SELECT id, point_id, action, previous_value FROM proposal
             WHERE status = 'approved' AND decided_at <= now() - ($1::bigint * interval '1 millisecond')`,
            [delayMs],
          );
          let done = 0;
          for (const proposal of due.rows) {
            const actionValue =
              typeof proposal.action.value === 'number' ? proposal.action.value : 0;
            const updated = await tx.query(
              `UPDATE proposal
                 SET status = 'executed', executed_at = now(),
                     execution_result = $3
               WHERE tenant_id = $1 AND id = $2 AND status = 'approved'`,
              [tenant.id, proposal.id, JSON.stringify(syntheticResult(actionValue))],
            );
            if (updated.rowCount === 0) continue;
            await tx.query(
              `INSERT INTO control_audit
                 (tenant_id, point_id, proposal_id, old_value, new_value,
                  actor_type, actor_ref, result, reason)
               VALUES ($1, $2, $3, $4, $5, 'system', 'mock-executor', 'ok', NULL)`,
              [tenant.id, proposal.point_id, proposal.id, proposal.previous_value, actionValue],
            );
            done += 1;
          }
          return done;
        });
      }
      return settledCount;
    } finally {
      this.sweeping = false;
    }
  }
}
