/**
 * M11 FDD 周报邮件订阅服务（M11-kpi-dashboard.md §5.8/§6.4；IMPL-22 / DAT-246）。
 *
 * - 订阅配置（admin，digest.manage）：一楼一份（UNIQUE tenant+building），PUT 全量
 *   替换幂等；收件人逐项邮箱校验 + ≤20 → 422 digest.recipient_invalid（details 序号）；
 * - 投递调度（§6.4 BF-11.1）：每周一 08:00（Asia/Shanghai）扫 enabled 订阅 → 取该楼
 *   「刚结束的完整自然周」报告（period_type='week'）→ 渲染 PDF（§6.2 同引擎，任务
 *   **不经 export_job 载体**——订阅投递走 delivery 行，避免任务列表被系统投递刷屏）
 *   → SMTP 投递 → 写 fdd_digest_delivery（sent/failed）；无报告周 skipped + no_report
 *   不伪造；同订阅同期 UNIQUE——tick 幂等，重投不插行；
 * - SMTP 不可达 → failed + failure_msg（错误摘要不含收件地址全文，PII 纪律）；投递
 *   失败不影响报告本体（PRD 卡 R6）；
 * - 租户枚举经 AUTH_DB internal_read 旁路（proposal expiry-sweeper 同款），
 *   每租户 withTenant 独立事务（ddl.md §5.2）；
 * - 埋点 fdd_digest_delivered（结构化日志带 report_id/recipients_count 属性；Counter
 *   只取低基数 event label，DAT-242 R2 纪律）。
 */
import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { Logger } from 'pino';
import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  FDD_DIGEST_RECIPIENTS_MAX,
  FDD_DIGEST_SCHEDULE,
  type FddDigestConfig,
  type FddDigestDeliveryItem,
  type FddDigestDeliveryList,
  type FddDigestDeliveriesQuery,
  type FddDigestPut,
  type FddDigestRecipient,
  type FddReportItem,
} from '@thermio/shared-types';
import { AUTH_DB_POOL, TENANT_DB } from '../infrastructure/db/db.tokens.js';
import type { TenantDb } from '../infrastructure/db/tenant-db.js';
import { LOGGER } from '../infrastructure/logger.js';
import { APP_CONFIG } from '../infrastructure/core.module.js';
import type { AppConfig } from '../config.js';
import { getRequestContext } from '../infrastructure/request-context.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { loadBuildingScope } from '../asset/asset-shared.js';
import { decodeFddCursor, encodeFddCursor, fddKeysetPredicate } from '../fdd/fdd-cursor.js';
import { buildFddReportHtml, type FddPdfRenderer } from './kpi-fdd-pdf.js';
import type { KpiActor } from './kpi.service.js';
import type { DigestMailer } from './kpi-mailer.js';
import { KPI_MAILER, KPI_PDF_RENDERER } from './kpi.tokens.js';
import { KpiMetrics } from './kpi.metrics.js';
import { SHANGHAI_OFFSET_MS } from './kpi-bucket.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

@Injectable()
export class KpiDigestService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger: Logger;
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    @Inject(TENANT_DB) private readonly db: TenantDb | null,
    @Inject(AUTH_DB_POOL) private readonly authPool: Pool | null,
    @Inject(LOGGER) rootLogger: Logger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(KPI_MAILER) private readonly mailer: DigestMailer,
    @Inject(KPI_PDF_RENDERER) private readonly renderer: FddPdfRenderer,
    @Inject(KpiMetrics) private readonly metrics: KpiMetrics,
  ) {
    this.logger = rootLogger.child({ component: 'kpi-digest' });
  }

  private requireDb(): TenantDb {
    if (this.db === null) throw new ReasonCodeException('common.internal_error', '数据库未接线');
    return this.db;
  }

  onModuleInit(): void {
    if (this.db === null || this.authPool === null) {
      this.logger.warn({ msg: 'kpi_digest_scheduler_disabled', hint: 'DB 未接线' });
      return;
    }
    const interval = this.config.KPI_DIGEST_SWEEP_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.sweep(new Date()).catch((err: unknown) => {
        this.logger.error({ msg: 'kpi_digest_sweep_failed', err });
      });
    }, interval);
    this.timer.unref();
    this.logger.info({ msg: 'kpi_digest_scheduler_started', sweep_interval_ms: interval });
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  // ═══════════ §5.8 GET/PUT /fdd/digest ═══════════

  async digestConfig(actor: KpiActor, buildingId: string): Promise<FddDigestConfig> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const building = await this.assertBuilding(tx, actor, buildingId);
      const row = await tx.query<{
        enabled: boolean;
        recipients: unknown;
        updated_by_name: string | null;
        updated_at: Date | null;
      }>(
        `SELECT s.enabled, s.recipients, u.display_name AS updated_by_name, s.updated_at
         FROM fdd_digest_subscription s
         LEFT JOIN app_user u ON u.tenant_id = s.tenant_id AND u.id = s.updated_by
         WHERE s.tenant_id = $1 AND s.building_id = $2`,
        [actor.tenant_id, buildingId],
      );
      const found = row.rows[0];
      if (found === undefined) {
        // 无订阅 = 缺省形状（enabled=false、recipients=[]），不 404（§5.8）
        return {
          building,
          enabled: false,
          period_type: 'week' as const,
          schedule: FDD_DIGEST_SCHEDULE,
          recipients: [],
          updated_by_name: null,
          updated_at: null,
        };
      }
      return {
        building,
        enabled: found.enabled,
        period_type: 'week' as const,
        schedule: FDD_DIGEST_SCHEDULE,
        recipients: recipientsOf(found.recipients),
        updated_by_name: found.updated_by_name,
        updated_at: found.updated_at === null ? null : new Date(found.updated_at).toISOString(),
      };
    });
  }

  async putDigestConfig(
    actor: KpiActor,
    buildingId: string,
    body: FddDigestPut,
  ): Promise<FddDigestConfig> {
    // 逐项邮箱校验 + ≤20 上限 → 422 digest.recipient_invalid（details 序号，§5.8/§5.9-11）
    if (body.recipients.length > FDD_DIGEST_RECIPIENTS_MAX) {
      throw new ReasonCodeException(
        'digest.recipient_invalid',
        `收件人超 ${String(FDD_DIGEST_RECIPIENTS_MAX)} 人上限`,
        { limit: FDD_DIGEST_RECIPIENTS_MAX, count: body.recipients.length },
      );
    }
    const badIndex = body.recipients.findIndex((r) => !EMAIL_RE.test(r.email));
    if (badIndex >= 0) {
      throw new ReasonCodeException(
        'digest.recipient_invalid',
        `第 ${String(badIndex + 1)} 项收件人邮箱格式非法`,
        { index: badIndex + 1 },
      );
    }
    const db = this.requireDb();
    await db.withTenant(actor.tenant_id, async (tx) => {
      await this.assertBuilding(tx, actor, buildingId);
      await tx.query(
        `INSERT INTO fdd_digest_subscription (tenant_id, building_id, enabled, period_type, schedule, recipients, updated_by)
         VALUES ($1, $2, $3, 'week', $4, $5::jsonb, $6)
         ON CONFLICT (tenant_id, building_id)
           DO UPDATE SET enabled = EXCLUDED.enabled, recipients = EXCLUDED.recipients,
                         updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [
          actor.tenant_id,
          buildingId,
          body.enabled,
          FDD_DIGEST_SCHEDULE,
          JSON.stringify(body.recipients),
          actor.user_id,
        ],
      );
      // 留痕 = 行内 updated_by/updated_at + 结构化日志（§3.3 审计承载定夺）
      const context = getRequestContext();
      this.logger.info({
        msg: 'fdd_digest_config_updated',
        ...(context !== null ? { request_id: context.request_id } : {}),
        tenant_id: actor.tenant_id,
        building_id: buildingId,
        actor: actor.user_id,
        enabled: body.enabled,
        recipients_count: body.recipients.length,
      });
    });
    return this.digestConfig(actor, buildingId);
  }

  // ═══════════ §5.8 GET /fdd/digest/deliveries ═══════════

  async deliveries(
    actor: KpiActor,
    query: FddDigestDeliveriesQuery,
  ): Promise<FddDigestDeliveryList> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const scope = await loadBuildingScope(tx, actor);
      const params: unknown[] = [actor.tenant_id];
      const where: string[] = ['d.tenant_id = $1'];
      if (query.building_id !== undefined) {
        await this.assertBuilding(tx, actor, query.building_id);
        params.push(query.building_id);
        where.push(`s.building_id = $${String(params.length)}::uuid`);
      } else if (scope !== null) {
        params.push([...scope]);
        where.push(`s.building_id = ANY($${String(params.length)}::uuid[])`);
      }
      if (query.from !== undefined) {
        params.push(query.from.slice(0, 10));
        where.push(`d.period_start >= $${String(params.length)}::date`);
      }
      if (query.to !== undefined) {
        params.push(query.to.slice(0, 10));
        where.push(`d.period_start < $${String(params.length)}::date`);
      }
      if (query.cursor !== undefined) {
        const cursor = decodeFddCursor(query.cursor, 1);
        const predicate = fddKeysetPredicate(
          '(extract(epoch from d.created_at) * 1000000)::bigint',
          'd.id::text',
          cursor,
          params.length + 1,
        );
        where.push(predicate.sql);
        params.push(...predicate.params);
      }
      const limit = query.limit;
      const result = await tx.query<Record<string, unknown>>(
        `SELECT d.id, s.building_id, b.name AS building_name,
                d.period_start::text AS period_start, d.period_end::text AS period_end,
                d.report_id, d.status, d.skip_reason, d.recipients_count, d.failure_msg,
                d.delivered_at, d.created_at
         FROM fdd_digest_delivery d
         JOIN fdd_digest_subscription s ON s.tenant_id = d.tenant_id AND s.id = d.subscription_id
         JOIN building b ON b.tenant_id = s.tenant_id AND b.id = s.building_id
         WHERE ${where.join(' AND ')}
         ORDER BY d.created_at DESC, d.id DESC
         LIMIT ${String(limit + 1)}`,
        params,
      );
      const rows = result.rows;
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page.map(deliveryItemOf),
        next_cursor:
          rows.length > limit && last !== undefined
            ? encodeFddCursor({
                k: [String(BigInt(Math.floor(new Date(last.created_at as Date).getTime() * 1000)))],
                id: last.id as string,
              })
            : null,
      };
    });
  }

  // ═══════════ §6.4 每周一 08:00 调度（BF-11.1） ═══════════

  /** 扫描入口（并发重入保护）：周一 08:00 后（本地时区）补投上一完整自然周。 */
  private async sweep(now: Date): Promise<{ delivered: number; skipped: number }> {
    if (this.sweeping) return { delivered: 0, skipped: 0 };
    this.sweeping = true;
    try {
      return await this.deliverWeeklyTick(now);
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * 周投递 tick（exported for e2e 直调注入模拟时钟，§9.5）：
   * 目标期 = 当前所在周的上一完整自然周 [本周一−7d, 本周一)（本地日界）；now 早于
   * 周一 08:00 → 本窗未到投递时刻，no-op；已投（同期行存在）→ no-op（幂等）。
   */
  async deliverWeeklyTick(now: Date): Promise<{ delivered: number; skipped: number }> {
    const db = this.requireDb();
    const pool = this.authPool;
    if (pool === null) return { delivered: 0, skipped: 0 };
    const { startDate, endDate, due } = weeklyPeriodOf(now);
    if (!due) return { delivered: 0, skipped: 0 };
    const tenants = await pool.query<{ id: string }>(
      `SELECT id FROM tenant ORDER BY created_at, id`,
    );
    let delivered = 0;
    let skipped = 0;
    for (const tenant of tenants.rows) {
      const subs = await db.withTenant(tenant.id, async (tx) => {
        const result = await tx.query<{
          subscription_id: string;
          building_id: string;
          recipients: unknown;
        }>(
          `SELECT id AS subscription_id, building_id, recipients
           FROM fdd_digest_subscription WHERE enabled ORDER BY id`,
        );
        return result.rows.map((r) => ({
          tenant_id: tenant.id,
          subscription_id: r.subscription_id,
          building_id: r.building_id,
          recipients: recipientsOf(r.recipients),
        }));
      });
      for (const sub of subs) {
        if (sub.recipients.length === 0) {
          // 启用但零收件人：无投递面，不落行（配置面问题，记录待配置侧收口）
          this.logger.warn({
            msg: 'kpi_digest_empty_recipients_skipped',
            tenant_id: sub.tenant_id,
            subscription_id: sub.subscription_id,
          });
          continue;
        }
        try {
          const outcome = await this.deliverOne(sub, startDate, endDate);
          if (outcome === 'sent') delivered += 1;
          else if (outcome === 'skipped') skipped += 1;
        } catch (err) {
          this.logger.warn({
            msg: 'kpi_digest_delivery_crashed',
            subscription_id: sub.subscription_id,
            err,
          });
        }
      }
    }
    return { delivered, skipped };
  }

  /** 单订阅投递：无报告 → skipped；有报告 → 渲染 + SMTP → sent/failed；同期幂等。 */
  private async deliverOne(
    sub: {
      readonly tenant_id: string;
      readonly subscription_id: string;
      readonly building_id: string;
      readonly recipients: readonly FddDigestRecipient[];
    },
    startDate: string,
    endDate: string,
  ): Promise<'sent' | 'failed' | 'skipped' | 'noop'> {
    const db = this.requireDb();
    // ① 同期幂等门 + 报告取数（短事务；渲染不入事务——周投递量级无竞争压力，
    //    同期 UNIQUE 兜底并发双实例窄窗）
    const load = await db.withTenant(sub.tenant_id, async (tx) => {
      const existing = await tx.query<{ id: string }>(
        `SELECT id FROM fdd_digest_delivery
         WHERE tenant_id = $1 AND subscription_id = $2 AND period_start = $3::date`,
        [sub.tenant_id, sub.subscription_id, startDate],
      );
      if (existing.rows.length > 0) return 'noop' as const;
      const report = await loadWeekReport(tx, sub.tenant_id, sub.building_id, startDate, endDate);
      return { report };
    });
    if (load === 'noop') return 'noop';
    const { report } = load;
    if (report === null) {
      // ② 该期报告未生成 → skipped + no_report，不伪造空报告（§6.4/§5.9-12）
      await db.withTenant(sub.tenant_id, async (tx) => {
        await insertDelivery(tx, sub, startDate, endDate, {
          status: 'skipped',
          skip_reason: 'no_report',
        });
      });
      this.metrics.lifecycleEvents.inc({ event: 'fdd_digest_skipped' });
      this.logger.info({
        msg: 'fdd_digest_skipped',
        tenant_id: sub.tenant_id,
        subscription_id: sub.subscription_id,
        period: { start: startDate, end: endDate },
      });
      return 'skipped';
    }
    // ③ 渲染（§6.2 同引擎）→ SMTP → 记录（§6.4：任务不经 export_job 载体）
    const input = {
      report,
      exportNo: `DG-${report.id.slice(0, 8)}`,
      exportedByName: '系统调度（周一 08:00 订阅投递）',
      exportedAt: new Date().toISOString(),
    };
    const bytes = await this.renderer.render(input);
    const result = await this.mailer.send({
      subject: `FDD 周报 · ${report.building.name} · ${startDate} ~ ${endDate}`,
      html: buildFddReportHtml(input),
      pdfBytes: bytes,
      pdfFilename: `fdd-weekly-${startDate}.pdf`,
      recipients: sub.recipients,
    });
    await db.withTenant(sub.tenant_id, async (tx) => {
      if (result.kind === 'sent') {
        await insertDelivery(tx, sub, startDate, endDate, {
          status: 'sent',
          report_id: report.id,
          delivered_at: result.delivered_at,
        });
      } else {
        await insertDelivery(tx, sub, startDate, endDate, {
          status: 'failed',
          report_id: report.id,
          failure_msg: result.failure_msg,
        });
      }
    });
    if (result.kind === 'sent') {
      this.metrics.lifecycleEvents.inc({ event: 'fdd_digest_delivered' });
      this.logger.info({
        msg: 'fdd_digest_delivered',
        tenant_id: sub.tenant_id,
        subscription_id: sub.subscription_id,
        report_id: report.id,
        recipients_count: sub.recipients.length,
      });
      return 'sent';
    }
    this.logger.warn({
      msg: 'fdd_digest_failed',
      tenant_id: sub.tenant_id,
      subscription_id: sub.subscription_id,
      report_id: report.id,
      failure_msg: result.failure_msg,
    });
    return 'failed';
  }

  /** 楼宇存在 + 归属校验（越界/不存在同 404 asset.not_found）。 */
  private async assertBuilding(
    tx: PoolClient,
    actor: KpiActor,
    buildingId: string,
  ): Promise<{ id: string; name: string }> {
    const scope = await loadBuildingScope(tx, actor);
    const result = await tx.query<{ id: string; name: string }>(
      `SELECT id, name FROM building WHERE tenant_id = $1 AND id = $2::uuid`,
      [actor.tenant_id, buildingId],
    );
    const row = result.rows[0];
    if (row === undefined || (scope !== null && !scope.has(buildingId))) {
      throw new ReasonCodeException('asset.not_found', '资源不存在', { entity: 'building' });
    }
    return { id: row.id, name: row.name };
  }
}

// ---------------------------------------------------------------------------
// 纯辅助
// ---------------------------------------------------------------------------

function deliveryItemOf(row: Record<string, unknown>): FddDigestDeliveryItem {
  return {
    id: row.id as string,
    building: { id: row.building_id as string, name: (row.building_name as string | null) ?? '' },
    period: { start: row.period_start as string, end: row.period_end as string },
    report_id: (row.report_id as string | null) ?? null,
    status: row.status as FddDigestDeliveryItem['status'],
    skip_reason: (row.skip_reason as string | null) ?? null,
    recipients_count: Number(row.recipients_count),
    failure_msg: (row.failure_msg as string | null) ?? null,
    delivered_at:
      row.delivered_at === null || row.delivered_at === undefined
        ? null
        : new Date(row.delivered_at as Date).toISOString(),
    created_at: new Date(row.created_at as Date).toISOString(),
  };
}

/** 周 tick 目标期（§6.4）：[本周一−7d, 本周一) 本地日界；due = now ≥ 周一 08:00。 */
export function weeklyPeriodOf(now: Date): {
  startDate: string;
  endDate: string;
  due: boolean;
} {
  const local = now.getTime() + SHANGHAI_OFFSET_MS;
  const dayIndex = Math.floor(local / 86_400_000);
  const dow = (dayIndex + 3) % 7; // dayIndex 0 = 1970-01-01（周四）→ 周一=0…周日=6
  const dayStart = dayIndex * 86_400_000;
  const thisMonday = dayStart - dow * 86_400_000; // 本地周一 0 点的 epoch（= UTC 前日 16:00）
  const due = local - dayStart >= 8 * 3_600_000;
  // 本地日期串：epoch + 偏移后取 UTC 日期（本地 0 点 +8h = 该本地日的 UTC 0 点）
  const localDate = (epoch: number): string =>
    new Date(epoch + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
  return {
    startDate: localDate(thisMonday - 7 * 86_400_000),
    endDate: localDate(thisMonday),
    due,
  };
}

/** 该楼该期周报（period = daterange(start,end) 精确匹配；无 → null）。 */
async function loadWeekReport(
  tx: PoolClient,
  tenantId: string,
  buildingId: string,
  startDate: string,
  endDate: string,
): Promise<FddReportItem | null> {
  const result = await tx.query<Record<string, unknown>>(
    `SELECT r.id, r.building_id, b.name AS building_name, r.period_type,
            lower(r.period)::text AS period_start, upper(r.period)::text AS period_end,
            r.summary, r.generated_at, r.algo_version
     FROM fdd_report r
     JOIN building b ON b.tenant_id = r.tenant_id AND b.id = r.building_id
     WHERE r.tenant_id = $1 AND r.building_id = $2::uuid AND r.period_type = 'week'
       AND r.period = daterange($3::date, $4::date)`,
    [tenantId, buildingId, startDate, endDate],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const { FddReportSummarySchema } = await import('@thermio/shared-types');
  const summary = FddReportSummarySchema.safeParse(row.summary);
  if (!summary.success) return null;
  return {
    id: row.id as string,
    building: { id: row.building_id as string, name: (row.building_name as string | null) ?? '' },
    period_type: 'week',
    period: { start: row.period_start as string, end: row.period_end as string },
    summary: summary.data,
    generated_at: new Date(row.generated_at as Date).toISOString(),
    algo_version: (row.algo_version as string | null) ?? null,
  };
}

interface DeliveryWrite {
  status: 'sent' | 'failed' | 'skipped';
  report_id?: string;
  skip_reason?: string;
  failure_msg?: string;
  delivered_at?: string;
}

/** 投递行写入（同期 UNIQUE 兜底：冲突即已被并发实例投递，DO NOTHING）。 */
async function insertDelivery(
  tx: PoolClient,
  sub: {
    readonly tenant_id: string;
    readonly subscription_id: string;
    readonly recipients: readonly unknown[];
  },
  startDate: string,
  endDate: string,
  write: DeliveryWrite,
): Promise<void> {
  await tx.query(
    `INSERT INTO fdd_digest_delivery
       (id, tenant_id, subscription_id, report_id, period_start, period_end, status,
        skip_reason, recipients_count, failure_msg, delivered_at)
     VALUES ($1, $2, $3, $4, $5::date, $6::date, $7, $8, $9, $10, $11::timestamptz)
     ON CONFLICT (tenant_id, subscription_id, period_start) DO NOTHING`,
    [
      randomUUID(),
      sub.tenant_id,
      sub.subscription_id,
      write.report_id ?? null,
      startDate,
      endDate,
      write.status,
      write.skip_reason ?? null,
      sub.recipients.length,
      write.failure_msg ?? null,
      write.delivered_at ?? null,
    ],
  );
}

/** recipients jsonb → wire 形状（脏数据防御：逐项过滤，不崩不静默吞）。 */
function recipientsOf(raw: unknown): FddDigestRecipient[] {
  const parsed = z
    .array(z.object({ email: z.string(), note: z.string().optional() }))
    .safeParse(raw);
  if (!parsed.success) return [];
  return parsed.data.filter((r: { email: string }) => EMAIL_RE.test(r.email));
}
