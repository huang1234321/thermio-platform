/**
 * 控制执行器（control-safety.md §4/§5，IMPL-18 / DAT-164）。
 *
 * 单次执行状态机（§2 phase 字段为锚，全部条件 UPDATE 单赢家）：
 *   dispatching → awaiting_ack →（ACK 超时不中止，§4.4）等 VERIFY_DELAY_S →
 *   awaiting_readback ⇄ retrying（整段重写 ≤ WRITE_RETRY_MAX）→
 *     一致 → executed；ack rejected / 仍不一致 → reverting（回写原值，只验一次
 *     不递归防乒乓）→ reverted / verify_failed（+ 告警联动 §5.4）。
 *
 * 边界（交付说明显式声明，非静默假设）：
 * - 应答等待为进程内 cmd_id 关联表；多副本时应答可能落在非发送实例，发送实例按
 *   §4.4 超时语义收敛（read 超时 = 读失败进重试 → 回写原值），设备面 setpoint
 *   写幂等故收敛不破坏；关联真值在 PG（execution_result.cmds），跨实例应答收敛
 *   依托条件 UPDATE 已就绪，进程内等待表是单实例直连优化而非正确性依赖；
 * - 全链路硬预算 EXECUTION_BUDGET_S 由 dispatcher 兜底扫描收敛（§2/§3.7）；
 * - auto 点位租约 acquire 在 dispatcher 派发前完成（lease-sweeper 域），本执行器
 *   不重复实现（§6.1 范围解释：MVP 全 advisory）。
 */
import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { PoolClient } from 'pg';
import type {
  ControlExecutedEvent,
  ControlReadResult,
  ControlUpEvent,
  ControlWriteAck,
  ControlWriteCommand,
} from '@thermio/shared-types';
import { CONTROL_CMD_EXPIRES_IN_S } from '@thermio/shared-types';
import type { AppConfig } from '../config.js';
import { APP_CONFIG } from '../infrastructure/core.module.js';
import { LOGGER } from '../infrastructure/logger.js';
import { AlarmEngineService } from '../alarm/alarm-engine.service.js';
import { MetricsService } from '../infrastructure/metrics/metrics.service.js';
import { TENANT_DB } from '../infrastructure/db/db.tokens.js';
import type { TenantDb } from '../infrastructure/db/tenant-db.js';
import type { TelemetryStore } from '../telemetry/tsdb-read.repository.js';
import { TELEMETRY_STORE } from '../telemetry/telemetry.tokens.js';
import { clampOf, type ArbitrationContext, type GateOutcome } from './arbitration.service.js';
import { ControlChannelUnavailableError, type ControlChannel } from './control-channel.js';
import { CONTROL_CHANNEL } from './control-safety.tokens.js';
import { ControlEventsPublisher } from './control-events.publisher.js';
import {
  appendCmd,
  appendReading,
  buildExecutedEvent,
  type ExecutionResult,
  finalizeProposal,
  transitionPhase,
} from './execution-store.js';

/** cmd_id → 应答等待器（§4.5：首个应答定阶段，后续重复仅存在性检查）。 */
interface CmdWaiter {
  readonly resolve: (event: ControlUpEvent | null) => void;
  readonly timer: NodeJS.Timeout;
}

interface ReadingRecord {
  readonly at: string | null;
  readonly value: number | null;
  readonly quality?: string | null;
  readonly match: boolean | null;
}

export interface ExecutionOutcome {
  readonly outcome: 'executed' | 'verify_failed' | 'reverted';
  readonly proposalId: string;
}

export type ExecutorDeps = {
  channel: ControlChannel;
  alarmEngine: AlarmEngineService;
  metrics: MetricsService;
  events: ControlEventsPublisher;
  telemetry: TelemetryStore;
  tenantDb: TenantDb | null;
};

@Injectable()
export class ControlExecutorService {
  private readonly logger: Logger;
  private readonly waiters = new Map<string, CmdWaiter>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) rootLogger: Logger,
    @Inject(CONTROL_CHANNEL) private readonly channel: ControlChannel,
    @Inject(AlarmEngineService) private readonly alarmEngine: AlarmEngineService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
    @Inject(ControlEventsPublisher) private readonly events: ControlEventsPublisher,
    @Inject(TELEMETRY_STORE) private readonly telemetry: TelemetryStore,
    @Inject(TENANT_DB) private readonly tenantDb: TenantDb | null,
  ) {
    this.logger = rootLogger.child({ component: 'control-executor' });
    // up/event → cmd_id 关联分发（§4.3：QoS1 at-least-once，首个应答定阶段）
    channel.onUpEvent((event) => {
      this.dispatchUpEvent(event);
    });
  }

  private dispatchUpEvent(event: ControlUpEvent): void {
    const waiter = this.waiters.get(event.cmd_id);
    if (waiter === undefined) return; // 迟到/重复应答（他实例或已超时收敛）
    this.waiters.delete(event.cmd_id);
    clearTimeout(waiter.timer);
    waiter.resolve(event);
  }

  /**
   * 执行一段已通过 T2 仲裁的提案（§5.2 判定流程全貌）。
   * effectiveValue 为 clamp 后生效值；clamped 时 control_audit.new_value 记生效值（§8-A2）。
   */
  async execute(
    tenantId: string,
    ctx: ArbitrationContext,
    effectiveValue: number,
    clamped: boolean,
    gates: readonly GateOutcome[],
  ): Promise<ExecutionOutcome> {
    const startedAtMs = Date.now();
    if (clamped) this.metrics.recordClamped();
    const verifyDurationS = () => (Date.now() - startedAtMs) / 1000;

    let retriesWrite = 0;
    let lastReading: ReadingRecord | null = null;
    let ackRejected: ControlWriteAck | null = null;

    for (let segment = 0; segment <= this.config.controlSafety.writeRetryMax; segment += 1) {
      const isFirstSegment = segment === 0;
      // ── 写段（§4.2 write_cmd；重试段 = 整段重写 effective 值，§5.2）──
      const writeCmdId = randomUUID();
      await this.withinTenant(tenantId, (tx) =>
        transitionPhase(
          tx,
          tenantId,
          ctx.proposal_id,
          isFirstSegment ? ['dispatching'] : ['awaiting_readback'],
          (result) =>
            appendCmd(
              {
                ...result,
                phase: isFirstSegment ? 'awaiting_ack' : 'retrying',
                gates: [...gates] as never,
                effective_value: effectiveValue,
                clamped,
                verify: { readings: result.verify?.readings ?? [], retries_write: retriesWrite },
              },
              { cmd_id: writeCmdId, kind: 'write' },
            ),
        ),
      );
      let ack: ControlWriteAck | null = null;
      try {
        ack = await this.writeAndWaitAck(ctx, writeCmdId, effectiveValue);
      } catch (err: unknown) {
        if (!(err instanceof ControlChannelUnavailableError)) throw err;
        // §4.4：发布重试耗尽——值可能已落（会话队列），转回写原值路径
        this.logger.warn({
          msg: 'control_publish_failed_entering_revert',
          tenant_id: tenantId,
          point_id: ctx.point_id,
          proposal_id: ctx.proposal_id,
          err,
        });
        break;
      }
      if (ack !== null && ack.result === 'rejected') {
        ackRejected = ack;
        break; // §5.2：rejected → 立即转 verify_failed 路径（先探测现场真值）
      }
      // ── 等 VERIFY_DELAY_S 再读（§5.1：寄存器稳定窗）──
      await sleep(this.config.controlSafety.verifyDelayS * 1000);
      const read = await this.readOnce(tenantId, ctx, effectiveValue, {
        fromPhases: isFirstSegment ? ['awaiting_ack'] : ['retrying'],
      });
      lastReading = read?.reading ?? null;
      if (read !== null && read.match) {
        // ── 回读一致 → executed（§5.2）──
        await this.finalizeExecuted(
          tenantId,
          ctx,
          effectiveValue,
          clamped,
          retriesWrite,
          read.reading,
          verifyDurationS(),
        );
        return { outcome: 'executed', proposalId: ctx.proposal_id };
      }
      retriesWrite += 1;
    }

    // ── 终态不一致：ack rejected（探测一次）或重写耗尽 → 回写原值（§5.3）──
    let probe: ReadingRecord | null = lastReading;
    if (ackRejected !== null && probe === null) {
      probe =
        (
          await this.readOnce(tenantId, ctx, effectiveValue, {
            fromPhases: ['awaiting_ack', 'retrying'],
          })
        )?.reading ?? null;
    }
    return this.revertToBaseline(
      tenantId,
      ctx,
      effectiveValue,
      clamped,
      retriesWrite,
      ackRejected,
      probe,
      verifyDurationS(),
    );
  }

  /** executed 终态（§8-A2：new_value = clamp 后生效值；clamped 双留 old/new）。 */
  private async finalizeExecuted(
    tenantId: string,
    ctx: ArbitrationContext,
    effectiveValue: number,
    clamped: boolean,
    retriesWrite: number,
    reading: ReadingRecord,
    verifyDurationS: number,
  ): Promise<void> {
    const won = await this.withinTenant(tenantId, (tx) =>
      finalizeProposal(tx, {
        tenantId,
        proposalId: ctx.proposal_id,
        pointId: ctx.point_id,
        phase: 'executed',
        status: 'executed',
        reasonCode: null,
        outcome: 'executed',
        audit: [
          {
            result: 'ok',
            actor_type: 'algo',
            reason: null,
            old_value: ctx.previous_value,
            new_value: effectiveValue,
          },
        ],
        mutate: (result) => ({
          ...result,
          verify: {
            readings: result.verify?.readings ?? [reading],
            retries_write: retriesWrite,
          },
        }),
      }),
    );
    if (!won) return;
    this.metrics.recordControlExecution('ok');
    this.metrics.recordDecision('ok');
    this.metrics.observeVerifyDuration(verifyDurationS);
    await this.events.publishControlExecuted(
      this.eventOf(ctx, {
        outcome: 'executed',
        reasonCode: null,
        valueEffective: effectiveValue,
        clamped,
        verify: {
          readings: [{ at: reading.at, value: reading.value, match: reading.match }],
          retries_write: retriesWrite,
        },
      }),
    );
  }

  /** 回写原值（§5.3：previous_value → 最新遥测 → 无法回写三段锚链）。只验一次，不再递归。 */
  private async revertToBaseline(
    tenantId: string,
    ctx: ArbitrationContext,
    effectiveValue: number,
    clamped: boolean,
    retriesWrite: number,
    ackRejected: ControlWriteAck | null,
    probeReading: ReadingRecord | null,
    verifyDurationS: number,
  ): Promise<ExecutionOutcome> {
    const baseline = ctx.previous_value ?? (await this.latestTelemetryValue(ctx.point_id));
    const verifyFailReason =
      ackRejected !== null ? `gw_rejected:${ackRejected.code ?? 'unknown'}` : 'readback_mismatch';

    if (baseline === null) {
      // §5.3 无基线：无法回写 → failed + critical（设备状态未知且无恢复锚）
      await this.finalizeVerifyFailed(tenantId, ctx, effectiveValue, clamped, retriesWrite, {
        auditReason: 'no_baseline',
        critical: true,
        mutate: probeReading === null ? undefined : (result) => appendReading(result, probeReading),
      });
      return { outcome: 'verify_failed', proposalId: ctx.proposal_id };
    }

    // 回写值同样过 clamp（ADR-009 值域兜底：最坏停在安全边界）
    const { effective: revertValue } = clampOf(baseline, ctx.clamp_min, ctx.clamp_max);
    const revertCmdId = randomUUID();
    await this.withinTenant(tenantId, (tx) =>
      transitionPhase(
        tx,
        tenantId,
        ctx.proposal_id,
        ['awaiting_ack', 'awaiting_readback', 'retrying', 'reverting'],
        (result) =>
          appendCmd({ ...result, phase: 'reverting' }, { cmd_id: revertCmdId, kind: 'revert' }),
      ),
    );
    let ack: ControlWriteAck | null = null;
    let ackOk = false;
    let read: { match: boolean; reading: ReadingRecord } | null = null;
    try {
      ack = await this.writeAndWaitAck(ctx, revertCmdId, revertValue);
      ackOk = ack === null || ack.result === 'accepted';
      await sleep(this.config.controlSafety.verifyDelayS * 1000);
      if (ackOk) {
        read = await this.readOnce(tenantId, ctx, revertValue, { fromPhases: ['reverting'] });
      }
    } catch (err: unknown) {
      if (!(err instanceof ControlChannelUnavailableError)) throw err;
      // 回写也发布失败（网关离线/无网关）：网关断链安全值 + 会话队列三层兜底
      // （§6.3-4）之前的云端语义 = verify_failed + critical，绝不静默丢弃
      this.logger.warn({
        msg: 'control_revert_publish_failed',
        tenant_id: tenantId,
        point_id: ctx.point_id,
        proposal_id: ctx.proposal_id,
        err,
      });
    }

    if (ackOk && read !== null && read.match) {
      // 回写验证通过 → reverted（§8-A3 verify_failed + A4 reverted 双行，§9.3 时序）
      const won = await this.withinTenant(tenantId, (tx) =>
        finalizeProposal(tx, {
          tenantId,
          proposalId: ctx.proposal_id,
          pointId: ctx.point_id,
          phase: 'reverted',
          status: 'failed',
          reasonCode: 'proposal.verify_failed',
          outcome: 'reverted',
          audit: [
            {
              result: 'verify_failed',
              actor_type: 'algo',
              reason: verifyFailReason,
              old_value: ctx.previous_value,
              new_value: effectiveValue,
            },
            {
              result: 'reverted',
              actor_type: 'system',
              reason: 'verify_failed',
              old_value: effectiveValue,
              new_value: revertValue,
            },
          ],
          mutate: (result) => appendReading(result, read.reading),
        }),
      );
      if (won) {
        this.metrics.recordControlExecution('reverted');
        this.metrics.recordDecision('reverted');
        this.metrics.observeVerifyDuration(verifyDurationS);
      }
      await this.openVerifyAlarm(
        tenantId,
        ctx,
        'major',
        `回读不一致已回写原值（${ctx.raw_name}：指令 ${String(effectiveValue)} 未生效，回写 ${String(revertValue)}）`,
      );
      await this.events.publishControlExecuted(
        this.eventOf(ctx, {
          outcome: 'reverted',
          reasonCode: 'proposal.verify_failed',
          valueEffective: effectiveValue,
          clamped,
          verify: {
            readings: [
              {
                at: read.reading.at,
                value: read.reading.value,
                match: read.reading.match,
              },
            ],
            retries_write: retriesWrite,
          },
        }),
      );
      return { outcome: 'reverted', proposalId: ctx.proposal_id };
    }

    // 回写验证失败 → verify_failed + critical（设备不跟随指令——熔断强信号，§5.3）
    const failReading = read?.reading ?? probeReading;
    await this.finalizeVerifyFailed(tenantId, ctx, effectiveValue, clamped, retriesWrite, {
      auditReason: ackOk ? 'revert_verify_failed' : 'revert_unreachable',
      critical: true,
      mutate: failReading === null ? undefined : (result) => appendReading(result, failReading),
    });
    return { outcome: 'verify_failed', proposalId: ctx.proposal_id };
  }

  /** verify_failed 终态公共面（无基线/回写失败共用；§8-A3 + §5.4 告警联动）。 */
  private async finalizeVerifyFailed(
    tenantId: string,
    ctx: ArbitrationContext,
    effectiveValue: number,
    clamped: boolean,
    retriesWrite: number,
    opts: {
      auditReason: string;
      critical: boolean;
      mutate?: ((result: ExecutionResult) => ExecutionResult) | undefined;
    },
  ): Promise<void> {
    const won = await this.withinTenant(tenantId, (tx) =>
      finalizeProposal(tx, {
        tenantId,
        proposalId: ctx.proposal_id,
        pointId: ctx.point_id,
        phase: 'verify_failed',
        status: 'failed',
        reasonCode: 'proposal.verify_failed',
        outcome: 'verify_failed',
        audit: [
          {
            result: 'verify_failed',
            actor_type: 'algo',
            reason: opts.auditReason,
            old_value: ctx.previous_value,
            new_value: effectiveValue,
          },
        ],
        mutate: opts.mutate,
      }),
    );
    if (!won) return;
    this.metrics.recordControlExecution('verify_failed');
    this.metrics.recordDecision('verify_failed');
    if (opts.critical) {
      await this.openVerifyAlarm(
        tenantId,
        ctx,
        'critical',
        `控制验证失败（${ctx.raw_name}，原因 ${opts.auditReason}）——设备不跟随指令，熔断强信号`,
      );
    }
    await this.events.publishControlExecuted(
      this.eventOf(ctx, {
        outcome: 'verify_failed',
        reasonCode: 'proposal.verify_failed',
        valueEffective: effectiveValue,
        clamped,
        verify: { readings: [], retries_write: retriesWrite },
      }),
    );
  }

  /**
   * 预算兜底接管（§2/§3.7：非终态超 EXECUTION_BUDGET_S → dispatcher 已条件
   * UPDATE 置 reverting，此处按 §5 verify_failed 路径收敛——先尝试回写原值
   * 再终态化，绝不静默丢弃）。
   */
  async reclaim(tenantId: string, ctx: ArbitrationContext, effectiveValue: number): Promise<void> {
    await this.revertToBaseline(
      tenantId,
      ctx,
      effectiveValue,
      false,
      this.config.controlSafety.writeRetryMax,
      null,
      null,
      this.config.controlSafety.executionBudgetS,
    );
  }

  // -------------------------------------------------------------------
  // 传输段（§4）
  // -------------------------------------------------------------------

  /** 发布 write_cmd 并等待 ack（§4.4：超时不中止，返回 null 让回读仲裁）。 */
  private async writeAndWaitAck(
    ctx: ArbitrationContext,
    cmdId: string,
    value: number,
  ): Promise<ControlWriteAck | null> {
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
    if (ctx.gateway_client_id === null) {
      throw new ControlChannelUnavailableError(`点位 ${ctx.raw_name} 无采集网关，控制指令不可达`);
    }
    await this.channel.publishCommand(ctx.gateway_client_id, command);
    return (await this.awaitEvent(
      cmdId,
      this.config.controlSafety.ackTimeoutS * 1000,
    )) as ControlWriteAck | null;
  }

  /** 发布 read_cmd 并等待 read_result（§4.4：超时/quality≠good = 读失败计一次）。 */
  private async readOnce(
    tenantId: string,
    ctx: ArbitrationContext,
    expectValue: number,
    opts: { fromPhases: readonly string[] },
  ): Promise<{ match: boolean; reading: ReadingRecord } | null> {
    const cmdId = randomUUID();
    await this.withinTenant(tenantId, (tx) =>
      transitionPhase(tx, tenantId, ctx.proposal_id, opts.fromPhases, (result) =>
        appendCmd({ ...result, phase: 'awaiting_readback' }, { cmd_id: cmdId, kind: 'read' }),
      ),
    );
    if (ctx.gateway_client_id !== null) {
      const command: ControlWriteCommand = {
        msg_type: 'read_cmd',
        ver: 1,
        cmd_id: cmdId,
        point_ref: ctx.raw_name,
        issued_at: new Date().toISOString(),
        expires_in_s: CONTROL_CMD_EXPIRES_IN_S,
      };
      try {
        await this.channel.publishCommand(ctx.gateway_client_id, command);
      } catch (err: unknown) {
        this.logger.warn({
          msg: 'control_read_publish_failed',
          tenant_id: tenantId,
          point_id: ctx.point_id,
          err,
        });
        const reading: ReadingRecord = {
          at: new Date().toISOString(),
          value: null,
          quality: 'publish_failed',
          match: null,
        };
        await this.recordReading(tenantId, ctx.proposal_id, reading);
        return { match: false, reading };
      }
    }
    const event = (await this.awaitEvent(
      cmdId,
      this.config.controlSafety.readTimeoutS * 1000,
    )) as ControlReadResult | null;
    const reading: ReadingRecord =
      event === null
        ? { at: new Date().toISOString(), value: null, quality: 'timeout', match: null }
        : { at: event.ts ?? event.at, value: event.value, quality: event.quality, match: null };
    const match =
      event !== null &&
      event.value !== null &&
      Math.abs(event.value - expectValue) <= this.config.controlSafety.verifyTolerance;
    const withMatch = { ...reading, match };
    await this.recordReading(tenantId, ctx.proposal_id, withMatch);
    return { match, reading: withMatch };
  }

  /** 回读时间线渐进留痕（M5 §2.3 verify.readings 读投影数据面）。 */
  private async recordReading(
    tenantId: string,
    proposalId: string,
    reading: ReadingRecord,
  ): Promise<void> {
    await this.withinTenant(tenantId, (tx) =>
      transitionPhase(
        tx,
        tenantId,
        proposalId,
        ['awaiting_readback', 'retrying', 'reverting', 'awaiting_ack'],
        (result) => appendReading(result, reading),
      ),
    );
  }

  /** 等待 cmd_id 关联事件（超时 → null；等待器注销防泄漏）。 */
  private awaitEvent(cmdId: string, timeoutMs: number): Promise<ControlUpEvent | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(cmdId);
        resolve(null);
      }, timeoutMs);
      this.waiters.set(cmdId, { timer, resolve });
    });
  }

  // -------------------------------------------------------------------
  // 辅助面
  // -------------------------------------------------------------------

  /** §5.3 原值锚链兜底：执行前最新遥测（tsdb_api 只读，ADR-005；不可达降级 null）。 */
  private async latestTelemetryValue(pointId: number): Promise<number | null> {
    try {
      const sample = await this.telemetry.latest(pointId);
      if (sample === null) return null;
      return typeof sample.value === 'number' ? sample.value : Number(sample.value);
    } catch {
      return null;
    }
  }

  /** §5.4 失败告警联动（M4 直写通道：不新建告警类型）。 */
  private async openVerifyAlarm(
    tenantId: string,
    ctx: ArbitrationContext,
    severity: 'major' | 'critical',
    message: string,
  ): Promise<void> {
    try {
      await this.alarmEngine.open({
        tenantId,
        category: 'control_verify_failed',
        source_type: 'equipment',
        source_id: ctx.equipment_id ?? String(ctx.point_id),
        severity,
        message,
      });
    } catch (err: unknown) {
      this.logger.error({ msg: 'control_alarm_open_failed', tenant_id: tenantId, err });
    }
  }

  private eventOf(
    ctx: ArbitrationContext,
    core: {
      outcome: ControlExecutedEvent['outcome'];
      reasonCode: string | null;
      valueEffective: number;
      clamped: boolean;
      verify: ControlExecutedEvent['verify'];
    },
  ): ControlExecutedEvent {
    return buildExecutedEvent({
      tenantId: ctx.tenant_id,
      proposalId: ctx.proposal_id,
      pointId: ctx.point_id,
      equipmentId: ctx.equipment_id,
      systemId: ctx.system_id,
      algo: ctx.algo,
      algoVersion: ctx.algo_version,
      outcome: core.outcome,
      reasonCode: core.reasonCode,
      valueBefore: ctx.previous_value,
      valueCommanded: ctx.action_value,
      valueEffective: core.valueEffective,
      clamped: core.clamped,
      decidedBy: ctx.decided_by,
      verify: core.verify,
    });
  }

  private async withinTenant<T>(tenantId: string, fn: (tx: PoolClient) => Promise<T>): Promise<T> {
    if (this.tenantDb === null) throw new Error('control executor: DB 未接线');
    return this.tenantDb.withTenant(tenantId, fn);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
