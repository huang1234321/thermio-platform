/**
 * 告警处置服务（modules M4-alarm.md §3.1–§3.7，IMPL-13 / DAT-116）。
 *
 * 纪律落点：
 * - 读写全部经 TenantDb.withTenant（ddl.md §5.2）；load-for-user 归属校验先行，
 *   越权/不存在同响应 404（SEC-AZ-02/03，alarm.not_found 不区分文案）；
 * - 状态机（§4.2）：重复 ack/close 幂等 200，非法迁移 409 alarm.state_invalid
 *   （details.current_status）；抑制续期 = superseded + 新行（R4）；
 * - 根因组级联（§4.5）：close → 引擎选择性级联（恢复信号已现者关）；suppress/
 *   unsuppress → 全组同动作（cascade 默认 true 仅对组代表行生效）；
 * - 处置动作 = 状态变更事务 + 事务外视图装配（装配开新事务，不嵌套占用连接）。
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { PoolClient } from 'pg';
import {
  ALARM_SUPPRESS_DURATION_S,
  type AlarmBatchAckItem,
  type AlarmBatchAckResponse,
  type AlarmCloseResponse,
  type AlarmCounts,
  type AlarmDetail,
  type AlarmEventView,
  type AlarmListQuery,
  type AlarmListResponse,
  type AlarmRuleSummary,
  type AlarmSeverity,
  type AlarmEventStatus,
  type AlarmSuppressResponse,
  type AlarmScope,
  type AlarmSuppressionEndReason,
  type AlarmSuppressionListItem,
  type AlarmSuppressionListQuery,
  type AlarmSuppressionListResponse,
  type AlarmSuppressionSegment,
  type AlarmTimelineEntry,
  type AlarmUnsuppressResponse,
} from '@thermio/shared-types';
import { TENANT_DB } from '../infrastructure/db/db.tokens.js';
import type { TenantDb } from '../infrastructure/db/tenant-db.js';
import { LOGGER } from '../infrastructure/logger.js';
import { MetricsService } from '../infrastructure/metrics/metrics.service.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { loadBuildingScope, type BuildingScope } from '../asset/asset-shared.js';
import { decodeAlarmCursor, encodeAlarmCursor, timeKeysetPredicate } from './alarm-cursor.js';
import {
  ALARM_SELECT_COLUMNS,
  SOURCE_UNION_SQL,
  foldRowToView,
  loadActiveSuppressions,
  loadChildCounts,
  type AlarmActor,
  type AlarmEventRow,
  type FoldRow,
} from './alarm-shared.js';
import { AlarmEngineService } from './alarm-engine.service.js';

interface SuppressionRow {
  readonly id: string;
  readonly alarm_event_id: string;
  readonly reason: string;
  readonly suppressed_by: string;
  readonly started_at: Date;
  readonly until_at: Date;
  readonly ended_at: Date | null;
  readonly ended_reason: string | null;
}

@Injectable()
export class AlarmsService {
  private readonly logger: Logger;

  constructor(
    @Inject(TENANT_DB) private readonly tenantDb: TenantDb | null,
    @Inject(LOGGER) rootLogger: Logger,
    @Inject(MetricsService) private readonly metrics: MetricsService,
    @Inject(AlarmEngineService) private readonly engine: AlarmEngineService,
  ) {
    this.logger = rootLogger.child({ component: 'alarm-alarms' });
  }

  // -------------------------------------------------------------------
  // GET /alarms（根因折叠视图，§3.1）
  // -------------------------------------------------------------------

  async list(actor: AlarmActor, query: AlarmListQuery): Promise<AlarmListResponse> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const scope = await loadBuildingScope(tx, actor);
      const where: string[] = ['a.tenant_id = $1'];
      const params: unknown[] = [actor.tenant_id];
      let next = 2;
      const expandMode = query.root_group_id !== undefined;

      // 折叠可见性（§3.1）：无 root_group_id 参数 → 独立行 + 组代表行；
      // 根已 closed/suppressed → 组内 open/acked 子告警上浮独立返回（真实故障可见）
      if (expandMode) {
        where.push(`a.root_group_id = $${String(next)}::uuid`);
        params.push(query.root_group_id);
        next += 1;
      } else {
        where.push(
          `(a.root_group_id IS NULL OR a.id = grp.root_id
            OR (root_a.status IN ('closed','suppressed') AND a.status IN ('open','acked')))`,
        );
      }
      if (query.status !== undefined) {
        where.push(`a.status = $${String(next)}::text`);
        params.push(query.status);
        next += 1;
      }
      if (query.severity !== undefined) {
        where.push(`a.severity = $${String(next)}::text`);
        params.push(query.severity);
        next += 1;
      }
      if (query.category !== undefined) {
        where.push(`a.category = $${String(next)}::text`);
        params.push(query.category);
        next += 1;
      }
      if (query.from !== undefined) {
        where.push(`a.opened_at >= $${String(next)}::timestamptz`);
        params.push(query.from);
        next += 1;
      }
      if (query.to !== undefined) {
        where.push(`a.opened_at < $${String(next)}::timestamptz`);
        params.push(query.to);
        next += 1;
      }
      if (query.source_type !== undefined && query.source_id !== undefined) {
        where.push(`a.source_type = $${String(next)}::text`);
        params.push(query.source_type);
        next += 1;
        where.push(`a.source_id = $${String(next)}::text`);
        params.push(String(query.source_id));
        next += 1;
      }
      if (query.equipment_id !== undefined) {
        // R9 设备维度聚合：equipment 源 ∪ 设备点位 point 源（与 M3 §3.3 联合查询同语义）
        where.push(
          `((a.source_type = 'equipment' AND a.source_id = $${String(next)}::text)
            OR (a.source_type = 'point' AND a.source_id IN
                (SELECT p.id::text FROM point p
                  WHERE p.tenant_id = $1 AND p.equipment_id = $${String(next)}::uuid)))`,
        );
        params.push(query.equipment_id);
        next += 1;
      }
      // 楼宇过滤（§3.1）：显式值经 load-for-user（越权/不存在 → 404 同码）；非 admin 强制注入
      if (query.building_id !== undefined) {
        await assertBuildingVisible(tx, actor.tenant_id, scope, query.building_id);
        where.push(`src.building_id = $${String(next)}::uuid`);
        params.push(query.building_id);
        next += 1;
      } else if (scope !== null) {
        where.push(`src.building_id = ANY($${String(next)}::uuid[])`);
        params.push([...scope]);
        next += 1;
      }

      let cursorSql = '';
      if (query.cursor !== undefined) {
        const cursor = decodeAlarmCursor(query.cursor, 1);
        const predicate = timeKeysetPredicate(
          'desc',
          '((extract(epoch FROM a.opened_at) * 1000000)::bigint)',
          'a.id',
          cursor,
          next,
        );
        cursorSql = ` AND ${predicate.sql}`;
        params.push(...predicate.params);
      }

      const limit = query.limit + 1;
      const result = await tx.query<FoldRow>(
        `WITH src AS (${SOURCE_UNION_SQL}),
         grp AS (SELECT root_group_id AS gid, MIN(id) AS root_id FROM alarm_event
                  WHERE tenant_id = $1 AND root_group_id IS NOT NULL GROUP BY root_group_id)
         SELECT ${ALARM_SELECT_COLUMNS}, src.name AS source_name, src.building_id,
                grp.root_id AS grp_root_id, root_a.status AS root_status
         FROM alarm_event a
         JOIN src ON src.source_type = a.source_type AND src.source_id = a.source_id
         LEFT JOIN grp ON grp.gid = a.root_group_id
         LEFT JOIN alarm_event root_a ON root_a.tenant_id = a.tenant_id AND root_a.id = grp.root_id
         WHERE ${where.join(' AND ')}${cursorSql}
         ORDER BY a.opened_at DESC, a.id DESC
         LIMIT ${String(limit)}`,
        params,
      );
      const rows = result.rows;
      const hasMore = rows.length > query.limit;
      const page = hasMore ? rows.slice(0, query.limit) : rows;
      const lastRow = page[page.length - 1];
      return {
        items: await decorateViews(tx, actor.tenant_id, page),
        next_cursor:
          hasMore && lastRow !== undefined
            ? encodeAlarmCursor({ k: [lastRow.opened_at_us], id: lastRow.id })
            : null,
      };
    });
  }

  // -------------------------------------------------------------------
  // GET /alarms/counts（角标，§3.2：open 含子行不折叠 + critical 红点）
  // -------------------------------------------------------------------

  async counts(actor: AlarmActor, buildingId?: string): Promise<AlarmCounts> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const scope = await loadBuildingScope(tx, actor);
      const where = ['a.tenant_id = $1', `a.status = 'open'`];
      const params: unknown[] = [actor.tenant_id];
      let next = 2;
      if (buildingId !== undefined) {
        await assertBuildingVisible(tx, actor.tenant_id, scope, buildingId);
        where.push(`src.building_id = $${String(next)}::uuid`);
        params.push(buildingId);
        next += 1;
      } else if (scope !== null) {
        where.push(`src.building_id = ANY($${String(next)}::uuid[])`);
        params.push([...scope]);
      }
      const result = await tx.query<{ open: number; open_critical: number }>(
        `WITH src AS (${SOURCE_UNION_SQL})
         SELECT count(*)::int AS open,
                count(*) FILTER (WHERE a.severity = 'critical')::int AS open_critical
         FROM alarm_event a
         JOIN src ON src.source_type = a.source_type AND src.source_id = a.source_id
         WHERE ${where.join(' AND ')}`,
        params,
      );
      return result.rows[0] ?? { open: 0, open_critical: 0 };
    });
  }

  // -------------------------------------------------------------------
  // GET /alarms/{id}（详情，§3.3）
  // -------------------------------------------------------------------

  async detail(actor: AlarmActor, alarmId: number): Promise<AlarmDetail> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const scope = await loadBuildingScope(tx, actor);
      const fold = await loadFoldRow(tx, actor.tenant_id, alarmId);
      if (fold === null) throw notFound();
      if (scope !== null && (fold.building_id === null || !scope.has(fold.building_id))) {
        throw notFound();
      }
      const base = (await decorateViews(tx, actor.tenant_id, [fold]))[0] ?? foldRowToView(fold);

      // 规则当前态（直写告警 rule_id = null）
      let rule: AlarmRuleSummary | null = null;
      if (fold.rule_id !== null) {
        const ruleRows = await tx.query<{
          id: string;
          rule_type: string;
          scope: string;
          scope_id: string;
          severity: string;
          sustained_s: number;
          params: Record<string, unknown> | null;
          enabled: boolean;
        }>(
          `SELECT id, rule_type, scope, scope_id, severity, sustained_s, params, enabled
           FROM alarm_rule WHERE tenant_id = $1 AND id = $2::uuid`,
          [actor.tenant_id, fold.rule_id],
        );
        const r = ruleRows.rows[0];
        if (r !== undefined) {
          rule = {
            id: r.id,
            rule_type: r.rule_type as AlarmRuleSummary['rule_type'],
            scope: r.scope as AlarmRuleSummary['scope'],
            scope_id: r.scope_id,
            severity: r.severity as AlarmSeverity,
            sustained_s: r.sustained_s,
            params: r.params ?? {},
            enabled: r.enabled,
          };
        }
      }

      // 来源上下文（name + building name；M4 §3.3 source 永远给值）
      const sourceRows = await tx.query<{
        name: string | null;
        building_id: string;
        building_name: string | null;
      }>(
        `SELECT src.name, src.building_id, b.name AS building_name
         FROM (${SOURCE_UNION_SQL}) src
         LEFT JOIN building b ON b.tenant_id = $1 AND b.id = src.building_id
         WHERE src.source_type = $2 AND src.source_id = $3`,
        [actor.tenant_id, fold.source_type, fold.source_id],
      );
      const source = sourceRows.rows[0];

      // 根因组（root_group_id 非空时；root 摘要仅子行给）
      let group: AlarmDetail['group'] = null;
      if (fold.root_group_id !== null) {
        const memberRows = await tx.query<{
          id: string;
          severity: string;
          status: string;
          message: string;
          opened_at: Date;
        }>(
          `SELECT id, severity, status, message, opened_at FROM alarm_event
           WHERE tenant_id = $1 AND root_group_id = $2::uuid ORDER BY id ASC`,
          [actor.tenant_id, fold.root_group_id],
        );
        const members = memberRows.rows;
        const rootRow = base.is_root ? undefined : members.find((m) => m.id === fold.grp_root_id);
        group = {
          root_group_id: fold.root_group_id,
          is_root: base.is_root,
          root:
            rootRow === undefined
              ? null
              : {
                  id: Number(rootRow.id),
                  severity: rootRow.severity as AlarmSeverity,
                  status: rootRow.status as AlarmEventStatus,
                  message: rootRow.message,
                },
          members: members.map((m) => ({
            id: Number(m.id),
            severity: m.severity as AlarmSeverity,
            status: m.status as AlarmEventStatus,
            message: m.message,
            opened_at: m.opened_at.toISOString(),
          })),
        };
      }

      // 抑制段 + 时间线
      const suppressionRows = (
        await tx.query<SuppressionRow>(
          `SELECT id, alarm_event_id, reason, suppressed_by, started_at, until_at, ended_at, ended_reason
           FROM alarm_suppression WHERE tenant_id = $1 AND alarm_event_id = $2::bigint
           ORDER BY started_at ASC`,
          [actor.tenant_id, String(alarmId)],
        )
      ).rows;

      return {
        alarm: base,
        rule,
        source: {
          type: base.source_type,
          id: base.source_id,
          name: source?.name ?? base.source_id,
          building: {
            id: source?.building_id ?? '',
            name: source?.building_name ?? '',
          },
        },
        group,
        suppressions: suppressionRows.map(mapSuppression),
        timeline: buildTimeline(fold, suppressionRows),
      };
    });
  }

  // -------------------------------------------------------------------
  // 处置动作（§3.4–§3.6）
  // -------------------------------------------------------------------

  /** ack：open → acked（记 acked_by/acked_at）；重复 ack 幂等 200 不改痕迹。 */
  async ack(actor: AlarmActor, alarmId: number, reason?: string): Promise<AlarmEventView> {
    const db = this.requireDb();
    await db.withTenant(actor.tenant_id, async (tx) => {
      const row = await lockAlarm(tx, actor.tenant_id, alarmId);
      if (row.status === 'closed' || row.status === 'suppressed') {
        throw stateInvalid(row.status);
      }
      if (row.status === 'acked') return; // 幂等：痕迹不重写
      await tx.query(
        `UPDATE alarm_event SET status = 'acked', acked_by = $3, acked_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [actor.tenant_id, String(alarmId), actor.user_id],
      );
      // ack reason 仅结构化日志（不落库，O3 评估）
      this.logger.info({
        msg: 'alarm_acked',
        tenant_id: actor.tenant_id,
        alarm_id: alarmId,
        acked_by: actor.user_id,
        ...(reason !== undefined ? { reason } : {}),
      });
    });
    return this.viewOf(actor.tenant_id, alarmId);
  }

  /** batch-ack：逐项语义与单点一致，越权/不存在项报 not_found 不中断整单（207）。 */
  async batchAck(actor: AlarmActor, ids: readonly number[]): Promise<AlarmBatchAckResponse> {
    const unique = [...new Set(ids)];
    const items: AlarmBatchAckItem[] = [];
    for (const id of unique) {
      try {
        await this.ack(actor, id);
        items.push({ alarm_id: id, ok: true });
      } catch (error) {
        if (error instanceof ReasonCodeException) {
          items.push({ alarm_id: id, ok: false, error: { reason_code: error.reasonCode } });
        } else {
          throw error;
        }
      }
    }
    return { items };
  }

  /** close：reason 必填；根告警 → 引擎选择性级联（恢复信号已现的子告警立即关）。 */
  async close(actor: AlarmActor, alarmId: number, reason: string): Promise<AlarmCloseResponse> {
    const db = this.requireDb();
    const outcome = await db.withTenant(actor.tenant_id, async (tx) => {
      const row = await lockAlarm(tx, actor.tenant_id, alarmId);
      if (row.status === 'suppressed') {
        // 先 unsuppress 或等恢复自动关闭（抑制期内恢复判据照常求值并直接关闭，§4.4）
        throw stateInvalid(row.status);
      }
      if (row.status === 'closed') return { changed: false, fold: row };
      await tx.query(
        `UPDATE alarm_event SET status = 'closed', closed_at = now(), closed_by = $3,
                close_reason = $4
         WHERE tenant_id = $1 AND id = $2`,
        [actor.tenant_id, String(alarmId), actor.user_id, reason],
      );
      this.metrics.recordAlarmClosed('manual');
      this.metrics.changeAlarmActive(row.severity as AlarmSeverity, -1);
      this.logger.info({
        msg: 'alarm_closed_manual',
        tenant_id: actor.tenant_id,
        alarm_id: alarmId,
        closed_by: actor.user_id,
        reason,
      });
      return { changed: true, fold: row };
    });
    let cascadeClosed = 0;
    if (outcome.changed && outcome.fold.root_group_id !== null) {
      const fold = await db.withTenant(actor.tenant_id, async (tx) =>
        loadFoldRow(tx, actor.tenant_id, alarmId),
      );
      if (fold !== null && fold.root_group_id !== null && fold.grp_root_id === fold.id) {
        // 组代表：级联只关「恢复信号已现」者，未恢复子告警上浮（§4.5）
        cascadeClosed = await this.engine.cascadeAfterRootClose(
          actor.tenant_id,
          fold.root_group_id,
        );
      }
      // 引擎状态重置（closed 终态；条件仍违反 → 复发开新行，防抖重新计）
      this.engine.onAlarmClosed({
        tenantId: actor.tenant_id,
        category: outcome.fold.category,
        sourceType: outcome.fold.source_type as 'point' | 'equipment' | 'system' | 'gateway',
        sourceId: outcome.fold.source_id,
      });
    }
    return { alarm: await this.viewOf(actor.tenant_id, alarmId), cascade_closed: cascadeClosed };
  }

  /** suppress：open|acked → suppressed（写抑制行）；已抑制 = 续期（superseded + 新行）。 */
  async suppress(
    actor: AlarmActor,
    alarmId: number,
    body: { duration_s: number; reason: string; cascade?: boolean },
  ): Promise<AlarmSuppressResponse> {
    if (
      body.duration_s < ALARM_SUPPRESS_DURATION_S.min ||
      body.duration_s > ALARM_SUPPRESS_DURATION_S.max
    ) {
      throw new ReasonCodeException(
        'alarm.suppress_duration_invalid',
        `抑制时长须在 [${String(ALARM_SUPPRESS_DURATION_S.min)}, ${String(ALARM_SUPPRESS_DURATION_S.max)}] 秒内`,
        { field: 'duration_s' },
      );
    }
    const db = this.requireDb();
    const result = await db.withTenant(actor.tenant_id, async (tx) => {
      const row = await lockAlarm(tx, actor.tenant_id, alarmId);
      if (row.status === 'closed') throw stateInvalid(row.status);
      if (row.status === 'suppressed') {
        await tx.query(
          `UPDATE alarm_suppression SET ended_at = now(), ended_reason = 'superseded'
           WHERE tenant_id = $1 AND alarm_event_id = $2 AND ended_at IS NULL`,
          [actor.tenant_id, String(alarmId)],
        );
      } else {
        await tx.query(
          `UPDATE alarm_event SET status = 'suppressed' WHERE tenant_id = $1 AND id = $2`,
          [actor.tenant_id, String(alarmId)],
        );
        this.metrics.changeAlarmSuppressed(1);
      }
      const inserted = await tx.query<{ id: string; until_at: Date }>(
        `INSERT INTO alarm_suppression
           (tenant_id, alarm_event_id, suppressed_by, reason, started_at, until_at)
         VALUES ($1, $2, $3, $4, now(), now() + ($5::int * interval '1 second'))
         RETURNING id, until_at`,
        [actor.tenant_id, String(alarmId), actor.user_id, body.reason, body.duration_s],
      );
      return inserted.rows[0] as { id: string; until_at: Date };
    });

    // 级联抑制（组代表 + cascade 默认 true）：组内 open|acked 子告警一并抑制
    //（各自抑制行，同 until_at/reason——风暴遮蔽正是 ADR-014 短板#2 场景）
    let cascadeSuppressed = 0;
    const fold = await db.withTenant(actor.tenant_id, async (tx) =>
      loadFoldRow(tx, actor.tenant_id, alarmId),
    );
    if (
      fold !== null &&
      fold.root_group_id !== null &&
      fold.grp_root_id === fold.id &&
      body.cascade !== false
    ) {
      cascadeSuppressed = await db.withTenant(actor.tenant_id, async (tx) => {
        const children = await tx.query<{ id: string }>(
          `SELECT id FROM alarm_event
           WHERE tenant_id = $1 AND root_group_id = $2::uuid AND id <> $3::bigint
             AND status IN ('open','acked')`,
          [actor.tenant_id, fold.root_group_id, String(alarmId)],
        );
        let count = 0;
        for (const child of children.rows) {
          await tx.query(
            `INSERT INTO alarm_suppression
               (tenant_id, alarm_event_id, suppressed_by, reason, started_at, until_at)
             VALUES ($1, $2, $3, $4, now(), $5)`,
            [actor.tenant_id, child.id, actor.user_id, body.reason, result.until_at],
          );
          await tx.query(
            `UPDATE alarm_event SET status = 'suppressed' WHERE tenant_id = $1 AND id = $2`,
            [actor.tenant_id, child.id],
          );
          count += 1;
        }
        if (count > 0) this.metrics.changeAlarmSuppressed(count);
        return count;
      });
    }
    return {
      alarm: await this.viewOf(actor.tenant_id, alarmId),
      suppression: { id: result.id, until_at: result.until_at.toISOString() },
      cascade_suppressed: cascadeSuppressed,
    };
  }

  /** unsuppress：suppressed → 回抑制前状态（acked_by 非空 ? acked : open）。 */
  async unsuppress(
    actor: AlarmActor,
    alarmId: number,
    cascade?: boolean,
  ): Promise<AlarmUnsuppressResponse> {
    const db = this.requireDb();
    await db.withTenant(actor.tenant_id, async (tx) => {
      const row = await lockAlarm(tx, actor.tenant_id, alarmId);
      if (row.status !== 'suppressed') throw stateInvalid(row.status);
      await restoreFromSuppression(tx, actor.tenant_id, String(alarmId));
      this.metrics.changeAlarmSuppressed(-1);
    });
    let cascadeUnsuppressed = 0;
    const fold = await db.withTenant(actor.tenant_id, async (tx) =>
      loadFoldRow(tx, actor.tenant_id, alarmId),
    );
    if (
      fold !== null &&
      fold.root_group_id !== null &&
      fold.grp_root_id === fold.id &&
      cascade !== false
    ) {
      cascadeUnsuppressed = await db.withTenant(actor.tenant_id, async (tx) => {
        const children = (
          await tx.query<{ id: string }>(
            `SELECT id FROM alarm_event
             WHERE tenant_id = $1 AND root_group_id = $2::uuid AND id <> $3::bigint
               AND status = 'suppressed'`,
            [actor.tenant_id, fold.root_group_id, String(alarmId)],
          )
        ).rows;
        for (const child of children) {
          await restoreFromSuppression(tx, actor.tenant_id, child.id);
        }
        if (children.length > 0) this.metrics.changeAlarmSuppressed(-children.length);
        return children.length;
      });
    }
    return {
      alarm: await this.viewOf(actor.tenant_id, alarmId),
      cascade_unsuppressed: cascadeUnsuppressed,
    };
  }

  // -------------------------------------------------------------------
  // GET /alarms/suppressions（§3.7）
  // -------------------------------------------------------------------

  async suppressionList(
    actor: AlarmActor,
    query: AlarmSuppressionListQuery,
  ): Promise<AlarmSuppressionListResponse> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const scope = await loadBuildingScope(tx, actor);
      const where: string[] = ['s.tenant_id = $1'];
      const params: unknown[] = [actor.tenant_id];
      let next = 2;
      where.push(query.state === 'active' ? 's.ended_at IS NULL' : 's.ended_at IS NOT NULL');
      if (query.alarm_event_id !== undefined) {
        where.push(`s.alarm_event_id = $${String(next)}::bigint`);
        params.push(query.alarm_event_id);
        next += 1;
      }
      if (query.building_id !== undefined) {
        await assertBuildingVisible(tx, actor.tenant_id, scope, query.building_id);
        where.push(`src.building_id = $${String(next)}::uuid`);
        params.push(query.building_id);
        next += 1;
      } else if (scope !== null) {
        where.push(`src.building_id = ANY($${String(next)}::uuid[])`);
        params.push([...scope]);
        next += 1;
      }
      let cursorSql = '';
      if (query.cursor !== undefined) {
        const cursor = decodeAlarmCursor(query.cursor, 1);
        const predicate = timeKeysetPredicate(
          'desc',
          '((extract(epoch FROM s.started_at) * 1000000)::bigint)',
          's.id',
          cursor,
          next,
        );
        cursorSql = ` AND ${predicate.sql}`;
        params.push(...predicate.params);
      }
      const limit = query.limit + 1;
      interface SuppressionListRow {
        readonly id: string;
        readonly alarm_event_id: string;
        readonly reason: string;
        readonly suppressed_by: string;
        readonly started_at: Date;
        readonly until_at: Date;
        readonly ended_at: Date | null;
        readonly ended_reason: AlarmSuppressionEndReason | null;
        readonly started_at_us: string;
        readonly alarm_id: string;
        readonly alarm_severity: string;
        readonly alarm_status: string;
        readonly alarm_message: string;
        readonly source_type: string;
        readonly source_id: string;
        readonly source_name: string | null;
      }
      const result = await tx.query<SuppressionListRow>(
        `WITH src AS (${SOURCE_UNION_SQL})
         SELECT s.id, s.alarm_event_id, s.reason, s.suppressed_by, s.started_at, s.until_at,
                s.ended_at, s.ended_reason,
                ((extract(epoch FROM s.started_at) * 1000000)::bigint)::text AS started_at_us,
                a.id AS alarm_id, a.severity AS alarm_severity, a.status AS alarm_status,
                a.message AS alarm_message, a.source_type, a.source_id, src.name AS source_name
         FROM alarm_suppression s
         JOIN alarm_event a ON a.tenant_id = s.tenant_id AND a.id = s.alarm_event_id
         JOIN src ON src.source_type = a.source_type AND src.source_id = a.source_id
         WHERE ${where.join(' AND ')}${cursorSql}
         ORDER BY s.started_at DESC, s.id DESC
         LIMIT ${String(limit)}`,
        params,
      );
      const rows = result.rows;
      const hasMore = rows.length > query.limit;
      const page = hasMore ? rows.slice(0, query.limit) : rows;
      const items: AlarmSuppressionListItem[] = page.map((row) => ({
        suppression: {
          id: row.id,
          alarm_event_id: Number(row.alarm_event_id),
          reason: row.reason,
          suppressed_by: row.suppressed_by,
          started_at: row.started_at.toISOString(),
          until_at: row.until_at.toISOString(),
          ended_at: row.ended_at?.toISOString() ?? null,
          ended_reason: row.ended_reason ?? null,
        },
        alarm: {
          id: Number(row.alarm_id),
          severity: row.alarm_severity as AlarmSeverity,
          status: row.alarm_status as AlarmEventStatus,
          message: row.alarm_message,
          source_type: row.source_type as AlarmScope,
          source_id: row.source_id,
          source_name: row.source_name,
        },
      }));
      const lastRow = page[page.length - 1];
      const response: AlarmSuppressionListResponse = {
        items,
        next_cursor:
          hasMore && lastRow !== undefined
            ? encodeAlarmCursor({ k: [lastRow.started_at_us], id: lastRow.id })
            : null,
      };
      return response;
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

  /** 单告警视图（处置动作响应）：独立事务装配，不与状态变更事务嵌套。 */
  private async viewOf(tenantId: string, alarmId: number): Promise<AlarmEventView> {
    const db = this.requireDb();
    return db.withTenant(tenantId, async (tx) => {
      const fold = await loadFoldRow(tx, tenantId, alarmId);
      if (fold === null) throw notFound();
      return (await decorateViews(tx, tenantId, [fold]))[0] ?? foldRowToView(fold);
    });
  }
}

// ---------------------------------------------------------------------------
// 局部助手
// ---------------------------------------------------------------------------

function notFound(): ReasonCodeException {
  return new ReasonCodeException('alarm.not_found', '告警不存在');
}

function stateInvalid(currentStatus: string): ReasonCodeException {
  return new ReasonCodeException('alarm.state_invalid', '告警状态不允许该操作', {
    current_status: currentStatus,
  });
}

async function lockAlarm(
  tx: PoolClient,
  tenantId: string,
  alarmId: number,
): Promise<AlarmEventRow> {
  const result = await tx.query<AlarmEventRow>(
    `SELECT ${ALARM_SELECT_COLUMNS} FROM alarm_event a
     WHERE a.tenant_id = $1 AND a.id = $2::bigint FOR UPDATE`,
    [tenantId, String(alarmId)],
  );
  const row = result.rows[0];
  if (row === undefined) throw notFound();
  return row;
}

/** 楼宇过滤值 load-for-user：不存在/越权同 404（SEC-AZ-03，asset.not_found 沿 §3.1 行语义）。 */
async function assertBuildingVisible(
  tx: PoolClient,
  tenantId: string,
  scope: BuildingScope,
  buildingId: string,
): Promise<void> {
  const result = await tx.query<{ id: string }>(
    `SELECT id FROM building WHERE tenant_id = $1 AND id = $2::uuid`,
    [tenantId, buildingId],
  );
  if (result.rows.length === 0 || (scope !== null && !scope.has(buildingId))) {
    throw new ReasonCodeException('asset.not_found', '资源不存在', { entity: 'building' });
  }
}

/** 单行折叠视图底料（grp_root_id/root_status 供代表行判定与上浮判定）。 */
async function loadFoldRow(
  tx: PoolClient,
  tenantId: string,
  alarmId: number,
): Promise<FoldRow | null> {
  const result = await tx.query<FoldRow>(
    `WITH src AS (${SOURCE_UNION_SQL}),
     grp AS (SELECT root_group_id AS gid, MIN(id) AS root_id FROM alarm_event
              WHERE tenant_id = $1 AND root_group_id IS NOT NULL GROUP BY root_group_id)
     SELECT ${ALARM_SELECT_COLUMNS}, src.name AS source_name, src.building_id,
            grp.root_id AS grp_root_id, root_a.status AS root_status
     FROM alarm_event a
     JOIN src ON src.source_type = a.source_type AND src.source_id = a.source_id
     LEFT JOIN grp ON grp.gid = a.root_group_id
     LEFT JOIN alarm_event root_a ON root_a.tenant_id = a.tenant_id AND root_a.id = grp.root_id
     WHERE a.tenant_id = $1 AND a.id = $2::bigint`,
    [tenantId, String(alarmId)],
  );
  return result.rows[0] ?? null;
}

/** 抑制回置（unsuppress/到期 sweep 共用语义）：行 ended(unsuppressed) + 状态回置。 */
async function restoreFromSuppression(
  tx: PoolClient,
  tenantId: string,
  alarmId: string,
): Promise<void> {
  await tx.query(
    `UPDATE alarm_event
     SET status = CASE WHEN acked_by IS NOT NULL THEN 'acked' ELSE 'open' END
     WHERE tenant_id = $1 AND id = $2::bigint AND status = 'suppressed'`,
    [tenantId, alarmId],
  );
  await tx.query(
    `UPDATE alarm_suppression SET ended_at = now(), ended_reason = 'unsuppressed'
     WHERE tenant_id = $1 AND alarm_event_id = $2::bigint AND ended_at IS NULL`,
    [tenantId, alarmId],
  );
}

/** 视图装配：代表行子计数 + suppressed 行抑制摘要（§3.1）。 */
async function decorateViews(
  tx: PoolClient,
  tenantId: string,
  rows: readonly FoldRow[],
): Promise<AlarmEventView[]> {
  const representativeGroups = rows
    .filter(
      (row): row is FoldRow & { root_group_id: string } =>
        row.root_group_id !== null && row.grp_root_id === row.id,
    )
    .map((row) => row.root_group_id);
  const childCounts = await loadChildCounts(tx, tenantId, representativeGroups);
  const suppressedIds = rows
    .filter((row) => row.status === 'suppressed')
    .map((row) => Number(row.id));
  const suppressionSummaries = await loadActiveSuppressions(tx, tenantId, suppressedIds);
  return rows.map((row) => {
    const view = foldRowToView(row);
    if (view.is_root && view.root_group_id !== null) {
      const counts = childCounts.get(view.root_group_id);
      return {
        ...view,
        child_count_active: counts?.active ?? 0,
        child_count_suppressed: counts?.suppressed ?? 0,
      };
    }
    if (view.status === 'suppressed') {
      return { ...view, suppression: suppressionSummaries.get(view.id) ?? null };
    }
    return view;
  });
}

function mapSuppression(row: SuppressionRow): AlarmSuppressionSegment {
  return {
    id: row.id,
    reason: row.reason,
    suppressed_by: row.suppressed_by,
    started_at: row.started_at.toISOString(),
    until_at: row.until_at.toISOString(),
    ended_at: row.ended_at?.toISOString() ?? null,
    ended_reason: (row.ended_reason as AlarmSuppressionEndReason | null) ?? null,
  };
}

function buildTimeline(
  alarm: AlarmEventRow,
  suppressions: readonly SuppressionRow[],
): AlarmTimelineEntry[] {
  const entries: AlarmTimelineEntry[] = [{ type: 'opened', at: alarm.opened_at.toISOString() }];
  if (alarm.acked_at !== null && alarm.acked_by !== null) {
    entries.push({ type: 'acked', at: alarm.acked_at.toISOString(), by: alarm.acked_by });
  }
  for (const s of suppressions) {
    entries.push({
      type: 'suppressed',
      at: s.started_at.toISOString(),
      until_at: s.until_at.toISOString(),
      reason: s.reason,
      by: s.suppressed_by,
      ended_at: s.ended_at?.toISOString() ?? null,
      ended_reason: s.ended_reason,
    });
  }
  if (alarm.closed_at !== null) {
    entries.push({
      type: 'closed',
      at: alarm.closed_at.toISOString(),
      by: alarm.closed_by,
      reason: alarm.close_reason ?? '',
    });
  }
  return entries.sort((a, b) => a.at.localeCompare(b.at));
}
