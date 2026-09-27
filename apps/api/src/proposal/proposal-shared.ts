/**
 * 建议域共享件（M5-proposal.md §2/§8.1，IMPL-17 / DAT-163）：
 * - 行形状与 SELECT 列（DDL 直传，ddl.md §4 proposal 19 列）；
 * - load-for-user 归属判定（point→equipment→building 链，SEC-AZ-02/03：
 *   越界与不存在同响应 404 proposal.not_found，文案不区分）；
 * - 行→视图映射（numeric string → number 收窄，TS-02）。
 */
import type { PoolClient } from 'pg';
import type { ProposalCard } from '@thermio/shared-types';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { bigintValue, isoOrNull, numericToNumber } from '../asset/asset-shared.js';

/** proposal 行（DDL 直传；jsonb 以 pg 驱动解析结果承接）。 */
export interface ProposalRow {
  readonly id: string;
  readonly algo: string;
  readonly algo_version: string;
  readonly equipment_id: string;
  readonly point_id: string;
  readonly action: unknown;
  readonly previous_value: string | number | null;
  readonly rationale: string;
  readonly expected_saving_kw: string | number | null;
  readonly confidence: string | number | null;
  readonly evidence: unknown;
  readonly expires_at: Date | null;
  readonly status: string;
  readonly decided_by: string | null;
  readonly executed_at: Date | null;
  readonly execution_result: unknown;
  readonly created_at: Date;
}

/** 列表/详情联查列（point 精简 + 决策人姓名，M5 §3.1）。 */
export const PROPOSAL_SELECT_COLUMNS = `
  p.id, p.algo, p.algo_version, p.equipment_id, p.point_id, p.action,
  p.previous_value, p.rationale, p.expected_saving_kw, p.confidence, p.evidence,
  p.expires_at, p.status, p.decided_by, p.decided_at, p.executed_at,
  p.execution_result, p.created_at,
  pt.raw_name        AS point_raw_name,
  pt.display_name    AS point_display_name,
  pt.unit_std        AS point_unit_std,
  du.display_name    AS decided_by_name
`;

export interface ProposalJoinedRow extends ProposalRow {
  readonly decided_at: Date | null;
  readonly point_raw_name: string;
  readonly point_display_name: string | null;
  readonly point_unit_std: string | null;
  readonly decided_by_name: string | null;
}

/** 行→ProposalCard（M5 §3.1；jsonb action 宽松直传——写入面已校验）。 */
export function proposalCardOf(row: ProposalJoinedRow): ProposalCard {
  return {
    id: row.id,
    status: row.status as ProposalCard['status'],
    algo: row.algo,
    algo_version: row.algo_version,
    equipment_id: row.equipment_id,
    point_id: bigintValue(row.point_id),
    point: {
      raw_name: row.point_raw_name,
      display_name: row.point_display_name,
      unit_std: row.point_unit_std,
    },
    action: row.action as ProposalCard['action'],
    previous_value: numericToNumber(row.previous_value),
    expected_saving_kw: numericToNumber(row.expected_saving_kw),
    confidence: numericToNumber(row.confidence),
    expires_at: isoOrNull(row.expires_at),
    decided_by: row.decided_by,
    decided_by_name: row.decided_by_name,
    decided_at: isoOrNull(row.decided_at),
    executed_at: isoOrNull(row.executed_at),
    created_at: row.created_at.toISOString(),
    reason_code: terminalReasonCode(row),
  };
}

/** 终态失败展示码（M5 §1.2 异步面码，从 execution_result 读投影；其余 null）。 */
function terminalReasonCode(row: ProposalJoinedRow): string | null {
  if (row.status !== 'failed') return null;
  const result = row.execution_result;
  if (typeof result !== 'object' || result === null) return null;
  const code = (result as { reason_code?: unknown }).reason_code;
  return typeof code === 'string' ? code : null;
}

/** timestamptz 行值 → epoch 微秒字符串（游标键）。 */
export function epochMicros(value: Date): string {
  return String(BigInt(Math.floor(value.getTime() * 1000)));
}

/**
 * load-for-user：加载 proposal 行并校验楼宇归属（point→building 链）。
 * viewer/operator 楼宇可见集 = user_building_scope；admin 全量（scope=null）。
 * 不存在/越租户/越楼宇 → 同 404 proposal.not_found（SEC-AZ-03）。
 */
export async function loadProposalForUser(
  tx: PoolClient,
  tenantId: string,
  proposalId: string,
  buildingScope: Set<string> | null,
): Promise<ProposalJoinedRow> {
  const result = await tx.query<ProposalJoinedRow>(
    `SELECT ${PROPOSAL_SELECT_COLUMNS}
     FROM proposal p
     JOIN point pt ON pt.tenant_id = p.tenant_id AND pt.id = p.point_id
     LEFT JOIN app_user du ON du.tenant_id = p.tenant_id AND du.id = p.decided_by
     WHERE p.tenant_id = $1 AND p.id = $2`,
    [tenantId, proposalId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ReasonCodeException('proposal.not_found', '建议不存在', { entity: 'proposal' });
  }
  if (buildingScope !== null) {
    const building = await tx.query<{ building_id: string }>(
      `SELECT pt.building_id FROM point pt
       WHERE pt.tenant_id = $1 AND pt.id = $2`,
      [tenantId, row.point_id],
    );
    const buildingId = building.rows[0]?.building_id;
    if (buildingId === undefined || !buildingScope.has(buildingId)) {
      throw new ReasonCodeException('proposal.not_found', '建议不存在', { entity: 'proposal' });
    }
  }
  return row;
}
