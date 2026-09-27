/**
 * 导入域服务（modules M2-import §3–§9；IMPL-15 / DAT-118）。
 *
 * 关键纪律落点：
 * - 同步/异步分界（§5.3）：POST /imports 请求内只做 multipart 完整性、building/gateway
 *   load-for-user + 一致性、大小/容器嗅探（422/404 同步拒绝、作业不入库）；
 *   工作表解析为异步段（202 → worker → failed 或 row_count>0 完成信号）；
 * - 守卫链（§4.2/§8.1）：404（存在/归属）→ 403（能力，guard 层）→ 409 state_invalid
 *   → 409 gateway_offline → 409 apply_conflict（SELECT 预演主面）→ 422（幂等键缺失）；
 * - apply 登记事务（§8.3-a）：FOR UPDATE 锁 job → 复核 validated → 冲突竞态兜底 →
 *   批量 INSERT point（§8.2 推导）→ 条件 UPDATE → applied；推送段失败不回滚登记
 *   （数据底座优先，§8.3-d 定夺）；
 * - 自检（§9）：读指令分批 ≤500（MQTT 停用形态跳过下发，统计仍可执行）→ 采集窗
 *   等待 → 回看窗内 ≥1 行 telemetry 即命中（read replica 读）→ UPDATE checked；
 * - 解析 worker 补偿（§11.2）：parsed ∧ row_count=0 ∧ created_at > 5 min 的作业在
 *   读侧触达时置 failed(sheet_corrupt)——文件字节不落库，重解析不可达，单行补偿。
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { PoolClient } from 'pg';
import {
  IMPORT_FILE_MAX_BYTES,
  IMPORT_SELFCHECK_LOOKBACK_S,
  IMPORT_SELFCHECK_READ_BATCH,
  IMPORT_SELFCHECK_WINDOW_S,
  QUANTITY_KINDS,
  QUANTITY_TYPES,
  type DryRunReport,
  type GatewayConfigArtifact,
  type ImportFailure,
  type ImportIssue,
  type ImportJob,
  type ImportJobListQuery,
  type ImportRow,
  type ImportRowPatch,
  type ImportRowsQuery,
  type Page,
  type RowSuggestion,
  type SelfCheckReport,
  findUnitConversion,
} from '@thermio/shared-types';
import { TENANT_DB } from '../infrastructure/db/db.tokens.js';
import type { TenantDb } from '../infrastructure/db/tenant-db.js';
import { LOGGER } from '../infrastructure/logger.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { loadBuildingScope, isoOrNull, bigintValue, requireRow } from '../asset/asset-shared.js';
import type { AssetActor } from '../asset/asset-shared.js';
import { TELEMETRY_STORE } from '../telemetry/telemetry.tokens.js';
import type { TelemetryStore } from '../telemetry/tsdb-read.repository.js';
import { TelemetryStoreUnavailableError } from '../telemetry/telemetry-store.error.js';
import {
  decodeJobCursor,
  decodeRowCursor,
  encodeImportCursor,
  rowKeysetPredicate,
} from './import-cursor.js';
import { inspectXlsxContainer, parsePointTable } from './xlsx-parser.js';
import {
  autoMapRow,
  similarSuggestions,
  type EquipmentCandidate,
  type HistoryRow,
} from './import-mapping.js';
import { buildConfigArtifact } from './config-artifact.js';
import type { DownChannel } from './down-channel.publisher.js';
import { AcksExhaustedError } from './down-channel.publisher.js';
import { DOWN_CHANNEL } from './import.tokens.js';
import { ImportMetrics } from './import.metrics.js';

/** 解析 worker 异常口径（§5.3：60s 无完成信号视为异常；§11.2 补偿取 5 min）。 */
const PARSE_STUCK_MS = 5 * 60 * 1000;
/** suggestions 相似源历史窗口（行上限——R4 索引未落，租户内扫描的有界化）。 */
const SIMILAR_HISTORY_LIMIT = 1000;
/** PATCH rows 守卫集（§4.2：applied/checked/failed 拒绝）。 */
const PATCH_ALLOWED = ['parsed', 'mapping', 'validated'] as const;

interface JobRecord {
  id: string;
  building_id: string;
  gateway_id: string;
  file_name: string;
  row_count: number;
  status: ImportJob['status'];
  mapped_count: number;
  issue_count: number;
  hit_rate: string | null;
  failure: ImportFailure | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  applied_at: Date | null;
  checked_at: Date | null;
  created_at_us: string;
}

interface RowRecord {
  id: string;
  job_id: string;
  row_no: number;
  raw_name: string;
  raw_description: string | null;
  unit_raw: string | null;
  is_write: boolean;
  equipment_id: string | null;
  quantity_type: string | null;
  unit_std: string | null;
  map_status: ImportRow['map_status'];
  issues: ImportIssue[];
  mapped_at: Date | null;
  mapped_by: string | null;
  created_at: Date;
  updated_at: Date;
}

interface GatewayRecord {
  id: string;
  building_id: string;
  mqtt_client_id: string;
  status: 'online' | 'offline';
  offline_action: { writes?: Array<{ raw_name: string; value: number }> } | null;
}

const JOB_COLUMNS = `j.id, j.building_id, j.gateway_id, j.file_name, j.row_count, j.status,
  j.mapped_count, j.issue_count, j.hit_rate, j.failure, j.created_by, j.created_at, j.updated_at,
  j.applied_at, j.checked_at,
  ((extract(epoch FROM j.created_at) * 1000000)::bigint)::text AS created_at_us`;

const ROW_COLUMNS = `r.id, r.job_id, r.row_no, r.raw_name, r.raw_description, r.unit_raw,
  r.is_write, r.equipment_id, r.quantity_type, r.unit_std, r.map_status, r.issues,
  r.mapped_at, r.mapped_by, r.created_at, r.updated_at`;

@Injectable()
export class ImportsService {
  constructor(
    @Inject(TENANT_DB) private readonly tenantDb: TenantDb | null,
    @Inject(LOGGER) rootLogger: Logger,
    @Inject(DOWN_CHANNEL) private readonly downChannel: DownChannel,
    @Inject(TELEMETRY_STORE) private readonly telemetry: TelemetryStore,
    private readonly metrics: ImportMetrics,
  ) {
    this.logger = rootLogger.child({ component: 'import' });
  }

  private readonly logger: Logger;
  /** 自检单飞（§3.9：in-flight 重复 POST 幂等 202，同一轮次去重）。 */
  private readonly selfCheckInFlight = new Set<string>();

  // ═══════════ §3.1 上传（步骤 1） ═══════════

  /** 同步校验（§5.3 分界表）→ 建作业（parsed, row_count=0）→ 异步解析。 */
  async create(
    actor: AssetActor,
    file: { buffer: Buffer; size: number; filename: string } | null,
    body: { building_id: string; gateway_id: string },
  ): Promise<ImportJob> {
    const db = this.requireDb();
    if (file === null || file.size === 0 || file.buffer.length === 0) {
      throw new ReasonCodeException('import.file_invalid', '上传文件缺失或为空', {
        reason: 'empty',
      });
    }
    if (file.size > IMPORT_FILE_MAX_BYTES) {
      throw new ReasonCodeException(
        'import.file_invalid',
        `文件超过 ${String(IMPORT_FILE_MAX_BYTES / (1024 * 1024))} MB 上限`,
        { reason: 'size_exceeded', size: file.size, limit: IMPORT_FILE_MAX_BYTES },
      );
    }
    const container = inspectXlsxContainer(file.buffer);
    if (container !== 'ok') {
      throw new ReasonCodeException('import.file_invalid', '文件不是有效的 xlsx 容器', {
        reason: container,
      });
    }

    const job = await db.withTenant(actor.tenant_id, async (tx) => {
      await loadBuildingForUser(tx, actor, body.building_id);
      const gateway = await loadGatewayForUser(tx, actor, body.gateway_id);
      if (gateway.building_id !== body.building_id) {
        throw new ReasonCodeException('import.building_mismatch', '网关不属于目标楼宇', {
          building_id: body.building_id,
          gateway_building_id: gateway.building_id,
        });
      }
      const result = await tx.query<{ id: string; created_at: Date }>(
        `INSERT INTO import_job (tenant_id, building_id, gateway_id, file_name, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
        [
          actor.tenant_id,
          body.building_id,
          body.gateway_id,
          file.filename.slice(0, 256),
          actor.user_id,
        ],
      );
      return requireRow(result.rows, 'import_job insert');
    });

    const jobId = job.id;
    const tenantId = actor.tenant_id;
    const buffer = file.buffer;
    // 异步解析（§5.3）：完成信号 = status=failed 或 row_count>0
    setImmediate(() => {
      this.runParse(tenantId, jobId, buffer).catch((err: unknown) => {
        this.logger.error({ msg: 'parse_worker_crashed', job_id: jobId, err });
      });
    });
    return this.detail(actor, jobId);
  }

  /** 异步解析 worker：模板规则 → 行入库 or 作业 failed（§5.2/§5.3）。 */
  private async runParse(tenantId: string, jobId: string, buffer: Buffer): Promise<void> {
    const db = this.requireDb();
    const outcome = await parsePointTable(buffer);
    if (!outcome.ok) {
      const failure: ImportFailure = {
        stage: 'parse',
        code: outcome.failure.code,
        message: outcome.failure.message,
        detail: outcome.failure.detail,
      };
      await db.withTenant(tenantId, async (tx) => {
        await tx.query(
          `UPDATE import_job SET status = 'failed', failure = $2
           WHERE id = $1 AND status = 'parsed'`,
          [jobId, JSON.stringify(failure)],
        );
      });
      this.metrics.parseFailures.inc({ code: outcome.failure.code });
      this.logger.warn({ msg: 'import_parse_failed', job_id: jobId, code: outcome.failure.code });
      return;
    }
    await db.withTenant(tenantId, async (tx) => {
      // 行入库 + row_count 单事务（DDL UNIQUE(tenant, job, row_no)；≤5,000 行分批 500；
      // tenant_id 显式携带——RLS WITH CHECK 键，P1-1）
      const rows = outcome.rows;
      for (let i = 0; i < rows.length; i += 500) {
        const batch = rows.slice(i, i + 500);
        const values: unknown[] = [tenantId, jobId];
        const tuples = batch.map((row) => {
          const base = values.length;
          values.push(row.row_no, row.raw_name, row.raw_description, row.unit_raw, row.is_write);
          return `($1, $2, $${String(base + 1)}, $${String(base + 2)}, $${String(base + 3)}, $${String(base + 4)}, $${String(base + 5)})`;
        });
        await tx.query(
          `INSERT INTO import_row (tenant_id, job_id, row_no, raw_name, raw_description, unit_raw, is_write)
           VALUES ${tuples.join(', ')}`,
          values,
        );
      }
      await tx.query(`UPDATE import_job SET row_count = $2 WHERE id = $1`, [jobId, rows.length]);
    });
    this.logger.info({ msg: 'import_parse_done', job_id: jobId, rows: outcome.rows.length });
  }

  // ═══════════ §3.2 作业列表 ═══════════

  async list(actor: AssetActor, query: ImportJobListQuery): Promise<Page<ImportJob>> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const scope = await loadBuildingScope(tx, actor);
      const where: string[] = ['j.tenant_id = $1'];
      const params: unknown[] = [actor.tenant_id];
      let next = 2;
      if (scope !== null) {
        where.push(`j.building_id = ANY($${String(next)}::uuid[])`);
        params.push([...scope]);
        next += 1;
      }
      if (query.building_id !== undefined) {
        await loadBuildingForUser(tx, actor, query.building_id); // load-for-user → 404
        where.push(`j.building_id = $${String(next)}`);
        params.push(query.building_id);
        next += 1;
      }
      if (query.status !== undefined) {
        where.push(`j.status = $${String(next)}::text`);
        params.push(query.status);
        next += 1;
      }
      if (query.cursor !== undefined) {
        const cursor = decodeJobCursor(query.cursor);
        where.push(
          `((extract(epoch FROM j.created_at) * 1000000)::bigint, j.id) < (${dollar(next)}::bigint, ${dollar(next + 1)}::uuid)`,
        );
        params.push(cursor.k[0] ?? '', cursor.id);
        next += 2;
      }
      const result = await tx.query<JobRecord>(
        `SELECT ${JOB_COLUMNS} FROM import_job j
         WHERE ${where.join(' AND ')}
         ORDER BY j.created_at DESC, j.id DESC
         LIMIT ${String(query.limit + 1)}`,
        params,
      );
      const page = result.rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: page.map(toJob),
        next_cursor:
          result.rows.length > query.limit && last !== undefined
            ? encodeImportCursor({ k: [last.created_at_us], id: last.id })
            : null,
      };
    });
  }

  // ═══════════ §3.3 作业详情（含读侧解析补偿 §11.2） ═══════════

  async detail(actor: AssetActor, jobId: string): Promise<ImportJob> {
    const db = this.requireDb();
    const job = await db.withTenant(actor.tenant_id, async (tx) => {
      return loadJobForUser(tx, actor, jobId);
    });
    return this.compensateStuckParse(actor, job);
  }

  // ═══════════ §3.4 行列表（解析预览/映射工作台/未命中清单） ═══════════

  async rows(actor: AssetActor, jobId: string, query: ImportRowsQuery): Promise<Page<ImportRow>> {
    const db = this.requireDb();
    const job = await db.withTenant(actor.tenant_id, async (tx) => {
      return loadJobForUser(tx, actor, jobId);
    });
    await this.compensateStuckParse(actor, job);

    return db.withTenant(actor.tenant_id, async (tx) => {
      const where: string[] = ['r.tenant_id = $1', 'r.job_id = $2'];
      const params: unknown[] = [actor.tenant_id, jobId];
      let next = 3;
      if (query.mapped === 'true') {
        where.push('r.quantity_type IS NOT NULL');
      } else if (query.mapped === 'false') {
        where.push('r.quantity_type IS NULL');
      }
      if (query.issue !== undefined) {
        if (query.issue === '*') {
          where.push('jsonb_array_length(r.issues) > 0');
        } else {
          where.push(`r.issues @> $${String(next)}::jsonb`);
          params.push(JSON.stringify([{ code: query.issue }]));
          next += 1;
        }
      }
      if (query.cursor !== undefined) {
        const cursor = decodeRowCursor(query.cursor);
        where.push(rowKeysetPredicate(cursor, next));
        params.push(Number(cursor.k[0] ?? 0), cursor.id);
        next += 2;
      }
      const result = await tx.query<RowRecord>(
        `SELECT ${ROW_COLUMNS} FROM import_row r
         WHERE ${where.join(' AND ')}
         ORDER BY r.row_no ASC, r.id ASC
         LIMIT ${String(query.limit + 1)}`,
        params,
      );
      const page = result.rows.slice(0, query.limit);
      const last = page.at(-1);

      // suggestions：仅当前页 unmapped 行惰性计算（§6.2/§6.3，读侧有界）
      const unmapped = page.filter((row) => row.quantity_type === null);
      let history: HistoryRow[] = [];
      if (unmapped.length > 0) {
        history = await loadHistoryRows(
          tx,
          actor.tenant_id,
          unmapped.map((r) => r.raw_name),
        );
      }
      return {
        items: page.map((row) =>
          toRow(
            row,
            row.quantity_type === null
              ? similarSuggestions(row.raw_name, row.raw_description, history)
              : [],
          ),
        ),
        next_cursor:
          result.rows.length > query.limit && last !== undefined
            ? encodeImportCursor({ k: [String(last.row_no)], id: last.id })
            : null,
      };
    });
  }

  // ═══════════ §3.5 人工映射（步骤 3/4） ═══════════

  async patchRow(
    actor: AssetActor,
    jobId: string,
    rowId: number,
    body: ImportRowPatch,
  ): Promise<ImportRow> {
    const db = this.requireDb();
    if (body.quantity_type !== undefined && body.quantity_type !== null) {
      assertQuantityTypeKnown(body.quantity_type);
    }
    return db.withTenant(actor.tenant_id, async (tx) => {
      // 锁 job 行：与 dry-run/apply 串行（§4.2 并发防护）
      const job = await lockJobForUser(tx, actor, jobId);
      if (!PATCH_ALLOWED.includes(job.status as (typeof PATCH_ALLOWED)[number])) {
        throw new ReasonCodeException('import.state_invalid', '作业状态不允许映射修改', {
          current_status: job.status,
          allowed: [...PATCH_ALLOWED],
        });
      }
      const rowResult = await tx.query<RowRecord>(
        `SELECT ${ROW_COLUMNS} FROM import_row r WHERE r.job_id = $1 AND r.id = $2`,
        [jobId, rowId],
      );
      const row = rowResult.rows[0];
      if (row === undefined) {
        throw new ReasonCodeException('import.not_found', '资源不存在', { entity: 'import_row' });
      }

      // equipment 归属（须属 job.building → 404 asset.not_found；equipment 经 system 挂楼宇）
      if (body.equipment_id !== undefined && body.equipment_id !== null) {
        const eq = await tx.query<{ id: string }>(
          `SELECT e.id FROM equipment e
           JOIN hvac_system s ON s.tenant_id = e.tenant_id AND s.id = e.system_id
           WHERE e.tenant_id = $1 AND e.id = $2 AND s.building_id = $3`,
          [actor.tenant_id, body.equipment_id, job.building_id],
        );
        if (eq.rows.length === 0) {
          throw new ReasonCodeException('asset.not_found', '资源不存在', { entity: 'equipment' });
        }
      }

      // 单位对即时校验（§6.5：unit_raw 解析期定格，与提交 unit_std 成对判定）
      const nextUnitStd = body.unit_std !== undefined ? body.unit_std : row.unit_std;
      if (row.unit_raw !== null && nextUnitStd !== null) {
        if (findUnitConversion(row.unit_raw, nextUnitStd) === null) {
          throw new ReasonCodeException('import.unit_conversion_unsupported', '单位对无转换规则', {
            unit_raw: row.unit_raw,
            unit_std: nextUnitStd,
            row_id: bigintValue(row.id),
          });
        }
      }

      const nextEquipment = body.equipment_id !== undefined ? body.equipment_id : row.equipment_id;
      const nextQuantity =
        body.quantity_type !== undefined ? body.quantity_type : row.quantity_type;
      const cleared = nextEquipment === null && nextQuantity === null && nextUnitStd === null;
      const mapStatus: ImportRow['map_status'] = cleared
        ? 'unmapped'
        : nextQuantity !== null
          ? 'manual'
          : row.map_status === 'manual'
            ? 'manual'
            : row.map_status;
      const mappedAt = mapStatus === 'manual' ? new Date() : null;
      const mappedBy = mapStatus === 'manual' ? actor.user_id : null;

      const updated = await tx.query<RowRecord>(
        `UPDATE import_row SET
           equipment_id = $3, quantity_type = $4, unit_std = $5,
           map_status = $6, mapped_at = $7, mapped_by = $8
         WHERE job_id = $1 AND id = $2
         RETURNING ${ROW_COLUMNS.replace(/r\./g, '')}`,
        [jobId, rowId, nextEquipment, nextQuantity, nextUnitStd, mapStatus, mappedAt, mappedBy],
      );
      // 摘要同事务重算（mapped_count = quantity_type 非空行数）+ 状态迁移
      const nextStatus =
        job.status === 'parsed' || job.status === 'validated' ? 'mapping' : job.status;
      await tx.query(
        `UPDATE import_job SET status = $2, mapped_count = (
           SELECT count(*) FROM import_row WHERE job_id = $1 AND quantity_type IS NOT NULL
         ) WHERE id = $1`,
        [jobId, nextStatus],
      );
      return toRow(requireRow(updated.rows, 'import_row update'), []);
    });
  }

  // ═══════════ §3.6 自动映射（步骤 3） ═══════════

  async autoMapping(actor: AssetActor, jobId: string): Promise<ImportJob> {
    const db = this.requireDb();
    const job = await db.withTenant(actor.tenant_id, async (tx) => {
      const existing = await loadJobForUser(tx, actor, jobId);
      if (existing.status !== 'parsed' && existing.status !== 'mapping') {
        throw new ReasonCodeException('import.state_invalid', '作业状态不允许自动映射', {
          current_status: existing.status,
          allowed: ['parsed', 'mapping'],
        });
      }
      // 受理即条件迁移（单赢家；mapping 停留）
      await tx.query(
        `UPDATE import_job SET status = 'mapping'
         WHERE id = $1 AND status IN ('parsed', 'mapping')`,
        [jobId],
      );
      return existing;
    });
    const tenantId = actor.tenant_id;
    setImmediate(() => {
      this.runAutoMapping(tenantId, jobId).catch((err: unknown) => {
        this.logger.error({ msg: 'auto_mapping_crashed', job_id: jobId, err });
      });
    });
    return { ...toJob(job), status: 'mapping' };
  }

  /** 两级引擎异步执行（§6.1）：只处理 unmapped 行，不覆盖既有结果。 */
  private async runAutoMapping(tenantId: string, jobId: string): Promise<void> {
    const db = this.requireDb();
    await db.withTenant(tenantId, async (tx) => {
      const job = requireRow(
        (
          await tx.query<{ building_id: string }>(
            `SELECT building_id FROM import_job WHERE id = $1`,
            [jobId],
          )
        ).rows,
        'job load',
      );
      const unmapped = (
        await tx.query<{ id: string; raw_name: string; raw_description: string | null }>(
          `SELECT id, raw_name, raw_description FROM import_row
           WHERE job_id = $1 AND map_status = 'unmapped'`,
          [jobId],
        )
      ).rows;
      if (unmapped.length === 0) return;

      const history = await loadHistoryRows(
        tx,
        tenantId,
        unmapped.map((r) => r.raw_name),
      );
      const candidates = (
        await tx.query<{ id: string; name: string; equipment_type: string }>(
          `SELECT e.id, e.name, e.equipment_type
           FROM equipment e
           JOIN hvac_system s ON s.tenant_id = e.tenant_id AND s.id = e.system_id
           WHERE e.tenant_id = $1 AND s.building_id = $2`,
          [tenantId, job.building_id],
        )
      ).rows satisfies EquipmentCandidate[];

      let mapped = 0;
      for (const row of unmapped) {
        const result = autoMapRow(row.raw_name, row.raw_description, history, candidates);
        if (result === null) continue;
        const updated = await tx.query(
          `UPDATE import_row SET
             equipment_id = $2, quantity_type = $3, unit_std = $4, map_status = 'auto'
           WHERE id = $1 AND map_status = 'unmapped'`,
          [row.id, result.equipment_id, result.quantity_type, result.unit_std],
        );
        mapped += updated.rowCount ?? 0;
      }
      await tx.query(
        `UPDATE import_job SET mapped_count = (
           SELECT count(*) FROM import_row WHERE job_id = $1 AND quantity_type IS NOT NULL
         ) WHERE id = $1`,
        [jobId],
      );
      this.logger.info({ msg: 'auto_mapping_done', job_id: jobId, mapped, of: unmapped.length });
    });
  }

  // ═══════════ §3.7 dry-run 校验（步骤 5 前置；同步单事务） ═══════════

  async dryRun(actor: AssetActor, jobId: string): Promise<DryRunReport> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const job = await lockJobForUser(tx, actor, jobId);
      if (job.status !== 'mapping') {
        throw new ReasonCodeException('import.state_invalid', 'dry-run 前置状态必须为 mapping', {
          current_status: job.status,
          allowed: ['mapping'],
        });
      }
      const gateway = await loadGatewayById(tx, actor.tenant_id, job.gateway_id);
      const rows = (
        await tx.query<RowRecord>(`SELECT ${ROW_COLUMNS} FROM import_row r WHERE r.job_id = $1`, [
          jobId,
        ])
      ).rows;
      const existing = new Set(
        (
          await tx.query<{ raw_name: string }>(
            `SELECT raw_name FROM point WHERE tenant_id = $1 AND gateway_id = $2`,
            [actor.tenant_id, job.gateway_id],
          )
        ).rows.map((r) => r.raw_name),
      );

      // 行级规则全集（§7）
      const internalDup = new Map<string, number>();
      for (const row of rows) {
        internalDup.set(row.raw_name, (internalDup.get(row.raw_name) ?? 0) + 1);
      }
      const allPointRefs = new Set([...existing, ...rows.map((r) => r.raw_name)]);
      const offlineRefs = collectOfflineActionRefs(gateway.offline_action);

      let blocking = 0;
      let warning = 0;
      const rowIssues = new Map<number, ImportIssue[]>();
      for (const row of rows) {
        const issues: ImportIssue[] = [];
        const push = (
          code: ImportIssue['code'],
          isBlocking: boolean,
          detail: Record<string, unknown>,
        ): void => {
          issues.push({ code, blocking: isBlocking, detail });
          if (isBlocking) blocking += 1;
          else warning += 1;
        };
        if (row.quantity_type === null) {
          push('row_unmapped', true, { row_no: row.row_no });
        }
        if ((internalDup.get(row.raw_name) ?? 0) > 1) {
          push('raw_name_duplicate_internal', true, { raw_name: row.raw_name });
        }
        if (existing.has(row.raw_name)) {
          push('raw_name_conflict_existing', true, {
            raw_name: row.raw_name,
            gateway_id: job.gateway_id,
          });
        }
        if (
          row.quantity_type !== null &&
          !(QUANTITY_TYPES as readonly string[]).includes(row.quantity_type)
        ) {
          push('quantity_type_unknown', true, { quantity_type: row.quantity_type });
        }
        if (
          row.is_write &&
          row.quantity_type !== null &&
          QUANTITY_KINDS[row.quantity_type as keyof typeof QUANTITY_KINDS] === 'enum'
        ) {
          push('write_point_not_numeric', true, {
            quantity_type: row.quantity_type,
            policy: 'P2-3',
          });
        }
        if (row.unit_raw !== null && row.unit_std !== null) {
          if (findUnitConversion(row.unit_raw, row.unit_std) === null) {
            push('unit_unsupported', true, { unit_raw: row.unit_raw, unit_std: row.unit_std });
          }
        }
        if (row.unit_raw !== null && row.unit_std === null) {
          push('unit_std_missing', false, { unit_raw: row.unit_raw });
        }
        if (row.quantity_type !== null && row.equipment_id === null) {
          push('equipment_unassigned', false, { row_no: row.row_no });
        }
        if (row.is_write) {
          push('write_point_clamp_pending', false, {
            hint: 'apply 后经 M8 闸门端点配置（导入不落闸门参数）',
          });
        }
        if (issues.length > 0) rowIssues.set(bigintValue(row.id), issues);
      }

      // 作业级（只入报告不入行，§7；不计入 issue_count——R12：issue_count = 行级口径）
      const jobIssues: ImportIssue[] = [];
      if (gateway.status === 'offline') {
        jobIssues.push({
          code: 'gateway_offline',
          blocking: false,
          detail: { gateway_id: gateway.id },
        });
      }
      for (const ref of offlineRefs) {
        if (!allPointRefs.has(ref)) {
          jobIssues.push({
            code: 'offline_action_ref_unresolved',
            blocking: false,
            detail: { raw_name: ref },
          });
        }
      }

      // issues 全量重算覆盖写入（mapping 态内幂等）
      await tx.query(`UPDATE import_row SET issues = '[]'::jsonb WHERE job_id = $1`, [jobId]);
      for (const [rowId, issues] of rowIssues) {
        await tx.query(`UPDATE import_row SET issues = $2::jsonb WHERE job_id = $1 AND id = $3`, [
          jobId,
          JSON.stringify(issues),
          rowId,
        ]);
      }
      const passed = blocking === 0;
      // R12：issue_count = 阻塞 + 警告（**行级**口径）——作业级问题只入报告（job_issues）
      // 不计入；blocking/warning 两计数器只被行级 push() 递增，故此处即行级总数。
      await tx.query(`UPDATE import_job SET issue_count = $2, status = $3 WHERE id = $1`, [
        jobId,
        blocking + warning,
        passed ? 'validated' : 'mapping',
      ]);
      this.metrics.dryRuns.inc({ passed: passed ? 'true' : 'false' });
      return {
        passed,
        blocking_count: blocking,
        warning_count: warning,
        job_issues: jobIssues,
        row_ref: { filter: 'issue=*' },
      };
    });
  }

  // ═══════════ §3.8 apply（步骤 5） ═══════════

  /** 同步预检（§8.1 守卫链）→ 202 受理（幂等键作用域 (tenant, job, key)，24h 窗）。 */
  async applyPrecheck(actor: AssetActor, jobId: string): Promise<void> {
    const db = this.requireDb();
    await db.withTenant(actor.tenant_id, async (tx) => {
      const job = await loadJobForUser(tx, actor, jobId);
      if (job.status !== 'validated') {
        throw new ReasonCodeException('import.state_invalid', 'apply 前置状态必须为 validated', {
          current_status: job.status,
          allowed: ['validated'],
        });
      }
      const gateway = await loadGatewayById(tx, actor.tenant_id, job.gateway_id);
      if (gateway.status === 'offline') {
        throw new ReasonCodeException('import.gateway_offline', '目标网关离线', {
          gateway_id: gateway.id,
        });
      }
      const conflicts = await findRawNameConflicts(tx, job.gateway_id, jobId);
      if (conflicts.length > 0) {
        throw new ReasonCodeException('import.apply_conflict', '与已注册点位 raw_name 冲突', {
          conflicts,
        });
      }
    });
  }

  /** 202 后异步管线（§8.3）：登记事务 → 配置产物 → 推送应答 → 收敛（内部全兜底，不向调用方抛）。 */
  async executeApplySafely(tenantId: string, jobId: string): Promise<void> {
    try {
      await this.executeApply(tenantId, jobId);
    } catch (err: unknown) {
      this.logger.error({ msg: 'apply_pipeline_crashed', job_id: jobId, err });
    }
  }

  /** 202 后异步管线（§8.3）：登记事务 → 配置产物 → 推送应答 → 收敛。 */
  async executeApply(tenantId: string, jobId: string): Promise<void> {
    const db = this.requireDb();
    // (a) 登记事务（单事务；条件 UPDATE 单赢家；附带 raw_name → row_no 映射，
    // 供 gateway_ack_partial 失败清单回填行号——验收建议 F4）
    const registered = await db
      .withTenant(tenantId, async (tx) => {
        const job = (
          await tx.query<JobRecord>(
            `SELECT ${JOB_COLUMNS.replace(/j\./g, 'ij.')} FROM import_job ij
           WHERE ij.id = $1 FOR UPDATE`,
            [jobId],
          )
        ).rows[0];
        if (job === undefined || job.status !== 'validated') {
          return null; // 输家（异键竞态或状态已前进）——不重复登记
        }
        const conflicts = await findRawNameConflicts(tx, job.gateway_id, jobId);
        if (conflicts.length > 0) {
          // 竞态兜底复核：回滚（抛出即回滚）、作业停留 validated（无 HTTP 面，§8.3-a）
          this.logger.warn({ msg: 'apply_race_conflict_rollback', job_id: jobId, conflicts });
          throw new ApplyRaceConflictError(conflicts);
        }
        const rows = (
          await tx.query<RowRecord>(`SELECT ${ROW_COLUMNS} FROM import_row r WHERE r.job_id = $1`, [
            jobId,
          ])
        ).rows;
        for (const row of rows) {
          await tx.query(
            `INSERT INTO point (
             tenant_id, building_id, equipment_id, source_type, gateway_id,
             protocol_address, raw_name, quantity_type, unit_raw, unit_std,
             display_name, description, direction
           ) VALUES ($1, $2, $3, 'mqtt_gateway', $4,
             jsonb_build_object('ref', $5::text, 'source', 'import'), $5, $6, $7, $8,
             $9, $10, $11)`,
            [
              tenantId,
              job.building_id,
              row.equipment_id,
              job.gateway_id,
              row.raw_name,
              row.quantity_type,
              row.unit_raw,
              row.unit_std,
              (row.raw_description ?? row.raw_name).slice(0, 128),
              row.raw_description,
              row.is_write ? 'write' : 'read',
            ],
          );
        }
        const updated = await tx.query(
          `UPDATE import_job SET status = 'applied', applied_at = now()
         WHERE id = $1 AND status = 'validated' RETURNING id`,
          [jobId],
        );
        if (updated.rowCount !== 1) return null;
        const rowNoByRawName = new Map(rows.map((r) => [r.raw_name, r.row_no]));
        return { job, rowNoByRawName };
      })
      .catch((err: unknown) => {
        if (err instanceof ApplyRaceConflictError) return null;
        throw err;
      });
    if (registered === null) {
      this.metrics.applyOutcomes.inc({ result: 'register_skipped' });
      return;
    }
    const { rowNoByRawName } = registered;

    // (b) 配置产物（全量快照，不落库可重 derive）
    const { artifact, gateway } = await this.buildArtifact(tenantId, jobId);
    this.metrics.configArtifacts.inc();
    this.logger.info({
      msg: 'config_artifact_generated',
      job_id: jobId,
      points: artifact.points.length,
      retained: true,
    });

    // (c)+(d) 推送与应答收敛（停用通道 → 降级跳过，登记保留语义 §8.3-d）
    if (!this.downChannel.enabled) {
      this.metrics.applyOutcomes.inc({ result: 'skipped_mqtt_disabled' });
      this.logger.warn({
        msg: 'config_push_skipped',
        job_id: jobId,
        reason: 'MQTT_BROKER_URL 未配置（dev 停用形态）',
      });
      return;
    }
    try {
      const ack = await this.downChannel.publishConfigAndWaitAck(gateway.mqtt_client_id, artifact);
      if (ack.failed.length === 0) {
        this.metrics.applyOutcomes.inc({ result: 'ack_ok' });
        this.logger.info({
          msg: 'config_ack_ok',
          job_id: jobId,
          ok_count: ack.ok_count,
        });
        return;
      }
      await this.failJob(tenantId, jobId, {
        stage: 'apply_push',
        code: 'gateway_ack_partial',
        message: '网关应答部分点失败（登记保留）',
        // row_no 回填（验收建议 F4）：失败点 join 本作业 import_row 定位行号，
        // 便于向导失败清单直达（§4.4 形状含 row_no；非本作业点保留 0）
        rows: ack.failed.map((f) => ({
          row_no: rowNoByRawName.get(f.raw_name) ?? 0,
          raw_name: f.raw_name,
          reason: f.reason,
        })),
      });
      this.metrics.applyOutcomes.inc({ result: 'ack_partial' });
    } catch (err: unknown) {
      if (err instanceof AcksExhaustedError) {
        await this.failJob(tenantId, jobId, {
          stage: 'apply_push',
          code: 'gateway_ack_timeout',
          message: err.message,
        });
        this.metrics.applyOutcomes.inc({ result: 'ack_timeout' });
        return;
      }
      await this.failJob(tenantId, jobId, {
        stage: 'apply_push',
        code: 'gateway_ack_failed',
        message: '网关整体拒绝配置推送',
        detail: { gateway_reason: err instanceof Error ? err.message : String(err) },
      });
      this.metrics.applyOutcomes.inc({ result: 'ack_failed' });
    }
  }

  /** (b) 全量快照产物（§8.4：points = 本网关全部已注册点）。 */
  private async buildArtifact(
    tenantId: string,
    jobId: string,
  ): Promise<{ artifact: GatewayConfigArtifact; gateway: GatewayRecord }> {
    const db = this.requireDb();
    return db.withTenant(tenantId, async (tx) => {
      const job = requireRow(
        (
          await tx.query<{ gateway_id: string }>(
            `SELECT gateway_id FROM import_job WHERE id = $1`,
            [jobId],
          )
        ).rows,
        'job load',
      );
      const gateway = await loadGatewayById(tx, tenantId, job.gateway_id);
      const points = (
        await tx.query<{ raw_name: string; unit_raw: string | null; unit_std: string | null }>(
          `SELECT raw_name, unit_raw, unit_std FROM point
           WHERE tenant_id = $1 AND gateway_id = $2 ORDER BY id`,
          [tenantId, job.gateway_id],
        )
      ).rows;
      return {
        artifact: buildConfigArtifact(jobId, points, gateway.offline_action ?? null),
        gateway,
      };
    });
  }

  private async failJob(tenantId: string, jobId: string, failure: ImportFailure): Promise<void> {
    const db = this.requireDb();
    await db.withTenant(tenantId, async (tx) => {
      await tx.query(`UPDATE import_job SET status = 'failed', failure = $2 WHERE id = $1`, [
        jobId,
        JSON.stringify(failure),
      ]);
    });
    this.logger.warn({ msg: 'import_job_failed', job_id: jobId, code: failure.code });
  }

  // ═══════════ §3.9/§3.10 自检（步骤 5） ═══════════

  /** POST self-check：守卫 applied/checked → 单飞 → 202 → 异步执行 §9 序列。 */
  async selfCheck(actor: AssetActor, jobId: string): Promise<ImportJob> {
    const db = this.requireDb();
    const job = await db.withTenant(actor.tenant_id, async (tx) => {
      return loadJobForUser(tx, actor, jobId);
    });
    if (job.status !== 'applied' && job.status !== 'checked') {
      throw new ReasonCodeException('import.state_invalid', '自检前置状态必须为 applied/checked', {
        current_status: job.status,
        allowed: ['applied', 'checked'],
      });
    }
    if (this.selfCheckInFlight.has(jobId)) {
      return toJob(job); // 单飞：同一轮次去重，幂等 202
    }
    // 统计依赖 TSDB（§9.3 read replica 读）：停用/不可用 → 503 显式降级（同遥测端点口径）
    await this.probeTelemetryStore();
    this.selfCheckInFlight.add(jobId);
    const tenantId = actor.tenant_id;
    setImmediate(() => {
      this.runSelfCheck(tenantId, jobId).catch((err: unknown) => {
        this.logger.error({ msg: 'self_check_crashed', job_id: jobId, err });
      });
    });
    return toJob(job);
  }

  private async runSelfCheck(tenantId: string, jobId: string): Promise<void> {
    try {
      const db = this.requireDb();
      // (1) 读指令分批下行（≤500/条，批间 100ms；停用通道跳过——统计走回看窗）
      const { gateway, points } = await this.loadSelfCheckPoints(tenantId, jobId);
      if (this.downChannel.enabled) {
        for (let i = 0; i < points.length; i += IMPORT_SELFCHECK_READ_BATCH) {
          const batch = points.slice(i, i + IMPORT_SELFCHECK_READ_BATCH);
          await this.downChannel.publishRead(gateway.mqtt_client_id, {
            job_id: jobId,
            req_id: `${jobId}:${String(i)}`,
            points: batch.map((p) => p.raw_name),
          });
          if (i + IMPORT_SELFCHECK_READ_BATCH < points.length) {
            await sleep(100);
          }
        }
      }
      // (2) 采集窗等待（执行期统计前的固定窗，§9.3；窗内网关上报走正常上行管线）
      await sleep(this.selfCheckWindowMs());
      // (3) 统计落库：[checked_at − W, checked_at] 内 ≥1 行即命中
      const checkedAt = new Date();
      const from = new Date(checkedAt.getTime() - IMPORT_SELFCHECK_LOOKBACK_S * 1000);
      const present = await this.telemetry.presentInWindow(
        points.map((p) => p.point_id),
        from,
        checkedAt,
      );
      const hitCount = points.filter((p) => present.has(p.point_id)).length;
      const hitRate = points.length === 0 ? 0 : hitCount / points.length;
      await db.withTenant(tenantId, async (tx) => {
        await tx.query(
          `UPDATE import_job SET status = 'checked', hit_rate = $2, checked_at = $3
           WHERE id = $1 AND status IN ('applied', 'checked')`,
          [jobId, hitRate.toFixed(4), checkedAt],
        );
      });
      this.metrics.selfChecks.inc();
      this.logger.info({
        msg: 'self_check_done',
        job_id: jobId,
        hit_count: hitCount,
        total: points.length,
      });
    } finally {
      this.selfCheckInFlight.delete(jobId);
    }
  }

  /** 本作业已登记点（raw_name ↔ import_row 行号 ↔ point id）。 */
  private async loadSelfCheckPoints(
    tenantId: string,
    jobId: string,
  ): Promise<{
    gateway: GatewayRecord;
    points: Array<{ point_id: number; raw_name: string; row_no: number }>;
  }> {
    const db = this.requireDb();
    return db.withTenant(tenantId, async (tx) => {
      const job = requireRow(
        (
          await tx.query<{ gateway_id: string }>(
            `SELECT gateway_id FROM import_job WHERE id = $1`,
            [jobId],
          )
        ).rows,
        'job load',
      );
      const gateway = await loadGatewayById(tx, tenantId, job.gateway_id);
      const points = (
        await tx.query<{ point_id: string; raw_name: string; row_no: number }>(
          `SELECT p.id AS point_id, p.raw_name, ir.row_no
           FROM point p JOIN import_row ir
             ON ir.job_id = $1 AND ir.raw_name = p.raw_name
           WHERE p.tenant_id = $2 AND p.gateway_id = $3`,
          [jobId, tenantId, job.gateway_id],
        )
      ).rows;
      return {
        gateway,
        points: points.map((p) => ({
          point_id: bigintValue(p.point_id),
          raw_name: p.raw_name,
          row_no: p.row_no,
        })),
      };
    });
  }

  /** GET self-check：实时计算口径（查询时刻 as_of、同一 W 回看，§9.3）。 */
  async selfCheckReport(actor: AssetActor, jobId: string): Promise<SelfCheckReport> {
    const db = this.requireDb();
    const job = await db.withTenant(actor.tenant_id, async (tx) => {
      return loadJobForUser(tx, actor, jobId);
    });
    if (job.checked_at === null) {
      throw new ReasonCodeException('import.selfcheck_not_ready', '自检报告未生成', {
        reason: this.selfCheckInFlight.has(jobId) ? 'in_progress' : 'never_run',
      });
    }
    const { points } = await this.loadSelfCheckPoints(actor.tenant_id, jobId);
    const asOf = new Date();
    const from = new Date(asOf.getTime() - IMPORT_SELFCHECK_LOOKBACK_S * 1000);
    const present = await this.queryPresence(
      points.map((p) => p.point_id),
      from,
      asOf,
    );
    const missed = points.filter((p) => !present.has(p.point_id));
    const hitCount = points.length - missed.length;
    return {
      job_id: jobId,
      checked_at: job.checked_at.toISOString(),
      hit_rate: points.length === 0 ? 0 : Number((hitCount / points.length).toFixed(4)),
      hit_count: hitCount,
      total_count: points.length,
      window: { lookback_s: IMPORT_SELFCHECK_LOOKBACK_S, as_of: asOf.toISOString() },
      missed: missed.map((p) => ({ row_no: p.row_no, raw_name: p.raw_name, point_id: p.point_id })),
    };
  }

  // ═══════════ 共享小件 ═══════════

  private requireDb(): TenantDb {
    if (this.tenantDb === null) {
      throw new ReasonCodeException('common.internal_error', '数据库未配置', {});
    }
    return this.tenantDb;
  }

  /** TSDB 可用性探测（空集批查：停用形态抛 TelemetryStoreUnavailableError → 503）。 */
  private async probeTelemetryStore(): Promise<void> {
    await this.queryPresence([], new Date(), new Date());
  }

  private async queryPresence(pointIds: number[], from: Date, to: Date): Promise<Set<number>> {
    try {
      return await this.telemetry.presentInWindow(pointIds, from, to);
    } catch (err: unknown) {
      if (err instanceof TelemetryStoreUnavailableError) {
        throw new ReasonCodeException(
          'telemetry.store_unavailable',
          '自检统计依赖的遥测存储不可用',
          {
            hint: 'TSDB_READ_URL 未配置或连接不可用',
          },
        );
      }
      throw err;
    }
  }

  /** §11.2 读侧补偿：parsed ∧ row_count=0 ∧ 超 5 min → failed(sheet_corrupt)。 */
  private async compensateStuckParse(actor: AssetActor, job: JobRecord): Promise<ImportJob> {
    if (
      job.status === 'parsed' &&
      job.row_count === 0 &&
      Date.now() - job.created_at.getTime() > PARSE_STUCK_MS
    ) {
      await this.failJob(actor.tenant_id, job.id, {
        stage: 'parse',
        code: 'sheet_corrupt',
        message: '解析 worker 异常（超时补偿：文件字节不落库，无法重解析）',
      });
      this.metrics.parseFailures.inc({ code: 'sheet_corrupt' });
      return { ...toJob(job), status: 'failed' };
    }
    return toJob(job);
  }

  private selfCheckWindowMs(): number {
    return this.selfCheckWindowMsValue;
  }

  /** 测试可覆写（采集窗 env 覆盖走 ImportModule 工厂注入，此处默认 §9.3 定夺值）。 */
  selfCheckWindowMsValue = IMPORT_SELFCHECK_WINDOW_S * 1000;
}

// ---------------------------------------------------------------------------
// 内部装载器（load-for-user：先查行、再判楼宇归属，越界与不存在同响应 SEC-AZ-03）
// ---------------------------------------------------------------------------

async function loadBuildingForUser(
  tx: PoolClient,
  actor: AssetActor,
  buildingId: string,
): Promise<{ id: string }> {
  const scope = await loadBuildingScope(tx, actor);
  if (scope !== null && !scope.has(buildingId)) {
    throw new ReasonCodeException('asset.not_found', '资源不存在', { entity: 'building' });
  }
  const result = await tx.query<{ id: string }>(
    `SELECT id FROM building WHERE tenant_id = $1 AND id = $2`,
    [actor.tenant_id, buildingId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ReasonCodeException('asset.not_found', '资源不存在', { entity: 'building' });
  }
  return row;
}

async function loadGatewayForUser(
  tx: PoolClient,
  actor: AssetActor,
  gatewayId: string,
): Promise<GatewayRecord> {
  const scope = await loadBuildingScope(tx, actor);
  const result = await tx.query<{
    id: string;
    building_id: string;
    mqtt_client_id: string;
    status: 'online' | 'offline';
    offline_action: GatewayRecord['offline_action'];
  }>(
    `SELECT id, building_id, mqtt_client_id, status, offline_action
     FROM gateway WHERE tenant_id = $1 AND id = $2`,
    [actor.tenant_id, gatewayId],
  );
  const row = result.rows[0];
  if (row === undefined || (scope !== null && !scope.has(row.building_id))) {
    throw new ReasonCodeException('gateway.not_found', '资源不存在', { entity: 'gateway' });
  }
  return row;
}

async function loadGatewayById(
  tx: PoolClient,
  tenantId: string,
  gatewayId: string,
): Promise<GatewayRecord> {
  const result = await tx.query<{
    id: string;
    building_id: string;
    mqtt_client_id: string;
    status: 'online' | 'offline';
    offline_action: GatewayRecord['offline_action'];
  }>(
    `SELECT id, building_id, mqtt_client_id, status, offline_action
     FROM gateway WHERE tenant_id = $1 AND id = $2`,
    [tenantId, gatewayId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ReasonCodeException('gateway.not_found', '资源不存在', { entity: 'gateway' });
  }
  return row;
}

/** 作业归属判定（M7 §5 M2 行：作业楼宇 ∈ scope；越界与不存在同响应）。 */
async function loadJobForUser(
  tx: PoolClient,
  actor: AssetActor,
  jobId: string,
): Promise<JobRecord> {
  const scope = await loadBuildingScope(tx, actor);
  const result = await tx.query<JobRecord>(
    `SELECT ${JOB_COLUMNS} FROM import_job j
     WHERE j.tenant_id = $1 AND j.id = $2`,
    [actor.tenant_id, jobId],
  );
  const row = result.rows[0];
  if (row === undefined || (scope !== null && !scope.has(row.building_id))) {
    throw new ReasonCodeException('import.not_found', '资源不存在', { entity: 'import_job' });
  }
  return row;
}

/** FOR UPDATE 锁定形态（写路径与 dry-run/apply 串行，§4.2）。 */
async function lockJobForUser(
  tx: PoolClient,
  actor: AssetActor,
  jobId: string,
): Promise<JobRecord> {
  const scope = await loadBuildingScope(tx, actor);
  const result = await tx.query<JobRecord>(
    `SELECT ${JOB_COLUMNS} FROM import_job j
     WHERE j.tenant_id = $1 AND j.id = $2 FOR UPDATE`,
    [actor.tenant_id, jobId],
  );
  const row = result.rows[0];
  if (row === undefined || (scope !== null && !scope.has(row.building_id))) {
    throw new ReasonCodeException('import.not_found', '资源不存在', { entity: 'import_job' });
  }
  return row;
}

/** raw_name 冲突清单（本作业行 × point_gateway_raw_name_uidx 预演 SELECT，§8.1）。 */
async function findRawNameConflicts(
  tx: PoolClient,
  gatewayId: string,
  jobId: string,
): Promise<Array<{ row_no: number; raw_name: string }>> {
  const result = await tx.query<{ row_no: number; raw_name: string }>(
    `SELECT ir.row_no, ir.raw_name FROM import_row ir
     JOIN point p ON p.tenant_id = ir.tenant_id AND p.gateway_id = $2 AND p.raw_name = ir.raw_name
     WHERE ir.job_id = $1`,
    [jobId, gatewayId],
  );
  return result.rows.map((r) => ({ row_no: r.row_no, raw_name: r.raw_name }));
}

/** 历史知识库行（§6.4：status ∈ {applied, checked} 的作业行；RLS 天然租户隔离）。 */
async function loadHistoryRows(
  tx: PoolClient,
  tenantId: string,
  rawNames: readonly string[],
): Promise<HistoryRow[]> {
  if (rawNames.length === 0) return [];
  const exact = (
    await tx.query<{
      raw_name: string;
      raw_description: string | null;
      equipment_id: string | null;
      quantity_type: string | null;
      unit_std: string | null;
    }>(
      `SELECT ir.raw_name, ir.raw_description, ir.equipment_id, ir.quantity_type, ir.unit_std
       FROM import_row ir JOIN import_job ij ON ij.id = ir.job_id
       WHERE ir.tenant_id = $1 AND ir.raw_name = ANY($2::text[])
         AND ij.status IN ('applied', 'checked')
       ORDER BY ij.created_at DESC`,
      [tenantId, [...rawNames]],
    )
  ).rows;
  // 相似源：最近历史行有界窗口（R4 索引未落的 MVP 量级裁剪）
  const recent = (
    await tx.query<{
      raw_name: string;
      raw_description: string | null;
      equipment_id: string | null;
      quantity_type: string | null;
      unit_std: string | null;
    }>(
      `SELECT ir.raw_name, ir.raw_description, ir.equipment_id, ir.quantity_type, ir.unit_std
       FROM import_row ir JOIN import_job ij ON ij.id = ir.job_id
       WHERE ir.tenant_id = $1 AND ij.status IN ('applied', 'checked')
         AND ir.quantity_type IS NOT NULL
       ORDER BY ir.created_at DESC LIMIT ${String(SIMILAR_HISTORY_LIMIT)}`,
      [tenantId],
    )
  ).rows;
  const seen = new Set<string>();
  const merged: HistoryRow[] = [];
  for (const row of [...exact, ...recent]) {
    if (row.quantity_type === null) continue;
    const key = row.raw_name;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }
  return merged;
}

function collectOfflineActionRefs(offlineAction: GatewayRecord['offline_action']): Set<string> {
  const refs = new Set<string>();
  for (const write of offlineAction?.writes ?? []) {
    if (typeof write.raw_name === 'string') refs.add(write.raw_name);
  }
  return refs;
}

function assertQuantityTypeKnown(value: string): void {
  if (!(QUANTITY_TYPES as readonly string[]).includes(value)) {
    throw new ReasonCodeException('point.quantity_type_unknown', '量类型不在受支持清单', {
      field: 'quantity_type',
    });
  }
}

function toJob(row: JobRecord): ImportJob {
  return {
    id: row.id,
    building_id: row.building_id,
    gateway_id: row.gateway_id,
    file_name: row.file_name,
    row_count: row.row_count,
    status: row.status,
    mapped_count: row.mapped_count,
    issue_count: row.issue_count,
    hit_rate: row.hit_rate === null ? null : Number(row.hit_rate),
    failure: row.failure,
    created_by: row.created_by,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    applied_at: isoOrNull(row.applied_at),
    checked_at: isoOrNull(row.checked_at),
  };
}

function toRow(row: RowRecord, suggestions: RowSuggestion[]): ImportRow {
  return {
    id: bigintValue(row.id),
    job_id: row.job_id,
    row_no: row.row_no,
    raw_name: row.raw_name,
    raw_description: row.raw_description,
    unit_raw: row.unit_raw,
    is_write: row.is_write,
    equipment_id: row.equipment_id,
    quantity_type: row.quantity_type,
    unit_std: row.unit_std,
    map_status: row.map_status,
    issues: row.issues,
    suggestions,
    mapped_at: isoOrNull(row.mapped_at),
    mapped_by: row.mapped_by,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function dollar(n: number): string {
  return `$${String(n)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 登记事务竞态兜底命中（§8.3-a：回滚、作业停留 validated、无 HTTP 面）。 */
class ApplyRaceConflictError extends Error {
  constructor(readonly conflicts: Array<{ row_no: number; raw_name: string }>) {
    super('apply 登记事务内冲突复核命中');
  }
}
