/**
 * M11 FDD 周报导出服务（M11-kpi-dashboard.md §5.4/§5.6/§5.7/§6.1–§6.3；
 * IMPL-22 / DAT-246）。
 *
 * - 载体 = M9 export_job（§6.1 引用不复制）：resource_type='fdd_report'（0011 迁移
 *   预留值即消费入口），状态机/留存 30 天/下载 302 签名 URL 60 min 沿 M9 §1.7/§4.3
 *   零偏离；载体条件码复用 M9（§4.8 载体行：404 mv.report_not_found /
 *   409 mv.report_state_invalid / 409 mv.export_file_expired / 429 common.rate_limited）；
 * - 双层限流（§5.4 + platform §12 v1.8）：每租户在飞 ≤2（M9 载体行）× 每楼宇每小时
 *   ≤20（M11 增量行——并发窗 × 频率窗）；
 * - 任务面只看本人（§5.6 定夺：requested_by = 会话用户，admin 亦不越人查）；
 * - 渲染 = KPI_PDF_RENDERER（puppeteer + 随镜像 Chromium，kpi-fdd-pdf.ts）；单渲染
 *   槽（每实例并发 1，§12 v1.8）——进程内串行队列承载；失败可重试（= 重新 POST 新
 *   任务行，M9 §4.3）；
 * - 导出件随载体落 mv-exports/ 私桶（deploy.md v1.0.3：与 M9 同一私桶前缀，目录键
 *   形状不变）。
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Response } from 'express';
import {
  FDD_EXPORT_PER_BUILDING_HOURLY,
  FddReportSummarySchema,
  MV_DOWNLOAD_URL_TTL_MINUTES,
  MV_EXPORT_CONCURRENCY,
  MV_EXPORT_RETENTION_DAYS,
  type FddExportJobsQuery,
  type FddReportItem,
  type MvExportCreateResponse,
  type MvExportJob,
  type MvExportJobList,
  type MvJobFailure,
} from '@thermio/shared-types';
import { TENANT_DB } from '../infrastructure/db/db.tokens.js';
import type { TenantDb } from '../infrastructure/db/tenant-db.js';
import { LOGGER } from '../infrastructure/logger.js';
import { APP_CONFIG } from '../infrastructure/core.module.js';
import type { AppConfig } from '../config.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { loadBuildingScope } from '../asset/asset-shared.js';
import {
  decodeMvCursor,
  encodeMvCursor,
  mvKeysetPredicate,
  toEpochMicros,
} from '../mv/mv-cursor.js';
import { mapExportJob } from '../mv/mv-export.service.js';
import { reportNoOf, type FddPdfInput, type FddPdfRenderer } from './kpi-fdd-pdf.js';
import { KPI_EXPORT_DIR, KPI_PDF_RENDERER } from './kpi.tokens.js';
import { KpiMetrics } from './kpi.metrics.js';
import type { KpiActor } from './kpi.service.js';

@Injectable()
export class KpiExportService {
  private readonly logger: Logger;
  /** 单渲染槽（§12 v1.8：fdd_report 渲染并发 1/实例）——尾接 promise 链承载。 */
  private renderChain: Promise<unknown> = Promise.resolve();

  constructor(
    @Inject(TENANT_DB) private readonly db: TenantDb | null,
    @Inject(LOGGER) rootLogger: Logger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(KPI_EXPORT_DIR) private readonly exportDir: string,
    @Inject(KPI_PDF_RENDERER) private readonly renderer: FddPdfRenderer,
    @Inject(KpiMetrics) private readonly metrics: KpiMetrics,
  ) {
    this.logger = rootLogger.child({ component: 'kpi-export' });
    // 单渲染槽（§12 v1.8 FDD_EXPORT_RENDER_CONCURRENCY = 1）：串行链实现假设单槽；
    // 常量改值需换信号量实现（快照钉在 shared-types）
  }

  private requireDb(): TenantDb {
    if (this.db === null) throw new ReasonCodeException('common.internal_error', '数据库未接线');
    return this.db;
  }

  // ═══════════ §5.4 POST /fdd/reports/{id}/export ═══════════

  /** 发起导出（fdd.export，operator+；报告本体即输入，无 Body）。 */
  async createExport(actor: KpiActor, reportId: string): Promise<MvExportCreateResponse> {
    const db = this.requireDb();
    const buildingId = await db.withTenant(actor.tenant_id, async (tx) => {
      const report = await loadFddReportForUser(tx, actor, reportId);
      return report.building.id;
    });
    // 限流双层（§5.4）：先频率窗（楼宇每小时 ≤20）再并发窗（租户在飞 ≤2）
    const hourly = await db.withTenant(actor.tenant_id, async (tx) => {
      const result = await tx.query<{ count: string }>(
        `SELECT count(*) AS count FROM export_job e
         JOIN fdd_report r ON r.tenant_id = e.tenant_id AND r.id = e.resource_id
         WHERE e.tenant_id = $1 AND e.resource_type = 'fdd_report' AND r.building_id = $2::uuid
           AND e.created_at >= now() - INTERVAL '1 hour'`,
        [actor.tenant_id, buildingId],
      );
      return Number(result.rows[0]?.count ?? 0);
    });
    if (hourly >= FDD_EXPORT_PER_BUILDING_HOURLY) {
      throw new ReasonCodeException('common.rate_limited', '导出请求超出楼宇每小时上限', {
        limit: FDD_EXPORT_PER_BUILDING_HOURLY,
      });
    }
    const inFlight = await db.withTenant(actor.tenant_id, async (tx) => {
      const result = await tx.query<{ count: string }>(
        `SELECT count(*) AS count FROM export_job
         WHERE tenant_id = $1 AND status IN ('queued','running')`,
        [actor.tenant_id],
      );
      return Number(result.rows[0]?.count ?? 0);
    });
    if (inFlight >= MV_EXPORT_CONCURRENCY) {
      throw new ReasonCodeException('common.rate_limited', '导出任务并发超限', {
        limit: MV_EXPORT_CONCURRENCY,
      });
    }
    const jobId = randomUUID();
    await db.withTenant(actor.tenant_id, async (tx) => {
      await tx.query(
        `INSERT INTO export_job (id, tenant_id, resource_type, resource_id, requested_by)
         VALUES ($1, $2, 'fdd_report', $3, $4)`,
        [jobId, actor.tenant_id, reportId, actor.user_id],
      );
    });
    // 动作留结构化日志（§5.4：actor/report_id/export_job_id/request_id）
    this.logger.info({
      msg: 'fdd_report_export_requested',
      tenant_id: actor.tenant_id,
      actor: actor.user_id,
      report_id: reportId,
      export_job_id: jobId,
    });
    const tenantId = actor.tenant_id;
    const exporterName = await this.displayNameOf(tenantId, actor.user_id);
    this.enqueueRender(tenantId, jobId, reportId, exporterName);
    return { export_job_id: jobId, status: 'queued' };
  }

  // ═══════════ §5.6/§5.7 列表/详情/下载（只看本人） ═══════════

  async listExports(actor: KpiActor, query: FddExportJobsQuery): Promise<MvExportJobList> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const params: unknown[] = [actor.tenant_id, actor.user_id, query.limit + 1];
      const predicates: string[] = [
        `e.tenant_id = $1`,
        `e.requested_by = $2`, // 只看本人（§5.6：admin 亦不越人查）
        `e.resource_type = 'fdd_report'`, // 恒定不开放参数（消费面分径）
      ];
      if (query.status !== undefined) {
        params.push(query.status);
        predicates.push(`e.status = $${String(params.length)}`);
      }
      if (query.resource_id !== undefined) {
        params.push(query.resource_id);
        predicates.push(`e.resource_id = $${String(params.length)}`);
      }
      if (query.cursor !== undefined) {
        const cursor = decodeMvCursor(query.cursor, 1);
        const keyset = mvKeysetPredicate(
          '(extract(epoch FROM e.created_at) * 1e6)::bigint',
          'e.id::text',
          cursor,
          params.length + 1,
        );
        predicates.push(keyset.sql);
        params.push(...keyset.params);
      }
      const result = await tx.query<Record<string, unknown>>(
        `SELECT e.id, e.resource_type, e.resource_id, e.format, e.status, e.failure,
                e.file_bytes, e.created_at, e.started_at, e.finished_at, e.expires_at
         FROM export_job e
         WHERE ${predicates.join(' AND ')}
         ORDER BY e.created_at DESC, e.id DESC
         LIMIT $3`,
        params,
      );
      const rows = result.rows;
      const items = rows.slice(0, query.limit).map(mapExportJob);
      const last = rows[query.limit - 1];
      return {
        items,
        next_cursor:
          rows.length > query.limit && last !== undefined
            ? encodeMvCursor({
                k: [toEpochMicros(last.created_at as Date)],
                id: last.id as string,
              })
            : null,
      };
    });
  }

  async exportDetail(actor: KpiActor, jobId: string): Promise<MvExportJob> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      return loadExportJobForUser(tx, actor, jobId);
    });
  }

  /** 下载守卫 → 302 签名 URL（60 min；M9 §6.13 逐字对齐）。 */
  async download(actor: KpiActor, jobId: string, baseUrl: string): Promise<string> {
    const db = this.requireDb();
    const job = await db.withTenant(actor.tenant_id, async (tx) => {
      return loadExportJobForUser(tx, actor, jobId);
    });
    if (job.status !== 'succeeded') {
      throw new ReasonCodeException('mv.report_state_invalid', '导出任务未完成', {
        current_status: job.status,
      });
    }
    if (job.expires_at !== null && Date.parse(job.expires_at) < Date.now()) {
      throw new ReasonCodeException('mv.export_file_expired', '导出件已过保留期，请重新导出');
    }
    const expires = Date.now() + MV_DOWNLOAD_URL_TTL_MINUTES * 60_000;
    const sig = this.sign(jobId, actor.tenant_id, expires);
    return `${baseUrl}/api/v1/kpi/exports/${jobId}/file?tenant=${actor.tenant_id}&expires=${String(expires)}&sig=${sig}`;
  }

  /** 签名文件端点校验（@Public 路由的 HMAC 门；M9 同款）。 */
  verifySignature(
    jobId: string,
    tenantId: string,
    expires: string | undefined,
    sig: string | undefined,
  ): void {
    if (expires === undefined || sig === undefined || !/^\d+$/.test(expires)) {
      throw new ReasonCodeException('mv.report_not_found', '资源不存在', { entity: 'export_file' });
    }
    if (Number(expires) < Date.now()) {
      throw new ReasonCodeException('mv.report_not_found', '资源不存在', { entity: 'export_file' });
    }
    const expected = this.sign(jobId, tenantId, Number(expires));
    const a = Buffer.from(expected);
    const b = Buffer.from(sig);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ReasonCodeException('mv.report_not_found', '资源不存在', { entity: 'export_file' });
    }
  }

  /** 流式输出导出件（签名端点；文件缺失 = 已被清理 → 409 过期语义）。 */
  async streamFile(tenantId: string, jobId: string, response: Response): Promise<void> {
    const db = this.requireDb();
    const job = await db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT e.id, e.resource_type, e.resource_id, e.format, e.status, e.failure,
                e.file_object_key, e.file_bytes, e.created_at, e.started_at, e.finished_at, e.expires_at
         FROM export_job e WHERE e.tenant_id = $1 AND e.id = $2 AND e.resource_type = 'fdd_report'`,
        [tenantId, jobId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new ReasonCodeException('mv.report_not_found', '资源不存在', {
          entity: 'export_job',
        });
      }
      return { job: mapExportJob(row), key: row.file_object_key as string | null };
    });
    if (job.job.status !== 'succeeded' || job.job.file_bytes === null) {
      throw new ReasonCodeException('mv.report_state_invalid', '导出任务未完成', {
        current_status: job.job.status,
      });
    }
    // 私桶 key = mv-exports/{tenant}/{report}/{ts}.pdf → 本地目录相对路径（M9 同形）
    if (job.key === null) {
      throw new ReasonCodeException('mv.export_file_expired', '导出件已过保留期，请重新导出');
    }
    const relative = job.key.replace(/^mv-exports\//, '');
    const target = path.join(this.exportDir, relative);
    if (!target.startsWith(path.resolve(this.exportDir))) {
      throw new ReasonCodeException('mv.export_file_expired', '导出件已过保留期，请重新导出');
    }
    if (!fs.existsSync(target)) {
      throw new ReasonCodeException('mv.export_file_expired', '导出件已过保留期，请重新导出');
    }
    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="fdd-report-${job.job.resource_id.slice(0, 8)}.pdf"`,
    );
    response.setHeader('Content-Length', String(job.job.file_bytes));
    await new Promise<void>((resolve, reject) => {
      const stream = fs.createReadStream(target);
      stream.on('error', reject);
      response.on('finish', resolve);
      stream.pipe(response);
    });
  }

  // ═══════════ 渲染执行器（§6.1 状态机：queued → running → succeeded|failed） ═══════════

  /** 单渲染槽入队（§12 v1.8 并发 1；后续任务串行等待）。 */
  private enqueueRender(
    tenantId: string,
    jobId: string,
    reportId: string,
    exporterName: string | null,
  ): void {
    this.renderChain = this.renderChain
      .then(() => this.render(tenantId, jobId, reportId, exporterName))
      .catch((err: unknown) => {
        this.logger.error({ msg: 'kpi_export_worker_crashed', export_job_id: jobId, err });
      });
  }

  private async render(
    tenantId: string,
    jobId: string,
    reportId: string,
    exporterName: string | null,
  ): Promise<void> {
    const db = this.requireDb();
    await db.withTenant(tenantId, async (tx) => {
      await tx.query(
        `UPDATE export_job SET status = 'running', started_at = now()
         WHERE id = $1 AND status = 'queued'`,
        [jobId],
      );
    });
    try {
      const input = await this.loadRenderInput(tenantId, jobId, reportId, exporterName);
      const bytes = await this.renderer.render(input);
      const objectKey = path.join(tenantId, reportId, `${String(Date.now())}.pdf`);
      const target = path.join(this.exportDir, objectKey);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, bytes);
      await db.withTenant(tenantId, async (tx) => {
        await tx.query(
          `UPDATE export_job SET status = 'succeeded', file_object_key = $2, file_bytes = $3,
               finished_at = now(),
               expires_at = now() + make_interval(days => $4)
           WHERE id = $1 AND status = 'running'`,
          [jobId, `mv-exports/${objectKey}`, bytes.byteLength, MV_EXPORT_RETENTION_DAYS],
        );
      });
      this.metrics.lifecycleEvents.inc({ event: 'fdd_report_exported' });
      this.logger.info({
        msg: 'fdd_report_exported',
        export_job_id: jobId,
        report_id: reportId,
        bytes: bytes.byteLength,
      });
    } catch (err) {
      const failure: MvJobFailure = {
        stage: 'render',
        code: 'kpi.export_render_failed',
        message: 'PDF 渲染失败（可重试新任务；报告本体不受影响）',
      };
      await db.withTenant(tenantId, async (tx) => {
        await tx.query(
          `UPDATE export_job SET status = 'failed', failure = $2, finished_at = now()
           WHERE id = $1 AND status = 'running'`,
          [jobId, JSON.stringify(failure)],
        );
      });
      this.logger.warn({ msg: 'kpi_export_failed', export_job_id: jobId, err });
    }
  }

  private async loadRenderInput(
    tenantId: string,
    jobId: string,
    reportId: string,
    exporterName: string | null,
  ): Promise<FddPdfInput> {
    const db = this.requireDb();
    const report = await db.withTenant(tenantId, async (tx) => {
      return loadFddReportForUser(
        tx,
        { tenant_id: tenantId, user_id: 'system', role: 'admin' },
        reportId,
      );
    });
    return {
      report,
      exportNo: `EJ-${jobId.slice(0, 8)}`,
      exportedByName: exporterName ?? '—',
      exportedAt: new Date().toISOString(),
    };
  }

  private async displayNameOf(tenantId: string, userId: string): Promise<string | null> {
    const db = this.requireDb();
    return db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ display_name: string }>(
        `SELECT display_name FROM app_user WHERE tenant_id = $1 AND id = $2`,
        [tenantId, userId],
      );
      return result.rows[0]?.display_name ?? null;
    });
  }

  /** 签名载荷 = (job_id, tenant_id, expires)——tenant 入签名，URL 篡改即失效（M9 同款）。 */
  private sign(jobId: string, tenantId: string, expires: number): string {
    return createHmac('sha256', this.config.AUTH_JWT_SECRET)
      .update(`${jobId}.${tenantId}.${String(expires)}`)
      .digest('base64url');
  }
}

/** 报告编号便捷透出（digest 复用同形编号）。 */
export function fddReportNo(report: FddReportItem): string {
  return reportNoOf(report.id, report.generated_at);
}

// ---------------------------------------------------------------------------
// load-for-user（§5.4 报告本体 404 fdd.report_not_found；§5.7 任务 404 mv.report_not_found）
// ---------------------------------------------------------------------------

interface ReportRow {
  readonly id: string;
  readonly building_id: string;
  readonly building_name: string | null;
  readonly period_type: string;
  readonly period_start: string;
  readonly period_end: string;
  readonly summary: unknown;
  readonly generated_at: Date;
  readonly algo_version: string | null;
}

const REPORT_SQL = `SELECT r.id, r.building_id, b.name AS building_name, r.period_type,
       lower(r.period)::text AS period_start, upper(r.period)::text AS period_end,
       r.summary, r.generated_at, r.algo_version
 FROM fdd_report r
 JOIN building b ON b.tenant_id = r.tenant_id AND b.id = r.building_id`;

/** fdd 报告 load-for-user（M6 §5.7 同语义：scope 越界/不存在同 404 同文案）。 */
export async function loadFddReportForUser(
  tx: import('pg').PoolClient,
  actor: KpiActor,
  reportId: string,
): Promise<FddReportItem> {
  const result = await tx.query<ReportRow>(
    `${REPORT_SQL} WHERE r.tenant_id = $1 AND r.id = $2::uuid`,
    [actor.tenant_id, reportId],
  );
  const row = result.rows[0];
  const scope = await loadBuildingScope(tx, actor);
  if (row === undefined || (scope !== null && !scope.has(row.building_id))) {
    throw new ReasonCodeException('fdd.report_not_found', '报告不存在');
  }
  return reportItemOf(row);
}

export function reportItemOf(row: ReportRow): FddReportItem {
  const summary = FddReportSummarySchema.safeParse(row.summary);
  if (!summary.success) {
    // 入库前已 zod 校验（M6 R2）——读侧仍防御：脏 summary 不渲染进出域件
    throw new ReasonCodeException('common.internal_error', '报告 summary 数据不合规');
  }
  return {
    id: row.id,
    building: { id: row.building_id, name: row.building_name ?? '' },
    period_type: row.period_type as FddReportItem['period_type'],
    period: { start: row.period_start, end: row.period_end },
    summary: summary.data,
    generated_at: row.generated_at.toISOString(),
    algo_version: row.algo_version,
  };
}

/**
 * 导出任务 load-for-user（§5.7：非本人/越权/不存在同 404 同文案；只看本人定夺
 * §5.6——admin 亦 404；楼宇 scope 经 fdd_report.building_id 直取）。
 */
async function loadExportJobForUser(
  tx: import('pg').PoolClient,
  actor: KpiActor,
  jobId: string,
): Promise<MvExportJob> {
  const result = await tx.query<Record<string, unknown>>(
    `SELECT e.id, e.resource_type, e.resource_id, e.format, e.status, e.failure,
            e.file_bytes, e.created_at, e.started_at, e.finished_at, e.expires_at,
            e.requested_by, r.building_id
     FROM export_job e
     LEFT JOIN fdd_report r ON r.tenant_id = e.tenant_id AND r.id = e.resource_id
     WHERE e.tenant_id = $1 AND e.id = $2`,
    [actor.tenant_id, jobId],
  );
  const row = result.rows[0];
  const scope = await loadBuildingScope(tx, actor);
  if (
    row === undefined ||
    row.resource_type !== 'fdd_report' ||
    row.requested_by !== actor.user_id ||
    (scope !== null && (row.building_id === null || !scope.has(row.building_id as string)))
  ) {
    throw new ReasonCodeException('mv.report_not_found', '资源不存在', { entity: 'export_job' });
  }
  return mapExportJob(row);
}
