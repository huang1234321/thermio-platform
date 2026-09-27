/**
 * 闸门预检快照（M5-proposal.md §3.3/§5，IMPL-17 / DAT-163）。
 *
 * 预检 ≠ 仲裁：详情请求时点的静态快照读，pass=false 不阻塞 approve（UI 红标提示）；
 * 判定口径引用 control-safety（§3.1 同式 / §3.3 rate 窗口 / 闸门 5 fuse 态）。
 * 数据源：point 行 + control_audit 聚合 + control_fuse 只读（〔R7〕信息项）。
 */
import type { PoolClient } from 'pg';
import type { ProposalPrecheck } from '@thermio/shared-types';

interface PointGateRow {
  readonly is_controllable: boolean;
  readonly status: string;
  readonly direction: string;
  readonly clamp_min: string | number | null;
  readonly clamp_max: string | number | null;
  readonly write_rate_limit_per_hour: number | null;
  readonly system_id: string | null;
}

/** control-safety §3.3 默认：write_rate_limit_per_hour NULL → 6（60min 窗口）。 */
const DEFAULT_RATE_LIMIT_PER_HOUR = 6;

function num(value: string | number | null): number | null {
  return value === null ? null : typeof value === 'number' ? value : Number(value);
}

/** 构建四项预检快照（checked_at = 服务端 now；调用方在租户事务内）。 */
export async function buildPrecheck(
  tx: PoolClient,
  pointId: number,
  actionValue: number,
): Promise<ProposalPrecheck> {
  const point = (
    await tx.query<PointGateRow>(
      `SELECT is_controllable, status, direction, clamp_min, clamp_max,
              write_rate_limit_per_hour, e.system_id
       FROM point pt LEFT JOIN equipment e ON e.tenant_id = pt.tenant_id AND e.id = pt.equipment_id
       WHERE pt.id = $1`,
      [pointId],
    )
  ).rows[0];
  // 调用方已做 load-for-user，point 必在；兜底防御（fail-closed 全项不过）
  const row: PointGateRow =
    point ??
    ({
      is_controllable: false,
      status: 'disabled',
      direction: 'read',
      clamp_min: null,
      clamp_max: null,
      write_rate_limit_per_hour: null,
      system_id: null,
    } satisfies PointGateRow);

  // ── 闸门 1 白名单（control-safety §3.1 同式）──
  const whitelistPass =
    row.is_controllable &&
    row.status === 'active' &&
    (row.direction === 'write' || row.direction === 'readwrite');

  // ── 闸门 2 值域（可空侧不夹；would_clamp 预演，非拒绝）──
  const clampMin = num(row.clamp_min);
  const clampMax = num(row.clamp_max);
  const clampedLow = clampMin !== null && actionValue < clampMin;
  const clampedHigh = clampMax !== null && actionValue > clampMax;
  const wouldClamp = clampedLow || clampedHigh;
  const effectiveValue = clampedLow ? clampMin : clampedHigh ? clampMax : actionValue;

  // ── 闸门 3 频率（60min 窗口 control_audit ok/reverted 计数 vs 上限，§3.3）──
  const limit = row.write_rate_limit_per_hour ?? DEFAULT_RATE_LIMIT_PER_HOUR;
  const usedResult = await tx.query<{ used: string }>(
    `SELECT count(*) AS used FROM control_audit
     WHERE point_id = $1 AND result IN ('ok', 'reverted')
       AND at > now() - interval '60 minutes'`,
    [pointId],
  );
  const used = Number(usedResult.rows[0]?.used ?? '0');

  // ── 闸门 5 熔断态（信息项〔R7〕：目标系统当前 control_fuse 态，缺行 = closed）──
  let fuseStatus: 'closed' | 'open' = 'closed';
  if (row.system_id !== null) {
    const fuse = await tx.query<{ status: string }>(
      `SELECT status FROM control_fuse WHERE system_id = $1`,
      [row.system_id],
    );
    if (fuse.rows[0]?.status === 'open') fuseStatus = 'open';
  }

  return {
    whitelist: {
      pass: whitelistPass,
      is_controllable: row.is_controllable,
      point_status: row.status,
      direction: row.direction,
    },
    clamp: {
      pass: !wouldClamp,
      value: actionValue,
      clamp_min: clampMin,
      clamp_max: clampMax,
      would_clamp: wouldClamp,
      effective_value: effectiveValue,
    },
    rate: { pass: used < limit, used, limit, window_s: 3600 },
    fuse: { pass: fuseStatus === 'closed', status: fuseStatus },
    checked_at: new Date().toISOString(),
  };
}
