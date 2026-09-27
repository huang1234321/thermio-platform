/**
 * 控制派发器（control-safety.md §1/§3.0/§3.7，IMPL-18 / DAT-164）。
 *
 * - approve 后入仲裁（T1 受理快查：闸门 1/2/5 快速失败少占队列）→ phase=queued；
 * - 每设备串行出队（同设备仅一条非终态执行不变式，§3.7）：FIFO by decided_at，
 *   出队时 T2 全量复评（闸门 3 窗口/闸门 5 trip/闸门 2 热改参数在此拦下）；
 * - 排队/合并/溢出/超时（§3.7 表）：队列上限 CONFLICT_QUEUE_MAX、等待超时
 *   min(CONFLICT_WAIT_TIMEOUT_S, expires_at−now)、同点位新提案顶位（superseded_by
 *   复用 failed 不新增状态值）；
 * - 崩溃恢复：phase 停在非终态超过 EXECUTION_BUDGET_S → 条件 UPDATE 接管，
 *   按 §5 verify_failed 路径收敛（先尝试回写原值再终态化，绝不静默丢弃）；
 * - 10s 扫描兜底 + approve 事件即时 kick（§1 后台任务表节奏）。
 *
 * 互斥纪律（mock-execution.settler 同款）：PROPOSAL_MOCK_EXECUTOR=on 时本派发器
 * 整体停用——开关开着就不该同时部署真实仲裁链。
 */
import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { Logger } from 'pino';
import type { Pool, PoolClient } from 'pg';
import { CONTROL_ACTIVE_PHASES } from '@thermio/shared-types';
import type { AppConfig } from '../config.js';
import { APP_CONFIG } from '../infrastructure/core.module.js';
import { LOGGER } from '../infrastructure/logger.js';
import { AUTH_DB_POOL, TENANT_DB } from '../infrastructure/db/db.tokens.js';
import type { TenantDb } from '../infrastructure/db/tenant-db.js';
import { MetricsService } from '../infrastructure/metrics/metrics.service.js';
import {
  ArbitrationService,
  type ArbitrationContext,
  type GateOutcome,
} from './arbitration.service.js';
import { ControlExecutorService } from './executor.service.js';
import { ControlEventsPublisher } from './control-events.publisher.js';
import {
  buildExecutedEvent,
  finalizeProposal,
  gateLabelOfReasonCode,
  transitionPhase,
  type ExecutionResult,
} from './execution-store.js';

/** 排队行（PG 持久真值，§3.7：天然崩溃安全）。 */
interface QueueRow {
  readonly id: string;
  readonly equipment_id: string | null;
  readonly point_id: string;
  readonly decided_at: Date;
  readonly expires_at: Date | null;
  readonly phase: string | null;
  readonly queued_at: string | null;
}

/** 溢出/超时/合并/拒绝共用的终态化（§8-A1：control_audit result=rejected actor=algo）。 */
async function finalizeGateRejection(
  tx: PoolClient,
  params: {
    tenantId: string;
    proposalId: string;
    pointId: number;
    reasonCode:
      | 'proposal.gate_whitelist_denied'
      | 'proposal.gate_rate_limited'
      | 'proposal.gate_conflict_queued'
      | 'proposal.gate_conflict_overflow'
      | 'proposal.gate_conflict_timeout'
      | 'proposal.gate_system_fused';
    gates: readonly GateOutcome[];
    mutate?: ((result: ExecutionResult) => ExecutionResult) | undefined;
  },
): Promise<boolean> {
  const baseMutate = params.mutate;
  return finalizeProposal(tx, {
    tenantId: params.tenantId,
    proposalId: params.proposalId,
    pointId: params.pointId,
    phase: 'rejected',
    status: 'failed',
    reasonCode: params.reasonCode,
    outcome: 'rejected_by_gate',
    audit: [
      {
        result: 'rejected',
        actor_type: 'algo',
        reason: params.reasonCode,
        old_value: null,
        new_value: null,
      },
    ],
    // 逐道闸门结果随终态持久化（M5 §2.3 读投影 gates 数据面；F1 修单补齐）
    mutate: (result) => {
      const withGates = { ...result, gates: [...params.gates] };
      return baseMutate === undefined ? withGates : baseMutate(withGates);
    },
  });
}

@Injectable()
export class ControlDispatcherService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger: Logger;
  private timer: NodeJS.Timeout | null = null;
  private scanning = false;
  private readonly inFlight = new Set<string>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) rootLogger: Logger,
    @Inject(TENANT_DB) private readonly tenantDb: TenantDb | null,
    @Inject(AUTH_DB_POOL) private readonly authPool: Pool | null,
    @Inject(ArbitrationService) private readonly arbitration: ArbitrationService,
    @Inject(ControlExecutorService) private readonly executor: ControlExecutorService,
    @Inject(ControlEventsPublisher) private readonly events: ControlEventsPublisher,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {
    this.logger = rootLogger.child({ component: 'control-dispatcher' });
  }

  onModuleInit(): void {
    if (this.config.PROPOSAL_MOCK_EXECUTOR === 'on') {
      this.logger.warn({
        msg: 'control_dispatcher_disabled',
        hint: 'PROPOSAL_MOCK_EXECUTOR=on（IMPL-17 闭环演练形态；与真实仲裁链互斥由开关承担）',
      });
      return;
    }
    if (this.tenantDb === null || this.authPool === null) {
      this.logger.warn({ msg: 'control_dispatcher_db_disabled', hint: 'PG 未接线，派发器停用' });
      return;
    }
    this.timer = setInterval(
      () => void this.sweep(),
      Math.max(100, this.config.CONTROL_DISPATCH_SCAN_INTERVAL_MS),
    );
    this.timer.unref();
    // 启动即扫一轮：重启后由扫描重建内存视图（§3.7 崩溃恢复）+ 预算兜底接管
    void this.sweep();
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  /** approve 事件即时入口（T1 受理快查 + 入队 + 即时派发尝试；异常只留痕不回滚决策）。 */
  async onApproved(tenantId: string, proposalId: string): Promise<void> {
    if (this.config.PROPOSAL_MOCK_EXECUTOR === 'on') return;
    if (this.tenantDb === null) return;
    try {
      const accepted = await this.tenantDb.withTenant(tenantId, async (tx) => {
        const ctx = await this.arbitration.loadContext(tx, tenantId, proposalId);
        if (ctx === null || Number.isNaN(ctx.action_value)) return false;
        // 幂等锚：仅 approved 且尚无 phase 的提案受理（重复 kick/他路径已受理直接跳过）
        const current = await tx.query<{ status: string; phase: string | null }>(
          `SELECT status, execution_result->>'phase' AS phase FROM proposal
           WHERE tenant_id = $1 AND id = $2`,
          [tenantId, proposalId],
        );
        const row = current.rows[0];
        if (row === undefined || row.status !== 'approved' || row.phase !== null) return false;

        const t1 = await this.arbitration.t1QuickCheck(tx, ctx);
        if (t1 !== null && t1.kind === 'reject') {
          const won = await finalizeGateRejection(tx, {
            tenantId,
            proposalId,
            pointId: ctx.point_id,
            reasonCode: t1.reason_code,
            gates: t1.gates,
          });
          if (won) {
            this.metrics.recordGate(gateLabelOfReasonCode(t1.reason_code));
            await this.events.publishControlExecuted(
              buildExecutedEvent({
                tenantId,
                proposalId,
                pointId: ctx.point_id,
                equipmentId: ctx.equipment_id,
                systemId: ctx.system_id,
                algo: ctx.algo,
                algoVersion: ctx.algo_version,
                outcome: 'rejected_by_gate',
                reasonCode: t1.reason_code,
                valueBefore: ctx.previous_value,
                valueCommanded: ctx.action_value,
                valueEffective: null,
                clamped: false,
                decidedBy: ctx.decided_by,
                verify: { readings: [], retries_write: 0 },
              }),
            );
          }
          return true;
        }
        // 受理通过 → 闸门 4 溢出主判定（§3.7 队列上限：同设备已有 CONFLICT_QUEUE_MAX
        // 条排队时，最新到达者即时拒绝——不占队列、不等扫描周期）
        const t1Pass = t1 !== null && t1.kind === 'pass' ? t1 : null;
        const equipmentId = ctx.equipment_id;
        if (equipmentId !== null) {
          const depthRow = await tx.query<{ depth: string }>(
            `SELECT count(*) AS depth FROM proposal
             WHERE tenant_id = $1 AND equipment_id = $2 AND status = 'approved'
               AND execution_result->>'phase' = 'queued'`,
            [tenantId, equipmentId],
          );
          const depth = Number(depthRow.rows[0]?.depth ?? '0');
          if (depth >= this.config.controlSafety.conflictQueueMax) {
            const won = await finalizeGateRejection(tx, {
              tenantId,
              proposalId,
              pointId: ctx.point_id,
              reasonCode: 'proposal.gate_conflict_overflow',
              gates: [
                ...([] as GateOutcome[]),
                ...(t1Pass?.gates ?? []),
                {
                  gate: 4,
                  name: 'conflict',
                  outcome: 'overflow',
                  detail: { depth, max: this.config.controlSafety.conflictQueueMax },
                },
              ],
            });
            if (won) {
              this.metrics.recordGate('conflict');
              await this.events.publishControlExecuted(
                buildExecutedEvent({
                  tenantId,
                  proposalId,
                  pointId: ctx.point_id,
                  equipmentId,
                  systemId: ctx.system_id,
                  algo: ctx.algo,
                  algoVersion: ctx.algo_version,
                  outcome: 'rejected_by_gate',
                  reasonCode: 'proposal.gate_conflict_overflow',
                  valueBefore: ctx.previous_value,
                  valueCommanded: ctx.action_value,
                  valueEffective: null,
                  clamped: false,
                  decidedBy: ctx.decided_by,
                  verify: { readings: [], retries_write: 0 },
                }),
              );
            }
            return true;
          }
        }
        // 入队（phase=queued；T1 gates + clamp 预演随行记录，§3.0）
        await tx.query(
          `UPDATE proposal SET execution_result = $3 WHERE tenant_id = $1 AND id = $2`,
          [
            tenantId,
            proposalId,
            JSON.stringify({
              phase: 'queued',
              queued_at: new Date().toISOString(),
              gates: [...(t1Pass?.gates ?? [])],
              clamped: t1Pass?.clamped ?? false,
              effective_value: t1Pass?.effective_value ?? ctx.action_value,
            } satisfies ExecutionResult),
          ],
        );
        return true;
      });
      if (accepted) await this.scanTenant(tenantId);
    } catch (err: unknown) {
      this.logger.error({
        msg: 'control_on_approved_failed',
        tenant_id: tenantId,
        proposal_id: proposalId,
        err,
      });
    }
  }

  /**
   * 周期组合扫描（B1 修单接线）：① 队列扫描派发（§3.7）+ ② 预算兜底接管
   * （§2/§3.7：非终态超 EXECUTION_BUDGET_S 的僵尸提案收敛——先回写原值再终态化，
   * 绝不静默丢弃）。机制本体经探针 P8 直调验证，此处补齐调度接线。
   */
  private async sweep(): Promise<void> {
    await this.scanAll();
    await this.reclaimStaleExecutions().catch((err: unknown) => {
      this.logger.error({ msg: 'control_reclaim_sweep_failed', err });
    });
  }

  /** 全租户扫描（10s 兜底；单租户 MVP 形态下一次列表查询）。 */
  async scanAll(): Promise<void> {
    if (this.scanning || this.tenantDb === null || this.authPool === null) return;
    if (this.config.PROPOSAL_MOCK_EXECUTOR === 'on') return;
    this.scanning = true;
    try {
      const tenants = await this.authPool.query<{ id: string }>(
        `SELECT id FROM tenant ORDER BY created_at, id`,
      );
      for (const tenant of tenants.rows) {
        await this.scanTenant(tenant.id);
      }
    } catch (err: unknown) {
      this.logger.error({ msg: 'control_scan_failed', err });
    } finally {
      this.scanning = false;
    }
  }

  /** 单租户扫描：超时 → 合并 → 溢出（入队侧即时判）→ 派发。 */
  async scanTenant(tenantId: string): Promise<void> {
    if (this.tenantDb === null) return;
    const { conflictQueueMax, conflictWaitTimeoutS } = this.config.controlSafety;
    await this.tenantDb.withTenant(tenantId, async (tx) => {
      // ── 1. 等待超时（§3.7：> min(300s, expires_at − now) → conflict_timeout）──
      const queued = await tx.query<QueueRow>(
        `SELECT id, equipment_id, point_id, decided_at, expires_at,
                execution_result->>'phase' AS phase,
                execution_result->>'queued_at' AS queued_at
         FROM proposal
         WHERE tenant_id = $1 AND status = 'approved'
           AND (execution_result->>'phase' = 'queued'
                OR (execution_result->>'phase' IS NULL AND decided_at IS NOT NULL))
         ORDER BY decided_at ASC`,
        [tenantId],
      );
      const now = Date.now();
      for (const row of queued.rows) {
        // 尚无 phase 的 approved（部署前决策/中断恢复）在此补入队
        if (row.phase === null) {
          await tx.query(
            `UPDATE proposal SET execution_result = jsonb_set(
               COALESCE(execution_result, '{}'::jsonb), '{phase}', '"queued"'::jsonb, true)
             WHERE tenant_id = $1 AND id = $2`,
            [tenantId, row.id],
          );
          continue;
        }
        const queuedAt = row.queued_at !== null ? Date.parse(row.queued_at) : now;
        const expiresInMs =
          row.expires_at !== null ? row.expires_at.getTime() - now : conflictWaitTimeoutS * 1000;
        const waitLimitMs = Math.min(conflictWaitTimeoutS * 1000, Math.max(0, expiresInMs));
        if (now - queuedAt <= waitLimitMs) continue;
        const ctx = await this.arbitration.loadContext(tx, tenantId, row.id);
        if (ctx === null) continue;
        const won = await finalizeGateRejection(tx, {
          tenantId,
          proposalId: row.id,
          pointId: ctx.point_id,
          reasonCode: 'proposal.gate_conflict_timeout',
          gates: [],
          mutate: (result) => ({
            ...result,
            gates: [
              {
                gate: 4,
                name: 'conflict',
                outcome: 'timeout',
                detail: { waited_s: Math.round((now - queuedAt) / 1000) },
              },
              ...(result.gates ?? []),
            ] as never,
          }),
        });
        if (won) {
          this.metrics.recordGate('conflict');
          await this.events.publishControlExecuted(
            buildExecutedEvent({
              tenantId,
              proposalId: row.id,
              pointId: ctx.point_id,
              equipmentId: ctx.equipment_id,
              systemId: ctx.system_id,
              algo: ctx.algo,
              algoVersion: ctx.algo_version,
              outcome: 'rejected_by_gate',
              reasonCode: 'proposal.gate_conflict_timeout',
              valueBefore: ctx.previous_value,
              valueCommanded: ctx.action_value,
              valueEffective: null,
              clamped: false,
              decidedBy: ctx.decided_by,
              verify: { readings: [], retries_write: 0 },
            }),
          );
        }
      }

      // ── 2. 同点位合并（§3.7：更新提案顶位，旧提案 superseded_by → failed）──
      const superseded = await tx.query<{
        id: string;
        point_id: string;
        newer: string;
        point: number;
      }>(
        `SELECT older.id, older.point_id, newer.id AS newer, older.point_id::text AS point
         FROM proposal older
         JOIN proposal newer
           ON newer.tenant_id = older.tenant_id
          AND newer.point_id = older.point_id
          AND newer.decided_at > older.decided_at
          AND newer.status = 'approved'
         WHERE older.tenant_id = $1 AND older.status = 'approved'
           AND older.execution_result->>'phase' = 'queued'
           AND newer.execution_result->>'phase' = 'queued'`,
        [tenantId],
      );
      for (const row of superseded.rows) {
        const ctx = await this.arbitration.loadContext(tx, tenantId, row.id);
        if (ctx === null) continue;
        const won = await finalizeGateRejection(tx, {
          tenantId,
          proposalId: row.id,
          pointId: Number(row.point_id),
          reasonCode: 'proposal.gate_conflict_queued',
          gates: [],
          mutate: (result) => ({
            ...result,
            gates: [
              {
                gate: 4,
                name: 'conflict',
                outcome: 'superseded',
                detail: { superseded_by: row.newer },
              },
              ...(result.gates ?? []),
            ] as never as GateOutcome[],
          }),
        });
        if (won) {
          // superseded 非闸门拒绝（合并语义）——不进 rejections 计数；
          // Kafka outcome=rejected_by_gate（终态事件契约 §10）
          await this.events.publishControlExecuted(
            buildExecutedEvent({
              tenantId,
              proposalId: row.id,
              pointId: Number(row.point_id),
              equipmentId: ctx.equipment_id,
              systemId: ctx.system_id,
              algo: ctx.algo,
              algoVersion: ctx.algo_version,
              outcome: 'rejected_by_gate',
              reasonCode: 'proposal.gate_conflict_queued',
              valueBefore: ctx.previous_value,
              valueCommanded: ctx.action_value,
              valueEffective: null,
              clamped: false,
              decidedBy: ctx.decided_by,
              verify: { readings: [], retries_write: 0 },
            }),
          );
        }
      }

      // ── 3. 每设备派发（§3.7：无非终态执行的设备出队队首，FIFO by decided_at）──
      const heads = await tx.query<QueueRow & { depth: string }>(
        `WITH queued AS (
           SELECT p.*, ROW_NUMBER() OVER (PARTITION BY p.equipment_id ORDER BY p.decided_at ASC) AS rn,
                  COUNT(*) OVER (PARTITION BY p.equipment_id) AS depth
           FROM proposal p
           WHERE p.tenant_id = $1 AND p.status = 'approved'
             AND p.execution_result->>'phase' = 'queued'
         )
         SELECT q.id, q.equipment_id, q.point_id, q.decided_at, q.expires_at,
                q.execution_result->>'phase' AS phase, NULL AS queued_at, q.depth::text
         FROM queued q
         WHERE q.rn = 1
           AND NOT EXISTS (
             SELECT 1 FROM proposal other
             WHERE other.tenant_id = $1 AND other.status = 'approved'
               AND other.equipment_id = q.equipment_id
               AND other.id <> q.id
               AND other.execution_result->>'phase' = ANY($2::text[])
           )`,
        [tenantId, [...CONTROL_ACTIVE_PHASES]],
      );
      for (const head of heads.rows) {
        if (head.equipment_id === null) continue;
        this.metrics.setConflictQueueDepth(head.equipment_id, Number(head.depth));
        if (Number(head.depth) > conflictQueueMax) {
          // 溢出竞态兜底（非主判定）：主判定在 onApproved 入队侧即时拒最新（§3.7）。
          // 并发 approve 各自计数可同时过闸（事务间互不见未提交行）→ 深度瞬时超限，
          // 此处按 FIFO 拒队首收敛；单到达路径不会走到本分支。
          const ctx = await this.arbitration.loadContext(tx, tenantId, head.id);
          if (ctx === null) continue;
          const won = await finalizeGateRejection(tx, {
            tenantId,
            proposalId: head.id,
            pointId: ctx.point_id,
            reasonCode: 'proposal.gate_conflict_overflow',
            gates: [],
            mutate: (result) => ({
              ...result,
              gates: [
                {
                  gate: 4,
                  name: 'conflict',
                  outcome: 'overflow',
                  detail: { depth: Number(head.depth), max: conflictQueueMax },
                },
                ...(result.gates ?? []),
              ] as never as GateOutcome[],
            }),
          });
          if (won) {
            this.metrics.recordGate('conflict');
          }
          continue;
        }
        void this.dispatchHead(tenantId, head.id).catch((err: unknown) => {
          this.logger.error({
            msg: 'control_dispatch_failed',
            tenant_id: tenantId,
            proposal_id: head.id,
            err,
          });
        });
      }
    });
  }

  /** 队首派发：T2 全量复评（selfIsHead）→ dispatching → executor（fire，不占扫描）。 */
  private async dispatchHead(tenantId: string, proposalId: string): Promise<void> {
    if (this.tenantDb === null || this.inFlight.has(proposalId)) return;
    this.inFlight.add(proposalId);
    try {
      type Dispatchable = {
        ctx: ArbitrationContext;
        effectiveValue: number;
        clamped: boolean;
        gates: readonly GateOutcome[];
      };
      const dispatchable = await this.tenantDb.withTenant<Dispatchable | null>(
        tenantId,
        async (tx) => {
          const loaded = await this.arbitration.loadContext(tx, tenantId, proposalId);
          if (loaded === null) return null;
          const t2 = await this.arbitration.t2FullReeval(tx, loaded, { selfIsHead: true });
          if (t2.kind === 'reject') {
            const won = await finalizeGateRejection(tx, {
              tenantId,
              proposalId,
              pointId: loaded.point_id,
              reasonCode: t2.reason_code,
              gates: t2.gates,
            });
            if (won) {
              this.metrics.recordGate(gateLabelOfReasonCode(t2.reason_code));
              await this.events.publishControlExecuted(
                buildExecutedEvent({
                  tenantId,
                  proposalId,
                  pointId: loaded.point_id,
                  equipmentId: loaded.equipment_id,
                  systemId: loaded.system_id,
                  algo: loaded.algo,
                  algoVersion: loaded.algo_version,
                  outcome: 'rejected_by_gate',
                  reasonCode: t2.reason_code,
                  valueBefore: loaded.previous_value,
                  valueCommanded: loaded.action_value,
                  valueEffective: null,
                  clamped: false,
                  decidedBy: loaded.decided_by,
                  verify: { readings: [], retries_write: 0 },
                }),
              );
            }
            return null;
          }
          if (t2.kind === 'queue') return null; // 闸门 4 仍拦截（并发变化），下轮再试
          // 抢占派发位：queued → dispatching 单赢家（跨副本互斥锚）
          const won = await transitionPhase(tx, tenantId, proposalId, ['queued'], (result) => ({
            ...result,
            phase: 'dispatching',
            gates: t2.gates as never,
            effective_value: t2.effective_value,
            clamped: t2.clamped,
            clamp_detail: t2.clamp_detail,
            verify: { readings: [], retries_write: 0 },
          }));
          return won
            ? {
                ctx: loaded,
                effectiveValue: t2.effective_value,
                clamped: t2.clamped,
                gates: t2.gates,
              }
            : null;
        },
      );
      if (dispatchable === null) return;
      try {
        await this.executor.execute(
          tenantId,
          dispatchable.ctx,
          dispatchable.effectiveValue,
          dispatchable.clamped,
          dispatchable.gates,
        );
      } catch (err: unknown) {
        // 执行链异常（DB/通道边界外）：预算兜底扫描会接管（§3.7 崩溃恢复）
        this.logger.error({
          msg: 'control_execute_crashed',
          tenant_id: tenantId,
          proposal_id: proposalId,
          err,
        });
      }
    } finally {
      this.inFlight.delete(proposalId);
    }
  }

  /** 预算兜底（§2/§3.7：非终态超 EXECUTION_BUDGET_S → 接管收敛）。 */
  async reclaimStaleExecutions(): Promise<number> {
    if (this.tenantDb === null || this.authPool === null) return 0;
    let reclaimed = 0;
    const tenants = await this.authPool.query<{ id: string }>(
      `SELECT id FROM tenant ORDER BY created_at, id`,
    );
    for (const tenant of tenants.rows) {
      reclaimed += await this.tenantDb.withTenant(tenant.id, async (tx) => {
        const stale = await tx.query<{ id: string; effective_value: string | number | null }>(
          `SELECT id, execution_result->>'effective_value' AS effective_value
           FROM proposal
           WHERE tenant_id = $1 AND status = 'approved'
             AND execution_result->>'phase' = ANY($2::text[])
             AND COALESCE(execution_result->>'claimed_at', execution_result->>'queued_at', to_char(decided_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')) ::timestamptz
                 < now() - ($3::bigint * interval '1 second')
           FOR UPDATE SKIP LOCKED`,
          [tenant.id, [...CONTROL_ACTIVE_PHASES], this.config.controlSafety.executionBudgetS],
        );
        let done = 0;
        for (const row of stale.rows) {
          const ctx = await this.arbitration.loadContext(tx, tenant.id, row.id);
          if (ctx === null) continue;
          // 条件接管：置 budget_reclaimed 标记（幂等锚），随后按 §5 verify_failed 收敛
          const won = await transitionPhase(
            tx,
            tenant.id,
            row.id,
            [...CONTROL_ACTIVE_PHASES],
            (result) => ({
              ...result,
              phase: 'reverting',
              budget_reclaimed: true,
            }),
          );
          if (!won) continue;
          done += 1;
          this.executor
            .reclaim(tenant.id, ctx, Number(row.effective_value ?? ctx.previous_value ?? 0))
            .catch((err: unknown) => {
              this.logger.error({
                msg: 'control_reclaim_failed',
                tenant_id: tenant.id,
                proposal_id: row.id,
                err,
              });
            });
        }
        return done;
      });
    }
    return reclaimed;
  }
}
