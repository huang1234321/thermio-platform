/**
 * 建议审批服务（modules M5-proposal.md §3/§4，IMPL-17 / DAT-163）。
 *
 * 纪律落点：
 * - 读写全部经 TenantDb.withTenant（ddl.md §5.2）；load-for-user 归属校验先行，
 *   越权/不存在同响应 404 proposal.not_found（SEC-AZ-02/03）；
 * - 状态机（§4.2）：approve 条件 UPDATE 单赢家（并发双击防竞态）；重复决策 409
 *   proposal.state_invalid（details.current_status）；过期仍 pending 409
 *   proposal.expired（不沉降——sweeper 60s 收敛）；reject 零 control_audit 写入
 *   （flows §2 审计双轨：未触设备）；
 * - R1 过渡态（M5 §9）：approve comment / reject reason 入结构化日志 + 响应回显，
 *   不持久化（decided_reason 落列前）——响应显式 comment_persisted=false；
 * - 列表（§3.1）：过滤白名单 + 楼宇 scope 谓词 + keyset created_at DESC；
 * - execution（§2.3/§3.6）：execution_result 宽松解析读投影（API-CT-01/03），
 *   未知字段忽略、缺省兜底，不回写。
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type {
  ControlAuditListQuery,
  ControlAuditListResponse,
  ControlAuditRow,
  ExecutionDetailView,
  ProposalApproveResponse,
  ProposalCounts,
  ProposalDetail,
  ProposalListQuery,
  ProposalListResponse,
  ProposalRejectResponse,
} from '@thermio/shared-types';
import { PROPOSAL_STATUSES } from '@thermio/shared-types';
import { TENANT_DB } from '../infrastructure/db/db.tokens.js';
import type { TenantDb } from '../infrastructure/db/tenant-db.js';
import { LOGGER } from '../infrastructure/logger.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import {
  loadBuildingScope,
  requireRow,
  type AssetActor,
  type BuildingScope,
} from '../asset/asset-shared.js';
import { decodeProposalCursor, encodeProposalCursor } from './proposal-cursor.js';
import {
  PROPOSAL_SELECT_COLUMNS,
  epochMicros,
  loadProposalForUser,
  proposalCardOf,
  type ProposalJoinedRow,
} from './proposal-shared.js';
import { buildPrecheck } from './precheck.js';
import { ControlDispatcherService } from '../control-safety/dispatcher.service.js';

@Injectable()
export class ProposalsService {
  private readonly logger: Logger;

  constructor(
    @Inject(TENANT_DB) private readonly tenantDb: TenantDb | null,
    @Inject(LOGGER) rootLogger: Logger,
    @Inject(ControlDispatcherService) private readonly dispatcher: ControlDispatcherService | null,
  ) {
    this.logger = rootLogger.child({ component: 'proposal-approvals' });
  }

  // -------------------------------------------------------------------
  // GET /proposals（§3.1：Tabs 多值 status + 过滤白名单 + scope 谓词）
  // -------------------------------------------------------------------
  async list(actor: AssetActor, query: ProposalListQuery): Promise<ProposalListResponse> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const scope = await loadBuildingScope(tx, actor);
      await this.validateListFilters(tx, actor.tenant_id, query, scope);

      const where: string[] = ['p.tenant_id = $1'];
      const params: unknown[] = [actor.tenant_id];
      let next = 2;
      const push = (sql: string, ...values: unknown[]): void => {
        where.push(sql);
        params.push(...values);
      };

      if (query.status !== undefined) {
        const values = query.status.split(',').map((part) => part.trim());
        push(`p.status = ANY($${String(next)}::text[])`, values);
        next += 1;
      }
      if (query.building_id !== undefined) {
        push(`pt.building_id = $${String(next)}::uuid`, query.building_id);
        next += 1;
      }
      if (query.equipment_id !== undefined) {
        push(`p.equipment_id = $${String(next)}::uuid`, query.equipment_id);
        next += 1;
      }
      if (query.point_id !== undefined) {
        push(`p.point_id = $${String(next)}::bigint`, query.point_id);
        next += 1;
      }
      if (query.algo !== undefined) {
        push(`p.algo = $${String(next)}::text`, query.algo);
        next += 1;
      }
      if (query.algo_version !== undefined) {
        push(`p.algo_version = $${String(next)}::text`, query.algo_version);
        next += 1;
      }
      if (query.decided_by !== undefined) {
        push(`p.decided_by = $${String(next)}::uuid`, query.decided_by);
        next += 1;
      }
      if (query.from !== undefined) {
        push(`p.created_at >= $${String(next)}::timestamptz`, query.from);
        next += 1;
      }
      if (query.to !== undefined) {
        push(`p.created_at < $${String(next)}::timestamptz`, query.to);
        next += 1;
      }
      if (scope !== null) {
        push(`pt.building_id = ANY($${String(next)}::uuid[])`, [...scope]);
        next += 1;
      }
      if (query.cursor !== undefined) {
        const cursor = decodeProposalCursor(query.cursor, 1);
        // keyset：created_at µs DESC, id（uuid 文本序）DESC
        where.push(
          `((extract(epoch from p.created_at) * 1000000)::bigint, p.id::text) < ($${String(next)}::bigint, $${String(next + 1)}::text)`,
        );
        const cursorTime = cursor.k[0];
        if (cursorTime === undefined) throw invalidCursorError();
        params.push(cursorTime, cursor.id);
        next += 2;
      }

      const limit = query.limit;
      const result = await tx.query<ProposalJoinedRow>(
        `SELECT ${PROPOSAL_SELECT_COLUMNS}
         FROM proposal p
         JOIN point pt ON pt.tenant_id = p.tenant_id AND pt.id = p.point_id
         LEFT JOIN app_user du ON du.tenant_id = p.tenant_id AND du.id = p.decided_by
         WHERE ${where.join(' AND ')}
         ORDER BY p.created_at DESC, p.id DESC
         LIMIT ${String(limit + 1)}`,
        params,
      );
      const rows = result.rows;
      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map(proposalCardOf);
      const last = hasMore ? rows[limit - 1] : undefined;
      return {
        items,
        next_cursor:
          hasMore && last !== undefined
            ? encodeProposalCursor({ k: [epochMicros(last.created_at)], id: last.id })
            : null,
      };
    });
  }

  /** 过滤入参所指向资源的存在/归属校验（§8.1：不存在与越权同 404）。 */
  private async validateListFilters(
    tx: Parameters<Parameters<TenantDb['withTenant']>[1]>[0],
    tenantId: string,
    query: ProposalListQuery,
    scope: BuildingScope,
  ): Promise<void> {
    if (query.building_id !== undefined) {
      const building = await tx.query<{ id: string }>(
        `SELECT id FROM building WHERE tenant_id = $1 AND id = $2`,
        [tenantId, query.building_id],
      );
      if (building.rows.length === 0 || (scope !== null && !scope.has(query.building_id))) {
        throw new ReasonCodeException('asset.not_found', '资源不存在', { entity: 'building' });
      }
    }
    if (query.equipment_id !== undefined) {
      const equipment = await tx.query<{ id: string }>(
        `SELECT e.id FROM equipment e
         JOIN hvac_system s ON s.tenant_id = e.tenant_id AND s.id = e.system_id
         WHERE e.tenant_id = $1 AND e.id = $2
           AND ($3::uuid[] IS NULL OR s.building_id = ANY($3::uuid[]))`,
        [tenantId, query.equipment_id, scope === null ? null : [...scope]],
      );
      if (equipment.rows.length === 0) {
        throw new ReasonCodeException('asset.not_found', '资源不存在', { entity: 'equipment' });
      }
    }
    if (query.point_id !== undefined) {
      const point = await tx.query<{ id: string }>(
        `SELECT pt.id FROM point pt
         WHERE pt.tenant_id = $1 AND pt.id = $2
           AND ($3::uuid[] IS NULL OR pt.building_id = ANY($3::uuid[]))`,
        [tenantId, query.point_id, scope === null ? null : [...scope]],
      );
      if (point.rows.length === 0) {
        throw new ReasonCodeException('asset.not_found', '资源不存在', { entity: 'point' });
      }
    }
    if (query.decided_by !== undefined) {
      const user = await tx.query<{ id: string }>(
        `SELECT id FROM app_user WHERE tenant_id = $1 AND id = $2`,
        [tenantId, query.decided_by],
      );
      if (user.rows.length === 0) {
        throw new ReasonCodeException('user.not_found', '资源不存在', { entity: 'user' });
      }
    }
  }

  // -------------------------------------------------------------------
  // GET /proposals/counts（§3.2：Tabs 角标，六键全给）
  // -------------------------------------------------------------------
  async counts(actor: AssetActor, buildingId?: string): Promise<ProposalCounts> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const scope = await loadBuildingScope(tx, actor);
      const where: string[] = ['p.tenant_id = $1'];
      const params: unknown[] = [actor.tenant_id];
      if (buildingId !== undefined) {
        if (scope !== null && !scope.has(buildingId)) {
          throw new ReasonCodeException('asset.not_found', '资源不存在', { entity: 'building' });
        }
        const building = await tx.query<{ id: string }>(
          `SELECT id FROM building WHERE tenant_id = $1 AND id = $2`,
          [actor.tenant_id, buildingId],
        );
        if (building.rows.length === 0) {
          throw new ReasonCodeException('asset.not_found', '资源不存在', { entity: 'building' });
        }
        where.push(`pt.building_id = $2::uuid`);
        params.push(buildingId);
      } else if (scope !== null) {
        where.push(`pt.building_id = ANY($2::uuid[])`);
        params.push([...scope]);
      }
      const result = await tx.query<{ status: string; count: string }>(
        `SELECT p.status, count(*) AS count FROM proposal p
         JOIN point pt ON pt.tenant_id = p.tenant_id AND pt.id = p.point_id
         WHERE ${where.join(' AND ')} GROUP BY p.status`,
        params,
      );
      const byStatus = new Map(result.rows.map((row) => [row.status, Number(row.count)]));
      return Object.fromEntries(
        PROPOSAL_STATUSES.map((status) => [status, byStatus.get(status) ?? 0]),
      ) as ProposalCounts;
    });
  }

  // -------------------------------------------------------------------
  // GET /proposals/{id}（§3.3：详情 + precheck 快照；仅 pending 非 null）
  // -------------------------------------------------------------------
  async detail(actor: AssetActor, proposalId: string): Promise<ProposalDetail> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const scope = await loadBuildingScope(tx, actor);
      const row = await loadProposalForUser(tx, actor.tenant_id, proposalId, scope);
      const card = proposalCardOf(row);
      const precheck =
        row.status === 'pending'
          ? await buildPrecheck(tx, card.point_id, numberOrNull(card.action.value))
          : null;
      return {
        ...card,
        rationale: row.rationale,
        evidence: (row.evidence ?? null) as ProposalDetail['evidence'],
        precheck,
      };
    });
  }

  // -------------------------------------------------------------------
  // POST /proposals/{id}/approve（§3.4：202 + 条件 UPDATE 单赢家）
  // -------------------------------------------------------------------
  async approve(
    actor: AssetActor,
    proposalId: string,
    comment: string | undefined,
  ): Promise<ProposalApproveResponse> {
    const result = await this.decide(actor, proposalId, 'approve');
    // IMPL-18 接通：approve 落库后即时 kick 仲裁链（T1 受理快查 + 入队 + 派发
    // 尝试；10s 扫描兜底）。fire-and-forget——202 语义不变，仲裁异步推进。
    if (result.status === 'approved' && this.dispatcher !== null) {
      void this.dispatcher.onApproved(actor.tenant_id, proposalId);
    }
    // R1 过渡态：comment 仅入结构化日志（decided_reason 落列前不持久化）
    if (comment !== undefined && comment.length > 0) {
      this.logger.info({
        msg: 'proposal_approve_comment',
        proposal_id: proposalId,
        tenant_id: actor.tenant_id,
        decided_by: actor.user_id,
        comment,
        persisted: false,
      });
    }
    return { ...result, comment_persisted: false };
  }

  // -------------------------------------------------------------------
  // POST /proposals/{id}/reject（§3.5：200 终态；reason 必填；零 control_audit）
  // -------------------------------------------------------------------
  async reject(
    actor: AssetActor,
    proposalId: string,
    reason: string,
  ): Promise<ProposalRejectResponse> {
    const result = await this.decide(actor, proposalId, 'reject');
    // R1 过渡态：reason 入结构化日志 + 响应回显，不持久化（M5 §9-R1 验收影响面）
    this.logger.info({
      msg: 'proposal_reject_reason',
      proposal_id: proposalId,
      tenant_id: actor.tenant_id,
      decided_by: actor.user_id,
      reason,
      persisted: false,
    });
    return { ...result, reason };
  }

  /** 决策公共面：404 → 409 state_invalid / expired（条件 UPDATE 单赢家，§4.2）。 */
  private async decide(
    actor: AssetActor,
    proposalId: string,
    kind: 'approve' | 'reject',
  ): Promise<{
    id: string;
    status: 'approved' | 'rejected';
    decided_by: string;
    decided_at: string;
  }> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const scope = await loadBuildingScope(tx, actor);
      await loadProposalForUser(tx, actor.tenant_id, proposalId, scope);
      const status = kind === 'approve' ? 'approved' : 'rejected';

      // 条件 UPDATE：status=pending 且未过期 → 单赢家；过期分支不沉降（sweeper 收敛）
      const updated = await tx.query<{ decided_at: Date }>(
        `UPDATE proposal SET status = $3, decided_by = $4, decided_at = now()
         WHERE tenant_id = $1 AND id = $2
           AND status = 'pending'
           AND (expires_at IS NULL OR expires_at > now())
         RETURNING decided_at`,
        [actor.tenant_id, proposalId, status, actor.user_id],
      );
      if (updated.rows.length > 0) {
        return {
          id: proposalId,
          status,
          decided_by: actor.user_id,
          decided_at: requireRow(updated.rows, 'proposal decide').decided_at.toISOString(),
        };
      }
      // 零行分类（§4.2 判定顺序）：先 status 后 expires
      const current = await loadProposalForUser(tx, actor.tenant_id, proposalId, scope);
      if (current.status !== 'pending') {
        throw new ReasonCodeException('proposal.state_invalid', '建议已决策', {
          current_status: current.status,
        });
      }
      throw new ReasonCodeException('proposal.expired', '建议已过期');
    });
  }

  // -------------------------------------------------------------------
  // GET /proposals/{id}/execution（§3.6：读投影 + 内联审计链 at ASC）
  // -------------------------------------------------------------------
  async execution(actor: AssetActor, proposalId: string): Promise<ExecutionDetailView> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const scope = await loadBuildingScope(tx, actor);
      const row = await loadProposalForUser(tx, actor.tenant_id, proposalId, scope);
      const auditRows = await tx.query<ControlAuditRowDb>(
        `SELECT ca.id, ca.point_id, ca.proposal_id, ca.old_value, ca.new_value,
                ca.actor_type, ca.actor_ref, ca.result, ca.reason, ca.at,
                pt.raw_name AS point_raw_name, pt.display_name AS point_display_name,
                pt.unit_std AS point_unit_std
         FROM control_audit ca
         JOIN point pt ON pt.tenant_id = ca.tenant_id AND pt.id = ca.point_id
         WHERE ca.tenant_id = $1 AND ca.proposal_id = $2
         ORDER BY ca.at ASC, ca.id ASC`,
        [actor.tenant_id, proposalId],
      );
      // §3.6：读投影 + 审计链内联（at ASC）——执行详情一屏闭环，免二次请求
      const audit = auditRows.rows.map(auditRowOf);
      return { ...executionViewOf(row, audit), audit }; // §3.6 内联审计链
    });
  }

  // -------------------------------------------------------------------
  // GET /control-audit（§3.7：只读检索，at DESC keyset）
  // -------------------------------------------------------------------
  async controlAudit(
    actor: AssetActor,
    query: ControlAuditListQuery,
  ): Promise<ControlAuditListResponse> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const scope = await loadBuildingScope(tx, actor);
      const where: string[] = ['ca.tenant_id = $1'];
      const params: unknown[] = [actor.tenant_id];
      let next = 2;
      if (query.point_id !== undefined) {
        const point = await tx.query<{ id: string }>(
          `SELECT id FROM point WHERE tenant_id = $1 AND id = $2`,
          [actor.tenant_id, query.point_id],
        );
        if (point.rows.length === 0) {
          throw new ReasonCodeException('asset.not_found', '资源不存在', { entity: 'point' });
        }
        where.push(`ca.point_id = $${String(next)}::bigint`);
        params.push(query.point_id);
        next += 1;
      }
      if (query.proposal_id !== undefined) {
        const proposal = await tx.query<{ id: string }>(
          `SELECT id FROM proposal WHERE tenant_id = $1 AND id = $2`,
          [actor.tenant_id, query.proposal_id],
        );
        if (proposal.rows.length === 0) {
          throw new ReasonCodeException('proposal.not_found', '建议不存在', {
            entity: 'proposal',
          });
        }
        where.push(`ca.proposal_id = $${String(next)}::uuid`);
        params.push(query.proposal_id);
        next += 1;
      }
      if (query.actor_type !== undefined) {
        where.push(`ca.actor_type = $${String(next)}::text`);
        params.push(query.actor_type);
        next += 1;
      }
      if (query.result !== undefined) {
        where.push(`ca.result = $${String(next)}::text`);
        params.push(query.result);
        next += 1;
      }
      if (query.from !== undefined) {
        where.push(`ca.at >= $${String(next)}::timestamptz`);
        params.push(query.from);
        next += 1;
      }
      if (query.to !== undefined) {
        where.push(`ca.at < $${String(next)}::timestamptz`);
        params.push(query.to);
        next += 1;
      }
      if (scope !== null) {
        where.push(`pt.building_id = ANY($${String(next)}::uuid[])`);
        params.push([...scope]);
        next += 1;
      }
      if (query.cursor !== undefined) {
        const cursor = decodeProposalCursor(query.cursor, 1);
        where.push(
          `((extract(epoch from ca.at) * 1000000)::bigint, ca.id) < ($${String(next)}::bigint, $${String(next + 1)}::bigint)`,
        );
        const cursorTime = cursor.k[0];
        if (cursorTime === undefined) throw invalidCursorError();
        params.push(cursorTime, cursor.id);
        next += 2;
      }
      const limit = query.limit;
      const result = await tx.query<ControlAuditRowDb & { created_at_us?: never }>(
        `SELECT ca.id, ca.point_id, ca.proposal_id, ca.old_value, ca.new_value,
                ca.actor_type, ca.actor_ref, ca.result, ca.reason, ca.at,
                pt.raw_name AS point_raw_name, pt.display_name AS point_display_name,
                pt.unit_std AS point_unit_std
         FROM control_audit ca
         JOIN point pt ON pt.tenant_id = ca.tenant_id AND pt.id = ca.point_id
         WHERE ${where.join(' AND ')}
         ORDER BY ca.at DESC, ca.id DESC
         LIMIT ${String(limit + 1)}`,
        params,
      );
      const rows = result.rows;
      const hasMore = rows.length > limit;
      const last = hasMore ? rows[limit - 1] : undefined;
      return {
        items: (hasMore ? rows.slice(0, limit) : rows).map(auditRowOf),
        next_cursor:
          hasMore && last !== undefined
            ? encodeProposalCursor({ k: [epochMicros(last.at)], id: last.id })
            : null,
      };
    });
  }

  private requireDb(): TenantDb {
    if (this.tenantDb === null) {
      throw new ReasonCodeException('common.internal_error', '数据库未接线');
    }
    return this.tenantDb;
  }
}

// ---------------------------------------------------------------------------
// control_audit 行映射（§3.7 ControlAuditRow）
// ---------------------------------------------------------------------------

interface ControlAuditRowDb {
  readonly id: string;
  readonly point_id: string;
  readonly proposal_id: string | null;
  readonly old_value: string | number | null;
  readonly new_value: string | number | null;
  readonly actor_type: 'algo' | 'human' | 'system';
  readonly actor_ref: string | null;
  readonly result: 'ok' | 'verify_failed' | 'reverted' | 'rejected';
  readonly reason: string | null;
  readonly at: Date;
  readonly point_raw_name: string;
  readonly point_display_name: string | null;
  readonly point_unit_std: string | null;
}

function auditRowOf(row: ControlAuditRowDb): ControlAuditRow {
  return {
    id: Number(row.id),
    point_id: Number(row.point_id),
    proposal_id: row.proposal_id,
    point: {
      raw_name: row.point_raw_name,
      display_name: row.point_display_name,
      unit_std: row.point_unit_std,
    },
    old_value: row.old_value === null ? null : Number(row.old_value),
    new_value: row.new_value === null ? null : Number(row.new_value),
    actor_type: row.actor_type,
    actor_ref: row.actor_ref,
    result: row.result,
    reason: row.reason,
    at: row.at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// execution_result 宽松读投影（§2.3；未知字段忽略、缺省兜底、不回写）
// ---------------------------------------------------------------------------

interface LooseExecution {
  phase?: unknown;
  gates?: unknown;
  clamped?: unknown;
  effective_value?: unknown;
  verify?: unknown;
  cmds?: unknown;
  reason_code?: unknown;
  outcome?: unknown;
}

const GATE_NAMES = ['whitelist', 'clamp', 'rate', 'conflict', 'fuse'] as const;

function looseNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function looseString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function executionViewOf(
  row: ProposalJoinedRow,
  audit: readonly ControlAuditRow[],
): ExecutionDetailView {
  const raw: LooseExecution =
    typeof row.execution_result === 'object' && row.execution_result !== null
      ? row.execution_result
      : {};
  const actionValue = looseNumber((row.action as { value?: unknown } | null)?.value);

  const gates: ExecutionDetailView['gates'] = Array.isArray(raw.gates)
    ? raw.gates
        .filter(
          (gate): gate is Record<string, unknown> => typeof gate === 'object' && gate !== null,
        )
        .map((gate, index) => ({
          gate: looseNumber(gate['gate']) ?? index + 1,
          name: looseString(gate['name']) ?? GATE_NAMES[index] ?? `gate${String(index + 1)}`,
          outcome: normalizeOutcome(gate['outcome']),
          detail:
            typeof gate['detail'] === 'object' && gate['detail'] !== null
              ? (gate['detail'] as Record<string, unknown>)
              : null,
        }))
    : [];

  const verifyRaw = typeof raw.verify === 'object' && raw.verify !== null ? raw.verify : {};
  const readings = Array.isArray((verifyRaw as { readings?: unknown }).readings)
    ? (verifyRaw as { readings: unknown[] }).readings
        .filter(
          (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
        )
        .map((item) => ({
          at: looseString(item['at']),
          value: looseNumber(item['value']),
          quality: looseString(item['quality']),
          match: typeof item['match'] === 'boolean' ? item['match'] : null,
        }))
    : [];

  const cmds = Array.isArray(raw.cmds)
    ? raw.cmds
        .filter((cmd): cmd is Record<string, unknown> => typeof cmd === 'object' && cmd !== null)
        .map((cmd) => ({
          cmd_id: looseString(cmd['cmd_id']),
          kind: typeof cmd['kind'] === 'string' ? cmd['kind'] : 'unknown',
          at: looseString(cmd['at']),
          ack: looseString(cmd['ack']),
        }))
    : [];

  const clampedFrom = raw.clamped as { from?: unknown; to?: unknown } | null | undefined;
  const effective = looseNumber(raw.effective_value) ?? looseNumber(clampedFrom?.['to']);
  const wasClamped =
    typeof raw.clamped === 'boolean'
      ? raw.clamped
      : clampedFrom !== null && clampedFrom !== undefined && effective !== null
        ? effective !== actionValue
        : false;

  return {
    proposal_id: row.id,
    status: row.status as ExecutionDetailView['status'],
    phase: looseString(raw.phase),
    gates,
    value_chain: {
      value_before: row.previous_value === null ? null : Number(row.previous_value),
      value_commanded: actionValue,
      value_effective: effective ?? actionValue,
      clamped: wasClamped,
    },
    verify: {
      readings,
      retries_write: looseNumber((verifyRaw as { retries_write?: unknown }).retries_write) ?? 0,
    },
    cmds,
    reason_code: looseString(raw.reason_code),
    outcome: looseString(raw.outcome),
    executed_at: row.executed_at === null ? null : row.executed_at.toISOString(),
    audit_ref: { proposal_id: row.id, count: audit.length },
  };
}

/** gates[].outcome 未知值兜底（API-CT-02 default 分支——透传为 unevaluated 展示）。 */
function normalizeOutcome(value: unknown): ExecutionDetailView['gates'][number]['outcome'] {
  const allowed = new Set([
    'pass',
    'clamped',
    'queued',
    'denied',
    'overflow',
    'timeout',
    'superseded',
    'unevaluated',
  ]);
  return typeof value === 'string' && allowed.has(value)
    ? (value as ExecutionDetailView['gates'][number]['outcome'])
    : 'unevaluated';
}

function numberOrNull(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
}

function invalidCursorError(): ReasonCodeException {
  return new ReasonCodeException('common.validation_failed', '游标非法或已过期', {
    field: 'cursor',
  });
}
