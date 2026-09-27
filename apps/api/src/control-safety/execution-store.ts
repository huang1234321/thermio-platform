/**
 * 执行链状态存取件（control-safety.md §2/§8/§10，IMPL-18 / DAT-164）。
 *
 * - execution_result jsonb 是执行器内部状态的唯一载体（phase/gates/verify/cmds）；
 *   一切迁移走条件 UPDATE 单赢家（§4.5）——多副本/重入天然幂等；
 * - 终态化与 control_audit 行同事务（§8 双轨纪律：业务 UPDATE 与审计同事务）；
 * - Kafka thermio.control.executed 事件在每个终态发布（§10：outcome 四值）。
 */
import type { PoolClient } from 'pg';
import type {
  ControlExecutedEvent,
  ControlExecutedOutcome,
  GateLabel,
} from '@thermio/shared-types';
import { GATE_CAUSE_LABELS } from '@thermio/shared-types';
import type { GateOutcome } from './arbitration.service.js';

/** execution_result jsonb 形状（渐进合并；M5 §2.3 读投影宽松消费）。 */
export interface ExecutionResult {
  phase: string;
  gates?: GateOutcome[];
  clamped?: boolean;
  effective_value?: number;
  queued_at?: string;
  verify?: {
    readings: Array<{
      at: string | null;
      value: number | null;
      quality?: string | null;
      match: boolean | null;
    }>;
    retries_write: number;
  };
  cmds?: Array<{
    cmd_id: string;
    kind: 'write' | 'read' | 'revert';
    at: string;
    ack: string | null;
  }>;
  reason_code?: string | null;
  outcome?: ControlExecutedOutcome | null;
  [key: string]: unknown;
}

/** 终态化入参：status ∈ executed|failed；audit 行按 §8 矩阵由调用方给定。 */
export interface FinalizeAuditRow {
  readonly result: 'ok' | 'verify_failed' | 'reverted' | 'rejected';
  readonly actor_type: 'algo' | 'human' | 'system';
  readonly reason: string | null;
  readonly old_value: number | null;
  readonly new_value: number | null;
}

/** 条件阶段迁移：单赢家（WHERE phase = expected；返回是否赢家）。 */
export async function transitionPhase(
  tx: PoolClient,
  tenantId: string,
  proposalId: string,
  expected: readonly string[],
  mutate: (result: ExecutionResult) => ExecutionResult,
): Promise<boolean> {
  // 读-改-写必须在行锁下完成：SELECT ... FOR UPDATE 保证并发迁移串行化
  const locked = await tx.query<{ execution_result: unknown }>(
    `SELECT execution_result FROM proposal
     WHERE tenant_id = $1 AND id = $2 AND status = 'approved'
       AND execution_result->>'phase' = ANY($3::text[])
     FOR UPDATE`,
    [tenantId, proposalId, [...expected]],
  );
  const row = locked.rows[0];
  if (row === undefined) return false;
  const current = (row.execution_result ?? {}) as ExecutionResult;
  const next = mutate(current);
  await tx.query(
    `UPDATE proposal SET execution_result = $3
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, proposalId, JSON.stringify(next)],
  );
  return true;
}

/** 非条件合并（初始化入队等幂等场景：status 仍为 approved 才写）。 */
export async function mergeResult(
  tx: PoolClient,
  tenantId: string,
  proposalId: string,
  mutate: (result: ExecutionResult) => ExecutionResult,
): Promise<void> {
  const loaded = await tx.query<{ execution_result: unknown }>(
    `SELECT execution_result FROM proposal
     WHERE tenant_id = $1 AND id = $2 AND status = 'approved' FOR UPDATE`,
    [tenantId, proposalId],
  );
  const row = loaded.rows[0];
  if (row === undefined) return;
  const current = (row.execution_result ?? {}) as ExecutionResult;
  await tx.query(`UPDATE proposal SET execution_result = $3 WHERE tenant_id = $1 AND id = $2`, [
    tenantId,
    proposalId,
    JSON.stringify(mutate(current)),
  ]);
}

/** 追加 cmd 行（§4.2：execution_result.cmds 留全链）。 */
export function appendCmd(
  result: ExecutionResult,
  cmd: { cmd_id: string; kind: 'write' | 'read' | 'revert'; ack?: string | null },
): ExecutionResult {
  const cmds = [...(result.cmds ?? [])];
  cmds.push({
    cmd_id: cmd.cmd_id,
    kind: cmd.kind,
    at: new Date().toISOString(),
    ack: cmd.ack ?? null,
  });
  return { ...result, cmds };
}

export function appendReading(
  result: ExecutionResult,
  reading: {
    at: string | null;
    value: number | null;
    quality?: string | null;
    match: boolean | null;
  },
): ExecutionResult {
  const verify = result.verify ?? { readings: [], retries_write: 0 };
  return {
    ...result,
    verify: { ...verify, readings: [...verify.readings, reading] },
  };
}

/**
 * 终态化（§2：executed/rejected/verify_failed/reverted）：
 * proposal.status + execution_result + control_audit 同事务；返回是否赢家
 * （并发他方已终态化则 false，调用方不再发 Kafka/告警）。
 */
export async function finalizeProposal(
  tx: PoolClient,
  params: {
    tenantId: string;
    proposalId: string;
    pointId: number;
    phase: 'executed' | 'rejected' | 'verify_failed' | 'reverted';
    status: 'executed' | 'failed';
    reasonCode: string | null;
    outcome: ControlExecutedOutcome;
    audit: readonly FinalizeAuditRow[];
    mutate?: ((result: ExecutionResult) => ExecutionResult) | undefined;
  },
): Promise<boolean> {
  const locked = await tx.query<{ execution_result: unknown }>(
    `SELECT execution_result FROM proposal
     WHERE tenant_id = $1 AND id = $2 AND status = 'approved' FOR UPDATE`,
    [params.tenantId, params.proposalId],
  );
  const row = locked.rows[0];
  if (row === undefined) return false;
  let result = (row.execution_result ?? {}) as ExecutionResult;
  if (params.mutate !== undefined) result = params.mutate(result);
  result = {
    ...result,
    phase: params.phase,
    reason_code: params.reasonCode,
    outcome: params.outcome,
  };
  await tx.query(
    `UPDATE proposal SET status = $3, executed_at = now(), execution_result = $4
     WHERE tenant_id = $1 AND id = $2`,
    [params.tenantId, params.proposalId, params.status, JSON.stringify(result)],
  );
  for (const audit of params.audit) {
    await tx.query(
      `INSERT INTO control_audit
         (tenant_id, point_id, proposal_id, old_value, new_value, actor_type, actor_ref, result, reason)
       VALUES ($1, $2, $3, $4, $5, $6, 'control-safety', $7, $8)`,
      [
        params.tenantId,
        params.pointId,
        params.proposalId,
        audit.old_value,
        audit.new_value,
        audit.actor_type,
        audit.result,
        audit.reason,
      ],
    );
  }
  return true;
}

/** §10 Kafka 事件组装（调用方补齐数值链与 verify）。 */
export function buildExecutedEvent(params: {
  tenantId: string;
  proposalId: string;
  pointId: number;
  equipmentId: string | null;
  systemId: string | null;
  algo: string;
  algoVersion: string;
  outcome: ControlExecutedOutcome;
  reasonCode: string | null;
  valueBefore: number | null;
  valueCommanded: number | null;
  valueEffective: number | null;
  clamped: boolean;
  decidedBy: string | null;
  verify: ControlExecutedEvent['verify'];
}): ControlExecutedEvent {
  return {
    proposal_id: params.proposalId,
    tenant_id: params.tenantId,
    trace_id: `ctl-${params.proposalId}`,
    point_id: params.pointId,
    equipment_id: params.equipmentId ?? '00000000-0000-7000-8000-000000000000',
    system_id: params.systemId,
    algo: params.algo,
    algo_version: params.algoVersion,
    outcome: params.outcome,
    reason_code: params.reasonCode,
    value_before: params.valueBefore,
    value_commanded: params.valueCommanded,
    value_effective: params.valueEffective,
    clamped: params.clamped,
    decided_by: params.decidedBy,
    actor_type: 'algo',
    verify: params.verify,
    at: new Date().toISOString(),
  };
}

/** 闸门 reason_code → 指标 label（§3.6 同源；metrics.recordGate 入参）。 */
export function gateLabelOfReasonCode(reasonCode: string): GateLabel {
  const cause = reasonCode.replace(/^proposal\./, '') as keyof typeof GATE_CAUSE_LABELS;
  const labels = GATE_CAUSE_LABELS as Readonly<Record<string, GateLabel>>;
  return labels[cause] ?? 'conflict';
}
