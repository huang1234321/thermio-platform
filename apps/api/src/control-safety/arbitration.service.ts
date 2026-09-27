/**
 * 五道闸门顺序求值器（control-safety.md §3，IMPL-18 / DAT-164）。
 *
 * 顺序逐字按 ADR-009 编号 1→5（flows.md §2「顺序执行」）：
 *   1 受控白名单 → 2 值域 clamp → 3 频率限制 → 4 冲突检测（排队/合并）→ 5 全局熔断
 *
 * 求值时机两阶段（§3.0）——T1 受理快查（approve 后：闸门 1/2/5 静态参数快速失败）
 * 与 T2 出队复评（全部五道重评，以 T2 结果为准）。本服务只做求值与行加载，
 * 终态化/审计/Kafka 由 dispatcher/executor 承担。
 */
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import { APP_CONFIG } from '../infrastructure/core.module.js';
import { LOGGER } from '../infrastructure/logger.js';

/** 闸门逐道结果行（execution_result.gates 的元素，M5 §2.3 读投影同形）。 */
export interface GateOutcome {
  readonly gate: number;
  readonly name: 'whitelist' | 'clamp' | 'rate' | 'conflict' | 'fuse';
  readonly outcome:
    | 'pass'
    | 'clamped'
    | 'queued'
    | 'denied'
    | 'overflow'
    | 'timeout'
    | 'superseded'
    | 'unevaluated';
  readonly detail: Record<string, unknown> | null;
}

/** 求值上下文行：proposal + point + 网关 + 系统链（一次联查，ddl.md §4 复合 FK 链）。 */
export interface ArbitrationContext {
  readonly proposal_id: string;
  readonly tenant_id: string;
  readonly point_id: number;
  readonly equipment_id: string | null;
  readonly system_id: string | null;
  readonly building_id: string;
  readonly algo: string;
  readonly algo_version: string;
  readonly decided_by: string | null;
  readonly action_value: number;
  readonly previous_value: number | null;
  readonly expires_at: Date | null;
  readonly is_controllable: boolean;
  readonly point_status: string;
  readonly direction: string;
  readonly clamp_min: number | null;
  readonly clamp_max: number | null;
  readonly write_rate_limit_per_hour: number | null;
  readonly raw_name: string;
  readonly unit_std: string | null;
  readonly gateway_client_id: string | null;
}

/** T2 求值裁决：通过（clamp 后值生效）或拒绝（闸门码 + 逐道结果）。 */
export type ArbitrationVerdict =
  | {
      readonly kind: 'pass';
      readonly effective_value: number;
      readonly clamped: boolean;
      readonly clamp_detail: { from: number; to: number } | null;
      readonly gates: readonly GateOutcome[];
    }
  | {
      readonly kind: 'reject';
      readonly reason_code:
        | 'proposal.gate_whitelist_denied'
        | 'proposal.gate_rate_limited'
        | 'proposal.gate_conflict_overflow'
        | 'proposal.gate_conflict_timeout'
        | 'proposal.gate_system_fused';
      readonly gates: readonly GateOutcome[];
    }
  | {
      /** 闸门 4 排队（非失败，flows.md §2）：不产生拒绝码，dispatcher 入队等待。 */
      readonly kind: 'queue';
      readonly gates: readonly GateOutcome[];
    };

interface ContextRow {
  proposal_id: string;
  tenant_id: string;
  point_id: string;
  equipment_id: string | null;
  system_id: string | null;
  building_id: string;
  algo: string;
  algo_version: string;
  decided_by: string | null;
  action: unknown;
  previous_value: string | null;
  expires_at: Date | null;
  is_controllable: boolean;
  point_status: string;
  direction: string;
  clamp_min: string | null;
  clamp_max: string | null;
  write_rate_limit_per_hour: number | null;
  raw_name: string;
  unit_std: string | null;
  mqtt_client_id: string | null;
}

function num(value: string | number | null): number | null {
  if (value === null) return null;
  return typeof value === 'number' ? value : Number(value);
}

@Injectable()
export class ArbitrationService {
  private readonly logger: Logger;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) rootLogger: Logger,
  ) {
    this.logger = rootLogger.child({ component: 'control-arbitration' });
  }

  /** 加载求值上下文（proposal→point→equipment→system→gateway 联查）。 */
  async loadContext(
    tx: PoolClient,
    tenantId: string,
    proposalId: string,
  ): Promise<ArbitrationContext | null> {
    const result = await tx.query<ContextRow>(
      `SELECT p.id AS proposal_id, p.tenant_id, p.point_id, p.equipment_id,
              e.system_id, pt.building_id, p.algo, p.algo_version, p.decided_by,
              p.action, p.previous_value, p.expires_at,
              pt.is_controllable, pt.status AS point_status, pt.direction,
              pt.clamp_min, pt.clamp_max, pt.write_rate_limit_per_hour,
              pt.raw_name, pt.unit_std, gw.mqtt_client_id
       FROM proposal p
       JOIN point pt ON pt.tenant_id = p.tenant_id AND pt.id = p.point_id
       LEFT JOIN equipment e ON e.tenant_id = pt.tenant_id AND e.id = pt.equipment_id
       LEFT JOIN gateway gw ON gw.tenant_id = pt.tenant_id AND gw.id = pt.gateway_id
       WHERE p.tenant_id = $1 AND p.id = $2`,
      [tenantId, proposalId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const actionValue = (row.action as { value?: unknown } | null)?.value;
    return {
      proposal_id: row.proposal_id,
      tenant_id: row.tenant_id,
      point_id: Number(row.point_id),
      equipment_id: row.equipment_id,
      system_id: row.system_id,
      building_id: row.building_id,
      algo: row.algo,
      algo_version: row.algo_version,
      decided_by: row.decided_by,
      action_value: typeof actionValue === 'number' ? actionValue : Number.NaN,
      previous_value: num(row.previous_value),
      expires_at: row.expires_at,
      is_controllable: row.is_controllable,
      point_status: row.point_status,
      direction: row.direction,
      clamp_min: num(row.clamp_min),
      clamp_max: num(row.clamp_max),
      write_rate_limit_per_hour: row.write_rate_limit_per_hour,
      raw_name: row.raw_name,
      unit_std: row.unit_std,
      gateway_client_id: row.mqtt_client_id,
    };
  }

  /**
   * T1 受理快查（§3.0）：闸门 1/2/5——静态参数 + 系统熔断态。
   * 返回 null 表示受理通过（不占队列拒绝），gate1/5 硬拒绝返回 reject 裁决；
   * clamp 结果（effective_value）随 pass 带出供入队记录。
   */
  async t1QuickCheck(tx: PoolClient, ctx: ArbitrationContext): Promise<ArbitrationVerdict | null> {
    const gates: GateOutcome[] = [];
    // ── 闸门 1：受控白名单（§3.1）──
    const whitelistPass =
      ctx.is_controllable &&
      ctx.point_status === 'active' &&
      (ctx.direction === 'write' || ctx.direction === 'readwrite');
    gates.push({
      gate: 1,
      name: 'whitelist',
      outcome: whitelistPass ? 'pass' : 'denied',
      detail: whitelistPass
        ? null
        : {
            is_controllable: ctx.is_controllable,
            point_status: ctx.point_status,
            direction: ctx.direction,
          },
    });
    if (!whitelistPass) {
      return { kind: 'reject', reason_code: 'proposal.gate_whitelist_denied', gates };
    }
    // ── 闸门 2：值域 clamp（§3.2 调整不拒绝）──
    const { effective, clamped, detail } = clampOf(ctx.action_value, ctx.clamp_min, ctx.clamp_max);
    gates.push({ gate: 2, name: 'clamp', outcome: clamped ? 'clamped' : 'pass', detail });
    // ── 闸门 5：全局熔断（§3.5 只读 control_fuse）──
    const fuseOpen =
      ctx.system_id !== null && (await this.isFuseOpen(tx, ctx.tenant_id, ctx.system_id));
    gates.push({
      gate: 5,
      name: 'fuse',
      outcome: fuseOpen ? 'denied' : 'pass',
      detail: fuseOpen ? { status: 'open', system_id: ctx.system_id } : null,
    });
    if (fuseOpen) {
      return { kind: 'reject', reason_code: 'proposal.gate_system_fused', gates };
    }
    // T1 通过：clamp 结果一并返回（入队时记 execution_result，M5 详情展示）
    return { kind: 'pass', effective_value: effective, clamped, clamp_detail: detail, gates };
  }

  /**
   * T2 出队复评（§3.0）：全部五道重评（排队期间窗口/熔断/参数可能已变），以 T2 为准。
   * 闸门 4 判定「同设备存在非终态执行」——由调用方在队列语义下先行（dispatcher），
   * 本方法聚焦判定本身：active 存在 → queue（等待轮到）；本提案即队首 → 后续闸门。
   */
  async t2FullReeval(
    tx: PoolClient,
    ctx: ArbitrationContext,
    options: { readonly selfIsHead: boolean },
  ): Promise<ArbitrationVerdict> {
    const gates: GateOutcome[] = [];
    // ── 闸门 1 ──
    const whitelistPass =
      ctx.is_controllable &&
      ctx.point_status === 'active' &&
      (ctx.direction === 'write' || ctx.direction === 'readwrite');
    gates.push({
      gate: 1,
      name: 'whitelist',
      outcome: whitelistPass ? 'pass' : 'denied',
      detail: whitelistPass
        ? null
        : {
            is_controllable: ctx.is_controllable,
            point_status: ctx.point_status,
            direction: ctx.direction,
          },
    });
    if (!whitelistPass)
      return { kind: 'reject', reason_code: 'proposal.gate_whitelist_denied', gates };
    // ── 闸门 2 ──
    const { effective, clamped, detail } = clampOf(ctx.action_value, ctx.clamp_min, ctx.clamp_max);
    gates.push({ gate: 2, name: 'clamp', outcome: clamped ? 'clamped' : 'pass', detail });
    // ── 闸门 3：频率（§3.3 滑动 60min 真实触达计数）──
    const limit = ctx.write_rate_limit_per_hour ?? this.config.controlSafety.rateLimitDefault;
    const usedResult = await tx.query<{ used: string }>(
      `SELECT count(*) AS used FROM control_audit
       WHERE tenant_id = $1 AND point_id = $2 AND result IN ('ok', 'reverted')
         AND at > now() - interval '60 minutes'`,
      [ctx.tenant_id, ctx.point_id],
    );
    const used = Number(usedResult.rows[0]?.used ?? '0');
    const ratePass = used < limit;
    gates.push({
      gate: 3,
      name: 'rate',
      outcome: ratePass ? 'pass' : 'denied',
      detail: { used, limit, window_s: 3600 },
    });
    if (!ratePass) return { kind: 'reject', reason_code: 'proposal.gate_rate_limited', gates };
    // ── 闸门 4：冲突（§3.4——selfIsHead=真时表示轮到本提案执行，闸门 4 放行）──
    if (!options.selfIsHead) {
      gates.push({ gate: 4, name: 'conflict', outcome: 'queued', detail: null });
      return { kind: 'queue', gates };
    }
    gates.push({ gate: 4, name: 'conflict', outcome: 'pass', detail: null });
    // ── 闸门 5 ──
    const fuseOpen =
      ctx.system_id !== null && (await this.isFuseOpen(tx, ctx.tenant_id, ctx.system_id));
    gates.push({
      gate: 5,
      name: 'fuse',
      outcome: fuseOpen ? 'denied' : 'pass',
      detail: fuseOpen ? { status: 'open', system_id: ctx.system_id } : null,
    });
    if (fuseOpen) return { kind: 'reject', reason_code: 'proposal.gate_system_fused', gates };
    return { kind: 'pass', effective_value: effective, clamped, clamp_detail: detail, gates };
  }

  /** 闸门 5 只读判定（§3.5：缺行 = closed）。 */
  async isFuseOpen(tx: PoolClient, tenantId: string, systemId: string): Promise<boolean> {
    const fuse = await tx.query<{ status: string }>(
      `SELECT status FROM control_fuse WHERE tenant_id = $1 AND system_id = $2`,
      [tenantId, systemId],
    );
    return fuse.rows[0]?.status === 'open';
  }
}

/** 闸门 2 clamp（§3.2：空侧不夹；调整不拒绝）。导出供执行器回写原值复用。 */
export function clampOf(
  value: number,
  clampMin: number | null,
  clampMax: number | null,
): { effective: number; clamped: boolean; detail: { from: number; to: number } | null } {
  const clampedLow = clampMin !== null && value < clampMin;
  const clampedHigh = clampMax !== null && value > clampMax;
  if (!clampedLow && !clampedHigh) {
    return { effective: value, clamped: false, detail: null };
  }
  const effective = clampedLow ? clampMin : clampMax;
  return {
    effective: effective as number,
    clamped: true,
    detail: { from: value, to: effective as number },
  };
}
