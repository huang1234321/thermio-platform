/**
 * M&V 域 api 数据面（modules/M9-mv-report.md §6/§8；IMPL-21 / DAT-242）。
 *
 * 全部经 apiFetch safeParse（API-CT-01）；generate 必带 Idempotency-Key
 * （API-DSN-01，§6.2——crypto.randomUUID 每次动作新生成）。
 */
import {
  MvBaselineActivateResponseSchema,
  MvBaselineDetailSchema,
  MvBaselineListSchema,
  MvExportCreateResponseSchema,
  MvExportJobListSchema,
  MvExportJobSchema,
  MvGenerateResponseSchema,
  MvGenerationJobSchema,
  MvReportApproveResponseSchema,
  MvReportDetailSchema,
  MvReportListSchema,
  MvValidationResultSchema,
  MvWeatherStationsResponseSchema,
  type MvBaselineActivate,
  type MvBaselineActivateResponse,
  type MvBaselineCreate,
  type MvBaselineDetail,
  type MvBaselineList,
  type MvBaselinePatch,
  type MvExportCreateResponse,
  type MvExportJob,
  type MvExportJobList,
  type MvExportJobsQuery,
  type MvGenerateRequest,
  type MvGenerateResponse,
  type MvGenerationJob,
  type MvReportApproveResponse,
  type MvReportDetail,
  type MvReportList,
  type MvReportsQuery,
  type MvBaselinesQuery,
  type MvValidationResult,
  type MvWeatherStationsResponse,
} from '@thermio/shared-types';
import { apiFetch } from '../../app/api-client.js';

function toQuery(filter: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && String(value).length > 0) params.set(key, String(value));
  }
  const query = params.toString();
  return query.length > 0 ? `?${query}` : '';
}

function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ik-${String(Date.now())}-${String(Math.random()).slice(2, 12)}`;
}

// ── 基线（§6.1/§6.4–§6.7） ──

export async function fetchMvBaselines(
  query: Partial<MvBaselinesQuery> = {},
): Promise<MvBaselineList> {
  return apiFetch(
    `/mv/baselines${toQuery(query as Record<string, string | number | undefined>)}`,
    MvBaselineListSchema,
  );
}

export async function fetchMvBaselineDetail(baselineId: string): Promise<MvBaselineDetail> {
  return apiFetch(`/mv/baselines/${baselineId}`, MvBaselineDetailSchema);
}

export async function createMvBaseline(body: MvBaselineCreate): Promise<MvBaselineDetail> {
  return apiFetch('/mv/baselines', MvBaselineDetailSchema, { method: 'POST', body });
}

export async function patchMvBaseline(
  baselineId: string,
  body: MvBaselinePatch,
): Promise<MvBaselineDetail> {
  return apiFetch(`/mv/baselines/${baselineId}`, MvBaselineDetailSchema, {
    method: 'PATCH',
    body,
  });
}

/** DELETE 204 无 body（alarm-rules 的 noContent 同款）。 */
const noContent = {
  safeParse: (input: unknown): { success: true; data: unknown } => ({ success: true, data: input }),
};

export async function deleteMvBaseline(baselineId: string): Promise<void> {
  await apiFetch(`/mv/baselines/${baselineId}`, noContent, { method: 'DELETE' });
}

export async function validateMvBaseline(baselineId: string): Promise<MvValidationResult> {
  return apiFetch(`/mv/baselines/${baselineId}/validate`, MvValidationResultSchema, {
    method: 'POST',
  });
}

export async function activateMvBaseline(
  baselineId: string,
  body: MvBaselineActivate = {},
): Promise<MvBaselineActivateResponse> {
  return apiFetch(`/mv/baselines/${baselineId}/activate`, MvBaselineActivateResponseSchema, {
    method: 'POST',
    body,
  });
}

export async function retireMvBaseline(
  baselineId: string,
): Promise<{ id: string; status: string }> {
  return apiFetch(`/mv/baselines/${baselineId}/retire`, MvBaselineActivateResponseSchema, {
    method: 'POST',
    body: {},
  });
}

// ── 报告（§6.2/§6.3/§6.8–§6.11） ──

export async function generateMvReport(
  body: MvGenerateRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<MvGenerateResponse> {
  return apiFetch('/mv/reports/generate', MvGenerateResponseSchema, {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
    body,
  });
}

export async function fetchMvGenerationJob(jobId: string): Promise<MvGenerationJob> {
  return apiFetch(`/mv/generation-jobs/${jobId}`, MvGenerationJobSchema);
}

export async function fetchMvReports(query: Partial<MvReportsQuery> = {}): Promise<MvReportList> {
  return apiFetch(
    `/mv/reports${toQuery(query as Record<string, string | number | boolean | undefined>)}`,
    MvReportListSchema,
  );
}

export async function fetchMvReportDetail(reportId: string): Promise<MvReportDetail> {
  return apiFetch(`/mv/reports/${reportId}`, MvReportDetailSchema);
}

export async function deleteMvReport(reportId: string): Promise<void> {
  await apiFetch(`/mv/reports/${reportId}`, noContent, { method: 'DELETE' });
}

export async function approveMvReport(reportId: string): Promise<MvReportApproveResponse> {
  return apiFetch(`/mv/reports/${reportId}/approve`, MvReportApproveResponseSchema, {
    method: 'POST',
  });
}

// ── 导出（§6.12/§6.13） ──

export async function exportMvReport(reportId: string): Promise<MvExportCreateResponse> {
  return apiFetch(`/mv/reports/${reportId}/export`, MvExportCreateResponseSchema, {
    method: 'POST',
    headers: { 'idempotency-key': newIdempotencyKey() },
    body: {},
  });
}

export async function fetchMvExportJobs(
  query: Partial<MvExportJobsQuery> = {},
): Promise<MvExportJobList> {
  return apiFetch(
    `/mv/export-jobs${toQuery(query as Record<string, string | number | undefined>)}`,
    MvExportJobListSchema,
  );
}

export async function fetchMvExportJob(jobId: string): Promise<MvExportJob> {
  return apiFetch(`/mv/export-jobs/${jobId}`, MvExportJobSchema);
}

export function exportDownloadHref(jobId: string): string {
  return `/api/v1/mv/export-jobs/${jobId}/download`;
}

// ── 天气站点（§6.14） ──

export async function fetchMvWeatherStations(): Promise<MvWeatherStationsResponse> {
  return apiFetch('/mv/weather-stations', MvWeatherStationsResponseSchema);
}
