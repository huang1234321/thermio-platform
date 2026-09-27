/**
 * FDD internal 写面服务（algo.md §8.2/§8.3，modules/M6-fdd.md §3.2/§3.4；
 * IMPL-17 并入项 / DAT-163）。
 *
 * - findings 批量 upsert：hits 按 (tenant, equipment_id, rule_key) 活跃行 upsert
 *   （无则 insert status=open，有则仅刷新展示面字段——判定时间轴不变）；
 *   cleared 置 resolved + resolved_at（无活跃行忽略，幂等）；
 *   id/tenant_id/status 等 api 维护字段一律 api 侧维护（报文出现即拒，控制器层 strict）；
 * - reports upsert：同期 UNIQUE (tenant, building, period_type, period) → 重生成
 *   天然可重跑；period 闭开区间 api 构造 daterange；summary 钉死形状入库前校验
 *   （防脏 summary 入库污染报告页，M6 §4.4【提修订 R2】）；
 * - 租户由目标实体解析（platform §11-5）：equipment（0007 旁路）/ building
 *   （0008 旁路）→ withTenant 落库；
 * - findings 提交限速 60/min（platform §12）。
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { Pool } from 'pg';
import type { FddFindingsBatch, FddReportSubmission } from '@thermio/shared-types';
import { AUTH_DB_POOL, TENANT_DB } from '../infrastructure/db/db.tokens.js';
import type { TenantDb } from '../infrastructure/db/tenant-db.js';
import { LOGGER } from '../infrastructure/logger.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { InternalRateLimiter } from '../internal-algo/internal-rate-limit.js';

@Injectable()
export class InternalFddService {
  private readonly logger: Logger;

  constructor(
    @Inject(TENANT_DB) private readonly tenantDb: TenantDb | null,
    @Inject(AUTH_DB_POOL) private readonly authPool: Pool | null,
    @Inject(LOGGER) rootLogger: Logger,
    @Inject(InternalRateLimiter) private readonly rateLimiter: InternalRateLimiter,
  ) {
    this.logger = rootLogger.child({ component: 'fdd-internal' });
  }

  /** POST /internal/fdd/findings：批量 upsert（分组租户事务，M6 §3.2 钉死 SQL 级行为）。 */
  async submitFindings(batch: FddFindingsBatch, traceId: string | undefined): Promise<void> {
    this.rateLimiter.consume('internal:fdd-findings');

    // 租户分组（一批可跨租户——按 equipment 归属分组各起一个租户事务）
    const tenantOf = new Map<string, string>();
    for (const hit of [...batch.hits, ...batch.cleared]) {
      const equipmentId = hit.equipment_id;
      let tenantId = tenantOf.get(equipmentId);
      if (tenantId === undefined) {
        tenantId = await this.resolveTenantByEquipment(equipmentId);
        tenantOf.set(equipmentId, tenantId);
      }
    }
    const byTenant = new Map<string, { hits: typeof batch.hits; cleared: typeof batch.cleared }>();
    for (const hit of batch.hits) {
      const tenantId = tenantOf.get(hit.equipment_id) as string;
      const group = byTenant.get(tenantId) ?? { hits: [], cleared: [] };
      group.hits.push(hit);
      byTenant.set(tenantId, group);
    }
    for (const cleared of batch.cleared) {
      const tenantId = tenantOf.get(cleared.equipment_id) as string;
      const group = byTenant.get(tenantId) ?? { hits: [], cleared: [] };
      group.cleared.push(cleared);
      byTenant.set(tenantId, group);
    }

    const db = this.requireDb();
    for (const [tenantId, group] of byTenant) {
      await db.withTenant(tenantId, async (tx) => {
        for (const hit of group.hits) {
          // 活跃唯一索引 (tenant, equipment, rule) WHERE status='open'：无则 insert、
          // 有则仅刷新 last/severity/title/evidence/suggested/algo_version（M6 §3.2）
          await tx.query(
            `INSERT INTO fdd_finding
               (tenant_id, equipment_id, rule_key, algo_version, severity, status,
                title, evidence, suggested_action, first_detected_at, last_detected_at)
             VALUES ($1, $2, $3, $4, $5, 'open', $6, $7, $8, $9, $10)
             ON CONFLICT (tenant_id, equipment_id, rule_key) WHERE status = 'open'
             DO UPDATE SET
               last_detected_at = EXCLUDED.last_detected_at,
               severity = EXCLUDED.severity,
               title = EXCLUDED.title,
               evidence = EXCLUDED.evidence,
               suggested_action = EXCLUDED.suggested_action,
               algo_version = EXCLUDED.algo_version`,
            [
              tenantId,
              hit.equipment_id,
              hit.rule_key,
              batch.algo_version,
              hit.severity,
              hit.title,
              JSON.stringify(hit.evidence),
              hit.suggested_action ?? null,
              hit.first_detected_at,
              hit.last_detected_at,
            ],
          );
        }
        for (const cleared of group.cleared) {
          // 无活跃行则忽略（幂等，重复提交不报错）
          await tx.query(
            `UPDATE fdd_finding SET status = 'resolved', resolved_at = $4
             WHERE tenant_id = $1 AND equipment_id = $2 AND rule_key = $3
               AND status = 'open'`,
            [tenantId, cleared.equipment_id, cleared.rule_key, cleared.cleared_at],
          );
        }
      });
    }

    this.logger.info({
      msg: 'fdd_findings_upserted',
      service: 'thermio-algo',
      trace_id: traceId,
      hits: batch.hits.length,
      cleared: batch.cleared.length,
      algo_version: batch.algo_version,
      tenants: byTenant.size,
    });
  }

  /** POST /internal/fdd/reports：同期 upsert（重生成可重跑，M6 §3.4）。 */
  async submitReport(report: FddReportSubmission, traceId: string | undefined): Promise<void> {
    if (
      Date.parse(`${report.period.start}T00:00:00Z`) >= Date.parse(`${report.period.end}T00:00:00Z`)
    ) {
      throw new ReasonCodeException(
        'common.validation_failed',
        '报告期 start 须早于 end（闭开区间）',
        {
          field: 'period',
        },
      );
    }
    const tenantId = await this.resolveTenantByBuilding(report.building_id);
    const db = this.requireDb();
    await db.withTenant(tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO fdd_report (tenant_id, building_id, period_type, period,
                                  summary, generated_at, algo_version)
         VALUES ($1, $2, $3, daterange($4::date, $5::date, '[)'), $6, now(), $7)
         ON CONFLICT (tenant_id, building_id, period_type, period)
         DO UPDATE SET summary = EXCLUDED.summary,
                       generated_at = now(),
                       algo_version = EXCLUDED.algo_version`,
        [
          tenantId,
          report.building_id,
          report.period_type,
          report.period.start,
          report.period.end,
          JSON.stringify(report.summary),
          report.algo_version,
        ],
      );
    });
    this.logger.info({
      msg: 'fdd_report_upserted',
      service: 'thermio-algo',
      trace_id: traceId,
      tenant_id: tenantId,
      building_id: report.building_id,
      period_type: report.period_type,
      period: report.period,
      algo_version: report.algo_version,
    });
  }

  /** equipment_id → tenant_id（platform §11-5；0007 internal_read 旁路）。 */
  private async resolveTenantByEquipment(equipmentId: string): Promise<string> {
    if (this.authPool === null) {
      throw new ReasonCodeException('common.internal_error', '数据库未接线');
    }
    const result = await this.authPool.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM equipment WHERE id = $1`,
      [equipmentId],
    );
    const tenantId = result.rows[0]?.tenant_id;
    if (tenantId === undefined) {
      throw new ReasonCodeException('asset.not_found', '资源不存在', { entity: 'equipment' });
    }
    return tenantId;
  }

  /** building_id → tenant_id（0008 internal_read 旁路）。 */
  private async resolveTenantByBuilding(buildingId: string): Promise<string> {
    if (this.authPool === null) {
      throw new ReasonCodeException('common.internal_error', '数据库未接线');
    }
    const result = await this.authPool.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM building WHERE id = $1`,
      [buildingId],
    );
    const tenantId = result.rows[0]?.tenant_id;
    if (tenantId === undefined) {
      throw new ReasonCodeException('asset.not_found', '资源不存在', { entity: 'building' });
    }
    return tenantId;
  }

  private requireDb(): TenantDb {
    if (this.tenantDb === null) {
      throw new ReasonCodeException('common.internal_error', '数据库未接线');
    }
    return this.tenantDb;
  }
}
