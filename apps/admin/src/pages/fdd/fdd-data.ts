/**
 * FDD 域 api 数据面（modules/M6-fdd.md §5，IMPL-16 切片 / DAT-212）。
 *
 * 全部经 apiFetch safeParse（API-CT-01）；ignore 必带 Idempotency-Key
 * （API-DSN-01，§5.5——crypto.randomUUID 每次动作新生成，重试语义由幂等存储回放）。
 */
import {
  FddFindingDetailSchema,
  FddFindingListSchema,
  FddOverviewSchema,
  FddReportItemSchema,
  FddReportListSchema,
  type FddFindingDetail,
  type FddFindingList,
  type FddOverview,
  type FddReportItem,
  type FddReportList,
  type FddReviewRequest,
} from '@thermio/shared-types';
import { apiFetch } from '../../app/api-client.js';

export async function fetchFddOverview(buildingId?: string): Promise<FddOverview> {
  const path =
    buildingId === undefined ? '/fdd/overview' : `/fdd/overview?building_id=${buildingId}`;
  return apiFetch(path, FddOverviewSchema);
}

export interface FindingsFilter {
  readonly building_id?: string;
  readonly equipment_id?: string;
  readonly status?: string;
  readonly severity?: string;
  readonly rule_key?: string;
  readonly review?: string;
  readonly from?: string;
  readonly to?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export async function fetchFddFindings(filter: FindingsFilter = {}): Promise<FddFindingList> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const query = params.toString();
  return apiFetch(
    query.length > 0 ? `/fdd/findings?${query}` : '/fdd/findings',
    FddFindingListSchema,
  );
}

export async function fetchFddFindingDetail(findingId: string): Promise<FddFindingDetail> {
  return apiFetch(`/fdd/findings/${findingId}`, FddFindingDetailSchema);
}

/** PUT review（§5.4：设置/覆写判定；Idempotency-Key 接受不要求——PUT 天然幂等）。 */
export async function reviewFinding(
  findingId: string,
  body: FddReviewRequest,
): Promise<FddFindingDetail> {
  return apiFetch(`/fdd/findings/${findingId}/review`, FddFindingDetailSchema, {
    method: 'PUT',
    body,
  });
}

function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ik-${String(Date.now())}-${String(Math.random()).slice(2, 12)}`;
}

/** POST ignore（§5.5：reason 必填；Idempotency-Key 必带——后果性写 API-DSN-01）。 */
export async function ignoreFinding(
  findingId: string,
  reason: string,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<FddFindingDetail> {
  return apiFetch(`/fdd/findings/${findingId}/ignore`, FddFindingDetailSchema, {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
    body: { reason },
  });
}

export interface ReportsFilter {
  readonly building_id?: string;
  readonly period_type?: string;
  readonly from?: string;
  readonly to?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export async function fetchFddReports(filter: ReportsFilter = {}): Promise<FddReportList> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const query = params.toString();
  return apiFetch(query.length > 0 ? `/fdd/reports?${query}` : '/fdd/reports', FddReportListSchema);
}

export async function fetchFddReportDetail(reportId: string): Promise<FddReportItem> {
  return apiFetch(`/fdd/reports/${reportId}`, FddReportItemSchema);
}
