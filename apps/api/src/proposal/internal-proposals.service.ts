/**
 * POST /internal/proposals（M5-proposal.md §3.8，UC-M5-6；IMPL-17 / DAT-163）。
 *
 * - 服务凭证面（platform §11）：守卫在控制器（AlgoServiceAuthGuard），本服务只做
 *   业务校验与落库；
 * - 信封校验单源 shared-types ProposalEnvelopeSchema（DAT-104 管道；必填缺失
 *   → 422 proposal.payload_invalid details.cause=required）；
 * - target 解析（§3.8-1）：equipment 全局定位租户（AUTH_DB internal_read 旁路，
 *   0007 迁移）→ withTenant 内 quantity_type + direction 白名单解析点位列；
 *   零命中 target_not_found / 命中>1 target_ambiguous；
 * - expires_at ≤ now → expires_invalid（入口拦下「落地即过期」）；
 * - R2 过渡态（M5 §9）：client_ref（信封 proposal_id）无落列不去重——重试重复
 *   落库风险由 algo 侧「一次生成、重试复用同一 proposal_id」缓解，api 侧无法
 *   幂等（该边界为 R2 验收影响面，交付说明显式声明）；
 * - 限速 60/min（platform §12）→ 429 common.rate_limited。
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { Pool } from 'pg';
import {
  ProposalEnvelopeSchema,
  type ProposalSubmitResponse,
  type ProposalEnvelope,
} from '@thermio/shared-types';
import { AUTH_DB_POOL, TENANT_DB } from '../infrastructure/db/db.tokens.js';
import type { TenantDb } from '../infrastructure/db/tenant-db.js';
import { LOGGER } from '../infrastructure/logger.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { zodFieldIssues } from '../infrastructure/validation/zod-validation.pipe.js';
import { InternalRateLimiter } from '../internal-algo/internal-rate-limit.js';
import { requireRow } from '../asset/asset-shared.js';

@Injectable()
export class InternalProposalsService {
  private readonly logger: Logger;

  constructor(
    @Inject(TENANT_DB) private readonly tenantDb: TenantDb | null,
    @Inject(AUTH_DB_POOL) private readonly authPool: Pool | null,
    @Inject(LOGGER) rootLogger: Logger,
    @Inject(InternalRateLimiter) private readonly rateLimiter: InternalRateLimiter,
  ) {
    this.logger = rootLogger.child({ component: 'proposal-internal-submit' });
  }

  async submit(rawBody: unknown, traceId: string | undefined): Promise<ProposalSubmitResponse> {
    this.rateLimiter.consume('internal:proposals');

    const envelope = this.parseEnvelope(rawBody);
    if (Date.parse(envelope.expires_at) <= Date.now()) {
      throw new ReasonCodeException('proposal.payload_invalid', 'expires_at 已过期', {
        cause: 'expires_invalid',
        field: 'expires_at',
      });
    }

    const tenantId = await this.resolveTenantByEquipment(envelope.target.equipment_id);

    const db = this.requireDb();
    const inserted = await db.withTenant(tenantId, async (tx) => {
      const candidates = await tx.query<{ id: string }>(
        `SELECT id FROM point
         WHERE equipment_id = $1 AND quantity_type = $2
           AND direction IN ('write','readwrite')`,
        [envelope.target.equipment_id, envelope.target.point],
      );
      if (candidates.rows.length === 0) {
        throw new ReasonCodeException('proposal.payload_invalid', '目标点位未命中', {
          cause: 'target_not_found',
          field: 'target.point',
        });
      }
      if (candidates.rows.length > 1) {
        throw new ReasonCodeException('proposal.payload_invalid', '目标点位歧义', {
          cause: 'target_ambiguous',
          field: 'target.point',
          candidates: candidates.rows.length,
        });
      }
      const pointId = candidates.rows[0]?.id as string;
      const row = requireRow(
        (
          await tx.query<{ id: string; expires_at: Date | null }>(
            `INSERT INTO proposal
               (tenant_id, algo, algo_version, equipment_id, point_id, action,
                previous_value, rationale, expected_saving_kw, confidence, evidence,
                expires_at, status, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending', now())
             RETURNING id, expires_at`,
            [
              tenantId,
              envelope.algo,
              envelope.algo_version,
              envelope.target.equipment_id,
              pointId,
              JSON.stringify(envelope.action),
              envelope.previous_value,
              envelope.rationale,
              envelope.expected_saving_kw,
              envelope.confidence,
              JSON.stringify(envelope.evidence),
              envelope.expires_at,
            ],
          )
        ).rows,
        'proposal insert',
      );
      return row;
    });

    // 留痕：服务身份 + trace_id，不记 token（SEC-KEY-02 / platform §11-6）
    this.logger.info({
      msg: 'proposal_submitted',
      service: 'thermio-algo',
      trace_id: traceId,
      tenant_id: tenantId,
      proposal_id: inserted.id,
      client_ref: envelope.proposal_id,
      algo: envelope.algo,
      algo_version: envelope.algo_version,
    });

    return {
      proposal_id: inserted.id,
      client_ref: envelope.proposal_id,
      status: 'pending',
      expires_at: inserted.expires_at === null ? null : inserted.expires_at.toISOString(),
    };
  }

  /** 信封解析：schema 失败 → payload_invalid（缺必填 cause=required，其余 cause=schema）。 */
  private parseEnvelope(rawBody: unknown): ProposalEnvelope {
    const parsed = ProposalEnvelopeSchema.safeParse(rawBody);
    if (parsed.success) return parsed.data;
    const issues = parsed.error.issues;
    // zod v4 缺键 = invalid_type + message「received undefined」（issue 无 received 字段）
    const missing = issues.filter(
      (issue) => issue.code === 'invalid_type' && issue.message.includes('received undefined'),
    );
    throw new ReasonCodeException(
      'proposal.payload_invalid',
      missing.length > 0 ? '信封必填字段缺失' : '信封格式校验失败',
      {
        cause: missing.length > 0 ? 'required' : 'schema',
        issues: zodFieldIssues(parsed.error),
      },
    );
  }

  /** equipment_id → tenant_id（platform §11-5 租户由目标实体解析；0007 internal_read 旁路）。 */
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

  private requireDb(): TenantDb {
    if (this.tenantDb === null) {
      throw new ReasonCodeException('common.internal_error', '数据库未接线');
    }
    return this.tenantDb;
  }
}
