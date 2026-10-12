/**
 * M&V 报告导出服务（M9-mv-report.md §1.6/§2.5/§4.3/§6.12/§6.13；IMPL-21 / DAT-242）。
 *
 * - export_job 资源无关载体（resource_type='mv_report'；fdd_report 为 M11 预留——
 *   只建承载，不越界实现 M11 面）；
 * - 渲染 = api 进程内 pdf-lib（mv-pdf.ts，§1.6 R7）；导出件落 mv-exports/ 私桶锚的
 *   本地文件形态（MV_EXPORT_DIR，单楼私有化部署 V1.0；对象存储替换 = 实现本接口）；
 * - 下载 = 302 签名 URL（HMAC-SHA256，60 min，M3 §2.3 同款语义）；过期 → 409
 *   mv.export_file_expired；渲染失败报告本体零影响（§4.3）；
 * - 保留 30 天（expires_at 承载；到期清理由部署侧 cron 按 mv-exports/ 目录扫描，
 *   下载路径即时 409 兜底）。
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Response } from 'express';
import {
  MV_DOWNLOAD_URL_TTL_MINUTES,
  MV_EXPORT_CONCURRENCY,
  MV_EXPORT_RETENTION_DAYS,
  type MvExportCreateResponse,
  type MvExportJob,
  type MvExportJobList,
  type MvExportJobsQuery,
  type MvJobFailure,
  type MvReportDetail,
} from '@thermio/shared-types';
import { TENANT_DB } from '../infrastructure/db/db.tokens.js';
import type { TenantDb } from '../infrastructure/db/tenant-db.js';
import { LOGGER } from '../infrastructure/logger.js';
import { APP_CONFIG } from '../infrastructure/core.module.js';
import type { AppConfig } from '../config.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { loadBuildingScope } from '../asset/asset-shared.js';
import type { MvActor } from './mv-shared.js';
import { loadReportForUser } from './mv.service.js';
import { MV_EXPORT_DIR } from './mv.tokens.js';
import { decodeMvCursor, encodeMvCursor, mvKeysetPredicate, toEpochMicros } from './mv-cursor.js';
import { MvMetrics } from './mv.metrics.js';
import { renderMvReportPdf } from './mv-pdf.js';
import { MvService } from './mv.service.js';

@Injectable()
export class MvExportService {
  private readonly logger: Logger;

  constructor(
    @Inject(TENANT_DB) private readonly db: TenantDb | null,
    @Inject(LOGGER) rootLogger: Logger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MV_EXPORT_DIR) private readonly exportDir: string,
    @Inject(MvService) private readonly mv: MvService,
    @Inject(MvMetrics) private readonly metrics: MvMetrics,
  ) {
    this.logger = rootLogger.child({ component: 'mv-export' });
  }

  private requireDb(): TenantDb {
    if (this.db === null) throw new ReasonCodeException('common.internal_error', '数据库未接线');
    return this.db;
  }

  // ═══════════ §6.12 POST /mv/reports/{id}/export ═══════════

  /** 发起导出（operator+/admin；渲染内容 = 已审批或待审批报告当前快照，§6.12）。 */
  async createExport(actor: MvActor, reportId: string): Promise<MvExportCreateResponse> {
    const db = this.requireDb();
    await db.withTenant(actor.tenant_id, async (tx) => {
      await loadReportForUser(tx, actor, reportId);
    });
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
         VALUES ($1, $2, 'mv_report', $3, $4)`,
        [jobId, actor.tenant_id, reportId, actor.user_id],
      );
    });
    const tenantId = actor.tenant_id;
    setImmediate(() => {
      this.render(tenantId, jobId, reportId).catch((err: unknown) => {
        this.logger.error({ msg: 'mv_export_worker_crashed', export_job_id: jobId, err });
      });
    });
    return { export_job_id: jobId, status: 'queued' };
  }

  /** 渲染执行器（§4.3）：report 快照 → PDF → 私桶文件 → succeeded；失败可重试新任务。 */
  private async render(tenantId: string, jobId: string, reportId: string): Promise<void> {
    const db = this.requireDb();
    await db.withTenant(tenantId, async (tx) => {
      await tx.query(
        `UPDATE export_job SET status = 'running', started_at = now()
         WHERE id = $1 AND status = 'queued'`,
        [jobId],
      );
    });
    try {
      const detail = await this.loadSnapshot(tenantId, reportId);
      const bytes = await renderMvReportPdf(detail.report, detail.meta);
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
      this.metrics.lifecycleEvents.inc({ event: 'mv_report_exported' });
      this.logger.info({
        msg: 'mv_report_exported',
        export_job_id: jobId,
        report_id: reportId,
        bytes: bytes.byteLength,
      });
    } catch (err) {
      const failure: MvJobFailure = {
        stage: 'render',
        code: 'mv.export_render_failed',
        message: 'PDF 渲染失败（可重试新任务；报告本体不受影响）',
      };
      await db.withTenant(tenantId, async (tx) => {
        await tx.query(
          `UPDATE export_job SET status = 'failed', failure = $2, finished_at = now()
           WHERE id = $1 AND status = 'running'`,
          [jobId, JSON.stringify(failure)],
        );
      });
      this.logger.warn({ msg: 'mv_export_failed', export_job_id: jobId, err });
    }
  }

  // ═══════════ §6.13 列表/详情/下载 ═══════════

  async listExports(actor: MvActor, query: MvExportJobsQuery): Promise<MvExportJobList> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const params: unknown[] = [actor.tenant_id, query.limit + 1];
      const predicates: string[] = ['e.tenant_id = $1'];
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
         LIMIT $2`,
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

  async exportDetail(actor: MvActor, jobId: string): Promise<MvExportJob> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      return loadExportJobForUser(tx, actor, jobId);
    });
  }

  /** 下载守卫 → 302 签名 URL（60 min；§4.3）。 */
  async download(actor: MvActor, jobId: string, baseUrl: string): Promise<string> {
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
    return `${baseUrl}/api/v1/mv/exports/${jobId}/file?tenant=${actor.tenant_id}&expires=${String(expires)}&sig=${sig}`;
  }

  /** 签名文件端点校验（@Public 路由的 HMAC 门）：过期/签名不符 → 404 同文案（不泄露）。 */
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
         FROM export_job e WHERE e.tenant_id = $1 AND e.id = $2`,
        [tenantId, jobId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new ReasonCodeException('mv.report_not_found', '资源不存在', {
          entity: 'export_job',
        });
      }
      return mapExportJob(row);
    });
    if (job.status !== 'succeeded' || job.file_bytes === null) {
      throw new ReasonCodeException('mv.report_state_invalid', '导出任务未完成', {
        current_status: job.status,
      });
    }
    const objectKey = await db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ key: string }>(
        `SELECT file_object_key AS key FROM export_job WHERE tenant_id = $1 AND id = $2`,
        [tenantId, jobId],
      );
      return result.rows[0]?.key ?? null;
    });
    // 私桶 key = mv-exports/{tenant}/{report}/{ts}.pdf → 本地目录相对路径
    if (objectKey === null) {
      throw new ReasonCodeException('mv.export_file_expired', '导出件已过保留期，请重新导出');
    }
    const relative = objectKey.replace(/^mv-exports\//, '');
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
      `attachment; filename="mv-report-${job.resource_id.slice(0, 8)}.pdf"`,
    );
    response.setHeader('Content-Length', String(job.file_bytes));
    await new Promise<void>((resolve, reject) => {
      const stream = fs.createReadStream(target);
      stream.on('error', reject);
      response.on('finish', resolve);
      stream.pipe(response);
    });
  }

  // ═══════════ 内部 ═══════════

  /** 签名载荷 = (job_id, tenant_id, expires)——tenant 入签名，URL 篡改即失效。 */
  private sign(jobId: string, tenantId: string, expires: number): string {
    return createHmac('sha256', this.config.AUTH_JWT_SECRET)
      .update(`${jobId}.${tenantId}.${String(expires)}`)
      .digest('base64url');
  }

  private async loadSnapshot(
    tenantId: string,
    reportId: string,
  ): Promise<{ report: MvReportDetail; meta: ReturnType<typeof pdfMeta> }> {
    const detail = await this.mv.reportDetail(
      { tenant_id: tenantId, user_id: 'system', role: 'admin' },
      reportId,
    );
    const db = this.requireDb();
    const meta = await db.withTenant(tenantId, async (tx) => {
      const { baseline, buildingName } = await loadReportForUser(
        tx,
        { tenant_id: tenantId, user_id: 'system', role: 'admin' },
        reportId,
      );
      const points = await tx.query<{ point_id: string; name: string }>(
        `SELECT bp.point_id, COALESCE(p.display_name, p.raw_name) AS name FROM mv_baseline_point bp
         JOIN point p ON p.tenant_id = bp.tenant_id AND p.id = bp.point_id
         WHERE bp.baseline_id = $1 ORDER BY bp.point_id`,
        [baseline.id],
      );
      return pdfMeta(buildingName, baseline, points.rows);
    });
    return { report: detail, meta };
  }
}

function pdfMeta(
  buildingName: string | null,
  baseline: { weather_source: string; baseline_period: string },
  points: readonly { point_id: string; name: string }[],
) {
  return {
    building_name: buildingName ?? '—',
    baseline_period: parse(baseline.baseline_period),
    method_label: 'IPMVP 选项 C（整楼度量 + 天气归一化）',
    weather_source: baseline.weather_source,
    metering_points: points.map((p) => ({ point_id: Number(p.point_id), name: p.name })),
  };
}

function parse(range: string): { start: string; end: string } {
  const match = /\[("?\d{4}-\d{2}-\d{2}"?),("?\d{4}-\d{2}-\d{2}"?)\]/.exec(range);
  if (match === null) return { start: '—', end: '—' };
  return { start: (match[1] ?? '').replace(/"/g, ''), end: (match[2] ?? '').replace(/"/g, '') };
}

export function mapExportJob(row: Record<string, unknown>): MvExportJob {
  return {
    id: row.id as string,
    resource_type: row.resource_type as MvExportJob['resource_type'],
    resource_id: row.resource_id as string,
    format: row.format as MvExportJob['format'],
    status: row.status as MvExportJob['status'],
    failure: (row.failure as MvJobFailure | null) ?? null,
    file_bytes:
      row.file_bytes === null || row.file_bytes === undefined ? null : Number(row.file_bytes),
    created_at: (row.created_at as Date).toISOString(),
    started_at:
      row.started_at === null || row.started_at === undefined
        ? null
        : (row.started_at as Date).toISOString(),
    finished_at:
      row.finished_at === null || row.finished_at === undefined
        ? null
        : (row.finished_at as Date).toISOString(),
    expires_at:
      row.expires_at === null || row.expires_at === undefined
        ? null
        : (row.expires_at as Date).toISOString(),
  };
}

/** 导出任务 load-for-user（mv_report 资源经报告→基线→楼宇解析；fdd_report 资源仅本租户可见）。 */
async function loadExportJobForUser(
  tx: import('pg').PoolClient,
  actor: MvActor,
  jobId: string,
): Promise<MvExportJob> {
  const result = await tx.query<Record<string, unknown>>(
    `SELECT e.id, e.resource_type, e.resource_id, e.format, e.status, e.failure,
            e.file_bytes, e.created_at, e.started_at, e.finished_at, e.expires_at
     FROM export_job e WHERE e.tenant_id = $1 AND e.id = $2`,
    [actor.tenant_id, jobId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ReasonCodeException('mv.report_not_found', '资源不存在', { entity: 'export_job' });
  }
  if (row.resource_type === 'mv_report') {
    const scope = await loadBuildingScope(tx, actor);
    const building = await tx.query<{ building_id: string | null }>(
      `SELECT b.building_id FROM export_job e
       JOIN mv_report r ON r.tenant_id = e.tenant_id AND r.id = e.resource_id
       JOIN mv_baseline b ON b.tenant_id = r.tenant_id AND b.id = r.baseline_id
       WHERE e.tenant_id = $1 AND e.id = $2`,
      [actor.tenant_id, jobId],
    );
    const buildingId = building.rows[0]?.building_id;
    if (
      scope !== null &&
      (buildingId === undefined || buildingId === null || !scope.has(buildingId))
    ) {
      throw new ReasonCodeException('mv.report_not_found', '资源不存在', { entity: 'export_job' });
    }
  }
  return mapExportJob(row);
}
