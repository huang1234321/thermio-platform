/**
 * 控制租约生命周期（control-safety.md §6，IMPL-18 / DAT-164）。
 *
 * §6.1 范围解释（解释性定夺，非蓝本修订）：租约保护对象 = control_mode='auto'
 * 的点位（算法连续执掌，失联必须回滚接管前原值）；supervised/advisory 每次写
 * 都经人工担责，无「接管」语义，不设租约。MVP 全 advisory——链路就绪，路径待
 * auto 模式启用自然激活。
 *
 * - acquire：auto 点位首次派发写前（ON CONFLICT DO NOTHING，已持有则复用）；
 * - renew：POST /internal/control/leases/heartbeat（platform.md §11〔R3〕），
 *   body {holder, point_ids} → 逐点 renewed|not_found|stale；
 * - expire：lease-sweeper（30s）扫过期租约 → 取 value_at_takeover 走 §5 完整
 *   验证路径回滚 → 成功 DELETE + control_audit(reverted, system, lease_expired)
 *   + info 告警；失败保留租约行下轮重试（它是唯一的回滚指令载体，§6.3-3）；
 * - 不做过期前抢占（多算法实例以过期为唯一交接点，防 split-brain）。
 */
import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { Pool } from 'pg';
import {
  CONTROL_CMD_EXPIRES_IN_S,
  type ControlWriteCommand,
  type LeaseHeartbeatOutcome,
} from '@thermio/shared-types';
import type { AppConfig } from '../config.js';
import { APP_CONFIG } from '../infrastructure/core.module.js';
import { LOGGER } from '../infrastructure/logger.js';
import { AUTH_DB_POOL, TENANT_DB } from '../infrastructure/db/db.tokens.js';
import type { TenantDb } from '../infrastructure/db/tenant-db.js';
import { AlarmEngineService } from '../alarm/alarm-engine.service.js';
import { MetricsService } from '../infrastructure/metrics/metrics.service.js';
import { clampOf } from './arbitration.service.js';
import { ControlChannelUnavailableError, type ControlChannel } from './control-channel.js';
import { CONTROL_CHANNEL } from './control-safety.tokens.js';

interface LeaseRow {
  readonly point_id: string;
  readonly holder: string;
  readonly value_at_takeover: string | null;
}

interface PointLeaseContext {
  readonly point_id: number;
  readonly tenant_id: string;
  readonly equipment_id: string | null;
  readonly raw_name: string;
  readonly unit_std: string | null;
  readonly clamp_min: number | null;
  readonly clamp_max: number | null;
  readonly gateway_client_id: string | null;
}

@Injectable()
export class LeaseService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger: Logger;
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) rootLogger: Logger,
    @Inject(TENANT_DB) private readonly tenantDb: TenantDb | null,
    @Inject(AUTH_DB_POOL) private readonly authPool: Pool | null,
    @Inject(CONTROL_CHANNEL) private readonly channel: ControlChannel,
    @Inject(AlarmEngineService) private readonly alarmEngine: AlarmEngineService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {
    this.logger = rootLogger.child({ component: 'control-lease' });
  }

  onModuleInit(): void {
    if (this.tenantDb === null || this.authPool === null) return;
    this.timer = setInterval(
      () =>
        void this.sweep().catch((err: unknown) => {
          this.logger.error({ msg: 'lease_sweep_failed', err });
        }),
      Math.max(5, this.config.controlSafety.leaseSweepIntervalS) * 1000,
    );
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  /** acquire（§6.2：auto 点位首次派发写前；已持有则复用，holder 不变）。 */
  async acquire(
    tenantId: string,
    pointId: number,
    holder: string,
    valueAtTakeover: number | null,
  ): Promise<void> {
    if (this.tenantDb === null) return;
    await this.tenantDb.withTenant(tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO control_lease (point_id, tenant_id, holder, value_at_takeover,
                                     expires_at, last_heartbeat_at)
         VALUES ($1, $2, $3, $4, now() + ($5::bigint * interval '1 second'), now())
         ON CONFLICT (point_id) DO NOTHING`,
        [pointId, tenantId, holder, valueAtTakeover, this.config.controlSafety.leaseTtlS],
      );
    });
  }

  /** release（§6.2：点位退出 auto / 设备退役；模式联动归 M8 端点）。 */
  async release(tenantId: string, pointId: number): Promise<void> {
    if (this.tenantDb === null) return;
    await this.tenantDb.withTenant(tenantId, async (tx) => {
      await tx.query(`DELETE FROM control_lease WHERE tenant_id = $1 AND point_id = $2`, [
        tenantId,
        pointId,
      ]);
    });
  }

  /**
   * 心跳批量续租（§6.2〔R3〕：SVC_TOKEN_ALGO 面；跨租户点集按租户分组处理——
   * MVP 单租户形态一次直查，多租户为 O(租户数) 组内批查）。
   * 逐点语义：renewed（本 holder 续上）/ not_found（无租约行）/ stale（他 holder 持有）。
   */
  async heartbeat(
    holder: string,
    pointIds: readonly number[],
  ): Promise<
    Array<{ point_id: number; outcome: LeaseHeartbeatOutcome; expires_at: string | null }>
  > {
    if (this.tenantDb === null || this.authPool === null) {
      throw new Error('数据库未接线');
    }
    const results = new Map<
      number,
      { point_id: number; outcome: LeaseHeartbeatOutcome; expires_at: string | null }
    >();
    for (const pointId of pointIds) {
      results.set(pointId, { point_id: pointId, outcome: 'not_found', expires_at: null });
    }
    const tenants = await this.authPool.query<{ id: string }>(
      `SELECT id FROM tenant ORDER BY created_at, id`,
    );
    for (const tenant of tenants.rows) {
      await this.tenantDb.withTenant(tenant.id, async (tx) => {
        const renewed = await tx.query<{ point_id: string; expires_at: Date }>(
          `UPDATE control_lease
             SET last_heartbeat_at = now(),
                 expires_at = now() + ($3::bigint * interval '1 second')
           WHERE tenant_id = $1 AND point_id = ANY($2::bigint[]) AND holder = $4
           RETURNING point_id, expires_at`,
          [tenant.id, pointIds.map(String), this.config.controlSafety.leaseTtlS, holder],
        );
        for (const row of renewed.rows) {
          results.set(Number(row.point_id), {
            point_id: Number(row.point_id),
            outcome: 'renewed',
            expires_at: row.expires_at.toISOString(),
          });
        }
        const stale = await tx.query<{ point_id: string }>(
          `SELECT point_id FROM control_lease
            WHERE tenant_id = $1 AND point_id = ANY($2::bigint[]) AND holder <> $3`,
          [tenant.id, pointIds.map(String), holder],
        );
        for (const row of stale.rows) {
          results.set(Number(row.point_id), {
            point_id: Number(row.point_id),
            outcome: 'stale',
            expires_at: null,
          });
        }
      });
    }
    return [...results.values()];
  }

  /** lease-sweeper（§6.3 过期接管）：value_at_takeover 回写 → 成功删行 + info 告警。 */
  async sweep(): Promise<number> {
    if (this.sweeping || this.tenantDb === null || this.authPool === null) return 0;
    this.sweeping = true;
    try {
      let expired = 0;
      const tenants = await this.authPool.query<{ id: string }>(
        `SELECT id FROM tenant ORDER BY created_at, id`,
      );
      for (const tenant of tenants.rows) {
        expired += await this.tenantDb.withTenant(tenant.id, async (tx) => {
          const due = await tx.query<LeaseRow>(
            `SELECT point_id, holder, value_at_takeover
             FROM control_lease
             WHERE tenant_id = $1 AND expires_at < now()
             ORDER BY expires_at ASC
             LIMIT 20`,
            [tenant.id],
          );
          let done = 0;
          for (const lease of due.rows) {
            const pointId = Number(lease.point_id);
            const ctx = await this.loadPointContext(tx, tenant.id, pointId);
            if (ctx === null) {
              // 点位已退役/解绑（P1）：租约行失去载体，删除留痕（§6.3-3 人工介入面）
              await tx.query(`DELETE FROM control_lease WHERE tenant_id = $1 AND point_id = $2`, [
                tenant.id,
                pointId,
              ]);
              continue;
            }
            this.metrics.recordLeaseExpiry();
            const takeoverValue =
              lease.value_at_takeover !== null ? Number(lease.value_at_takeover) : null;
            if (takeoverValue === null) {
              // 无接管值锚：只能留痕告警（回滚指令无载体，人工介入）
              await this.auditLease(
                tx,
                tenant.id,
                pointId,
                'verify_failed',
                null,
                'lease_expired_no_baseline',
              );
              await this.openLeaseAlarm(
                tenant.id,
                pointId,
                ctx,
                'critical',
                `租约过期但无接管值（点位 ${ctx.raw_name}）——需人工介入`,
              );
              continue;
            }
            const { effective } = clampOf(takeoverValue, ctx.clamp_min, ctx.clamp_max);
            const ok = await this.writeAndVerify(ctx, effective);
            if (ok) {
              await this.auditLease(tx, tenant.id, pointId, 'reverted', effective, 'lease_expired');
              await tx.query(`DELETE FROM control_lease WHERE tenant_id = $1 AND point_id = $2`, [
                tenant.id,
                pointId,
              ]);
              await this.openLeaseAlarm(
                tenant.id,
                pointId,
                ctx,
                'info',
                `算法失联，租约过期回滚（${ctx.raw_name} → ${String(effective)}）`,
              );
            } else {
              // §6.3-3：失败保留租约行（唯一回滚指令载体），下轮重试
              await this.auditLease(
                tx,
                tenant.id,
                pointId,
                'verify_failed',
                null,
                'lease_expired_rollback_failed',
              );
              await this.openLeaseAlarm(
                tenant.id,
                pointId,
                ctx,
                'critical',
                `租约过期回滚失败（${ctx.raw_name}，网关离线或回读不符）——保留租约重试中`,
              );
            }
            done += 1;
          }
          return done;
        });
      }
      return expired;
    } finally {
      this.sweeping = false;
    }
  }

  /** 写 + 单次回读验证（§6.3-1：走 §5 完整验证路径的最小实现——只验一次）。 */
  private async writeAndVerify(ctx: PointLeaseContext, value: number): Promise<boolean> {
    if (ctx.gateway_client_id === null) return false;
    const cmdId = randomUUID();
    const command: ControlWriteCommand = {
      msg_type: 'write_cmd',
      ver: 1,
      cmd_id: cmdId,
      point_ref: ctx.raw_name,
      value,
      unit: ctx.unit_std ?? undefined,
      issued_at: new Date().toISOString(),
      expires_in_s: CONTROL_CMD_EXPIRES_IN_S,
    };
    try {
      await this.channel.publishCommand(ctx.gateway_client_id, command);
    } catch (err: unknown) {
      if (!(err instanceof ControlChannelUnavailableError)) {
        this.logger.error({ msg: 'lease_write_publish_error', point_id: ctx.point_id, err });
      }
      return false; // 网关离线期间 QoS1 会话队列仍保送达希望，下轮重试（§6.3-4）
    }
    const ack = await this.awaitEvent(cmdId, this.config.controlSafety.ackTimeoutS * 1000);
    if (ack !== null && ack.msg_type === 'write_ack' && ack.result === 'rejected') return false;
    await new Promise((resolve) =>
      setTimeout(resolve, this.config.controlSafety.verifyDelayS * 1000),
    );
    // 读回验证（复用读指令通道；租约回滚无 proposal 行，cmd 关联仅进程内）
    const readCmdId = randomUUID();
    const readCommand: ControlWriteCommand = {
      msg_type: 'read_cmd',
      ver: 1,
      cmd_id: readCmdId,
      point_ref: ctx.raw_name,
      issued_at: new Date().toISOString(),
      expires_in_s: CONTROL_CMD_EXPIRES_IN_S,
    };
    try {
      await this.channel.publishCommand(ctx.gateway_client_id, readCommand);
    } catch {
      return false;
    }
    const read = await this.awaitEvent(readCmdId, this.config.controlSafety.readTimeoutS * 1000);
    if (read === null || read.msg_type !== 'read_result' || read.value === null) return false;
    return Math.abs(read.value - value) <= this.config.controlSafety.verifyTolerance;
  }

  /** 进程内 cmd 等待（租约路径专用小实现；与 executor 等待表同构不共享——无 proposal 锚）。 */
  private awaitEvent(
    cmdId: string,
    timeoutMs: number,
  ): Promise<
    | { msg_type: 'write_ack'; result: 'accepted' | 'rejected' }
    | { msg_type: 'read_result'; value: number | null }
    | null
  > {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.leaseWaiters.delete(cmdId);
        resolve(null);
      }, timeoutMs);
      this.leaseWaiters.set(cmdId, { timer, resolve: resolve });
    });
  }

  private readonly leaseWaiters = new Map<
    string,
    {
      timer: NodeJS.Timeout;
      resolve: (
        value:
          | { msg_type: 'write_ack'; result: 'accepted' | 'rejected' }
          | { msg_type: 'read_result'; value: number | null }
          | null,
      ) => void;
    }
  >();

  /** 通道事件入口（module 装配时经 channel.onUpEvent 接上）。 */
  handleUpEvent(event: { cmd_id: string }): void {
    const waiter = this.leaseWaiters.get(event.cmd_id);
    if (waiter === undefined) return;
    this.leaseWaiters.delete(event.cmd_id);
    clearTimeout(waiter.timer);
    waiter.resolve(event as never);
  }

  private async loadPointContext(
    tx: import('pg').PoolClient,
    tenantId: string,
    pointId: number,
  ): Promise<PointLeaseContext | null> {
    const result = await tx.query<PointLeaseContext>(
      `SELECT pt.id::text AS point_id_text, pt.tenant_id, pt.equipment_id::text AS equipment_id,
              pt.raw_name, pt.unit_std, pt.clamp_min::text AS clamp_min_t, pt.clamp_max::text AS clamp_max_t,
              gw.mqtt_client_id AS gateway_client_id
       FROM point pt
       LEFT JOIN gateway gw ON gw.tenant_id = pt.tenant_id AND gw.id = pt.gateway_id
       WHERE pt.tenant_id = $1 AND pt.id = $2`,
      [tenantId, pointId],
    );
    const row = result.rows[0] as unknown as
      | (Omit<PointLeaseContext, 'point_id' | 'equipment_id' | 'clamp_min' | 'clamp_max'> & {
          point_id_text: string;
          equipment_id: string | null;
          clamp_min_t: string | null;
          clamp_max_t: string | null;
        })
      | undefined;
    if (row === undefined) return null;
    return {
      point_id: Number(row.point_id_text),
      tenant_id: tenantId,
      equipment_id: row.equipment_id,
      raw_name: row.raw_name,
      unit_std: row.unit_std,
      clamp_min: row.clamp_min_t === null ? null : Number(row.clamp_min_t),
      clamp_max: row.clamp_max_t === null ? null : Number(row.clamp_max_t),
      gateway_client_id: row.gateway_client_id,
    };
  }

  /** A5/A6 审计行（§8：租约接管无 proposal 关联，actor=system）。 */
  private async auditLease(
    tx: import('pg').PoolClient,
    tenantId: string,
    pointId: number,
    result: 'reverted' | 'verify_failed',
    newValue: number | null,
    reason: string,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO control_audit
         (tenant_id, point_id, proposal_id, old_value, new_value, actor_type, actor_ref, result, reason)
       VALUES ($1, $2, NULL, NULL, $3, 'system', 'lease-sweeper', $4, $5)`,
      [tenantId, pointId, newValue, result, reason],
    );
    this.metrics.recordControlExecution(result);
  }

  /** §6.3-2 info / §6.3-3 critical（control_lease_rollback 类别，M4 直写通道）。 */
  private async openLeaseAlarm(
    tenantId: string,
    pointId: number,
    ctx: PointLeaseContext,
    severity: 'info' | 'critical',
    message: string,
  ): Promise<void> {
    try {
      await this.alarmEngine.open({
        tenantId,
        category: 'control_lease_rollback',
        source_type: 'equipment',
        source_id: ctx.equipment_id ?? String(pointId),
        severity,
        message,
      });
    } catch (err: unknown) {
      this.logger.error({ msg: 'lease_alarm_open_failed', tenant_id: tenantId, err });
    }
  }
}
