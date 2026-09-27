/**
 * 熔断评估与状态机（control-safety.md §7 / ddl.md §9.3，IMPL-18 / DAT-164）。
 *
 * - fuse-evaluator（60s）：15min 滑动窗口按 system_id 聚合 control_audit——
 *   分子 = verify_failed/reverted（含 reconciler 注入的 drift），分母 = 真实触达
 *   设备的写（ok/verify_failed/reverted；rejected 未触达不计）；
 *   trip 条件（满足其一）：占比 ≥ 30%，或最近连续 3 次写全异常；分母 0 不评估；
 * - trip 联动（单事务，RLS 租户上下文内）：control_fuse closed→open 条件迁移
 *   单赢家 + control_fuse_event(tripped, system, 快照) + 系统内 control_mode≠advisory
 *   点位逐点压回 advisory + config_audit(system, reason=fuse_trip: 判据)（§7.3）；
 * - 自动恢复：占比 < 5% 持续 30min（ratio_ok_since 首达标时刻锚定）→ open→closed；
 * - 解除 ≠ 控制恢复：两路径都不触碰点位 control_mode（ddl.md §9.3）；
 * - 手动解除端点 P1 不开（M8 只读页消费本服务读模型）。
 */
import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { Logger } from 'pino';
import type { Pool } from 'pg';
import type { FuseEventItem, FuseStatusResponse } from '@thermio/shared-types';
import type { AppConfig } from '../config.js';
import { APP_CONFIG } from '../infrastructure/core.module.js';
import { LOGGER } from '../infrastructure/logger.js';
import { AUTH_DB_POOL, TENANT_DB } from '../infrastructure/db/db.tokens.js';
import type { TenantDb } from '../infrastructure/db/tenant-db.js';
import { MetricsService } from '../infrastructure/metrics/metrics.service.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { loadBuildingScope, type AssetActor } from '../asset/asset-shared.js';

/** 窗口聚合行（§7.2 口径）。 */
interface WindowRow {
  readonly system_id: string;
  readonly numerator: string;
  readonly denominator: string;
  readonly first_ok_rn: string;
}

/** 评估快照（trip/release 判据留痕，ddl.md §9.3 detail 原文形态）。 */
export interface FuseSnapshot {
  readonly systemId: string;
  readonly windowS: number;
  readonly numerator: number;
  readonly denominator: number;
  readonly ratio: number;
  readonly consecutiveFails: number;
}

@Injectable()
export class FuseService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger: Logger;
  private timer: NodeJS.Timeout | null = null;
  private evaluating = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) rootLogger: Logger,
    @Inject(TENANT_DB) private readonly tenantDb: TenantDb | null,
    @Inject(AUTH_DB_POOL) private readonly authPool: Pool | null,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {
    this.logger = rootLogger.child({ component: 'control-fuse' });
  }

  onModuleInit(): void {
    if (this.tenantDb === null || this.authPool === null) return;
    this.timer = setInterval(
      () =>
        void this.evaluateAll().catch((err: unknown) => {
          this.logger.error({ msg: 'fuse_eval_failed', err });
        }),
      Math.max(5, this.config.controlSafety.fuseEvalIntervalS) * 1000,
    );
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  /** 全租户评估（trip + 自动恢复同一事务节奏）。 */
  async evaluateAll(): Promise<void> {
    if (this.evaluating || this.tenantDb === null || this.authPool === null) return;
    this.evaluating = true;
    try {
      const tenants = await this.authPool.query<{ id: string }>(
        `SELECT id FROM tenant ORDER BY created_at, id`,
      );
      for (const tenant of tenants.rows) {
        await this.evaluateTenant(tenant.id);
      }
    } finally {
      this.evaluating = false;
    }
  }

  /** 单租户评估（导出供 e2e 直调）。 */
  async evaluateTenant(tenantId: string): Promise<void> {
    if (this.tenantDb === null) return;
    const { fuseWindowS, fuseRateThreshold, fuseConsecutiveFails, fuseReleaseRate, fuseCooldownS } =
      this.config.controlSafety;
    await this.tenantDb.withTenant(tenantId, async (tx) => {
      // ── 窗口聚合（§7.2：15min 滑动；最近 3 行连续判定用同窗口行集）──
      const rows = await tx.query<WindowRow>(
        `WITH writes AS (
           SELECT ca.result, e.system_id, ca.at,
                  ROW_NUMBER() OVER (PARTITION BY e.system_id ORDER BY ca.at DESC) AS rn
           FROM control_audit ca
           JOIN point pt ON pt.tenant_id = ca.tenant_id AND pt.id = ca.point_id
           JOIN equipment e ON e.tenant_id = pt.tenant_id AND e.id = pt.equipment_id
           WHERE ca.tenant_id = $1
             AND ca.at > now() - ($2::bigint * interval '1 second')
             AND ca.result IN ('ok', 'verify_failed', 'reverted')
         )
         SELECT w.system_id,
                count(*) FILTER (WHERE w.result IN ('verify_failed', 'reverted'))::text AS numerator,
                count(*)::text AS denominator,
                COALESCE((
                  SELECT MIN(w2.rn) FROM writes w2
                  WHERE w2.system_id = w.system_id AND w2.result = 'ok'
                ), 9999)::text AS first_ok_rn
         FROM writes w
         GROUP BY w.system_id`,
        [tenantId, fuseWindowS],
      );
      const snapshots = new Map<string, FuseSnapshot>(
        rows.rows.map((row) => [
          row.system_id,
          {
            systemId: row.system_id,
            windowS: fuseWindowS,
            numerator: Number(row.numerator),
            denominator: Number(row.denominator),
            ratio:
              Number(row.denominator) === 0 ? 0 : Number(row.numerator) / Number(row.denominator),
            // 连续失败 = 最近写序中首个 ok 之前的位数（§7.2「最近连续 3 次全异常」）；
            // 窗口内无 ok → 取窗口分母（≥ 阈值即 trip，detail 不落哨兵值）
            consecutiveFails: Math.min(
              Math.max(0, Number(row.first_ok_rn) - 1),
              Number(row.denominator),
            ),
          },
        ]),
      );

      // ── 全系统行（含窗口无活动的系统——open 态需评估自动恢复）──
      const systems = await tx.query<{ system_id: string; status: string }>(
        `SELECT cf.system_id, cf.status FROM control_fuse cf WHERE cf.tenant_id = $1`,
        [tenantId],
      );
      for (const system of systems.rows) {
        const snapshot = snapshots.get(system.system_id) ?? {
          systemId: system.system_id,
          windowS: fuseWindowS,
          numerator: 0,
          denominator: 0,
          ratio: 0,
          consecutiveFails: 0,
        };
        this.metrics.setFuseState(system.system_id, system.status === 'open');
        if (system.status === 'closed') {
          if (snapshot.denominator === 0) continue; // 分母 0 不评估（§7.2）
          if (
            snapshot.ratio >= fuseRateThreshold ||
            snapshot.consecutiveFails >= fuseConsecutiveFails
          ) {
            await this.trip(tx, tenantId, snapshot);
          }
        } else if (system.status === 'open') {
          // 自动恢复：占比 < 5% 持续 30min（ratio_ok_since 锚定首次达标时刻）
          if (snapshot.denominator > 0 && snapshot.ratio < fuseReleaseRate) {
            await this.maybeRelease(tx, tenantId, snapshot, fuseCooldownS);
          } else {
            // 未达标：清锚（下次重新计持续窗）
            await tx.query(
              `UPDATE control_fuse SET trigger_detail =
                 jsonb_set(COALESCE(trigger_detail, '{}'::jsonb), '{ratio_ok_since}', 'null'::jsonb)
               WHERE tenant_id = $1 AND system_id = $2`,
              [tenantId, snapshot.systemId],
            );
          }
        }
      }

      // ── 无 control_fuse 行但有窗口异常活动的系统（行懒建：trip 时 INSERT ON CONFLICT）──
      for (const snapshot of snapshots.values()) {
        if (snapshot.denominator === 0) continue;
        if (
          snapshot.ratio >= fuseRateThreshold ||
          snapshot.consecutiveFails >= fuseConsecutiveFails
        ) {
          await this.trip(tx, tenantId, snapshot);
        }
      }
    });
  }

  /** trip 联动（§7.3 单事务：条件迁移单赢家 + 事件 + 逐点压回 advisory + config_audit）。 */
  private async trip(
    tx: import('pg').PoolClient,
    tenantId: string,
    snapshot: FuseSnapshot,
  ): Promise<void> {
    const detail = {
      window_s: snapshot.windowS,
      ratio: round4(snapshot.ratio),
      consecutive_fails: snapshot.consecutiveFails,
      numerator: snapshot.numerator,
      denominator: snapshot.denominator,
    };
    const updated = await tx.query<{ system_id: string }>(
      `INSERT INTO control_fuse (system_id, tenant_id, status, triggered_at, trigger_detail, released_at)
       VALUES ($1, $2, 'open', now(), $3, NULL)
       ON CONFLICT (system_id) DO UPDATE
         SET status = 'open', triggered_at = now(), trigger_detail = $3, released_at = NULL
       WHERE control_fuse.status = 'closed'
       RETURNING system_id`,
      [snapshot.systemId, tenantId, JSON.stringify(detail)],
    );
    if (updated.rows.length === 0) return; // 他实例已 trip（单赢家）
    await tx.query(
      `INSERT INTO control_fuse_event (tenant_id, system_id, event_type, actor_type, actor_ref, detail)
       VALUES ($1, $2, 'tripped', 'system', 'fuse-evaluator', $3)`,
      [tenantId, snapshot.systemId, JSON.stringify(detail)],
    );
    // 逐点压回 advisory（§7.3 loop；§9.3 联动原文）+ 逐点 config_audit(system)
    const degraded = await tx.query<{ id: string; control_mode: string }>(
      `UPDATE point SET control_mode = 'advisory'
       WHERE tenant_id = $1
         AND EXISTS (
           SELECT 1 FROM equipment e
           WHERE e.tenant_id = $1 AND e.id = point.equipment_id AND e.system_id = $2
         )
         AND control_mode <> 'advisory'
       RETURNING id, control_mode`,
      [tenantId, snapshot.systemId],
    );
    for (const point of degraded.rows) {
      await tx.query(
        `INSERT INTO config_audit (tenant_id, point_id, field, old_value, new_value, actor_type, actor_ref, reason)
         VALUES ($1, $2, 'control_mode', $3, '"advisory"'::jsonb, 'system', 'fuse-evaluator', $4)`,
        [
          tenantId,
          point.id,
          JSON.stringify(point.control_mode),
          `fuse_trip: ${detailText(detail)}`,
        ],
      );
    }
    this.metrics.setFuseState(snapshot.systemId, true);
    this.logger.warn({
      msg: 'fuse_tripped',
      tenant_id: tenantId,
      system_id: snapshot.systemId,
      ...detail,
      degraded_points: degraded.rows.length,
    });
  }

  /** 自动恢复（§7.4：ratio_ok_since ≥ 30min 才动作；不触碰点位模式）。 */
  private async maybeRelease(
    tx: import('pg').PoolClient,
    tenantId: string,
    snapshot: FuseSnapshot,
    cooldownS: number,
  ): Promise<void> {
    const row = await tx.query<{ ratio_ok_since: string | null }>(
      `SELECT trigger_detail->>'ratio_ok_since' AS ratio_ok_since
       FROM control_fuse WHERE tenant_id = $1 AND system_id = $2 FOR UPDATE`,
      [tenantId, snapshot.systemId],
    );
    const since = row.rows[0]?.ratio_ok_since ?? null;
    let sinceTs: number;
    if (since === null) {
      sinceTs = Date.now();
      await tx.query(
        `UPDATE control_fuse SET trigger_detail =
           jsonb_set(COALESCE(trigger_detail, '{}'::jsonb), '{ratio_ok_since}', $3::jsonb)
         WHERE tenant_id = $1 AND system_id = $2`,
        [tenantId, snapshot.systemId, JSON.stringify(new Date(sinceTs).toISOString())],
      );
      return;
    }
    sinceTs = Date.parse(since);
    if (Number.isNaN(sinceTs) || Date.now() - sinceTs < cooldownS * 1000) return;
    const released = await tx.query<{ system_id: string }>(
      `UPDATE control_fuse
         SET status = 'closed', released_at = now(),
             trigger_detail = trigger_detail - 'ratio_ok_since'
       WHERE tenant_id = $1 AND system_id = $2 AND status = 'open'
       RETURNING system_id`,
      [tenantId, snapshot.systemId],
    );
    if (released.rows.length === 0) return;
    await tx.query(
      `INSERT INTO control_fuse_event (tenant_id, system_id, event_type, actor_type, actor_ref, detail)
       VALUES ($1, $2, 'released', 'system', 'fuse-evaluator', $3)`,
      [
        tenantId,
        snapshot.systemId,
        JSON.stringify({
          ratio: round4(snapshot.ratio),
          sustained_s: cooldownS,
          numerator: snapshot.numerator,
          denominator: snapshot.denominator,
        }),
      ],
    );
    this.metrics.setFuseState(snapshot.systemId, false);
    this.logger.info({
      msg: 'fuse_auto_released',
      tenant_id: tenantId,
      system_id: snapshot.systemId,
    });
  }

  // -------------------------------------------------------------------
  // M8 读模型（overview §4 M8 / M8-safety-ui.md §7.2）
  // -------------------------------------------------------------------

  /** fuse-status：当前态 + 最近事件 ≤10（404 asset.not_found——SEC-AZ-03 越权同码）。 */
  async status(actor: AssetActor, systemId: string): Promise<FuseStatusResponse> {
    if (this.tenantDb === null)
      throw new ReasonCodeException('common.internal_error', '数据库未接线');
    return this.tenantDb.withTenant(actor.tenant_id, async (tx) => {
      const buildingScope = await loadBuildingScope(tx, actor);
      const row = await tx.query<{
        status: string;
        triggered_at: Date | null;
        trigger_detail: unknown;
        released_at: Date | null;
        name: string;
        system_type: string;
        building_id: string;
      }>(
        `SELECT cf.status, cf.triggered_at, cf.trigger_detail, cf.released_at,
                s.name, s.system_type, s.building_id
         FROM hvac_system s
         LEFT JOIN control_fuse cf ON cf.tenant_id = s.tenant_id AND cf.system_id = s.id
         WHERE s.tenant_id = $1 AND s.id = $2`,
        [actor.tenant_id, systemId],
      );
      const system = row.rows[0];
      if (
        system === undefined ||
        (buildingScope !== null && !buildingScope.has(system.building_id))
      ) {
        throw new ReasonCodeException('asset.not_found', '资源不存在', { entity: 'system' });
      }
      const events = await tx.query<FuseEventRow>(
        `SELECT id, event_type, actor_type, actor_ref, reason, detail, at
         FROM control_fuse_event WHERE tenant_id = $1 AND system_id = $2
         ORDER BY at DESC, id DESC LIMIT 10`,
        [actor.tenant_id, systemId],
      );
      return {
        system: { id: systemId, name: system.name, system_type: system.system_type },
        status: system.status === 'open' ? 'open' : 'closed',
        triggered_at: system.triggered_at === null ? null : system.triggered_at.toISOString(),
        trigger_detail: (system.trigger_detail ?? null) as FuseStatusResponse['trigger_detail'],
        released_at: system.released_at?.toISOString() ?? null,
        recent_events: events.rows.map(fuseEventOf),
      };
    });
  }

  /** fuse-events：游标全量（M8-safety-ui.md §10-U1 增补端点）。 */
  async events(
    actor: AssetActor,
    systemId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ items: FuseEventItem[]; next_cursor: string | null }> {
    if (this.tenantDb === null)
      throw new ReasonCodeException('common.internal_error', '数据库未接线');
    return this.tenantDb.withTenant(actor.tenant_id, async (tx) => {
      const buildingScope = await loadBuildingScope(tx, actor);
      // 归属校验（同 status 的 404 语义）
      const system = await tx.query<{ building_id: string }>(
        `SELECT building_id FROM hvac_system WHERE tenant_id = $1 AND id = $2`,
        [actor.tenant_id, systemId],
      );
      const target = system.rows[0];
      if (
        target === undefined ||
        (buildingScope !== null && !buildingScope.has(target.building_id))
      ) {
        throw new ReasonCodeException('asset.not_found', '资源不存在', { entity: 'system' });
      }
      const params: unknown[] = [actor.tenant_id, systemId];
      let where = `tenant_id = $1 AND system_id = $2`;
      if (cursor !== undefined) {
        params.push(cursor);
        where += ` AND (at, id) < ((($3::timestamptz), (SELECT id FROM control_fuse_event WHERE tenant_id = $1 AND system_id = $2 AND at = $3::timestamptz ORDER BY id DESC LIMIT 1)))`;
      }
      params.push(limit + 1);
      const rows = await tx.query<FuseEventRow & { at: Date }>(
        `SELECT id, event_type, actor_type, actor_ref, reason, detail, at
         FROM control_fuse_event WHERE ${where}
         ORDER BY at DESC, id DESC LIMIT $${String(params.length)}`,
        params,
      );
      const items = rows.rows.slice(0, limit).map(fuseEventOf);
      const last = rows.rows[limit - 1];
      return {
        items,
        next_cursor: rows.rows.length > limit && last !== undefined ? last.at.toISOString() : null,
      };
    });
  }
}

interface FuseEventRow {
  readonly id: string;
  readonly event_type: 'tripped' | 'released';
  readonly actor_type: 'system' | 'human';
  readonly actor_ref: string | null;
  readonly reason: string | null;
  readonly detail: unknown;
  readonly at: Date;
}

function fuseEventOf(row: FuseEventRow): FuseEventItem {
  return {
    id: Number(row.id),
    event_type: row.event_type,
    actor_type: row.actor_type,
    actor_ref: row.actor_ref,
    reason: row.reason,
    detail: (row.detail ?? null) as FuseEventItem['detail'],
    at: row.at.toISOString(),
  };
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function detailText(detail: {
  ratio: number;
  consecutive_fails: number;
  numerator: number;
  denominator: number;
}): string {
  return `窗口异常占比 ${String(Math.round(detail.ratio * 100))}%（${String(detail.numerator)}/${String(detail.denominator)}），连续失败 ${String(detail.consecutive_fails)}`;
}
