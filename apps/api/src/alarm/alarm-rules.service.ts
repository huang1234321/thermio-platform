/**
 * 告警规则服务（modules M4-alarm.md §3.8–§3.10 / §4.1，IMPL-13 / DAT-116）。
 *
 * 校验序（§3.9 定序，逐级短路）：rule_type 枚举（alarm.rule_type_unknown）→
 * severity 枚举（alarm.severity_unknown）→ scope 取值/scope_id 类型/rule_type × scope
 * 组合矩阵（alarm.rule_scope_invalid）→ 目标存在且归属（目标域 not_found，SEC-AZ-03）→
 * params schema（alarm.rule_params_invalid）→ sustained_s 值域（common.validation_failed）。
 *
 * 语义：scope/scope_id/rule_type 不可变（重定向 = 新建规则，R4）；在途求值不回溯
 * （引擎按边沿时点快照取规则，§3.9）；DELETE 被引用 → 409 rule_in_use（FK RESTRICT
 * 的应用层映射，归档式停用 = enabled=false）。
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { PoolClient } from 'pg';
import {
  ALARM_RECOVERY_S_DEFAULT,
  ALARM_RULE_PARAMS_SCHEMA,
  ALARM_RULE_TYPES,
  ALARM_SCOPES,
  ALARM_SEVERITIES,
  ALARM_SUSTAINED_S_DEFAULT,
  type AlarmRule,
  type AlarmRuleCreate,
  type AlarmRuleListQuery,
  type AlarmRuleListResponse,
  type AlarmRulePatch,
  type AlarmScope,
  type AlarmSeverity,
} from '@thermio/shared-types';
import { TENANT_DB } from '../infrastructure/db/db.tokens.js';
import type { TenantDb } from '../infrastructure/db/tenant-db.js';
import { LOGGER } from '../infrastructure/logger.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { loadBuildingScope, type BuildingScope } from '../asset/asset-shared.js';
import { decodeAlarmCursor, encodeAlarmCursor, timeKeysetPredicate } from './alarm-cursor.js';
import { SOURCE_UNION_SQL, type AlarmActor } from './alarm-shared.js';

/** rule_type × scope 组合矩阵（§4.1 表）。 */
const RULE_SCOPE_MATRIX: Record<(typeof ALARM_RULE_TYPES)[number], readonly AlarmScope[]> = {
  point_stale: ['point'],
  gateway_offline: ['gateway'],
  fdd_finding: ['equipment'],
};

/** params 缺省键补全落库（§3.9 201 注：按 rule_type 默认值）。 */
const PARAMS_DEFAULTS: Record<(typeof ALARM_RULE_TYPES)[number], Record<string, unknown>> = {
  point_stale: { recovery_s: ALARM_RECOVERY_S_DEFAULT.point_stale },
  gateway_offline: { recovery_s: ALARM_RECOVERY_S_DEFAULT.gateway_offline },
  fdd_finding: { min_severity: 'warning' },
};

interface RuleRow {
  readonly id: string;
  readonly scope: string;
  readonly scope_id: string;
  readonly rule_type: string;
  readonly params: Record<string, unknown> | null;
  readonly severity: string;
  readonly sustained_s: number;
  readonly enabled: boolean;
  readonly created_at: Date;
  readonly created_at_us: string;
}

const RULE_SELECT_COLUMNS = `r.id, r.scope, r.scope_id, r.rule_type, r.params, r.severity,
  r.sustained_s, r.enabled, r.created_at,
  ((extract(epoch FROM r.created_at) * 1000000)::bigint)::text AS created_at_us`;

/** INSERT/UPDATE RETURNING 投影（INSERT 不接受表别名——裸列名）。 */
const RULE_RETURNING_COLUMNS = `id, scope, scope_id, rule_type, params, severity,
  sustained_s, enabled, created_at,
  ((extract(epoch FROM created_at) * 1000000)::bigint)::text AS created_at_us`;

function mapRule(row: RuleRow): AlarmRule {
  return {
    id: row.id,
    scope: row.scope as AlarmScope,
    scope_id: row.scope_id,
    rule_type: row.rule_type as AlarmRule['rule_type'],
    params: row.params ?? {},
    severity: row.severity as AlarmSeverity,
    sustained_s: row.sustained_s,
    enabled: row.enabled,
    created_at: row.created_at.toISOString(),
  };
}

@Injectable()
export class AlarmRulesService {
  private readonly logger: Logger;

  constructor(
    @Inject(TENANT_DB) private readonly tenantDb: TenantDb | null,
    @Inject(LOGGER) rootLogger: Logger,
  ) {
    this.logger = rootLogger.child({ component: 'alarm-rules' });
  }

  /** GET /alarm-rules（§3.8：规则 scope 目标 ∈ 授权范围，M7 §5）。 */
  async list(actor: AlarmActor, query: AlarmRuleListQuery): Promise<AlarmRuleListResponse> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const scope = await loadBuildingScope(tx, actor);
      const where: string[] = ['r.tenant_id = $1'];
      const params: unknown[] = [actor.tenant_id];
      let next = 2;
      if (query.scope !== undefined) {
        where.push(`r.scope = $${String(next)}::text`);
        params.push(query.scope);
        next += 1;
      }
      if (query.rule_type !== undefined) {
        where.push(`r.rule_type = $${String(next)}::text`);
        params.push(query.rule_type);
        next += 1;
      }
      if (query.enabled !== undefined) {
        where.push(`r.enabled = $${String(next)}`);
        params.push(query.enabled === 'true');
        next += 1;
      }
      if (query.building_id !== undefined) {
        await assertRuleBuildingVisible(tx, actor.tenant_id, scope, query.building_id);
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
          'asc',
          '((extract(epoch FROM r.created_at) * 1000000)::bigint)',
          'r.id',
          cursor,
          next,
        );
        cursorSql = ` AND ${predicate.sql}`;
        params.push(...predicate.params);
      }
      const limit = query.limit + 1;
      const result = await tx.query<RuleRow>(
        `WITH src AS (${SOURCE_UNION_SQL})
         SELECT ${RULE_SELECT_COLUMNS}
         FROM alarm_rule r
         JOIN src ON src.source_type = r.scope AND src.source_id = r.scope_id
         WHERE ${where.join(' AND ')}${cursorSql}
         ORDER BY r.created_at ASC, r.id ASC
         LIMIT ${String(limit)}`,
        params,
      );
      const rows = result.rows;
      const hasMore = rows.length > query.limit;
      const page = hasMore ? rows.slice(0, query.limit) : rows;
      const lastRow = page[page.length - 1];
      return {
        items: page.map(mapRule),
        next_cursor:
          hasMore && lastRow !== undefined
            ? encodeAlarmCursor({ k: [lastRow.created_at_us], id: lastRow.id })
            : null,
      };
    });
  }

  /** POST /alarm-rules（§3.9：校验序逐级短路；sustained_s 缺省按 severity 分级默认）。 */
  async create(actor: AlarmActor, body: AlarmRuleCreate): Promise<AlarmRule> {
    // 1. rule_type 枚举
    if (!(ALARM_RULE_TYPES as readonly string[]).includes(body.rule_type)) {
      throw new ReasonCodeException('alarm.rule_type_unknown', '未知规则类型', {
        rule_type: body.rule_type,
      });
    }
    // 2. severity 枚举
    if (!(ALARM_SEVERITIES as readonly string[]).includes(body.severity)) {
      throw new ReasonCodeException('alarm.severity_unknown', '未知严重级别', {
        severity: body.severity,
      });
    }
    // 3. scope 取值 / scope_id 类型 / 组合矩阵
    if (!(ALARM_SCOPES as readonly string[]).includes(body.scope)) {
      throw new ReasonCodeException('alarm.rule_scope_invalid', 'scope 取值非法', {
        field: 'scope',
      });
    }
    const ruleType = body.rule_type;
    if (!RULE_SCOPE_MATRIX[ruleType].includes(body.scope)) {
      throw new ReasonCodeException('alarm.rule_scope_invalid', 'rule_type 与 scope 组合不合法', {
        rule_type: ruleType,
        scope: body.scope,
      });
    }
    const scopeId = normalizeScopeId(body.scope, body.scope_id);
    if (scopeId === null) {
      throw new ReasonCodeException('alarm.rule_scope_invalid', 'scope_id 类型与 scope 不符', {
        field: 'scope_id',
      });
    }
    // 6a. sustained_s 值域（zod 已保证 int；此处补 0..86400 域）
    if (body.sustained_s !== undefined && (body.sustained_s < 0 || body.sustained_s > 86400)) {
      throw new ReasonCodeException('common.validation_failed', 'sustained_s 越界（0..86400）', {
        field: 'sustained_s',
      });
    }

    const db = this.requireDb();
    const created = await db.withTenant(actor.tenant_id, async (tx) => {
      const scope = await loadBuildingScope(tx, actor);
      // 4. 目标存在且归属（越权/不存在同 404，目标域 not_found 码）
      const target = await resolveRuleTarget(tx, actor.tenant_id, body.scope, scopeId);
      if (target === null) {
        throw targetNotFound(body.scope);
      }
      if (scope !== null && !scope.has(target.building_id)) {
        throw targetNotFound(body.scope);
      }
      // 5. params schema（未知键/越界 → alarm.rule_params_invalid）+ 缺省键补全落库
      const params = validateAndFillParams(ruleType, body.params ?? {});
      const sustainedS = body.sustained_s ?? ALARM_SUSTAINED_S_DEFAULT[body.severity];
      const inserted = await tx.query<RuleRow>(
        `INSERT INTO alarm_rule
           (tenant_id, scope, scope_id, rule_type, params, severity, sustained_s, enabled)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
         RETURNING ${RULE_RETURNING_COLUMNS}`,
        [
          actor.tenant_id,
          body.scope,
          scopeId,
          ruleType,
          JSON.stringify(params),
          body.severity,
          sustainedS,
          body.enabled ?? true,
        ],
      );
      return requireRuleRow(inserted.rows);
    });
    this.logger.info({
      msg: 'alarm_rule_created',
      tenant_id: actor.tenant_id,
      rule_id: created.id,
      rule_type: created.rule_type,
      scope: created.scope,
      scope_id: created.scope_id,
    });
    return mapRule(created);
  }

  /** PATCH /alarm-rules/{id}（白名单 ≥1 项；scope/scope_id/rule_type 不可变，R4）。 */
  async patch(actor: AlarmActor, ruleId: string, body: AlarmRulePatch): Promise<AlarmRule> {
    if (body.sustained_s !== undefined && (body.sustained_s < 0 || body.sustained_s > 86400)) {
      throw new ReasonCodeException('common.validation_failed', 'sustained_s 越界（0..86400）', {
        field: 'sustained_s',
      });
    }
    if (
      body.severity !== undefined &&
      !(ALARM_SEVERITIES as readonly string[]).includes(body.severity)
    ) {
      throw new ReasonCodeException('alarm.severity_unknown', '未知严重级别', {
        severity: body.severity,
      });
    }
    const db = this.requireDb();
    const updated = await db.withTenant(actor.tenant_id, async (tx) => {
      const scope = await loadBuildingScope(tx, actor);
      const existing = await tx.query<RuleRow>(
        `SELECT ${RULE_SELECT_COLUMNS} FROM alarm_rule r
         WHERE r.tenant_id = $1 AND r.id = $2::uuid FOR UPDATE`,
        [actor.tenant_id, ruleId],
      );
      const row = existing.rows[0];
      if (row === undefined) {
        throw new ReasonCodeException('alarm.rule_not_found', '告警规则不存在');
      }
      const target = await resolveRuleTarget(tx, actor.tenant_id, row.scope, row.scope_id);
      if (target === null || (scope !== null && !scope.has(target.building_id))) {
        throw new ReasonCodeException('alarm.rule_not_found', '告警规则不存在');
      }
      // params 按既有 rule_type schema 复验（rule_type 不可变），缺省键补全
      const nextParams =
        body.params !== undefined
          ? validateAndFillParams(row.rule_type as (typeof ALARM_RULE_TYPES)[number], body.params)
          : (row.params ?? {});
      const updatedRow = await tx.query<RuleRow>(
        `UPDATE alarm_rule SET
           params = $3::jsonb,
           severity = $4,
           sustained_s = $5,
           enabled = $6
         WHERE tenant_id = $1 AND id = $2::uuid
         RETURNING ${RULE_RETURNING_COLUMNS}`,
        [
          actor.tenant_id,
          ruleId,
          JSON.stringify(nextParams),
          body.severity ?? row.severity,
          body.sustained_s ?? row.sustained_s,
          body.enabled ?? row.enabled,
        ],
      );
      return requireRuleRow(updatedRow.rows);
    });
    this.logger.info({
      msg: 'alarm_rule_patched',
      tenant_id: actor.tenant_id,
      rule_id: updated.id,
      fields: Object.keys(body),
    });
    return mapRule(updated);
  }

  /** DELETE /alarm-rules/{id}（§3.10：被引用 → 409 rule_in_use）。 */
  async remove(actor: AlarmActor, ruleId: string): Promise<void> {
    const db = this.requireDb();
    await db.withTenant(actor.tenant_id, async (tx) => {
      const scope = await loadBuildingScope(tx, actor);
      const existing = await tx.query<RuleRow & { building_id: string | null }>(
        `SELECT ${RULE_SELECT_COLUMNS}, src.building_id FROM alarm_rule r
         JOIN (SELECT source_type, source_id, building_id FROM (${SOURCE_UNION_SQL}) s) src
           ON src.source_type = r.scope AND src.source_id = r.scope_id
         WHERE r.tenant_id = $1 AND r.id = $2::uuid FOR UPDATE OF r`,
        [actor.tenant_id, ruleId],
      );
      const row = existing.rows[0] as (RuleRow & { building_id: string | null }) | undefined;
      if (row === undefined || (scope !== null && !scope.has(row.building_id ?? ''))) {
        throw new ReasonCodeException('alarm.rule_not_found', '告警规则不存在');
      }
      const referenced = await tx.query<{ id: string }>(
        `SELECT id FROM alarm_event WHERE tenant_id = $1 AND rule_id = $2::uuid LIMIT 1`,
        [actor.tenant_id, ruleId],
      );
      if (referenced.rows.length > 0) {
        throw new ReasonCodeException('alarm.rule_in_use', '规则仍被告警事件引用，请改用停用', {
          hint: 'enabled=false（归档式停用，历史告警可解释性优先）',
        });
      }
      await tx.query(`DELETE FROM alarm_rule WHERE tenant_id = $1 AND id = $2::uuid`, [
        actor.tenant_id,
        ruleId,
      ]);
      this.logger.info({
        msg: 'alarm_rule_deleted',
        tenant_id: actor.tenant_id,
        rule_id: ruleId,
      });
    });
  }

  private requireDb(): TenantDb {
    if (this.tenantDb === null) {
      throw new ReasonCodeException('common.internal_error', '数据库未配置');
    }
    return this.tenantDb;
  }
}

/** RETURNING 单行强制取值（空行 = 程序缺陷 → 500 兜底）。 */
function requireRuleRow(rows: readonly RuleRow[]): RuleRow {
  const row = rows[0];
  if (row === undefined) throw new Error('unreachable: alarm_rule RETURNING 未返回行');
  return row;
}

// ---------------------------------------------------------------------------
// 校验助手
// ---------------------------------------------------------------------------

/** scope_id 类型归一（§2.3：point → integer 字符串化；其余 uuid）。不符返回 null。 */
function normalizeScopeId(scope: string, raw: string | number): string | null {
  if (scope === 'point') {
    return typeof raw === 'number' ? String(raw) : /^\d{1,19}$/.test(raw) ? raw : null;
  }
  const value = typeof raw === 'number' ? null : raw;
  if (value === null) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

/** 目标存在性 + 楼宇归属解析（§2.3：经四路 UNION 单查）。 */
async function resolveRuleTarget(
  tx: PoolClient,
  tenantId: string,
  scope: string,
  scopeId: string,
): Promise<{ building_id: string } | null> {
  const result = await tx.query<{ building_id: string }>(
    `SELECT building_id FROM (${SOURCE_UNION_SQL}) src
     WHERE src.source_type = $2 AND src.source_id = $3`,
    [tenantId, scope, scopeId],
  );
  return (result.rows[0] as { building_id: string } | undefined) ?? null;
}

function targetNotFound(scope: string): ReasonCodeException {
  const entity = scope === 'gateway' ? 'gateway' : scope;
  return new ReasonCodeException(
    scope === 'gateway' ? 'gateway.not_found' : 'asset.not_found',
    '资源不存在',
    { entity },
  );
}

/** params schema 复验 + 缺省键补全（§4.1 schema 单源 shared-types）。 */
function validateAndFillParams(
  ruleType: (typeof ALARM_RULE_TYPES)[number],
  params: Record<string, unknown>,
): Record<string, unknown> {
  const schema = ALARM_RULE_PARAMS_SCHEMA[ruleType];
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    throw new ReasonCodeException('alarm.rule_params_invalid', '规则参数不符合 schema', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return { ...PARAMS_DEFAULTS[ruleType], ...parsed.data };
}

/** 楼宇过滤值 load-for-user（§3.8 building_id 行，沿告警列表语义）。 */
async function assertRuleBuildingVisible(
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
