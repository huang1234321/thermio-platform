/**
 * M11 kpi 域 api 数据面（modules/M11-kpi-dashboard.md §5；IMPL-22 / DAT-246）。
 *
 * 全部经 apiFetch safeParse（API-CT-01）。窗口快捷项（今日/近 7 天/…）在此解析为
 * from/to（本地时区 Asia/Shanghai 日界，固定 +8）；跨度 >7 天自动请求 interval=day
 * （§2.3 自动规则）。
 */
import {
  FddDigestConfigSchema,
  FddDigestDeliveryListSchema,
  KpiBenchmarkConfigSchema,
  KpiEnergyStructureSchema,
  KpiEnergyTrendSchema,
  KpiOverviewSchema,
  MvExportCreateResponseSchema,
  MvExportJobListSchema,
  MvExportJobSchema,
  type FddDigestConfig,
  type FddDigestDeliveryList,
  type FddDigestDeliveriesQuery,
  type FddDigestPut,
  type FddExportJobsQuery,
  type KpiBenchmarkConfig,
  type KpiBenchmarkConfigPut,
  type KpiEnergyStructure,
  type KpiEnergyTrend,
  type KpiOverview,
  type KpiStructureQuery,
  type KpiTrendQuery,
  type MvExportCreateResponse,
  type MvExportJob,
  type MvExportJobList,
} from '@thermio/shared-types';
import { apiFetch } from '../../app/api-client.js';

/** Asia/Shanghai 固定偏移（1991 起无 DST；与服务端 kpi-bucket 同口径）。 */
const TZ_OFFSET_MS = 8 * 3600 * 1000;

export type WindowKey = 'today' | '7d' | '30d' | 'month' | 'quarter' | 'year';

export const WINDOW_OPTIONS: readonly { key: WindowKey; label: string }[] = [
  { key: 'today', label: '今日' },
  { key: '7d', label: '近 7 天' },
  { key: '30d', label: '近 30 天' },
  { key: 'month', label: '本月' },
  { key: 'quarter', label: '本季' },
  { key: 'year', label: '本年' },
];

/** 快捷窗 → [from, to]（本地日界；闭开语义对齐 §2.3）。 */
export function windowRange(key: WindowKey, now: Date = new Date()): { from: string; to: string } {
  const to = now.toISOString();
  const local = new Date(now.getTime() + TZ_OFFSET_MS);
  const localDayStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  switch (key) {
    case 'today':
      return { from: new Date(localDayStart - TZ_OFFSET_MS).toISOString(), to };
    case '7d':
      return { from: new Date(now.getTime() - 7 * 86_400_000).toISOString(), to };
    case '30d':
      return { from: new Date(now.getTime() - 30 * 86_400_000).toISOString(), to };
    case 'month':
      return {
        from: new Date(
          Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - TZ_OFFSET_MS,
        ).toISOString(),
        to,
      };
    case 'quarter': {
      const q = Math.floor(local.getUTCMonth() / 3);
      return {
        from: new Date(Date.UTC(local.getUTCFullYear(), q * 3, 1) - TZ_OFFSET_MS).toISOString(),
        to,
      };
    }
    case 'year':
      return {
        from: new Date(Date.UTC(local.getUTCFullYear(), 0, 1) - TZ_OFFSET_MS).toISOString(),
        to,
      };
  }
}

function toQuery(filter: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && String(value).length > 0) params.set(key, String(value));
  }
  const query = params.toString();
  return query.length > 0 ? `?${query}` : '';
}

/** §2.3 自动规则：跨度 >7 天必须 day（与服务端 assertWindow 同判）。 */
function autoIntervalOf(from: string, to: string): 'hour' | 'day' {
  return Date.parse(to) - Date.parse(from) > 7 * 86_400_000 ? 'day' : 'hour';
}

// ── 看板三端点（§5.1–§5.3） ──

export async function fetchKpiOverview(
  buildingId: string | undefined,
  range: { from: string; to: string },
): Promise<KpiOverview> {
  return apiFetch(
    `/kpi/overview${toQuery({ building_id: buildingId, from: range.from, to: range.to })}`,
    KpiOverviewSchema,
  );
}

export async function fetchKpiTrend(
  buildingId: string | undefined,
  range: { from: string; to: string },
  groupBy: KpiTrendQuery['group_by'],
): Promise<KpiEnergyTrend> {
  return apiFetch(
    `/kpi/energy/trend${toQuery({
      building_id: buildingId,
      from: range.from,
      to: range.to,
      interval: autoIntervalOf(range.from, range.to),
      group_by: groupBy,
    })}`,
    KpiEnergyTrendSchema,
  );
}

export async function fetchKpiStructure(
  buildingId: string | undefined,
  range: { from: string; to: string },
  groupBy: KpiStructureQuery['group_by'],
): Promise<KpiEnergyStructure> {
  return apiFetch(
    `/kpi/energy/structure${toQuery({
      building_id: buildingId,
      from: range.from,
      to: range.to,
      group_by: groupBy,
    })}`,
    KpiEnergyStructureSchema,
  );
}

// ── 基准配置（§5.5） ──

export async function fetchKpiBenchmarkConfig(buildingId: string): Promise<KpiBenchmarkConfig> {
  return apiFetch(
    `/kpi/benchmark-config${toQuery({ building_id: buildingId })}`,
    KpiBenchmarkConfigSchema,
  );
}

export async function putKpiBenchmarkConfig(
  buildingId: string,
  body: KpiBenchmarkConfigPut,
): Promise<KpiBenchmarkConfig> {
  return apiFetch(
    `/kpi/benchmark-config${toQuery({ building_id: buildingId })}`,
    KpiBenchmarkConfigSchema,
    {
      method: 'PUT',
      body,
    },
  );
}

// ── FDD 导出族（§5.4/§5.6/§5.7；fdd 报告详情页消费） ──

export async function exportFddReport(reportId: string): Promise<MvExportCreateResponse> {
  return apiFetch(`/fdd/reports/${reportId}/export`, MvExportCreateResponseSchema, {
    method: 'POST',
  });
}

export async function fetchFddExportJobs(
  query: Partial<FddExportJobsQuery> = {},
): Promise<MvExportJobList> {
  return apiFetch(
    `/kpi/export-jobs${toQuery(query as Record<string, string | number | undefined>)}`,
    MvExportJobListSchema,
  );
}

export async function fetchFddExportJob(jobId: string): Promise<MvExportJob> {
  return apiFetch(`/kpi/export-jobs/${jobId}`, MvExportJobSchema);
}

export function fddExportDownloadHref(jobId: string): string {
  return `/api/v1/kpi/export-jobs/${jobId}/download`;
}

// ── 订阅面（§5.8） ──

export async function fetchFddDigest(buildingId: string): Promise<FddDigestConfig> {
  return apiFetch(`/fdd/digest${toQuery({ building_id: buildingId })}`, FddDigestConfigSchema);
}

export async function putFddDigest(
  buildingId: string,
  body: FddDigestPut,
): Promise<FddDigestConfig> {
  return apiFetch(`/fdd/digest${toQuery({ building_id: buildingId })}`, FddDigestConfigSchema, {
    method: 'PUT',
    body,
  });
}

export async function fetchFddDigestDeliveries(
  query: Partial<FddDigestDeliveriesQuery> = {},
): Promise<FddDigestDeliveryList> {
  return apiFetch(
    `/fdd/digest/deliveries${toQuery(query as Record<string, string | number | undefined>)}`,
    FddDigestDeliveryListSchema,
  );
}
