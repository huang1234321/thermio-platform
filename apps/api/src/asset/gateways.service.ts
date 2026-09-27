/**
 * 网关与凭证服务（modules M1-asset §3.8/§3.9/§4）。
 *
 * 纪律落点：
 * - serial 全局唯一（跨租户 UNIQUE）：预检 + 23505 兜底 → `gateway.serial_duplicate`
 *   409，details 仅含 serial 本身（**不泄露对方租户信息**，§8.3）；
 * - mqtt_client_id 服务端派生 `gw-{serial}`（serial 全局唯一 ⇒ 派生值唯一）；
 * - username 生成逐字采用 emqx §3.2 约定：首条 `{gateway_serial}@{tenant_slug}`；
 *   轮换 `.r{n}` 后缀（n=该网关历史发放序号**含已吊销**，R13 双活轮换必要扩展）；
 * - secret：32 字节随机 base64url（≥256-bit，SEC-KEY-01）→ argon2id 哈希入库
 *   （SEC-PW-01，复用 auth/password）；**明文仅生成响应返回一次**，不落日志
 *   （SEC-KEY-02/CODE-LOG-01）、列表/详情永不回显（§2.6）；
 * - 双活轮换：每网关 enabled 凭证 < 2（§4；超限 `credential.limit_exceeded` 409）；
 *   凭证发放对网关行 FOR UPDATE 串行（并发不铸双凭证）；
 * - 吊销单向（enabled=false 不可逆），重复吊销幂等 200（§3.9）；
 * - offline_action loose schema（zod 已结构校验）；引用校验在 M2 apply（R10）。
 */
import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { PoolClient } from 'pg';
import {
  CREDENTIAL_ACTIVE_LIMIT,
  GATEWAY_SECRET_BYTES,
  type CredentialDisableRequest,
  type CredentialIssueResponse,
  type CredentialMeta,
  type Gateway,
  type GatewayCreate,
  type GatewayDetail,
  type GatewayListQuery,
  type GatewayUpdate,
  type OfflineAction,
  type Page,
} from '@thermio/shared-types';
import { TENANT_DB } from '../infrastructure/db/db.tokens.js';
import type { TenantDb } from '../infrastructure/db/tenant-db.js';
import { LOGGER } from '../infrastructure/logger.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { hashPassword } from '../auth/password.js';
import {
  loadBuildingScope,
  assertBuildingInScope,
  isoOrNull,
  requireRow,
  type AssetActor,
} from './asset-shared.js';
import { loadBuilding } from './buildings.service.js';
import {
  GATEWAY_KEYSET_COLUMNS,
  decodeAssetCursor,
  encodeAssetCursor,
  isMicrosecondKey,
  keysetPredicate,
} from './asset-cursor.js';

interface GatewayRow {
  id: string;
  building_id: string;
  name: string;
  serial: string;
  vendor_model: string | null;
  mqtt_client_id: string;
  status: 'online' | 'offline';
  last_seen_at: Date | null;
  offline_action: OfflineAction | null;
  created_at: Date;
  created_at_us: string;
}

interface CredentialRow {
  id: string;
  gateway_id: string;
  username: string;
  enabled: boolean;
  created_at: Date;
}

const SELECT_COLUMNS = `g.id, g.building_id, g.name, g.serial, g.vendor_model, g.mqtt_client_id,
       g.status, g.last_seen_at, g.offline_action, g.created_at,
       ((extract(epoch FROM g.created_at) * 1000000)::bigint)::text AS created_at_us`;

const RETURNING_COLUMNS = `id, building_id, name, serial, vendor_model, mqtt_client_id,
       status, last_seen_at, offline_action, created_at,
       ((extract(epoch FROM created_at) * 1000000)::bigint)::text AS created_at_us`;

@Injectable()
export class GatewaysService {
  constructor(
    @Inject(TENANT_DB) private readonly tenantDb: TenantDb | null,
    @Inject(LOGGER) rootLogger: Logger,
  ) {
    this.logger = rootLogger.child({ component: 'asset-gateways' });
  }

  private readonly logger: Logger;

  /** GET /gateways（?building_id&status；(created_at,id) 升序）。 */
  async list(actor: AssetActor, query: GatewayListQuery): Promise<Page<Gateway>> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const scope = await loadBuildingScope(tx, actor);
      const where: string[] = ['g.tenant_id = $1'];
      const params: unknown[] = [actor.tenant_id];
      let next = 2;
      if (scope !== null) {
        where.push(`g.building_id = ANY($${String(next)}::uuid[])`);
        params.push([...scope]);
        next += 1;
      }
      if (query.building_id !== undefined) {
        await loadBuilding(tx, actor, query.building_id); // load-for-user → 404
        where.push(`g.building_id = $${String(next)}`);
        params.push(query.building_id);
        next += 1;
      }
      if (query.status !== undefined) {
        where.push(`g.status = $${String(next)}::text`);
        params.push(query.status);
        next += 1;
      }
      if (query.cursor !== undefined) {
        const cursor = decodeAssetCursor(query.cursor, 1);
        if (!isMicrosecondKey(cursor.k[0] ?? '')) {
          throw new ReasonCodeException('common.validation_failed', '游标不合法或已过期', {
            field: 'cursor',
          });
        }
        const predicate = keysetPredicate(GATEWAY_KEYSET_COLUMNS, cursor, next, ['::bigint', '']);
        where.push(predicate.sql);
        params.push(...predicate.params);
      }
      const result = await tx.query<GatewayRow>(
        `SELECT ${SELECT_COLUMNS}
         FROM gateway g
         WHERE ${where.join(' AND ')}
         ORDER BY g.created_at ASC, g.id ASC
         LIMIT ${String(query.limit + 1)}`,
        params,
      );
      const page = result.rows.slice(0, query.limit);
      const hasMore = result.rows.length > query.limit;
      const lastRow = page.at(-1);
      return {
        items: page.map(toGateway),
        next_cursor:
          hasMore && lastRow !== undefined
            ? encodeAssetCursor({ k: [lastRow.created_at_us], id: lastRow.id })
            : null,
      };
    });
  }

  /** POST /gateways（登记不自动发放凭证——R8：首条显式走 §3.9）。 */
  async create(actor: AssetActor, body: GatewayCreate): Promise<Gateway> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      await loadBuilding(tx, actor, body.building_id);
      await assertSerialFree(tx, body.serial);
      const result = await insertGateway(tx, actor.tenant_id, body).catch((error: unknown) => {
        if (isUniqueViolation(error)) {
          // 竞态兜底：serial 预检后仍撞 UNIQUE（跨租户同名并发登记）
          throw new ReasonCodeException('gateway.serial_duplicate', '网关序列号已存在', {
            serial: body.serial,
          });
        }
        throw error;
      });
      this.logger.info({
        msg: 'gateway_registered',
        tenant_id: actor.tenant_id,
        actor: actor.user_id,
        building_id: body.building_id,
        gateway_id: result.id,
      });
      return toGateway(result);
    });
  }

  /** GET /gateways/{gateway_id}（档案 + 凭证元数据，R2 增补端点）。 */
  async detail(actor: AssetActor, gatewayId: string): Promise<GatewayDetail> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const row = await loadGateway(tx, actor, gatewayId);
      const credentials = await listCredentialMeta(tx, actor.tenant_id, gatewayId);
      return { ...toGateway(row), credentials };
    });
  }

  /** PATCH /gateways/{gateway_id}（{name?, vendor_model?, offline_action?}）。 */
  async update(actor: AssetActor, gatewayId: string, body: GatewayUpdate): Promise<GatewayDetail> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      await loadGateway(tx, actor, gatewayId);
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const [field, value] of Object.entries(body)) {
        params.push(value ?? null);
        sets.push(`${field} = $${String(params.length)}`);
      }
      params.push(actor.tenant_id, gatewayId);
      const result = await tx.query<GatewayRow>(
        `UPDATE gateway SET ${sets.join(', ')}
         WHERE tenant_id = $${String(params.length - 1)} AND id = $${String(params.length)}
         RETURNING ${RETURNING_COLUMNS}`,
        params,
      );
      this.logger.info({
        msg: 'gateway_updated',
        tenant_id: actor.tenant_id,
        actor: actor.user_id,
        gateway_id: gatewayId,
        fields: Object.keys(body),
      });
      const credentials = await listCredentialMeta(tx, actor.tenant_id, gatewayId);
      return { ...toGateway(requireRow(result.rows, 'gateway UPDATE')), credentials };
    });
  }

  /**
   * POST /gateways/{gateway_id}/credentials（生成/轮换双活，§3.9/§4）。
   * 网关行 FOR UPDATE 串行化：上限检查与序号取值无并发窗口。
   */
  async issueCredential(actor: AssetActor, gatewayId: string): Promise<CredentialIssueResponse> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const gateway = await lockGateway(tx, actor, gatewayId);
      const active = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM device_credential
         WHERE tenant_id = $1 AND gateway_id = $2 AND enabled`,
        [actor.tenant_id, gatewayId],
      );
      const activeCount = active.rows[0]?.n ?? 0;
      if (activeCount >= CREDENTIAL_ACTIVE_LIMIT) {
        throw new ReasonCodeException('credential.limit_exceeded', '活跃凭证数已达上限', {
          active_count: activeCount,
          limit: CREDENTIAL_ACTIVE_LIMIT,
        });
      }
      // n = 历史发放序号（含已吊销，§2.6）：首条无后缀，其后 .r1/.r2…
      const history = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM device_credential
         WHERE tenant_id = $1 AND gateway_id = $2`,
        [actor.tenant_id, gatewayId],
      );
      const slug = await tenantSlug(tx, actor.tenant_id);
      const secret = randomBytes(GATEWAY_SECRET_BYTES).toString('base64url');
      const secretHash = await hashPassword(secret);
      let n = history.rows[0]?.n ?? 0;
      let username = credentialUsername(gateway.serial, slug, n);
      let inserted: CredentialRow | undefined;
      for (let attempt = 0; attempt < 2 && inserted === undefined; attempt += 1) {
        try {
          const result = await tx.query<CredentialRow>(
            `INSERT INTO device_credential (tenant_id, gateway_id, username, secret_hash, enabled)
             VALUES ($1, $2, $3, $4, true)
             RETURNING id, gateway_id, username, enabled, created_at`,
            [actor.tenant_id, gatewayId, username, secretHash],
          );
          inserted = result.rows[0];
        } catch (error: unknown) {
          // username 全局唯一兜底（跨网关 serial 撞车已不可能——serial 唯一；
          // 同网关并发已被 FOR UPDATE 挡住，此处仅防御性重试一次）
          if (isUniqueViolation(error) && attempt === 0) {
            n += 1;
            username = credentialUsername(gateway.serial, slug, n);
            continue;
          }
          throw error;
        }
      }
      if (inserted === undefined)
        throw new ReasonCodeException('common.internal_error', '凭证生成失败');
      // 结构化留痕：actor/gateway_id/credential_id/k 序号——**无 secret**（SEC-KEY-02）
      this.logger.info({
        msg: 'credential_issued',
        tenant_id: actor.tenant_id,
        actor: actor.user_id,
        gateway_id: gatewayId,
        credential_id: inserted.id,
        k: n + 1,
        active_count: activeCount + 1,
      });
      return {
        credential: toCredentialMeta(inserted),
        secret, // 仅本次返回（§3.9；关闭弹窗后不可再取）
      };
    });
  }

  /** POST /credentials/{credential_id}/disable（单向吊销，幂等）。 */
  async disableCredential(
    actor: AssetActor,
    credentialId: string,
    body: CredentialDisableRequest,
  ): Promise<CredentialMeta> {
    const db = this.requireDb();
    return db.withTenant(actor.tenant_id, async (tx) => {
      const existing = await loadCredential(tx, actor, credentialId);
      if (!existing.enabled) {
        // 重复吊销幂等 200（§3.9）
        this.logger.info({
          msg: 'credential_disable_idempotent',
          tenant_id: actor.tenant_id,
          actor: actor.user_id,
          credential_id: credentialId,
          reason: body.reason ?? null,
        });
        return toCredentialMeta(existing);
      }
      const result = await tx.query<CredentialRow>(
        `UPDATE device_credential SET enabled = false
         WHERE tenant_id = $1 AND id = $2
         RETURNING id, gateway_id, username, enabled, created_at`,
        [actor.tenant_id, credentialId],
      );
      this.logger.info({
        msg: 'credential_disabled',
        tenant_id: actor.tenant_id,
        actor: actor.user_id,
        gateway_id: existing.gateway_id,
        credential_id: credentialId,
        reason: body.reason ?? null,
      });
      return toCredentialMeta(requireRow(result.rows, 'credential disable'));
    });
  }

  private requireDb(): TenantDb {
    if (this.tenantDb === null) {
      throw new ReasonCodeException('common.internal_error', '资产域未接线');
    }
    return this.tenantDb;
  }
}

/** load-for-user 读单行（gateway.not_found 域码，接入域 R6）。 */
export async function loadGateway(
  tx: PoolClient,
  actor: AssetActor,
  gatewayId: string,
): Promise<GatewayRow> {
  const result = await tx.query<GatewayRow>(
    `SELECT ${SELECT_COLUMNS} FROM gateway g WHERE g.tenant_id = $1 AND g.id = $2`,
    [actor.tenant_id, gatewayId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ReasonCodeException('gateway.not_found', '资源不存在', { entity: 'gateway' });
  }
  const scope = await loadBuildingScope(tx, actor);
  assertBuildingInScope(scope, row.building_id, 'gateway.not_found');
  return row;
}

/** FOR UPDATE 读（凭证发放串行化锚）。 */
async function lockGateway(
  tx: PoolClient,
  actor: AssetActor,
  gatewayId: string,
): Promise<GatewayRow> {
  const result = await tx.query<GatewayRow>(
    `SELECT ${SELECT_COLUMNS} FROM gateway g
     WHERE g.tenant_id = $1 AND g.id = $2 FOR UPDATE`,
    [actor.tenant_id, gatewayId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ReasonCodeException('gateway.not_found', '资源不存在', { entity: 'gateway' });
  }
  const scope = await loadBuildingScope(tx, actor);
  assertBuildingInScope(scope, row.building_id, 'gateway.not_found');
  return row;
}

async function insertGateway(
  tx: PoolClient,
  tenantId: string,
  body: GatewayCreate,
): Promise<GatewayRow> {
  const result = await tx.query<GatewayRow>(
    `INSERT INTO gateway (tenant_id, building_id, name, serial, vendor_model,
                          mqtt_client_id, offline_action)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${RETURNING_COLUMNS}`,
    [
      tenantId,
      body.building_id,
      body.name,
      body.serial,
      body.vendor_model ?? null,
      `gw-${body.serial}`,
      body.offline_action ?? null,
    ],
  );
  return requireRow(result.rows, 'gateway INSERT');
}

async function assertSerialFree(tx: PoolClient, serial: string): Promise<void> {
  const result = await tx.query(`SELECT 1 FROM gateway WHERE serial = $1`, [serial]);
  if (result.rows.length > 0) {
    throw new ReasonCodeException('gateway.serial_duplicate', '网关序列号已存在', { serial });
  }
}

async function loadCredential(
  tx: PoolClient,
  actor: AssetActor,
  credentialId: string,
): Promise<CredentialRow> {
  const result = await tx.query<CredentialRow & { building_id: string }>(
    `SELECT c.id, c.gateway_id, c.username, c.enabled, c.created_at, g.building_id
     FROM device_credential c
     JOIN gateway g ON g.tenant_id = c.tenant_id AND g.id = c.gateway_id
     WHERE c.tenant_id = $1 AND c.id = $2`,
    [actor.tenant_id, credentialId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ReasonCodeException('credential.not_found', '资源不存在', { entity: 'credential' });
  }
  const scope = await loadBuildingScope(tx, actor);
  assertBuildingInScope(scope, row.building_id, 'credential.not_found');
  return row;
}

async function listCredentialMeta(
  tx: PoolClient,
  tenantId: string,
  gatewayId: string,
): Promise<CredentialMeta[]> {
  const result = await tx.query<CredentialRow>(
    `SELECT id, gateway_id, username, enabled, created_at FROM device_credential
     WHERE tenant_id = $1 AND gateway_id = $2
     ORDER BY created_at ASC, id ASC`,
    [tenantId, gatewayId],
  );
  return result.rows.map(toCredentialMeta);
}

/** 凭证 username（emqx §3.2 逐字 + R13 轮换后缀）：`{serial}@{slug}`〔.r{n}〕。 */
function credentialUsername(serial: string, slug: string, n: number): string {
  return n === 0 ? `${serial}@${slug}` : `${serial}@${slug}.r${String(n)}`;
}

async function tenantSlug(tx: PoolClient, tenantId: string): Promise<string> {
  const result = await tx.query<{ slug: string }>(`SELECT slug FROM tenant WHERE id = $1`, [
    tenantId,
  ]);
  const slug = result.rows[0]?.slug;
  if (slug === undefined) throw new ReasonCodeException('common.internal_error', '租户解析失败');
  return slug;
}

function toGateway(row: GatewayRow): Gateway {
  return {
    id: row.id,
    building_id: row.building_id,
    name: row.name,
    serial: row.serial,
    vendor_model: row.vendor_model,
    mqtt_client_id: row.mqtt_client_id,
    status: row.status,
    last_seen_at: isoOrNull(row.last_seen_at),
    offline_action: row.offline_action,
    created_at: isoOrNull(row.created_at) ?? '',
  };
}

function toCredentialMeta(row: CredentialRow): CredentialMeta {
  return {
    id: row.id,
    username: row.username,
    enabled: row.enabled,
    created_at: isoOrNull(row.created_at) ?? '',
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}
