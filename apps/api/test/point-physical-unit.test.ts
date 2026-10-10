/**
 * §3.10 物理层编辑单元测试（DAT-151，M1-asset §3.10）：
 * - 唯一性双面同构：预检命中与索引兜底（23505）**同码同 details**（验收锚点）；
 * - offline_action 引用命中 → 409 阻塞（ADR-003 硬指标 4，details.refs 清单）；
 * - 迁移目标网关跨楼宇 → 422 asset.building_mismatch（双 building_id details）；
 * - ref 联动改写：现值 ref===旧名自动随 raw_name 前进；显式携带 = 操作员意图不覆写；
 * - 提交后配置重推：与 apply 同一生产者（§8.4 产物 + DownChannel），job_id 语义
 *   = 触发关联 id（physical-{point_id}-{uuid}）；迁移时双网关（源+目标）各推一次；
 *   dev 停用通道 → skipped（不 publish）。
 *
 * fake tx 按 SQL 文本路由（无真实库）；PointsService 直构（构造注入面）。
 */
import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type { PoolClient } from 'pg';
import type { GatewayConfigAck, OfflineAction } from '@thermio/shared-types';
import { PointsService, type PointRow } from '../src/asset/points.service.js';
import type { DownChannel } from '../src/import/down-channel.publisher.js';
import { MetricsService } from '../src/infrastructure/metrics/metrics.service.js';
import { ReasonCodeException } from '../src/infrastructure/errors/reason-code.exception.js';
import type { TelemetryStore } from '../src/telemetry/tsdb-read.repository.js';
import type { AlarmEngineService } from '../src/alarm/alarm-engine.service.js';
import type { TenantDb } from '../src/infrastructure/db/tenant-db.js';

const SILENT = pino({ level: 'silent' });
const TENANT = '11111111-1111-1111-1111-111111111111';
const GW_A = '22222222-2222-2222-2222-222222222222';
const GW_B = '33333333-3333-3333-3333-333333333333';
const BUILDING_1 = '44444444-4444-4444-4444-444444444444';
const BUILDING_2 = '55555555-5555-5555-5555-555555555555';

const ACTOR = { tenant_id: TENANT, user_id: 'u1', role: 'admin' } as const;

function pointRow(overrides: Partial<PointRow> = {}): PointRow {
  return {
    id: '101',
    building_id: BUILDING_1,
    equipment_id: null,
    source_type: 'mqtt_gateway',
    gateway_id: GW_A,
    protocol_address: { ref: 'CHW.T01', source: 'import' },
    raw_name: 'CHW.T01',
    sample_interval_s: null,
    quantity_type: 'chw_supply_temp',
    display_name: 'CHW.T01',
    description: null,
    unit_raw: '℃',
    unit_std: 'DegC',
    direction: 'read',
    is_controllable: false,
    clamp_min: null,
    clamp_max: null,
    write_rate_limit_per_hour: null,
    control_mode: 'manual',
    stale_timeout_s: 600,
    valid_range_min: null,
    valid_range_max: null,
    status: 'active',
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-02T00:00:00Z'),
    ...overrides,
  };
}

interface QueryCall {
  sql: string;
  params: unknown[];
}

/** SQL 文本路由 fake tx：物理编辑事务内查询 + 重推快照查询（恒异步——pg 同款）。 */
function makeTx(router: (call: QueryCall) => { rows: object[] }): PoolClient {
  return {
    query: vi.fn(
      (sql: string, params: unknown[] = []) =>
        new Promise((resolve, reject) => {
          try {
            const outcome = router({ sql, params });
            resolve({ rows: outcome.rows, rowCount: outcome.rows.length });
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        }),
    ),
  } as unknown as PoolClient;
}

function makeDb(tx: PoolClient): TenantDb {
  return {
    withTenant: (_tenantId: string, fn: (tx: PoolClient) => unknown) => fn(tx),
  } as unknown as TenantDb;
}

function makeChannel(
  ack: GatewayConfigAck | Error = { job_id: 'j', ok_count: 1, failed: [] },
): { channel: DownChannel; publish: ReturnType<typeof vi.fn> } & { enabled: true } {
  const publish = vi
    .fn()
    .mockImplementation(() => (ack instanceof Error ? Promise.reject(ack) : Promise.resolve(ack)));
  const channel = {
    enabled: true,
    publishConfigAndWaitAck: publish,
    publishRead: vi.fn(),
  } as unknown as DownChannel;
  return { channel, publish, enabled: true };
}

function makeService(
  tx: PoolClient,
  channel: DownChannel = { enabled: false } as unknown as DownChannel,
): PointsService {
  return new PointsService(
    makeDb(tx),
    SILENT,
    {} as TelemetryStore,
    {} as AlarmEngineService,
    channel,
    new MetricsService(),
  );
}

/** 常规改名事务路由（offline_action 可注入；UPDATE 可改为抛错）。 */
function renameRouter(options: {
  offlineAction?: OfflineAction | null;
  updateThrows?: Error;
  updatedRow?: PointRow;
}): (call: QueryCall) => { rows: object[] } {
  return ({ sql }) => {
    if (sql.includes('FROM point p WHERE')) {
      return { rows: [pointRow()] }; // loadPoint（含 loadBuildingScope：admin 免查）
    }
    if (sql.includes('SELECT offline_action FROM gateway')) {
      return { rows: [{ offline_action: options.offlineAction ?? null }] };
    }
    if (sql.includes('id <> $4')) {
      return { rows: [] }; // 唯一性预检（默认无冲突）
    }
    if (sql.includes('UPDATE point SET')) {
      if (options.updateThrows !== undefined) throw options.updateThrows;
      return {
        rows: [
          options.updatedRow ??
            pointRow({
              raw_name: 'CHW.T01.REN',
              protocol_address: { ref: 'CHW.T01.REN', source: 'import' },
            }),
        ],
      };
    }
    if (sql.includes('SELECT mqtt_client_id')) {
      return { rows: [{ mqtt_client_id: 'gw-X', offline_action: null }] }; // 重推快照：网关行
    }
    if (sql.includes('gateway_id = $2 ORDER BY id')) {
      return { rows: [{ raw_name: 'CHW.T01.REN', unit_raw: '℃', unit_std: 'DegC' }] }; // 重推快照：点位
    }
    throw new Error(`未路由的查询: ${sql.slice(0, 60)}`);
  };
}

async function rejectWith(promise: Promise<unknown>): Promise<ReasonCodeException> {
  try {
    await promise;
    throw new Error('预期抛出 ReasonCodeException');
  } catch (caught) {
    if (!(caught instanceof ReasonCodeException)) throw caught;
    return caught;
  }
}

describe('§3.10 物理层编辑（预检/兜底/联动）', () => {
  it('shouldMapIndexViolation_toSameCodeAndDetails_asPrecheck（双面同构验收锚点）', async () => {
    // 预检面：目标 (gateway_id, raw_name) 命中既有行
    const precheckTx = makeTx(({ sql }) => {
      if (sql.includes('FROM point p WHERE')) return { rows: [pointRow()] };
      if (sql.includes('SELECT offline_action FROM gateway'))
        return { rows: [{ offline_action: null }] };
      if (sql.includes('id <> $4')) return { rows: [{ '?column?': 1 }] }; // 命中
      throw new Error(`未路由的查询: ${sql.slice(0, 60)}`);
    });
    const precheck = await rejectWith(
      makeService(precheckTx).physicalPatch(
        ACTOR,
        101,
        { raw_name: 'CHW.OTHER', reason: '修正' },
        undefined,
      ),
    );
    expect(precheck.reasonCode).toBe('asset.duplicate_raw_name');
    expect(precheck.reasonDetails).toEqual({ gateway_id: GW_A, raw_name: 'CHW.OTHER' });

    // 索引兜底面：预检放过、UPDATE 撞 point_gateway_raw_name_uidx（23505）
    const indexTx = makeTx(
      renameRouter({ updateThrows: Object.assign(new Error('dup key'), { code: '23505' }) }),
    );
    const fallback = await rejectWith(
      makeService(indexTx).physicalPatch(
        ACTOR,
        101,
        { raw_name: 'CHW.OTHER', reason: '修正' },
        undefined,
      ),
    );
    expect(fallback.reasonCode).toBe(precheck.reasonCode); // 同码
    expect(fallback.reasonDetails).toEqual(precheck.reasonDetails); // 同 details
  });

  it('shouldBlockOfflineActionReference_with409_andRefsDetails', async () => {
    const writes = { writes: [{ raw_name: 'CHW.T01', value: 0 }] };
    const tx = makeTx(renameRouter({ offlineAction: writes, updatedRow: pointRow() }));
    const error = await rejectWith(
      makeService(tx).physicalPatch(
        ACTOR,
        101,
        { raw_name: 'CHW.T01.REN', reason: '更名' },
        undefined,
      ),
    );
    expect(error.reasonCode).toBe('asset.offline_action_ref_conflict');
    expect(error.reasonDetails).toEqual({
      gateway_id: GW_A,
      refs: [{ raw_name: 'CHW.T01', value: 0 }],
    });
  });

  it('shouldRejectCrossBuildingGatewayMigration_with422_bothBuildingIds', async () => {
    const tx = makeTx(({ sql }) => {
      if (sql.includes('FROM point p WHERE')) return { rows: [pointRow()] };
      if (sql.includes('FROM gateway g WHERE')) {
        // loadGateway：目标网关在另一楼宇
        return { rows: [{ id: GW_B, building_id: BUILDING_2 }] };
      }
      throw new Error(`未路由的查询: ${sql.slice(0, 60)}`);
    });
    const error = await rejectWith(
      makeService(tx).physicalPatch(ACTOR, 101, { gateway_id: GW_B, reason: '迁移' }, undefined),
    );
    expect(error.reasonCode).toBe('asset.building_mismatch');
    expect(error.reasonDetails).toEqual({
      point_building_id: BUILDING_1,
      gateway_building_id: BUILDING_2,
    });
  });

  it('shouldRewriteRefLinkage_inSameTransaction_whenRefEqualsOldRawName', async () => {
    const tx = makeTx(renameRouter({}));
    const point = await makeService(tx).physicalPatch(
      ACTOR,
      101,
      { raw_name: 'CHW.T01.REN', reason: '修正点表错误' },
      undefined,
    );
    expect(point.raw_name).toBe('CHW.T01.REN');
    expect(point.protocol_address).toEqual({ ref: 'CHW.T01.REN', source: 'import' }); // ref 联动改写
    // UPDATE 参数层：protocol_address = 改写后的对象（同事务）
    const calls = (tx.query as ReturnType<typeof vi.fn>).mock.calls as [string, unknown[]][];
    const update = calls.find(([sql]) => sql.includes('UPDATE point SET'));
    if (update === undefined) throw new Error('物理编辑 UPDATE 未发生');
    expect(update[1]).toContainEqual({ ref: 'CHW.T01.REN', source: 'import' });
  });

  it('shouldKeepExplicitProtocolAddress_operatorIntentWins', async () => {
    const tx = makeTx(
      renameRouter({
        updatedRow: pointRow({ raw_name: 'ALIAS', protocol_address: { ref: 'alias-x' } }),
      }),
    );
    const point = await makeService(tx).physicalPatch(
      ACTOR,
      101,
      { raw_name: 'ALIAS', protocol_address: { ref: 'alias-x' }, reason: '显式别名' },
      undefined,
    );
    expect(point.protocol_address).toEqual({ ref: 'alias-x' }); // 显式携带不覆写
  });
});

describe('§3.10 提交后配置重推（M2 §8.4 生产者复用）', () => {
  it('shouldPushTargetGateway_withTriggerScopedJobId_afterRename', async () => {
    const { channel, publish } = makeChannel();
    const tx = makeTx(renameRouter({}));
    await makeService(tx, channel).physicalPatch(
      ACTOR,
      101,
      { raw_name: 'CHW.T01.REN', reason: 'r' },
      undefined,
    );
    await vi.waitFor(() => {
      expect(publish).toHaveBeenCalledTimes(1);
    });
    const [clientId, artifact] = publish.mock.calls[0] as [
      string,
      { job_id: string; points: unknown[] },
    ];
    expect(clientId).toBe('gw-X');
    // job_id 语义（DAT-148 对接注记）：非 apply 触发 = 触发关联 id
    expect(artifact.job_id).toMatch(/^physical-101-[0-9a-f-]{36}$/);
    expect(artifact.points).toEqual([
      { raw_name: 'CHW.T01.REN', ref: 'CHW.T01.REN', unit_raw: '℃', unit_std: 'DegC' },
    ]);
  });

  it('shouldPushBothGateways_onMigration', async () => {
    const { channel, publish } = makeChannel();
    const tx = makeTx(({ sql }) => {
      if (sql.includes('FROM point p WHERE')) return { rows: [pointRow()] };
      if (sql.includes('FROM gateway g WHERE'))
        return { rows: [{ id: GW_B, building_id: BUILDING_1 }] };
      if (sql.includes('SELECT offline_action FROM gateway'))
        return { rows: [{ offline_action: null }] };
      if (sql.includes('id <> $4')) return { rows: [] };
      if (sql.includes('UPDATE point SET')) {
        return { rows: [pointRow({ gateway_id: GW_B })] };
      }
      if (sql.includes('SELECT mqtt_client_id'))
        return { rows: [{ mqtt_client_id: 'gw-B', offline_action: null }] };
      if (sql.includes('gateway_id = $2 ORDER BY id')) return { rows: [] };
      throw new Error(`未路由的查询: ${sql.slice(0, 60)}`);
    });
    await makeService(tx, channel).physicalPatch(
      ACTOR,
      101,
      { gateway_id: GW_B, reason: '迁移' },
      undefined,
    );
    await vi.waitFor(() => {
      expect(publish).toHaveBeenCalledTimes(2);
    }); // 源 + 目标各一次
    const jobIds = new Set(
      (publish.mock.calls as [string, { job_id: string }][]).map(([, a]) => a.job_id),
    );
    expect(jobIds.size).toBe(2); // 每次推送唯一 job_id（应答等待器不互串）
  });

  it('shouldSkipPublish_whenChannelDisabled_dev形态', async () => {
    const publish = vi.fn();
    const channel = { enabled: false, publishConfigAndWaitAck: publish } as unknown as DownChannel;
    const tx = makeTx(renameRouter({}));
    const point = await makeService(tx, channel).physicalPatch(
      ACTOR,
      101,
      { raw_name: 'CHW.T01.REN', reason: 'r' },
      undefined,
    );
    expect(point.raw_name).toBe('CHW.T01.REN'); // 编辑不受停用通道影响
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(publish).not.toHaveBeenCalled();
  });
});
