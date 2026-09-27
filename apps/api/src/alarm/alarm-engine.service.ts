/**
 * 告警引擎（modules M4-alarm.md §5，IMPL-13 / DAT-116 落地依据）。
 *
 * 四通道接入（§5.1）：
 * ① Kafka thermio.telemetry.quality（QualityEventConsumer 驱动 onQualityEvent）；
 * ② EMQX 离线/在线事件（InternalMqttModule 经 registerGatewaySignalSink 注入，
 *    IMPL-7 预留联动接通；同 ts 重投的重复离线 WARN 随状态表去重一并收口，DAT-110）；
 * ③ FDD findings（IMPL-16 预留，本卡不接线——rule_type=fdd_finding 可配置可求值，
 *    事件源随 M6 落地时接 onFddSignal，契约即本类边沿入口）；
 * ④ control-safety 直写 open API（§5.2，进程内服务非 HTTP；IMPL-17 接入）。
 *
 * 求值算法（§5.3）：边沿归一化 → 进程内状态表 → sustained_s 防抖开 / recovery_s 回稳关；
 * 去重键 (tenant, category, source_type, source_id)——活跃告警存在不重复开（DB 权威复核）；
 * root_group 聚合（§5.5）：gateway_offline 开启铸 uuid 自锚，point_stale 挂活跃网关根。
 *
 * 重启重建（§5.6）：gateway 通道以 gateway.status 电平真值对账；质量通道由消费组
 * 2h 重放驱动边沿幂等重建；FDD 通道随 IMPL-16。抑制到期 sweep（§4.3）30s 周期。
 *
 * 并发口径（§5.6）：MVP 单实例写（ADR-014 阶段 1）；多副本分区归属/leader 选举 = O2。
 */
import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { Logger } from 'pino';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import pg from 'pg';
import { ALARM_RECOVERY_S_DEFAULT, type AlarmSeverity } from '@thermio/shared-types';
import { LOGGER } from '../infrastructure/logger.js';
import { MetricsService } from '../infrastructure/metrics/metrics.service.js';
import { AUTH_DB_POOL, TENANT_DB } from '../infrastructure/db/db.tokens.js';
import type { TenantDb } from '../infrastructure/db/tenant-db.js';
import {
  applyClear,
  applyViolation,
  emptyEntry,
  engineKeyString,
  recoveryDue,
  sustainedDue,
  type EngineEntry,
  type EngineKey,
  type RuleSnapshot,
} from './engine/engine-state.js';

/** 跨租户旁路读最小面（thermio_auth 角色；行形状由调用方窄化）。 */
export interface BypassQueryPort {
  query(
    sql: string,
    params: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

/** 到期抑制行（sweep 扫描面，thermio_auth internal_read 旁路）。type alias：PgRow 约束。 */
type DueSuppressionRow = {
  readonly id: string;
  readonly tenant_id: string;
  readonly alarm_event_id: string;
};

/** 活跃告警（去重键命中行）。type alias：PgRow 约束。 */
type ActiveAlarmRow = {
  readonly id: string;
  readonly root_group_id: string | null;
  readonly status: string;
};

type PointRow = {
  readonly status: string;
  readonly display_name: string | null;
  readonly raw_name: string;
};

type RuleRow = {
  readonly id: string;
  readonly severity: string;
  readonly sustained_s: number;
  readonly params: Record<string, unknown> | null;
};

/** control-safety 直写通道命令（M4-alarm.md §5.2；tenant 由进程内调用方给定）。 */
export interface OpenAlarmCmd {
  readonly tenantId: string;
  readonly category: 'control_verify_failed' | 'control_lease_rollback' | 'control_drift';
  readonly source_type: 'point' | 'equipment' | 'system' | 'gateway';
  readonly source_id: string;
  readonly severity: AlarmSeverity;
  readonly message: string;
}

/** EMQX 网关信号（internal-mqtt 注入；status 电平 + 触发 reason）。 */
export interface GatewaySignal {
  readonly tenantId: string;
  readonly gatewayId: string;
  readonly gatewayName: string;
  readonly status: 'online' | 'offline';
  readonly reason: string | null;
  readonly atMs: number;
}

/** 引擎 tick 周期（防抖/回稳判定粒度；sustained_s=0 的 critical 约 1s 内开）。 */
const TICK_MS = 1_000;
/** 抑制到期 sweep 周期（§4.3：≤30s 延迟）。 */
const SWEEP_MS = 30_000;

@Injectable()
export class AlarmEngineService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger: Logger;
  private readonly state = new Map<string, EngineEntry>();
  private tickTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(TENANT_DB) private readonly tenantDb: TenantDb | null,
    @Inject(AUTH_DB_POOL) authPool: pg.Pool | null,
    @Inject(LOGGER) rootLogger: Logger,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {
    this.logger = rootLogger.child({ component: 'alarm-engine' });
    // 跨租户旁路读（gateway → tenant）：thermio_auth 角色 internal_read（0001）。
    // 复用 infra AUTH_DB_POOL（PG_AUTH_URL）——与登录解析同池，不另开连接。
    this.authDb =
      authPool === null
        ? null
        : {
            query: (sql, params) =>
              authPool.query(sql, params as unknown[]).catch((err: unknown) => {
                this.logger.error({ msg: 'alarm_engine_bypass_query_failed', err });
                throw err;
              }),
          };
  }

  private readonly authDb: BypassQueryPort | null;

  /** 租户事务入口（引擎启用前提 tenantDb 非空；空态在 onModuleInit 提前返回）。 */
  private db(): TenantDb {
    if (this.tenantDb === null) throw new Error('alarm engine: DB 未配置');
    return this.tenantDb;
  }

  onModuleInit(): void {
    if (this.tenantDb === null) {
      this.logger.warn({
        msg: 'alarm_engine_db_disabled',
        hint: 'PG 未配置，引擎停用（骨架形态）',
      });
      return;
    }
    this.tickTimer = setInterval(() => void this.tick(), TICK_MS);
    this.sweepTimer = setInterval(() => void this.sweepSuppressions(), SWEEP_MS);
    void this.rebuildFromGatewayTruth();
  }

  onApplicationShutdown(): void {
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
  }

  // -------------------------------------------------------------------
  // 通道 ①：质量事件（Kafka 消费者驱动，ingest.md §8 载荷）
  // -------------------------------------------------------------------

  /**
   * 质量事件求值入口。载荷 {point_id, gateway_id, ts, event, detail}；
   * event 值集 QUALITY_EVENTS（R7 钉死）——仅 stale_set/stale_clear 是边沿，
   * ts_skew/unit_unconverted 计数留痕不参与求值（去抖口径归 DAT-122 归属卡）。
   */
  async onQualityEvent(payload: {
    point_id: number | string;
    gateway_id?: string | null;
    ts?: number | string;
    event: string;
  }): Promise<void> {
    const event = payload.event;
    if (event !== 'stale_set' && event !== 'stale_clear') {
      if (event === 'ts_skew' || event === 'unit_unconverted') {
        this.metrics.recordQualityEvent(event);
      } else {
        this.logger.warn({ msg: 'quality_event_unknown', event });
      }
      return;
    }
    this.metrics.recordQualityEvent(event);
    const tenantId = await this.resolveTenantByGateway(payload.gateway_id ?? null);
    if (tenantId === null) {
      this.logger.warn({
        msg: 'quality_event_gateway_unresolved',
        point_id: payload.point_id,
        gateway_id: payload.gateway_id ?? null,
      });
      return;
    }
    const pointId = String(payload.point_id);
    const at = typeof payload.ts === 'number' ? payload.ts : Date.now();
    // 加载与求值分离：onEdge 的到期处理自开事务（不与加载事务嵌套占连接）
    const loaded = await this.db().withTenant(tenantId, async (tx) => {
      const point = await this.loadPoint(tx, pointId);
      if (point === null || point.status !== 'active') {
        return null; // M1-asset §10-O3：disabled 点跳过求值与恢复
      }
      const rule = await this.loadRule(tx, tenantId, 'point', pointId, 'point_stale');
      return { point, rule };
    });
    if (loaded === null) return;
    const { point, rule } = loaded;
    await this.onEdge(
      {
        tenantId,
        category: 'point_stale',
        sourceType: 'point',
        sourceId: pointId,
      },
      event === 'stale_set' ? 'violation' : 'clear',
      at,
      rule === null
        ? null
        : {
            ruleId: rule.id,
            severity: rule.severity as AlarmSeverity,
            sustainedS: rule.sustained_s,
            recoveryS: recoverySeconds(rule.params, 'point_stale'),
          },
      {
        displayName: point.display_name ?? point.raw_name,
        gatewayId: payload.gateway_id ?? null,
      },
    );
  }

  // -------------------------------------------------------------------
  // 通道 ②：EMQX 网关事件（internal-mqtt sink 注入）
  // -------------------------------------------------------------------

  /**
   * 网关上下线边沿（emqx.md §5.2-3）。返回是否构成**新边沿**（状态表变化）——
   * internal-mqtt 以此对同 ts 重投的重复离线 WARN 去重（DAT-110 跟踪项 2）。
   */
  async onGatewaySignal(signal: GatewaySignal): Promise<boolean> {
    const { tenantId, gatewayId, status, atMs } = signal;
    const key: EngineKey = {
      tenantId,
      category: 'gateway_offline',
      sourceType: 'gateway',
      sourceId: gatewayId,
    };
    const rule = await this.db().withTenant(tenantId, async (tx) =>
      this.loadRule(tx, tenantId, 'gateway', gatewayId, 'gateway_offline'),
    );
    const edge = status === 'offline' ? 'violation' : 'clear';
    const before = this.state.get(engineKeyString(key));
    await this.onEdge(key, edge, atMs, this.ruleSnapshotOf(rule, 'gateway_offline'), {
      displayName: signal.gatewayName,
      gatewayId,
      offlineReason: signal.reason,
    });
    const after = this.state.get(engineKeyString(key));
    // 新边沿判定：条目出现/清除，或边沿方向翻转（violating ⇄ 恢复中）
    const beforeTag = edgeTag(before);
    const afterTag = edgeTag(after);
    return beforeTag !== afterTag;
  }

  // -------------------------------------------------------------------
  // 通道 ④：control-safety 直写 open API（§5.2；IMPL-17 接入，无自动恢复）
  // -------------------------------------------------------------------

  /**
   * 直写通道（§5.2）：事件即事实直开（无防抖、无自动恢复——仅人工关闭，§4.1 表）；
   * 活跃同 (category, source_type, source_id) 告警存在 → created=false（去重不重复开，
   * 重复失败经 control_audit 可见）。root_group 不并组（§5.4：组锚仅 gateway 场景）。
   */
  async open(cmd: OpenAlarmCmd): Promise<{ alarm_id: number; created: boolean }> {
    return this.db().withTenant(cmd.tenantId, async (tx) => {
      const active = await this.loadActiveAlarm(
        tx,
        cmd.tenantId,
        cmd.category,
        cmd.source_type,
        cmd.source_id,
      );
      if (active !== null) return { alarm_id: Number(active.id), created: false };
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO alarm_event
           (tenant_id, rule_id, source_type, source_id, severity, message, root_group_id,
            status, category)
         VALUES ($1, NULL, $2, $3, $4, $5, NULL, 'open', $6) RETURNING id`,
        [cmd.tenantId, cmd.source_type, cmd.source_id, cmd.severity, cmd.message, cmd.category],
      );
      const insertedRow = requireRow(inserted.rows, 'alarm_event INSERT');
      const alarmId = Number(insertedRow.id);
      this.metrics.recordAlarmOpened(cmd.category, cmd.severity);
      this.metrics.changeAlarmActive(cmd.severity, 1);
      this.logger.info({
        msg: 'alarm_opened',
        tenant_id: cmd.tenantId,
        alarm_id: alarmId,
        category: cmd.category,
        source_type: cmd.source_type,
        source_id: cmd.source_id,
        severity: cmd.severity,
        channel: 'direct-write',
      });
      return { alarm_id: alarmId, created: true };
    });
  }

  // -------------------------------------------------------------------
  // 停用点联动（M1-asset §10-O3 收口）：活跃 point_stale 告警系统关闭
  // -------------------------------------------------------------------

  async onPointsDisabled(tenantId: string, pointIds: readonly number[]): Promise<number> {
    if (pointIds.length === 0) return 0;
    const closed = await this.db().withTenant(tenantId, async (tx) => {
      const ids = pointIds.map(String);
      const result = await tx.query<{ id: string; severity: string }>(
        `UPDATE alarm_event SET status = 'closed', closed_at = now(), closed_by = NULL,
                close_reason = 'point_disabled'
         WHERE tenant_id = $1 AND category = 'point_stale' AND source_type = 'point'
           AND source_id = ANY($2::text[]) AND status <> 'closed'
         RETURNING id, severity`,
        [tenantId, ids],
      );
      return result.rows;
    });
    for (const row of closed) {
      this.metrics.recordAlarmClosed('point_disabled');
      this.metrics.changeAlarmActive(row.severity as AlarmSeverity, -1);
    }
    for (const pointId of pointIds) {
      this.state.delete(
        engineKeyString({
          tenantId,
          category: 'point_stale',
          sourceType: 'point',
          sourceId: String(pointId),
        }),
      );
    }
    if (closed.length > 0) {
      this.logger.info({
        msg: 'alarm_point_disabled_closed',
        tenant_id: tenantId,
        closed: closed.length,
      });
    }
    return closed.length;
  }

  /**
   * 人工关闭通知（alarms.service close 后调用）：closed 为终态，状态表解除告警链接；
   * 条件仍违反（violating）→ 违约起算重置为 now——复发走新告警行（§4.2），防抖重新计。
   */
  onAlarmClosed(key: EngineKey): void {
    const stateKey = engineKeyString(key);
    const entry = this.state.get(stateKey);
    if (entry === undefined) return;
    if (entry.violatingSince !== null && entry.rule !== null) {
      this.state.set(stateKey, {
        ...entry,
        alarmId: null,
        violatingSince: Date.now(),
        pendingCloseAt: null,
      });
    } else {
      this.state.delete(stateKey);
    }
  }

  // -------------------------------------------------------------------
  // 根因组级联（§4.5）：根告警关闭后，恢复信号已现的子告警立即关闭（回稳窗豁免）
  // -------------------------------------------------------------------

  /** 返回级联关闭数。供本引擎自动恢复路径与 alarms.service 人工 close 复用。 */
  async cascadeAfterRootClose(tenantId: string, rootGroupId: string): Promise<number> {
    const children = await this.db().withTenant(tenantId, async (tx) => {
      const result = await tx.query<{
        id: string;
        source_type: string;
        source_id: string;
        category: string;
        severity: string;
      }>(
        `SELECT id, source_type, source_id, category, severity FROM alarm_event
         WHERE tenant_id = $1 AND root_group_id = $2 AND status IN ('open','acked')`,
        [tenantId, rootGroupId],
      );
      return result.rows;
    });
    let cascadeClosed = 0;
    for (const child of children) {
      const entry = this.state.get(
        engineKeyString({
          tenantId,
          category: child.category,
          sourceType: child.source_type as EngineKey['sourceType'],
          sourceId: child.source_id,
        }),
      );
      // 恢复信号已现 = clear 边沿到达（violating 已清）；无状态（重启丢失）保守保留
      if (entry === undefined || entry.violatingSince !== null) continue;
      const closed = await this.closeAlarm(tenantId, Number(child.id), 'root_group_cascade');
      if (closed) {
        cascadeClosed += 1;
        // closed 终态：子告警状态项解除链接（复发条件再违反时开新行，§4.2）
        this.onAlarmClosed({
          tenantId,
          category: child.category,
          sourceType: child.source_type as 'point' | 'equipment' | 'system' | 'gateway',
          sourceId: child.source_id,
        });
      }
    }
    return cascadeClosed;
  }

  // -------------------------------------------------------------------
  // 内部：边沿处理 / 定时器 / sweep / 重建
  // -------------------------------------------------------------------

  private async onEdge(
    key: EngineKey,
    edge: 'violation' | 'clear',
    at: number,
    rule: RuleSnapshot | null,
    context: { displayName: string; gatewayId: string | null; offlineReason?: string | null },
  ): Promise<void> {
    const stateKey = engineKeyString(key);
    const entry = this.state.get(stateKey) ?? emptyEntry();
    const next =
      edge === 'violation'
        ? applyViolation(entry, at, rule)
        : applyClear(entry, at, rule ?? entry.rule);
    this.state.set(stateKey, next);
    if (edge === 'violation' && edgeTag(entry) !== 'violating') {
      // 新离线/stale 边沿留痕（§5.2-3 的 WARN 面；重复边沿被状态表吸收 = DAT-110 去重）
      this.logger.warn({
        msg: key.category === 'gateway_offline' ? 'gateway_offline_signal' : 'point_stale_signal',
        tenant_id: key.tenantId,
        source_type: key.sourceType,
        source_id: key.sourceId,
        reason: context.offlineReason ?? 'stale',
        rule_configured: rule !== null,
      });
    }
    // clear 即时路径：无活跃告警 → 状态即清（等价 recovery_s=0）
    if (edge === 'clear' && next.alarmId === null && next.pendingCloseAt === null) {
      this.state.delete(stateKey);
    }
    await this.processDue(key, stateKey, context);
  }

  /** 1s tick：扫描状态表执行到期开启/到期关闭（防抖与回稳的唯一执行点）。 */
  private async tick(): Promise<void> {
    const entries = [...this.state.entries()];
    for (const [stateKey, entry] of entries) {
      if (!sustainedDue(entry, Date.now()) && !recoveryDue(entry, Date.now())) continue;
      const key = splitStateKey(stateKey);
      if (key === null) continue;
      await this.processDue(key, stateKey, { displayName: key.sourceId, gatewayId: null });
    }
  }

  private async processDue(
    key: EngineKey,
    stateKey: string,
    context: { displayName: string; gatewayId: string | null },
  ): Promise<void> {
    const entry = this.state.get(stateKey);
    if (entry === undefined) return;
    const now = Date.now();
    if (sustainedDue(entry, now)) {
      const opened = await this.openAlarm(key, entry.rule, context);
      this.state.set(stateKey, { ...entry, alarmId: opened, violatingSince: entry.violatingSince });
      return;
    }
    if (recoveryDue(entry, now)) {
      const alarmId = entry.alarmId;
      if (alarmId === null) return;
      const closed = await this.closeAlarm(key.tenantId, alarmId, 'auto_recovered');
      if (closed) {
        // 根告警自动恢复 → 级联评估（§4.4 路径④）
        const rootGroup = closed.rootGroupId;
        if (rootGroup !== null) {
          void this.cascadeAfterRootClose(key.tenantId, rootGroup).catch((err: unknown) => {
            this.logger.error({ msg: 'alarm_cascade_failed', err, root_group_id: rootGroup });
          });
        }
      }
      this.state.delete(stateKey);
    }
  }

  /** 开启告警（DB 权威去重：活跃告警存在 → 链接不重复开；§5.3-3）。 */
  private async openAlarm(
    key: EngineKey,
    rule: RuleSnapshot | null,
    context: { displayName: string; gatewayId: string | null },
  ): Promise<number | null> {
    if (rule === null) return null;
    return this.db().withTenant(key.tenantId, async (tx) => {
      const active = await this.loadActiveAlarm(
        tx,
        key.tenantId,
        key.category,
        key.sourceType,
        key.sourceId,
      );
      if (active !== null) return Number(active.id);
      // root_group 聚合（§5.5）：网关根自锚铸 uuid；点位 stale 挂活跃网关根
      let rootGroupId: string | null = null;
      if (key.category === 'gateway_offline') {
        rootGroupId = randomUUID();
      } else if (key.category === 'point_stale' && context.gatewayId !== null) {
        const root = await this.loadActiveAlarm(
          tx,
          key.tenantId,
          'gateway_offline',
          'gateway',
          context.gatewayId,
        );
        rootGroupId = root?.root_group_id ?? null;
      }
      const message =
        key.category === 'gateway_offline'
          ? `网关离线：${context.displayName}`
          : `点位数据失效（stale）：${context.displayName}`;
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO alarm_event
           (tenant_id, rule_id, source_type, source_id, severity, message, root_group_id,
            status, category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8) RETURNING id`,
        [
          key.tenantId,
          rule.ruleId,
          key.sourceType,
          key.sourceId,
          rule.severity,
          message,
          rootGroupId,
          key.category,
        ],
      );
      const insertedRow = requireRow(inserted.rows, 'alarm_event INSERT');
      const alarmId = Number(insertedRow.id);
      this.metrics.recordAlarmOpened(key.category, rule.severity);
      this.metrics.changeAlarmActive(rule.severity, 1);
      this.logger.info({
        msg: 'alarm_opened',
        tenant_id: key.tenantId,
        alarm_id: alarmId,
        category: key.category,
        source_type: key.sourceType,
        source_id: key.sourceId,
        severity: rule.severity,
        root_group_id: rootGroupId,
      });
      return alarmId;
    });
  }

  /** 关闭告警（条件 UPDATE 单赢家）。返回 root_group_id（级联锚）或 null（未关成）。 */
  private async closeAlarm(
    tenantId: string,
    alarmId: number,
    closeReason: 'auto_recovered' | 'root_group_cascade',
  ): Promise<{ rootGroupId: string | null } | null> {
    const result = await this.db().withTenant(tenantId, async (tx) => {
      // R2：suppressed 同样执行（行直接 closed，抑制行 ended(alarm_closed)）
      const closed = await tx.query<{ id: string; root_group_id: string | null; severity: string }>(
        `UPDATE alarm_event SET status = 'closed', closed_at = now(), closed_by = NULL,
                close_reason = $3
         WHERE tenant_id = $1 AND id = $2 AND status IN ('open','acked','suppressed')
         RETURNING id, root_group_id, severity`,
        [tenantId, alarmId, closeReason],
      );
      const row = closed.rows[0];
      if (row === undefined) return null;
      // 抑制期内关闭：现行抑制行 ended(alarm_closed)（§4.3）
      await tx.query(
        `UPDATE alarm_suppression SET ended_at = now(), ended_reason = 'alarm_closed'
         WHERE tenant_id = $1 AND alarm_event_id = $2 AND ended_at IS NULL`,
        [tenantId, String(alarmId)],
      );
      return { rootGroupId: row.root_group_id, severity: row.severity };
    });
    if (result === null) return null;
    this.metrics.recordAlarmClosed(closeReason);
    this.metrics.changeAlarmActive(result.severity as AlarmSeverity, -1);
    return { rootGroupId: result.rootGroupId };
  }

  /** 抑制到期 sweep（§4.3：30s 周期；行级条件 UPDATE 单赢家，幂等可安全手工触发）。 */
  async sweepSuppressions(): Promise<void> {
    if (this.authDb === null) return;
    let due: DueSuppressionRow[];
    try {
      const result = await this.authDb.query(
        `SELECT id, tenant_id, alarm_event_id FROM alarm_suppression
         WHERE ended_at IS NULL AND until_at <= now()`,
        [],
      );
      due = result.rows as DueSuppressionRow[];
    } catch (err: unknown) {
      this.logger.error({ msg: 'alarm_sweep_scan_failed', err });
      return;
    }
    for (const row of due) {
      await this.expireSuppression(row).catch((err: unknown) => {
        this.logger.error({ msg: 'alarm_sweep_row_failed', err, suppression_id: row.id });
      });
    }
  }

  private async expireSuppression(row: DueSuppressionRow): Promise<void> {
    await this.db().withTenant(row.tenant_id, async (tx) => {
      const won = await tx.query(
        `UPDATE alarm_suppression SET ended_at = now(), ended_reason = 'expired'
         WHERE id = $1 AND ended_at IS NULL AND tenant_id = $2`,
        [row.id, row.tenant_id],
      );
      if ((won.rowCount ?? 0) === 0) return; // 败者跳过（回置只执行一次，§8.3）
      // 回置抑制前状态（acked_by 非空 ? acked : open）；已 closed 则跳过（不复活）
      const restored = await tx.query<{ id: string }>(
        `UPDATE alarm_event SET status = CASE WHEN acked_by IS NOT NULL THEN 'acked' ELSE 'open' END
         WHERE tenant_id = $1 AND id = $2 AND status = 'suppressed'
         RETURNING id`,
        [row.tenant_id, row.alarm_event_id],
      );
      if (restored.rows.length > 0) {
        this.logger.info({
          msg: 'alarm_suppression_expired',
          tenant_id: row.tenant_id,
          alarm_event_id: Number(row.alarm_event_id),
        });
      }
    });
  }

  /**
   * 重启重建·gateway 通道（§5.6）：以 gateway.status 电平真值对账——
   * offline 无活跃告警 → 补 violation 边沿（防抖从 now 起算，§4.4 配置指引语义）；
   * online 有活跃告警 → 补 clear 边沿（回稳窗起算）。
   */
  private async rebuildFromGatewayTruth(): Promise<void> {
    if (this.authDb === null || this.tenantDb === null) return;
    try {
      const gateways = await this.authDb.query(
        `SELECT id, tenant_id, name, status FROM gateway WHERE status IN ('online','offline')`,
        [],
      );
      for (const gw of gateways.rows as Array<{
        id: string;
        tenant_id: string;
        name: string;
        status: string;
      }>) {
        const status = gw.status === 'online' ? ('online' as const) : ('offline' as const);
        await this.onGatewaySignal({
          tenantId: gw.tenant_id,
          gatewayId: gw.id,
          gatewayName: gw.name,
          status,
          reason: null,
          atMs: Date.now(),
        }).catch((err: unknown) => {
          this.logger.error({ msg: 'alarm_rebuild_gateway_failed', err, gateway_id: gw.id });
        });
      }
      this.logger.info({
        msg: 'alarm_engine_rebuilt_from_gateway_truth',
        gateways: gateways.rows.length,
      });
    } catch (err: unknown) {
      this.logger.error({ msg: 'alarm_rebuild_failed', err });
    }
  }

  /** gateway_id → tenant（质量事件无租户载荷：经 AUTH_DB 旁路解析，§5.1 通道①）。 */
  private async resolveTenantByGateway(gatewayId: string | null): Promise<string | null> {
    if (this.authDb === null || gatewayId === null) return null;
    const result = await this.authDb.query(`SELECT tenant_id FROM gateway WHERE id = $1::uuid`, [
      gatewayId,
    ]);
    return (result.rows[0] as { tenant_id: string } | undefined)?.tenant_id ?? null;
  }

  private async loadPoint(tx: PoolClient, pointId: string): Promise<PointRow | null> {
    const result = await tx.query<PointRow>(
      `SELECT status, display_name, raw_name FROM point WHERE id = $1::bigint LIMIT 1`,
      [pointId],
    );
    return result.rows[0] ?? null;
  }

  /** 求值规则查找（alarm_rule_lookup_idx 路径；enabled 才参与新求值，§5.3-8）。 */
  private async loadRule(
    tx: PoolClient,
    tenantId: string,
    scope: 'point' | 'gateway',
    scopeId: string,
    ruleType: 'point_stale' | 'gateway_offline',
  ): Promise<RuleRow | null> {
    const result = await tx.query<RuleRow>(
      `SELECT id, severity, sustained_s, params FROM alarm_rule
       WHERE tenant_id = $1 AND scope = $2 AND scope_id = $3
         AND rule_type = $4 AND enabled
       ORDER BY created_at ASC, id ASC LIMIT 1`,
      [tenantId, scope, scopeId, ruleType],
    );
    return result.rows[0] ?? null;
  }

  private async loadActiveAlarm(
    tx: PoolClient,
    tenantId: string,
    category: string,
    sourceType: string,
    sourceId: string,
  ): Promise<ActiveAlarmRow | null> {
    const result = await tx.query<ActiveAlarmRow>(
      `SELECT id, root_group_id, status FROM alarm_event
       WHERE tenant_id = $1 AND category = $2 AND source_type = $3
         AND source_id = $4 AND status <> 'closed'
       ORDER BY id DESC LIMIT 1`,
      [tenantId, category, sourceType, sourceId],
    );
    return result.rows[0] ?? null;
  }

  private ruleSnapshotOf(rule: RuleRow | null, category: string): RuleSnapshot | null {
    if (rule === null) return null;
    return {
      ruleId: rule.id,
      severity: rule.severity as AlarmSeverity,
      sustainedS: rule.sustained_s,
      recoveryS: recoverySeconds(rule.params, category),
    };
  }
}

/** RETURNING 单行强制取值（空行 = 程序缺陷 → 500 兜底，同 asset 域 requireRow）。 */
function requireRow<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`unreachable: ${what} RETURNING 未返回行`);
  }
  return row;
}

/** 边沿方向标记（新边沿判定用）。 */
function edgeTag(entry: EngineEntry | undefined): string {
  if (entry === undefined) return 'none';
  if (entry.violatingSince !== null) return 'violating';
  if (entry.pendingCloseAt !== null) return 'recovering';
  return 'none';
}

function splitStateKey(stateKey: string): EngineKey | null {
  const [tenantId, category, sourceType, sourceId] = stateKey.split('|');
  if (
    tenantId === undefined ||
    category === undefined ||
    sourceType === undefined ||
    sourceId === undefined
  ) {
    return null;
  }
  return {
    tenantId,
    category,
    sourceType: sourceType as EngineKey['sourceType'],
    sourceId,
  };
}

/** params.recovery_s 缺省值（M4-alarm.md §4.1：point_stale 300 / gateway_offline 120）。 */
function recoverySeconds(params: Record<string, unknown> | null, category: string): number {
  const raw = params?.['recovery_s'];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const byType = ALARM_RECOVERY_S_DEFAULT as Record<string, number>;
  return byType[category] ?? 0;
}
