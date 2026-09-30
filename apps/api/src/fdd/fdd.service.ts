/**
 * FDD 查看与人工记录服务（modules/M6-fdd.md §5，IMPL-16 切片 / DAT-212）。
 *
 * 纪律落点：
 * - M6 一切端点只读写 PG 业务表（fdd_finding/fdd_report），不碰 TimescaleDB——
 *   证据曲线数据经 M1 GET /points/{id}/telemetry 前端复用（M6 §0 铁律 1）；
 * - 读写全部经 TenantDb.withTenant（ddl.md §5.2）；楼宇可见范围 = user_building_scope
 *   （admin 全租户，SEC-AZ-02）；越权/不存在同响应 404 fdd.*_not_found（SEC-AZ-03）；
 * - 活跃窗口谓词（§5.2：first < to ∧ effective_end 为空 ∨ ≥ from，effective_end =
 *   COALESCE(resolved_at, ignored_at)）与 internal 读面一处定义两处消费；
 * - review/ignore 只写 review_* 与 ignored_* 列（§1 写路径字段集与 internal 面不相交）；
 *   ignore reason / review 动作留结构化日志（CODE-LOG-03），不入 config_audit（§5.4）。
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { PoolClient } from 'pg';
import {
  ALARM_SEVERITIES,
  FddEvidenceSchema,
  FddReportSummarySchema,
  type AlarmSeverity,
  type FddFindingDetail,
  type FddFindingListItem,
  type FddFindingList,
  type FddFindingsQuery,
  type FddOverview,
  type FddReportItem,
  type FddReportList,
  type FddReportsQuery,
  type FddReviewRequest,
  type FddReviewResult,
} from '@thermio/shared-types';
import { TENANT_DB } from '../infrastructure/db/db.tokens.js';
import type { TenantDb } from '../infrastructure/db/tenant-db.js';
import { LOGGER } from '../infrastructure/logger.js';
import { getRequestContext } from '../infrastructure/request-context.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { loadBuildingScope, type BuildingScope } from '../asset/asset-shared.js';
import { decodeFddCursor, encodeFddCursor, fddKeysetPredicate } from './fdd-cursor.js';

/** 请求侧身份（AuthContext 的 FDD 域消费面；role 供楼宇授权推导，M1-asset §1.5）。 */
export interface FddActor {
  readonly tenant_id: string;
  readonly user_id: string;
  readonly role: 'admin' | 'operator' | 'viewer';
}

/** 发现行公共列（列表/详情共用底料；evidence 仅详情取）。 */
const FINDING_LIST_COLUMNS = `f.id, f.rule_key, f.severity, f.status, f.title,
       f.suggested_action, f.algo_version, f.first_detected_at, f.last_detected_at,
       f.resolved_at, f.ignored_at, f.review_result, f.reviewed_at, f.created_at,
       s.building_id, e.id AS equipment_id, e.name AS equipment_name,
       e.local_id AS equipment_local_id, e.equipment_type`;

const FINDING_JOINS = `FROM fdd_finding f
       JOIN equipment e ON e.tenant_id = f.tenant_id AND e.id = f.equipment_id
       JOIN hvac_system s ON s.tenant_id = e.tenant_id AND s.id = e.system_id`;

interface FindingRow {
  readonly id: string;
  readonly rule_key: string;
  readonly severity: string;
  readonly status: string;
  readonly title: string;
  readonly suggested_action: string | null;
  readonly algo_version: string;
  readonly first_detected_at: Date;
  readonly last_detected_at: Date;
  readonly resolved_at: Date | null;
  readonly ignored_at: Date | null;
  readonly review_result: string | null;
  readonly reviewed_at: Date | null;
  readonly created_at: Date;
  readonly building_id: string;
  readonly equipment_id: string;
  readonly equipment_name: string;
  readonly equipment_local_id: string | null;
  readonly equipment_type: string;
}

/** 详情行附加列（判定/忽略全量留痕 + 服务端 join 人名，M6 §4.3）。 */
interface FindingDetailRow extends FindingRow {
  readonly evidence: unknown;
  readonly alarm_event_id: string | null;
  readonly review_note: string | null;
  readonly reviewed_by: string | null;
  readonly reviewed_by_name: string | null;
  readonly ignored_by: string | null;
  readonly ignored_by_name: string | null;
  readonly updated_at: Date;
}

function findingItemOf(row: FindingRow): FddFindingListItem {
  return {
    id: row.id,
    building_id: row.building_id,
    equipment: {
      id: row.equipment_id,
      name: row.equipment_name,
      local_id: row.equipment_local_id,
      equipment_type: row.equipment_type,
    },
    rule_key: row.rule_key,
    severity: row.severity as AlarmSeverity,
    status: row.status as FddFindingListItem['status'],
    title: row.title,
    suggested_action: row.suggested_action,
    algo_version: row.algo_version,
    first_detected_at: row.first_detected_at.toISOString(),
    last_detected_at: row.last_detected_at.toISOString(),
    resolved_at: row.resolved_at === null ? null : row.resolved_at.toISOString(),
    ignored_at: row.ignored_at === null ? null : row.ignored_at.toISOString(),
    review:
      row.review_result === null || row.reviewed_at === null
        ? null
        : {
            result: row.review_result as FddReviewResult,
            reviewed_at: row.reviewed_at.toISOString(),
          },
    created_at: row.created_at.toISOString(),
  };
}

function findingDetailOf(row: FindingDetailRow): FddFindingDetail {
  const evidence = FddEvidenceSchema.safeParse(row.evidence);
  if (!evidence.success) {
    throw new ReasonCodeException('common.internal_error', '发现证据数据缺失或不合规');
  }
  return {
    ...findingItemOf(row),
    evidence: evidence.data,
    alarm_event_id: row.alarm_event_id === null ? null : Number(row.alarm_event_id),
    review:
      row.review_result === null || row.reviewed_at === null || row.reviewed_by === null
        ? null
        : {
            result: row.review_result as FddReviewResult,
            note: row.review_note,
            reviewed_by: row.reviewed_by,
            reviewed_by_name: row.reviewed_by_name ?? '',
            reviewed_at: row.reviewed_at.toISOString(),
          },
    ignored_by_name: row.ignored_by_name,
    updated_at: row.updated_at.toISOString(),
  };
}

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

function reportItemOf(row: ReportRow): FddReportItem {
  const summary = FddReportSummarySchema.safeParse(row.summary);
  if (!summary.success) {
    // 入库前已 zod 校验（R2）——读侧仍防御：脏 summary 不静默渲染进报告页
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

const REPORT_COLUMNS = `r.id, r.building_id, b.name AS building_name, r.period_type,
       lower(r.period)::text AS period_start, upper(r.period)::text AS period_end,
       r.summary, r.generated_at, r.algo_version`;

const REPORT_JOINS = `FROM fdd_report r
       JOIN building b ON b.tenant_id = r.tenant_id AND b.id = r.building_id`;

/** 楼宇过滤子句（无过滤 = 空串；scope 非空时强制注入可见集）。 */
interface BuildingClause {
  readonly sql: string;
  readonly params: readonly unknown[];
}

const NO_BUILDING_FILTER: BuildingClause = { sql: '', params: [] };

@Injectable()
export class FddService {
  private readonly logger: Logger;

  constructor(
    @Inject(TENANT_DB) private readonly tenantDb: TenantDb | null,
    @Inject(LOGGER) rootLogger: Logger,
  ) {
    this.logger = rootLogger.child({ component: 'fdd-admin' });
  }

  // -------------------------------------------------------------------
  // GET /fdd/overview（§5.1：open 实时算 + 最新周报健康度 + S3 滚动窗）
  // -------------------------------------------------------------------

  async overview(actor: FddActor, buildingId?: string): Promise<FddOverview> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const scope = await loadBuildingScope(tx, actor);

      // open 计数（实时聚合，五级分布全给 0——前端免兜底）
      const openFilter = await this.buildingFilter(
        tx,
        actor,
        scope,
        buildingId,
        's.building_id',
        2,
      );
      const openResult = await tx.query<{ severity: string; n: number }>(
        `SELECT f.severity, count(*)::int AS n ${FINDING_JOINS}
         WHERE f.tenant_id = $1 AND f.status = 'open'
           ${openFilter.sql !== '' ? `AND ${openFilter.sql}` : ''}
         GROUP BY f.severity`,
        [actor.tenant_id, ...openFilter.params],
      );
      const bySeverity = Object.fromEntries(
        ALARM_SEVERITIES.map((severity) => [severity, 0]),
      ) as Record<AlarmSeverity, number>;
      let openTotal = 0;
      for (const row of openResult.rows) {
        if ((ALARM_SEVERITIES as readonly string[]).includes(row.severity)) {
          bySeverity[row.severity as AlarmSeverity] = row.n;
          openTotal += row.n;
        }
      }

      // 最新一份周报的健康度排名（无报告 = null；全部授权楼宇合并取最新）
      const reportFilter = await this.buildingFilter(
        tx,
        actor,
        scope,
        buildingId,
        'r.building_id',
        2,
      );
      const reportResult = await tx.query<ReportRow>(
        `SELECT ${REPORT_COLUMNS} ${REPORT_JOINS}
         WHERE r.tenant_id = $1 AND r.period_type = 'week'
           ${reportFilter.sql !== '' ? `AND ${reportFilter.sql}` : ''}
         ORDER BY r.generated_at DESC LIMIT 1`,
        [actor.tenant_id, ...reportFilter.params],
      );
      const latestReport = reportResult.rows[0];
      const health =
        latestReport === undefined
          ? null
          : {
              report_id: latestReport.id,
              period: { start: latestReport.period_start, end: latestReport.period_end },
              generated_at: latestReport.generated_at.toISOString(),
              ranking: reportItemOf(latestReport).summary.health_ranking,
            };

      // S3 滚动窗口（近 7×24h；采样框 = 窗口内新增，分母只计已抽检，§8）
      const windowFrom = new Date(Date.now() - 7 * 24 * 3600 * 1000);
      const statsFilter = await this.buildingFilter(
        tx,
        actor,
        scope,
        buildingId,
        's.building_id',
        3,
      );
      const statsResult = await tx.query<{
        new_findings: number;
        reviewed: number;
        confirmed: number;
        false_positive: number;
      }>(
        `SELECT count(*)::int AS new_findings,
                count(*) FILTER (WHERE f.review_result IS NOT NULL)::int AS reviewed,
                count(*) FILTER (WHERE f.review_result = 'confirmed')::int AS confirmed,
                count(*) FILTER (WHERE f.review_result = 'false_positive')::int AS false_positive
         ${FINDING_JOINS}
         WHERE f.tenant_id = $1 AND f.first_detected_at >= $2::timestamptz
           ${statsFilter.sql !== '' ? `AND ${statsFilter.sql}` : ''}`,
        [actor.tenant_id, windowFrom.toISOString(), ...statsFilter.params],
      );
      const stats = statsResult.rows[0] ?? {
        new_findings: 0,
        reviewed: 0,
        confirmed: 0,
        false_positive: 0,
      };
      const reviewed = stats.reviewed;
      const confirmed = stats.confirmed;

      return {
        building_id: buildingId ?? null,
        open: { total: openTotal, by_severity: bySeverity },
        health,
        review_stats: {
          window_from: windowFrom.toISOString(),
          new_findings: stats.new_findings,
          reviewed,
          confirmed,
          false_positive: stats.false_positive,
          hit_rate: reviewed === 0 ? null : Math.round((confirmed / reviewed) * 1000) / 1000,
        },
      };
    });
  }

  // -------------------------------------------------------------------
  // GET /fdd/findings（§5.2：白名单筛选 + 活跃窗口 + keyset）
  // -------------------------------------------------------------------

  async listFindings(actor: FddActor, query: FddFindingsQuery): Promise<FddFindingList> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const scope = await loadBuildingScope(tx, actor);
      const where: string[] = ['f.tenant_id = $1'];
      const params: unknown[] = [actor.tenant_id];
      let next = 2;
      const filter = await this.buildingFilter(
        tx,
        actor,
        scope,
        query.building_id,
        's.building_id',
        next,
      );
      if (filter.sql !== '') {
        where.push(filter.sql);
        params.push(...filter.params);
        next += filter.params.length;
      }
      if (query.equipment_id !== undefined) {
        where.push(`f.equipment_id = $${String(next)}::uuid`);
        params.push(query.equipment_id);
        next += 1;
      }
      if (query.status !== undefined) {
        where.push(`f.status = $${String(next)}::text`);
        params.push(query.status);
        next += 1;
      }
      if (query.severity !== undefined) {
        where.push(`f.severity = $${String(next)}::text`);
        params.push(query.severity);
        next += 1;
      }
      if (query.rule_key !== undefined) {
        where.push(`f.rule_key = $${String(next)}::text`);
        params.push(query.rule_key);
        next += 1;
      }
      if (query.review !== undefined) {
        // S3 采样（§5.2）：unreviewed = 未抽检（抽检对任意 status 合法，§5.4）
        where.push(
          query.review === 'unreviewed'
            ? 'f.review_result IS NULL'
            : `f.review_result = $${String(next)}::text`,
        );
        if (query.review !== 'unreviewed') {
          params.push(query.review);
          next += 1;
        }
      }
      // 活跃窗口谓词（§5.2 一处定义两处消费；to 开区间）
      if (query.to !== undefined) {
        where.push(`f.first_detected_at < $${String(next)}::timestamptz`);
        params.push(query.to);
        next += 1;
      }
      if (query.from !== undefined) {
        where.push(
          `(COALESCE(f.resolved_at, f.ignored_at) IS NULL
             OR COALESCE(f.resolved_at, f.ignored_at) >= $${String(next)}::timestamptz)`,
        );
        params.push(query.from);
        next += 1;
      }
      if (query.cursor !== undefined) {
        const cursor = decodeFddCursor(query.cursor, 1);
        const predicate = fddKeysetPredicate(
          '(extract(epoch from f.last_detected_at) * 1000000)::bigint',
          'f.id::text',
          cursor,
          next,
        );
        where.push(predicate.sql);
        params.push(...predicate.params);
      }
      const limit = query.limit;
      const result = await tx.query<FindingRow>(
        `SELECT ${FINDING_LIST_COLUMNS} ${FINDING_JOINS}
         WHERE ${where.join(' AND ')}
         ORDER BY f.last_detected_at DESC, f.id DESC
         LIMIT ${String(limit + 1)}`,
        params,
      );
      const rows = result.rows;
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      return {
        items: page.map(findingItemOf),
        next_cursor:
          hasMore && last !== undefined
            ? encodeFddCursor({
                k: [String(BigInt(Math.floor(last.last_detected_at.getTime() * 1000)))],
                id: last.id,
              })
            : null,
      };
    });
  }

  // -------------------------------------------------------------------
  // GET /fdd/findings/{id}（§5.3）
  // -------------------------------------------------------------------

  async findingDetail(actor: FddActor, findingId: string): Promise<FddFindingDetail> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const { row } = await this.loadFindingDetail(tx, actor, findingId);
      return findingDetailOf(row);
    });
  }

  // -------------------------------------------------------------------
  // PUT /fdd/findings/{id}/review（§5.4：S3 记录入口，设置/覆写，任意 status）
  // -------------------------------------------------------------------

  async reviewFinding(
    actor: FddActor,
    findingId: string,
    body: FddReviewRequest,
  ): Promise<FddFindingDetail> {
    const db = this.requireDb();
    await db.withTenant(actor.tenant_id, async (tx) => {
      const row = await this.lockFinding(tx, actor, findingId);
      await tx.query(
        `UPDATE fdd_finding
         SET review_result = $3, review_note = $4, reviewed_by = $5, reviewed_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [actor.tenant_id, findingId, body.result, body.note ?? null, actor.user_id],
      );
      // 动作留结构化日志（CODE-LOG-03）；抽检是运营记录不入 config_audit（§5.4 审计定位）
      const context = getRequestContext();
      this.logger.info({
        msg: 'fdd_finding_reviewed',
        ...(context !== null ? { request_id: context.request_id } : {}),
        tenant_id: actor.tenant_id,
        finding_id: findingId,
        reviewed_by: actor.user_id,
        result: body.result,
        ...(body.note !== undefined ? { note: body.note } : {}),
        rule_key: row.rule_key,
      });
    });
    return this.findingDetail(actor, findingId);
  }

  // -------------------------------------------------------------------
  // POST /fdd/findings/{id}/ignore（§5.5：open → ignored；已 ignored 幂等 200）
  // -------------------------------------------------------------------

  async ignoreFinding(
    actor: FddActor,
    findingId: string,
    reason: string,
  ): Promise<FddFindingDetail> {
    const db = this.requireDb();
    await db.withTenant(actor.tenant_id, async (tx) => {
      const row = await this.lockFinding(tx, actor, findingId);
      if (row.status === 'resolved') {
        // resolved 为系统终态不可人工忽略（§5.5 状态守卫）
        throw new ReasonCodeException('fdd.state_invalid', '该发现已消除，不可忽略', {
          current_status: row.status,
        });
      }
      if (row.status === 'ignored') return; // 幂等：重复忽略不重写留痕
      await tx.query(
        `UPDATE fdd_finding SET status = 'ignored', ignored_by = $3, ignored_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [actor.tenant_id, findingId, actor.user_id],
      );
      // reason 必填但走结构化日志不落列（与 M4 close 同口径，§5.5）
      const context = getRequestContext();
      this.logger.info({
        msg: 'fdd_finding_ignored',
        ...(context !== null ? { request_id: context.request_id } : {}),
        tenant_id: actor.tenant_id,
        finding_id: findingId,
        ignored_by: actor.user_id,
        reason,
        rule_key: row.rule_key,
      });
    });
    return this.findingDetail(actor, findingId);
  }

  // -------------------------------------------------------------------
  // GET /fdd/reports（§5.6）+ GET /fdd/reports/{id}（§5.7）
  // -------------------------------------------------------------------

  async listReports(actor: FddActor, query: FddReportsQuery): Promise<FddReportList> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const scope = await loadBuildingScope(tx, actor);
      const where: string[] = ['r.tenant_id = $1'];
      const params: unknown[] = [actor.tenant_id];
      let next = 2;
      const filter = await this.buildingFilter(
        tx,
        actor,
        scope,
        query.building_id,
        'r.building_id',
        next,
      );
      if (filter.sql !== '') {
        where.push(filter.sql);
        params.push(...filter.params);
        next += filter.params.length;
      }
      if (query.period_type !== undefined) {
        where.push(`r.period_type = $${String(next)}::text`);
        params.push(query.period_type);
        next += 1;
      }
      // from/to 过滤 period.start 落于 [from, to)（§5.6；date 与时间戳取日比较）
      if (query.from !== undefined) {
        where.push(`lower(r.period) >= ($${String(next)}::timestamptz)::date`);
        params.push(query.from);
        next += 1;
      }
      if (query.to !== undefined) {
        where.push(`lower(r.period) < ($${String(next)}::timestamptz)::date`);
        params.push(query.to);
        next += 1;
      }
      if (query.cursor !== undefined) {
        const cursor = decodeFddCursor(query.cursor, 1);
        const predicate = fddKeysetPredicate(
          '(extract(epoch from r.generated_at) * 1000000)::bigint',
          'r.id::text',
          cursor,
          next,
        );
        where.push(predicate.sql);
        params.push(...predicate.params);
      }
      const limit = query.limit;
      const result = await tx.query<ReportRow>(
        `SELECT ${REPORT_COLUMNS} ${REPORT_JOINS}
         WHERE ${where.join(' AND ')}
         ORDER BY r.generated_at DESC, r.id DESC
         LIMIT ${String(limit + 1)}`,
        params,
      );
      const rows = result.rows;
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      return {
        items: page.map(reportItemOf),
        next_cursor:
          hasMore && last !== undefined
            ? encodeFddCursor({
                k: [String(BigInt(Math.floor(last.generated_at.getTime() * 1000)))],
                id: last.id,
              })
            : null,
      };
    });
  }

  async reportDetail(actor: FddActor, reportId: string): Promise<FddReportItem> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const scope = await loadBuildingScope(tx, actor);
      const result = await tx.query<ReportRow>(
        `SELECT ${REPORT_COLUMNS} ${REPORT_JOINS}
         WHERE r.tenant_id = $1 AND r.id = $2::uuid`,
        [actor.tenant_id, reportId],
      );
      const row = result.rows[0];
      if (row === undefined || (scope !== null && !scope.has(row.building_id))) {
        throw new ReasonCodeException('fdd.report_not_found', '报告不存在');
      }
      return reportItemOf(row);
    });
  }

  // -------------------------------------------------------------------
  // 内部装配
  // -------------------------------------------------------------------

  private requireDb(): TenantDb {
    if (this.tenantDb === null) {
      throw new ReasonCodeException('common.internal_error', '数据库未配置');
    }
    return this.tenantDb;
  }

  /**
   * 楼宇过滤子句（§5.1 口径：显式值先 load-for-user 归属校验——越界/不存在 →
   * 404 asset.not_found 复用资产域既有码；scope 非空强制注入可见集）。
   */
  private async buildingFilter(
    tx: PoolClient,
    actor: FddActor,
    scope: BuildingScope,
    buildingId: string | undefined,
    column: string,
    startParam: number,
  ): Promise<BuildingClause> {
    if (buildingId !== undefined) {
      const visible = await tx.query<{ id: string }>(
        `SELECT id FROM building WHERE tenant_id = $1 AND id = $2::uuid`,
        [actor.tenant_id, buildingId],
      );
      if (visible.rows.length === 0 || (scope !== null && !scope.has(buildingId))) {
        throw new ReasonCodeException('asset.not_found', '资源不存在', { entity: 'building' });
      }
      return { sql: `${column} = $${String(startParam)}::uuid`, params: [buildingId] };
    }
    if (scope !== null) {
      return { sql: `${column} = ANY($${String(startParam)}::uuid[])`, params: [[...scope]] };
    }
    return NO_BUILDING_FILTER;
  }

  /** 详情底料（load-for-user：先查行再判楼宇归属，越界与不存在同响应 404）。 */
  private async loadFindingDetail(
    tx: PoolClient,
    actor: FddActor,
    findingId: string,
  ): Promise<{ row: FindingDetailRow; scope: BuildingScope }> {
    const scope = await loadBuildingScope(tx, actor);
    const result = await tx.query<FindingDetailRow>(
      `SELECT ${FINDING_LIST_COLUMNS}, f.evidence, f.alarm_event_id,
              f.review_note, f.reviewed_by, ru.display_name AS reviewed_by_name,
              f.ignored_by, iu.display_name AS ignored_by_name, f.updated_at
       ${FINDING_JOINS}
       LEFT JOIN app_user ru ON ru.tenant_id = f.tenant_id AND ru.id = f.reviewed_by
       LEFT JOIN app_user iu ON iu.tenant_id = f.tenant_id AND iu.id = f.ignored_by
       WHERE f.tenant_id = $1 AND f.id = $2::uuid`,
      [actor.tenant_id, findingId],
    );
    const row = result.rows[0];
    if (row === undefined || (scope !== null && !scope.has(row.building_id))) {
      throw new ReasonCodeException('fdd.finding_not_found', '发现不存在');
    }
    return { row, scope };
  }

  /** 写路径行锁（FOR UPDATE；不存在/越楼宇同 404，与详情同码同文案）。 */
  private async lockFinding(
    tx: PoolClient,
    actor: FddActor,
    findingId: string,
  ): Promise<{ status: string; rule_key: string }> {
    const result = await tx.query<{ status: string; rule_key: string; building_id: string }>(
      `SELECT f.status, f.rule_key, s.building_id ${FINDING_JOINS}
       WHERE f.tenant_id = $1 AND f.id = $2::uuid
         FOR UPDATE OF f`,
      [actor.tenant_id, findingId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new ReasonCodeException('fdd.finding_not_found', '发现不存在');
    }
    const scope = await loadBuildingScope(tx, actor);
    if (scope !== null && !scope.has(row.building_id)) {
      throw new ReasonCodeException('fdd.finding_not_found', '发现不存在');
    }
    return row;
  }
}
