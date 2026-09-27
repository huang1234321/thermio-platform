/**
 * 周期对账（control-safety.md §5.5，ADR-002「云端周期对账回读」，IMPL-18）。
 *
 * 24h 任务：对全部 is_controllable 点位，比对「最近一次 control_audit(ok/reverted)
 * 的 new_value」与「最新遥测值」（tsdb_api 只读，ADR-005 铁律）；偏差超容差 →
 * control_drift 告警（§5.4 同通道）+ 计入熔断窗口（视同 verify_failed 参与比率，
 * detail 标注来源=reconciler）。设备侧被人为改回/漂移在此暴露。
 *
 * 注：TSDB 未配置（dev 无栈）时显式降级跳过（WARN 一次），不静默不报错。
 */
import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { Logger } from 'pino';
import type { Pool } from 'pg';
import type { AppConfig } from '../config.js';
import { APP_CONFIG } from '../infrastructure/core.module.js';
import { LOGGER } from '../infrastructure/logger.js';
import { AUTH_DB_POOL, TENANT_DB } from '../infrastructure/db/db.tokens.js';
import type { TenantDb } from '../infrastructure/db/tenant-db.js';
import { AlarmEngineService } from '../alarm/alarm-engine.service.js';
import { MetricsService } from '../infrastructure/metrics/metrics.service.js';
import type { TelemetryStore } from '../telemetry/tsdb-read.repository.js';
import { TELEMETRY_STORE } from '../telemetry/telemetry.tokens.js';

interface ControllableRow {
  readonly point_id: string;
  readonly equipment_id: string | null;
  readonly raw_name: string;
  readonly last_value: string | null;
}

@Injectable()
export class ControlReconcilerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger: Logger;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private announcedDegraded = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) rootLogger: Logger,
    @Inject(TENANT_DB) private readonly tenantDb: TenantDb | null,
    @Inject(AUTH_DB_POOL) private readonly authPool: Pool | null,
    @Inject(AlarmEngineService) private readonly alarmEngine: AlarmEngineService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
    @Inject(TELEMETRY_STORE) private readonly telemetry: TelemetryStore,
  ) {
    this.logger = rootLogger.child({ component: 'control-reconciler' });
  }

  onModuleInit(): void {
    if (this.tenantDb === null || this.authPool === null) return;
    this.timer = setInterval(
      () =>
        void this.runOnce().catch((err: unknown) => {
          this.logger.error({ msg: 'control_reconcile_failed', err });
        }),
      Math.max(1_000, this.config.CONTROL_RECONCILE_INTERVAL_MS),
    );
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  /** 单轮对账（导出供 e2e 直调；返回 drift 告警数）。 */
  async runOnce(): Promise<number> {
    if (this.running || this.tenantDb === null || this.authPool === null) return 0;
    this.running = true;
    try {
      let drifts = 0;
      const tenants = await this.authPool.query<{ id: string }>(
        `SELECT id FROM tenant ORDER BY created_at, id`,
      );
      for (const tenant of tenants.rows) {
        drifts += await this.tenantDb.withTenant(tenant.id, async (tx) => {
          const rows = await tx.query<ControllableRow>(
            `SELECT pt.id::text AS point_id, pt.equipment_id::text AS equipment_id,
                    pt.raw_name, last.new_value::text AS last_value
             FROM point pt
             LEFT JOIN LATERAL (
               SELECT ca.new_value FROM control_audit ca
               WHERE ca.tenant_id = pt.tenant_id AND ca.point_id = pt.id
                 AND ca.result IN ('ok', 'reverted')
               ORDER BY ca.at DESC LIMIT 1
             ) last ON true
             WHERE pt.tenant_id = $1 AND pt.is_controllable AND pt.status = 'active'
               AND last.new_value IS NOT NULL`,
            [tenant.id],
          );
          let drifted = 0;
          for (const row of rows.rows) {
            const pointId = Number(row.point_id);
            const sample = await this.telemetry.latest(pointId).catch(() => null);
            if (sample === null) continue;
            const actual = typeof sample.value === 'number' ? sample.value : Number(sample.value);
            if (Number.isNaN(actual)) continue;
            const expected = Number(row.last_value);
            if (Math.abs(actual - expected) <= this.config.controlSafety.verifyTolerance) continue;
            // 偏差超容差：drift 告警 + 计入熔断窗口（verify_failed，§5.5）
            drifted += 1;
            await tx.query(
              `INSERT INTO control_audit
                 (tenant_id, point_id, proposal_id, old_value, new_value, actor_type, actor_ref, result, reason)
               VALUES ($1, $2, NULL, $3, $4, 'system', 'reconciler', 'verify_failed', 'drift')`,
              [tenant.id, pointId, expected, actual],
            );
            this.metrics.recordControlExecution('verify_failed');
            await this.alarmEngine
              .open({
                tenantId: tenant.id,
                category: 'control_drift',
                source_type: 'equipment',
                source_id: row.equipment_id ?? row.point_id,
                severity: 'major',
                message: `设定值漂移（${row.raw_name}：下发 ${String(expected)}，实测 ${String(actual)}）——设备侧被人为改回或漂移`,
              })
              .catch((err: unknown) => {
                this.logger.error({
                  msg: 'reconciler_alarm_open_failed',
                  tenant_id: tenant.id,
                  err,
                });
              });
          }
          if (drifted > 0) {
            this.logger.warn({ msg: 'control_reconcile_drift', tenant_id: tenant.id, drifted });
          }
          return drifted;
        });
      }
      return drifts;
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('store_unavailable')) {
        if (!this.announcedDegraded) {
          this.announcedDegraded = true;
          this.logger.warn({
            msg: 'control_reconciler_tsdb_unavailable',
            hint: 'TSDB 只读连接未配置，对账跳过',
          });
        }
        return 0;
      }
      throw err;
    } finally {
      this.running = false;
    }
  }
}
