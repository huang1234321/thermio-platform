/**
 * 资产域共享件（IMPL-11）：楼宇级授权（load-for-user）+ 行映射。
 *
 * SEC-AZ-02/03 纪律（M1-asset §1.5）：
 * - admin 隐式全量楼宇；operator/viewer = user_building_scope；
 * - 资源归属判定 load-for-user：先查行、再判楼宇归属，越界与不存在**同响应**
 *   （404 对应域 not_found，文案不区分——不泄露存在性）；
 * - RLS 是兜底而非第一道防线：漏配 scope 行不会因 RLS 可见而越权放出。
 */
import type { PoolClient } from 'pg';
import type { Role } from '@thermio/shared-types';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';

/** 请求侧身份（AuthContext 的资产域消费面——避免直接依赖 auth 模块类型）。 */
export interface AssetActor {
  readonly tenant_id: string;
  readonly user_id: string;
  readonly role: Role;
}

/** 楼宇可见集：null = admin 全量（不加过滤谓词）。 */
export type BuildingScope = Set<string> | null;

/** load-for-user：解析当前用户楼宇可见集（admin → null）。 */
export async function loadBuildingScope(tx: PoolClient, actor: AssetActor): Promise<BuildingScope> {
  if (actor.role === 'admin') return null;
  const result = await tx.query<{ building_id: string }>(
    `SELECT building_id FROM user_building_scope WHERE tenant_id = $1 AND user_id = $2`,
    [actor.tenant_id, actor.user_id],
  );
  return new Set(result.rows.map((row) => row.building_id));
}

/** 归属校验：scope 非空且不含目标楼宇 → 404（调用方传 entity 供 details）。 */
export function assertBuildingInScope(
  scope: BuildingScope,
  buildingId: string,
  reasonCode: 'asset.not_found' | 'gateway.not_found' | 'credential.not_found' = 'asset.not_found',
  entity = 'building',
): void {
  if (scope !== null && !scope.has(buildingId)) {
    throw new ReasonCodeException(reasonCode, '资源不存在', { entity });
  }
}

/** 楼宇过滤谓词参数（scope 非空时 `= ANY($n::uuid[])`），null = 全量。 */
export function scopeFilter(scope: BuildingScope, startParam: number): string | null {
  return scope === null ? null : `= ANY($${String(startParam)}::uuid[])`;
}

// ---------------------------------------------------------------------------
// 行映射（pg 驱动类型 → API 契约；numeric 以 string 返回 → Number 收窄）
// ---------------------------------------------------------------------------

/** pg numeric 列 → number | null（TS-02 边界收窄；DDL numeric 精度在 MVP 量级安全）。 */
export function numericToNumber(value: string | number | null): number | null {
  if (value === null) return null;
  return typeof value === 'number' ? value : Number(value);
}

/** timestamptz → RFC3339（toISOString 即 Z 形）。 */
export function isoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** bigint 主键（pg string）→ API integer。 */
export function bigintValue(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

/** RETURNING 单行强制取值（INSERT/UPDATE 命中行；空行 = 程序缺陷 → 500 兜底）。 */
export function requireRow<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`unreachable: ${what} RETURNING 未返回行`);
  }
  return row;
}
