/**
 * control-safety e2e（IMPL-18 / DAT-164 验收要点载体，PG 门控）。
 *
 * 覆盖（implementation-plan IMPL-18 验收要点逐条）：
 * - 五闸门逐道正/负（platform.md §5.2 码表：whitelist/rate/conflict/fuse 拒绝 +
 *   gate_clamped 2xx 语义→executed with effective 值）；
 * - 回读不一致 → 整段重写 → 回写原值 + verify_failed|reverted 审计演练
 *   （gw-sim 故障注入在本仓以契约级 fake channel 承载——真 gw-sim 在 thermio-ingest 仓，
 *   e2e 不跨仓）；
 * - 排队（同设备串行）/ 合并（同点位顶位 superseded_by）/ 溢出 / 超时；
 * - 租约心跳端点（401/200 三态）+ 过期接管回滚；
 * - 闸门参数变更热生效（下一提案按新 clamp 仲裁）；
 * - M8 端点：清单 / gate 编辑（422 三码 + config_audit 逐字段）/ 模式切换
 *   （skip|fuse_open|same|not_controllable）/ config-audit 检索 / fuse 两读；
 * - 熔断评估：连续 3 次异常 trip → 全系统点位压回 advisory + config_audit 留痕
 *   → 自动恢复（占比回落持续冷却窗）→ 解除≠控制恢复。
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import type { ControlWriteCommand, ControlUpEvent, LoginResponse } from '@thermio/shared-types';
import {
  E2E_ADMIN_URL,
  E2E_API_URL,
  E2E_AUTH_URL,
  E2E_READY,
  PASSWORDS,
  seedWorld,
  type SeededWorld,
} from './e2e-env.js';
import type { ControlChannel } from '../src/control-safety/control-channel.js';
import { CONTROL_CHANNEL } from '../src/control-safety/control-safety.tokens.js';
import { ControlDispatcherService } from '../src/control-safety/dispatcher.service.js';
import { FuseService } from '../src/control-safety/fuse.service.js';
import { LeaseService } from '../src/control-safety/lease.service.js';

const skipped = E2E_READY ? describe : describe.skip;
const SVC_TOKEN = 'e2e-svc-token-algo-0123456789abcdef-0123456789abcdef';

// ---------------------------------------------------------------------------
// gw-sim 契约级替身：down/write → 寄存器 + write_ack / read_result；
// 故障注入按点位族（apply=写生效 / stuck=写不生效 / reject=网关拒收）
// ---------------------------------------------------------------------------

type FaultMode = 'apply' | 'stuck' | 'reject' | 'silent';

class FakeGateway implements ControlChannel {
  readonly enabled = true;
  private readonly registers = new Map<number, number>();
  private readonly handlers: Array<(event: ControlUpEvent) => void> = [];
  faultMode: (pointRef: string) => FaultMode = () => 'apply';
  published: ControlWriteCommand[] = [];

  onUpEvent(handler: (event: ControlUpEvent) => void): void {
    this.handlers.push(handler);
  }

  setRegister(pointRef: string, value: number): void {
    this.registers.set(this.refKey(pointRef), value);
  }

  private refKey(pointRef: string): number {
    let hash = 0;
    for (const ch of pointRef) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
    return hash;
  }

  publishCommand(_gatewayClientId: string, command: ControlWriteCommand): Promise<void> {
    this.published.push(command);
    const mode = this.faultMode(command.point_ref);
    if (mode === 'silent') return Promise.resolve(); // 不应答：ack/read 全超时（§4.4 超时语义驱动）
    setTimeout(() => {
      if (command.msg_type === 'write_cmd') {
        if (mode === 'apply')
          this.registers.set(this.refKey(command.point_ref), command.value ?? 0);
        for (const handler of this.handlers) {
          handler({
            msg_type: 'write_ack',
            ver: 1,
            cmd_id: command.cmd_id,
            gw: _gatewayClientId,
            result: mode === 'reject' ? 'rejected' : 'accepted',
            code: mode === 'reject' ? 'WRITE_REFUSED' : null,
            at: new Date().toISOString(),
          });
        }
      } else {
        const value = this.registers.get(this.refKey(command.point_ref)) ?? null;
        for (const handler of this.handlers) {
          handler({
            msg_type: 'read_result',
            ver: 1,
            cmd_id: command.cmd_id,
            gw: _gatewayClientId,
            value,
            unit: null,
            quality: 'good',
            ts: new Date().toISOString(),
            at: new Date().toISOString(),
          });
        }
      }
    }, 5);
    return Promise.resolve();
  }
}

let app: INestApplication | null = null;
let world: SeededWorld;
let adminToken: string;
let viewerToken: string;
let fake: FakeGateway;
let adminPool: pg.Pool | null = null;
let dispatcher: ControlDispatcherService;
let fuseService: FuseService;
let leaseService: LeaseService;

interface CsSeed {
  systemId: string;
  equipmentA: string;
  equipmentB: string;
  pointSp: number; // 设备A写点（clamp 5..9）
  pointSp2: number; // 设备A同量型第二写点
  pointRo: number; // 只读点
  pointB: number; // 设备B唯一写点
  pointLd: number; // 设备A load_rate 写点（F1 队列用例）
  pointEn: number; // 设备A energy 写点（F1 队列用例）
  gatewayId: string;
}

let seed: CsSeed;

async function login(email: string, password: string): Promise<string> {
  const response = await request(requireApp().getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password });
  expect(response.status).toBe(200);
  return (response.body as LoginResponse).access_token;
}

function requireApp(): INestApplication {
  if (app === null) throw new Error('app 未启动');
  return app;
}

function adminGet(path: string, token = adminToken): request.Test {
  return request(requireApp().getHttpServer())
    .get(`/api/v1${path}`)
    .set('Authorization', `Bearer ${token}`);
}

function adminPatch(path: string, body: unknown, token = adminToken): request.Test {
  return request(requireApp().getHttpServer())
    .patch(`/api/v1${path}`)
    .set('Authorization', `Bearer ${token}`)
    .set('idempotency-key', `ik-${Math.random().toString(36).slice(2)}`)
    .send(body as Record<string, unknown>);
}

function adminPost(path: string, body: unknown, token = adminToken): request.Test {
  return request(requireApp().getHttpServer())
    .post(`/api/v1${path}`)
    .set('Authorization', `Bearer ${token}`)
    .set('idempotency-key', `ik-${Math.random().toString(36).slice(2)}`)
    .send(body as Record<string, unknown>);
}

function internalPost(path: string, body: unknown, token = SVC_TOKEN): request.Test {
  return request(requireApp().getHttpServer())
    .post(path)
    .set('Authorization', `Bearer ${token}`)
    .send(body as Record<string, unknown>);
}

/** internal 提案（equipmentB 单写点默认）+ 立即 approve，返回 proposal_id。 */
async function submitAndApprove(overrides: Record<string, unknown> = {}): Promise<string> {
  const envelope = {
    proposal_id: `pp_${Math.random().toString(36).slice(2, 10)}`,
    algo: 'optimizer/chiller-sequencer',
    algo_version: '0.1.0+abcdef12',
    target: { equipment_id: seed.equipmentB, point: 'chw_supply_temp' },
    action: { op: 'set', value: 7.5, unit: 'degC' },
    previous_value: 6.0,
    rationale: 'e2e 负荷上调',
    expected_saving_kw: 12.5,
    confidence: 0.8,
    evidence: {},
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
  const submitted = await internalPost('/internal/proposals', envelope);
  expect(submitted.status).toBe(201);
  const proposalId = (submitted.body as { proposal_id: string }).proposal_id;
  const approved = await adminPost(`/proposals/${proposalId}/approve`, {});
  expect(approved.status).toBe(202);
  return proposalId;
}

/** 轮询提案至终态（executed/failed/rejected...），返回最终详情。 */
async function awaitTerminal(
  proposalId: string,
  timeoutMs = 8_000,
): Promise<{ status: string; execution_result: Record<string, unknown> }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await queryRow<{ status: string; execution_result: Record<string, unknown> }>(
      `SELECT status, execution_result FROM proposal WHERE id = $1`,
      [proposalId],
    );
    if (row !== undefined && ['executed', 'failed', 'rejected', 'expired'].includes(row.status)) {
      return row;
    }
    if (Date.now() > deadline)
      throw new Error(
        `提案 ${proposalId} 未在 ${String(timeoutMs)}ms 内终态（当前 ${row?.status ?? '?'}）`,
      );
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

async function queryRow<T>(sql: string, params: readonly unknown[]): Promise<T | undefined> {
  const client = await (adminPool as pg.Pool).connect();
  try {
    const result = await client.query(sql, params as unknown[]);
    return result.rows[0] as T | undefined;
  } finally {
    client.release();
  }
}

async function exec(sql: string, params: readonly unknown[] = []): Promise<void> {
  const client = await (adminPool as pg.Pool).connect();
  try {
    await client.query(sql, params as unknown[]);
  } finally {
    client.release();
  }
}

skipped('control-safety e2e（IMPL-18 验收要点）', () => {
  beforeAll(async () => {
    // 执行链加速：VERIFY_DELAY=0 / 超时窗 300ms / 队列上限与预算压缩
    process.env['SVC_TOKEN_ALGO'] = SVC_TOKEN;
    process.env['PROPOSAL_MOCK_EXECUTOR'] = 'off';
    process.env['CONTROL_SAFETY__VERIFY_DELAY_S'] = '0';
    process.env['CONTROL_SAFETY__ACK_TIMEOUT_S'] = '1';
    process.env['CONTROL_SAFETY__READ_TIMEOUT_S'] = '1';
    process.env['CONTROL_SAFETY__WRITE_RETRY_MAX'] = '1';
    process.env['CONTROL_SAFETY__EXECUTION_BUDGET_S'] = '10';
    process.env['CONTROL_SAFETY__CONFLICT_QUEUE_MAX'] = '3';
    process.env['CONTROL_SAFETY__CONFLICT_WAIT_TIMEOUT_S'] = '300';
    process.env['CONTROL_SAFETY__LEASE_SWEEP_INTERVAL_S'] = '5';
    process.env['CONTROL_SAFETY__FUSE_EVAL_INTERVAL_S'] = '60';
    process.env['CONTROL_SAFETY__FUSE_WINDOW_S'] = '900';
    process.env['CONTROL_SAFETY__FUSE_RATE_THRESHOLD'] = '0.3';
    process.env['CONTROL_SAFETY__FUSE_CONSECUTIVE_FAILS'] = '3';
    process.env['CONTROL_SAFETY__FUSE_RELEASE_RATE'] = '0.05';
    process.env['CONTROL_SAFETY__FUSE_COOLDOWN_S'] = '1800';
    process.env['CONTROL_DISPATCH_SCAN_INTERVAL_MS'] = '150';
    process.env['PROPOSAL_EXPIRY_SWEEP_INTERVAL_MS'] = '60000';

    const { Test } = await import('@nestjs/testing');
    const { AppModule } = await import('../src/app.module.js');
    const { configureApp } = await import('../src/bootstrap.js');
    fake = new FakeGateway();
    process.env['PG_API_URL'] = E2E_API_URL;
    process.env['PG_AUTH_URL'] = E2E_AUTH_URL;
    process.env['AUTH_JWT_SECRET'] =
      process.env['AUTH_JWT_SECRET'] ?? 'e2e-test-secret-0123456789abcdef-0123456789abcdef';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CONTROL_CHANNEL)
      .useValue(fake)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    world = await seedWorld();
    adminPool = new pg.Pool({ connectionString: E2E_ADMIN_URL, max: 2 });

    adminToken = await login('admin-a@dt113.test', PASSWORDS.admin);
    viewerToken = await login('viewer-a@dt113.test', PASSWORDS.viewer);

    const client = await adminPool.connect();
    try {
      const firstId = (result: pg.QueryResult): string => {
        const row = result.rows[0] as { id: string } | undefined;
        if (row === undefined) throw new Error('种子 RETURNING 缺行');
        return row.id;
      };
      const gatewayId = firstId(
        await client.query(
          `INSERT INTO gateway (tenant_id, building_id, name, serial, mqtt_client_id, status)
           VALUES ($1, $2, 'e2e 网关', 'GW-E2E-164', 'gw-e2e-164', 'online') RETURNING id`,
          [world.tenantA, world.buildingA1],
        ),
      );
      const systemId = firstId(
        await client.query(
          `INSERT INTO hvac_system (tenant_id, building_id, system_type, name)
           VALUES ($1, $2, 'chilled_water', 'e2e 冷冻系统') RETURNING id`,
          [world.tenantA, world.buildingA1],
        ),
      );
      const equipmentA = firstId(
        await client.query(
          `INSERT INTO equipment (tenant_id, system_id, equipment_type, name, local_id)
           VALUES ($1, $2, 'chiller', 'A 冷机', 'A') RETURNING id`,
          [world.tenantA, systemId],
        ),
      );
      const equipmentB = firstId(
        await client.query(
          `INSERT INTO equipment (tenant_id, system_id, equipment_type, name, local_id)
           VALUES ($1, $2, 'chiller', 'B 冷机', 'B') RETURNING id`,
          [world.tenantA, systemId],
        ),
      );
      const insertPoint = async (
        rawName: string,
        extra: {
          equipmentId: string;
          quantityType: string;
          direction: string;
          controllable: boolean;
          rate?: number | null;
        },
      ): Promise<number> => {
        const row = (
          await client.query(
            `INSERT INTO point (tenant_id, building_id, equipment_id, gateway_id, source_type,
                                raw_name, display_name, quantity_type, unit_std, direction,
                                is_controllable, clamp_min, clamp_max, write_rate_limit_per_hour)
             VALUES ($1, $2, $3, $4, 'mqtt_gateway', $5, $6, $7, 'degC', $8, $9, 5.0, 9.0, $10)
             RETURNING id`,
            [
              world.tenantA,
              world.buildingA1,
              extra.equipmentId,
              gatewayId,
              rawName,
              `${rawName}显示名`,
              extra.quantityType,
              extra.direction,
              extra.controllable,
              extra.rate === undefined ? 6 : extra.rate,
            ],
          )
        ).rows[0] as { id: string };
        return Number(row.id);
      };
      const pointSp = await insertPoint('CHW_ST_SP_01', {
        equipmentId: equipmentA,
        quantityType: 'chw_supply_temp',
        direction: 'readwrite',
        controllable: true,
      });
      const pointSp2 = await insertPoint('CHW_ST_SP_02', {
        equipmentId: equipmentA,
        quantityType: 'power',
        direction: 'readwrite',
        controllable: true,
      });
      const pointRo = await insertPoint('CHW_ST_RO_03', {
        equipmentId: equipmentA,
        quantityType: 'chw_return_temp',
        direction: 'read',
        controllable: false,
      });
      const pointB = await insertPoint('CHW_ST_SP_B1', {
        equipmentId: equipmentB,
        quantityType: 'chw_supply_temp',
        direction: 'readwrite',
        controllable: true,
      });
      // F1 用例：闸门 4 队列上限按【同设备不同点位】排队验证（同点位会被合并语义
      // 顶位）——设备A 补两个可写点（量类型互异，internal target 解析无歧义）
      const pointLd = await insertPoint('CHW_LD_04', {
        equipmentId: equipmentA,
        quantityType: 'load_rate',
        direction: 'readwrite',
        controllable: true,
      });
      const pointEn = await insertPoint('CHW_EN_05', {
        equipmentId: equipmentA,
        quantityType: 'energy',
        direction: 'readwrite',
        controllable: true,
      });
      seed = {
        systemId,
        equipmentA,
        equipmentB,
        pointSp,
        pointSp2,
        pointRo,
        pointB,
        pointLd,
        pointEn,
        gatewayId,
      };
      // 初始寄存器值 = previous_value（回读一致基线）
      fake.setRegister('CHW_ST_SP_01', 6.0);
      fake.setRegister('CHW_ST_SP_02', 6.0);
      fake.setRegister('CHW_ST_SP_B1', 6.0);
      fake.setRegister('CHW_LD_04', 6.0);
      fake.setRegister('CHW_EN_05', 6.0);
    } finally {
      client.release();
    }

    dispatcher = app.get(ControlDispatcherService, { strict: false });
    fuseService = app.get(FuseService, { strict: false });
    leaseService = app.get(LeaseService, { strict: false });
  }, 120_000);

  afterAll(async () => {
    if (app !== null) await app.close();
    if (adminPool !== null) await adminPool.end();
  });

  // -------------------------------------------------------------------
  // 主路径：approve → T1 → 队列 → T2 → 写 → ack → 回读一致 → executed
  // -------------------------------------------------------------------
  it('shouldExecuteEndToEnd_whenReadbackMatches（§9.1 主路径）', async () => {
    const proposalId = await submitAndApprove({ action: { op: 'set', value: 7.5, unit: 'degC' } });
    const terminal = await awaitTerminal(proposalId);
    expect(terminal.status).toBe('executed');
    const result = terminal.execution_result;
    expect(result['phase']).toBe('executed');
    expect(result['effective_value']).toBe(7.5);
    expect(result['clamped']).toBe(false);
    // 全链 cmd 留痕（write + read 各一条，§4.2）
    const cmds = result['cmds'] as Array<{ kind: string }>;
    expect(cmds.map((c) => c.kind)).toEqual(['write', 'read']);
    // control_audit ok 行（§8-A2）
    const audit = await queryRow<{ result: string; actor_type: string; new_value: string }>(
      `SELECT result, actor_type, new_value::text FROM control_audit WHERE proposal_id = $1`,
      [proposalId],
    );
    expect(audit?.result).toBe('ok');
    expect(audit?.actor_type).toBe('algo');
    expect(Number(audit?.new_value)).toBe(7.5);
  });

  it('shouldClampAndRecord_whenValueOutsideRange（闸门 2：2xx + 夹紧前后值）', async () => {
    const proposalId = await submitAndApprove({ action: { op: 'set', value: 9.8, unit: 'degC' } });
    const terminal = await awaitTerminal(proposalId);
    expect(terminal.status).toBe('executed');
    expect(terminal.execution_result['clamped']).toBe(true);
    expect(terminal.execution_result['effective_value']).toBe(9);
    expect(terminal.execution_result['clamp_detail']).toEqual({ from: 9.8, to: 9 });
    // 网关侧寄存器 = clamp 后值
    const audit = await queryRow<{ new_value: string }>(
      `SELECT new_value::text FROM control_audit WHERE proposal_id = $1 AND result = 'ok'`,
      [proposalId],
    );
    expect(Number(audit?.new_value)).toBe(9);
  });

  // -------------------------------------------------------------------
  // 闸门 1 / 3 / 5：T1/T2 硬拒绝（§9.2）
  // -------------------------------------------------------------------
  it('shouldRejectAtGate1_whenPointNotControllable（白名单拒绝 + 审计 + 终态）', async () => {
    // 提案先落（点位此刻可控），approve 前撤白名单 → T1 闸门 1 拦下
    const submitted = await internalPost('/internal/proposals', {
      proposal_id: `pp_${Math.random().toString(36).slice(2, 10)}`,
      algo: 'optimizer/chiller-sequencer',
      algo_version: '0.1.0+abcdef12',
      target: { equipment_id: seed.equipmentB, point: 'chw_supply_temp' },
      action: { op: 'set', value: 7.0, unit: 'degC' },
      previous_value: 6.0,
      rationale: '闸门1用例',
      expected_saving_kw: 1,
      confidence: 0.5,
      evidence: {},
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(submitted.status).toBe(201);
    const pid = (submitted.body as { proposal_id: string }).proposal_id;
    await exec(`UPDATE point SET is_controllable = false WHERE id = $1`, [seed.pointB]);
    const approved = await adminPost(`/proposals/${pid}/approve`, {});
    expect(approved.status).toBe(202);
    const terminal = await awaitTerminal(pid);
    expect(terminal.status).toBe('failed');
    expect(terminal.execution_result['reason_code']).toBe('proposal.gate_whitelist_denied');
    const audit = await queryRow<{ result: string; reason: string }>(
      `SELECT result, reason FROM control_audit WHERE proposal_id = $1`,
      [pid],
    );
    expect(audit?.result).toBe('rejected');
    expect(audit?.reason).toBe('proposal.gate_whitelist_denied');
    await exec(`UPDATE point SET is_controllable = true WHERE id = $1`, [seed.pointB]);
  });

  it('shouldRejectAtGate3_whenRateWindowExhausted（频率限制）', async () => {
    // 上限压到 2 + 铺满窗口（隔离跨用例累计）
    await exec(`UPDATE point SET write_rate_limit_per_hour = 2 WHERE id = $1`, [seed.pointB]);
    for (let i = 0; i < 2; i += 1) {
      await exec(
        `INSERT INTO control_audit (tenant_id, point_id, proposal_id, old_value, new_value, actor_type, result)
         VALUES ($1, $2, NULL, 6, 7, 'algo', 'ok')`,
        [world.tenantA, seed.pointB],
      );
    }
    const proposalId = await submitAndApprove();
    const terminal = await awaitTerminal(proposalId);
    expect(terminal.status).toBe('failed');
    expect(terminal.execution_result['reason_code']).toBe('proposal.gate_rate_limited');
    // 还原 + 清窗口（后续用例）
    await exec(`UPDATE point SET write_rate_limit_per_hour = 60 WHERE id = $1`, [seed.pointB]);
    await exec(
      `DELETE FROM control_audit WHERE tenant_id = $1 AND point_id = $2 AND proposal_id IS NULL`,
      [world.tenantA, seed.pointB],
    );
  });

  it('shouldRejectAtGate5_whenSystemFuseOpen（熔断拒绝）', async () => {
    await exec(
      `INSERT INTO control_fuse (system_id, tenant_id, status, triggered_at, trigger_detail)
       VALUES ($1, $2, 'open', now(), '{}') ON CONFLICT (system_id) DO UPDATE SET status = 'open'`,
      [seed.systemId, world.tenantA],
    );
    const proposalId = await submitAndApprove();
    const terminal = await awaitTerminal(proposalId);
    expect(terminal.status).toBe('failed');
    expect(terminal.execution_result['reason_code']).toBe('proposal.gate_system_fused');
    await exec(`UPDATE control_fuse SET status = 'closed' WHERE system_id = $1`, [seed.systemId]);
  });

  // -------------------------------------------------------------------
  // 回读不一致 → 重写 → 回写原值（§9.3）
  // -------------------------------------------------------------------
  it('shouldRevertToPreviousValue_whenDeviceStuck（回读不一致演练）', async () => {
    fake.setRegister('CHW_ST_SP_B1', 6.0); // 前序 clamp 用例把寄存器写到 9——拨回基线
    fake.faultMode = () => 'stuck'; // 写不生效，回读恒 6.0
    const proposalId = await submitAndApprove({ action: { op: 'set', value: 8.5, unit: 'degC' } });
    const terminal = await awaitTerminal(proposalId, 15_000);
    fake.faultMode = () => 'apply';
    expect(terminal.status).toBe('failed');
    expect(terminal.execution_result['outcome']).toBe('reverted');
    // 审计双行：verify_failed(algo) + reverted(system)
    const audits = await queryRows<{ result: string; actor_type: string; reason: string }>(
      `SELECT result, actor_type, reason FROM control_audit WHERE proposal_id = $1 ORDER BY id ASC`,
      [proposalId],
    );
    expect(audits.map((a) => `${a.result}:${a.actor_type}`)).toEqual([
      'verify_failed:algo',
      'reverted:system',
    ]);
    // 重写段发生了（WRITE_RETRY_MAX=1 → write cmds = 主写 + 重写 + 回写 = 3）
    const cmds = terminal.execution_result['cmds'] as Array<{ kind: string }>;
    expect(cmds.filter((c) => c.kind === 'write')).toHaveLength(2);
    expect(cmds.filter((c) => c.kind === 'revert')).toHaveLength(1);
    // 回写后设备回原值（fault 恢复 apply：revert 写 6.0 生效）
  });

  it('shouldFailCritical_whenNoBaseline（§5.3 无基线：无法回写 → critical）', async () => {
    // previous_value 信封必填——无基线形态用 SQL 直插（DDL 列可空）+ 设备 stuck：
    // 回读不一致 → 回写锚链 null（TSDB e2e 未接）→ no_baseline
    fake.faultMode = (ref) => (ref === 'CHW_ST_SP_01' ? 'stuck' : 'apply');
    const pidRow = await queryRow<{ id: string }>(
      `INSERT INTO proposal
         (tenant_id, algo, algo_version, equipment_id, point_id, action, previous_value,
          rationale, expected_saving_kw, confidence, evidence, expires_at, status, decided_at)
       VALUES ($1, 'optimizer/e2e', '0.1', $2, $3, $4, NULL, '无基线用例', 1, 0.5, '{}',
               now() + interval '1 hour', 'approved', now() - interval '1 second')
       RETURNING id`,
      [
        world.tenantA,
        seed.equipmentA,
        seed.pointSp,
        JSON.stringify({ op: 'set', value: 7.0, unit: 'degC' }),
      ],
    );
    expect(pidRow).toBeDefined();
    const terminal = await awaitTerminal(pidRow?.id as string, 15_000);
    fake.faultMode = () => 'apply';
    expect(terminal.status).toBe('failed');
    expect(terminal.execution_result['outcome']).toBe('verify_failed');
    const audit = await queryRow<{ reason: string }>(
      `SELECT reason FROM control_audit WHERE proposal_id = $1`,
      [pidRow?.id],
    );
    expect(audit?.reason).toBe('no_baseline');
  });

  // -------------------------------------------------------------------
  // 闸门 4：排队 / 合并 / 溢出 / 超时（§9.4）
  // -------------------------------------------------------------------
  it('shouldQueueSameEquipment_andDispatchInOrder（同设备串行）', async () => {
    fake.faultMode = (ref) => (ref === 'CHW_ST_SP_01' ? 'silent' : 'apply');
    // 设备A 两提案：第一阻塞在超时链（silent 无应答），第二应排队
    const first = await internalSubmitForEquipment(seed.equipmentA, 'chw_supply_temp', 7.2);
    const second = await internalSubmitForEquipment(seed.equipmentA, 'power', 6.8);
    await adminPost(`/proposals/${first}/approve`, {});
    await adminPost(`/proposals/${second}/approve`, {});
    // 第一在执行中（ack/read 超时链 ≥ 数秒），第二停留 queued（§3.7 不并发写）
    await new Promise((resolve) => setTimeout(resolve, 400));
    const secondRow = await queryRow<{ status: string; phase: string }>(
      `SELECT status, execution_result->>'phase' AS phase FROM proposal WHERE id = $1`,
      [second],
    );
    expect(secondRow?.status).toBe('approved');
    expect(secondRow?.phase).toBe('queued');
    // 第一终态（silent → verify_failed）后第二出队执行（power 点正常 → executed）
    const firstTerminal = await awaitTerminal(first, 25_000);
    expect(firstTerminal.status).toBe('failed');
    const secondTerminal = await awaitTerminal(second, 25_000);
    fake.faultMode = () => 'apply';
    expect(secondTerminal.status).toBe('executed');
  }, 60_000);

  it('shouldSupersedeQueuedProposal_whenNewerForSamePoint（同点位顶位）', async () => {
    fake.faultMode = (ref) => (ref === 'CHW_ST_SP_02' ? 'silent' : 'apply');
    // blocker 占住设备A（power 点 silent 阻塞，同设备串行不变式）→ 同点位 first/newer 排队
    const blocker = await internalSubmitForEquipment(seed.equipmentA, 'power', 7.1);
    await adminPost(`/proposals/${blocker}/approve`, {});
    await new Promise((resolve) => setTimeout(resolve, 300)); // blocker 进入执行中
    const first = await internalSubmitForEquipment(seed.equipmentA, 'chw_supply_temp', 7.3);
    const newer = await internalSubmitForEquipment(seed.equipmentA, 'chw_supply_temp', 7.4);
    await adminPost(`/proposals/${first}/approve`, {});
    await adminPost(`/proposals/${newer}/approve`, {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    await dispatcher.scanTenant(world.tenantA);
    // 旧排队提案被新提案顶位：failed + superseded_by（复用 failed，不新增状态值）
    const supersededRow = await awaitTerminal(first, 10_000);
    expect(supersededRow.status).toBe('failed');
    const gates = supersededRow.execution_result['gates'] as Array<{
      gate: number;
      outcome: string;
      detail: { superseded_by?: string };
    }>;
    const conflictGate = gates.find((g) => g.gate === 4);
    expect(conflictGate?.outcome).toBe('superseded');
    expect(conflictGate?.detail.superseded_by).toBe(newer);
    // blocker 终态后 newer 顶位执行（chw_supply_temp 点全程 apply：写读正常）
    await awaitTerminal(blocker, 25_000);
    const newerTerminal = await awaitTerminal(newer, 25_000);
    fake.faultMode = () => 'apply';
    expect(newerTerminal.status).toBe('executed');
  }, 60_000);

  it('shouldTimeoutQueuedProposal_whenWaitLimitExceeded（等待超时）', async () => {
    fake.faultMode = (ref) => (ref === 'CHW_ST_SP_01' ? 'silent' : 'apply');
    const blocker = await internalSubmitForEquipment(seed.equipmentA, 'chw_supply_temp', 7.5);
    const waiting = await internalSubmitForEquipment(seed.equipmentA, 'power', 6.9);
    await adminPost(`/proposals/${blocker}/approve`, {});
    await adminPost(`/proposals/${waiting}/approve`, {});
    // 等 waiting 入队后人为拨回 queued_at（> CONFLICT_WAIT_TIMEOUT_S=300）
    await new Promise((resolve) => setTimeout(resolve, 400));
    await exec(
      `UPDATE proposal SET execution_result = jsonb_set(execution_result, '{queued_at}',
         to_jsonb((now() - interval '400 seconds')::timestamptz::text))
       WHERE id = $1`,
      [waiting],
    );
    await dispatcher.scanTenant(world.tenantA);
    const terminal = await awaitTerminal(waiting, 5_000);
    fake.faultMode = () => 'apply';
    expect(terminal.status).toBe('failed');
    expect(terminal.execution_result['reason_code']).toBe('proposal.gate_conflict_timeout');
    await awaitTerminal(blocker, 25_000);
  }, 60_000);

  // -------------------------------------------------------------------
  // M8：闸门参数编辑 + 热生效（验收要点「下一提案即按新参数仲裁」）
  // -------------------------------------------------------------------
  it('shouldApplyNewClampOnNextProposal_afterGatePatch（参数热生效）', async () => {
    const patch = await adminPatch(`/points/${String(seed.pointB)}/gate`, {
      clamp_max: 7.2,
      reason: '秋季负荷下调冷出水上限（e2e 热生效）',
    });
    expect(patch.status).toBe(200);
    const body = patch.body as {
      config_audit_ids: number[];
      point: { gate: { clamp_max: number } };
    };
    expect(body.point.gate.clamp_max).toBe(7.2);
    expect(body.config_audit_ids).toHaveLength(1);
    // 下一提案 7.5 → 按新 clamp 7.2 生效
    const proposalId = await submitAndApprove({ action: { op: 'set', value: 7.5, unit: 'degC' } });
    const terminal = await awaitTerminal(proposalId);
    expect(terminal.status).toBe('executed');
    expect(terminal.execution_result['effective_value']).toBe(7.2);
    // config_audit 行可检索（C1）
    const audit = await queryRow<{ field: string; reason: string }>(
      `SELECT field, reason FROM config_audit WHERE point_id = $1 ORDER BY id DESC LIMIT 1`,
      [seed.pointB],
    );
    expect(audit?.field).toBe('clamp_max');
    expect(audit?.reason).toContain('秋季');
    // 还原
    await adminPatch(`/points/${String(seed.pointB)}/gate`, {
      clamp_max: 9,
      reason: '还原（e2e）',
    });
  });

  it('shouldValidateGatePatch_withDomainCodes（422 三码 + reason 必填）', async () => {
    // reason 空值（M8 §1.2：服务端域码兜底；缺失键为 schema 层 422）
    const noReason = await adminPatch(`/points/${String(seed.pointB)}/gate`, {
      clamp_max: 8,
      reason: '',
    });
    expect(noReason.status).toBe(422);
    expect((noReason.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'point.gate_reason_required',
    );
    // min ≥ max
    const inverted = await adminPatch(`/points/${String(seed.pointB)}/gate`, {
      clamp_min: 9,
      clamp_max: 5,
      reason: '倒置',
    });
    expect(inverted.status).toBe(422);
    expect((inverted.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'point.gate_clamp_range_invalid',
    );
    // 可控点频率上限必填（R8 语义扩展）
    const noRate = await adminPatch(`/points/${String(seed.pointB)}/gate`, {
      write_rate_limit_per_hour: null,
      reason: '清空频率',
    });
    expect(noRate.status).toBe(422);
    expect((noRate.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'point.gate_rate_invalid',
    );
    // viewer 无写能力 → 403（control.write 仅 admin）
    const forbidden = await adminPatch(
      `/points/${String(seed.pointB)}/gate`,
      { clamp_max: 8, reason: '越权' },
      viewerToken,
    );
    expect(forbidden.status).toBe(403);
  });

  it('shouldEnforceModeStateMachine（跳档/同档/前提/熔断封锁 + C2 审计）', async () => {
    const base = `/points/${String(seed.pointB)}/control-mode`;
    // 跳档 advisory → auto
    const skip = await adminPost(base, { target_mode: 'auto', reason: '跳档' });
    expect(skip.status).toBe(409);
    expect(
      (skip.body as { error: { reason_code: string; details: { cause: string } } }).error,
    ).toMatchObject({
      reason_code: 'point.control_mode_transition_invalid',
      details: { cause: 'skip' },
    });
    // 同档
    const same = await adminPost(base, { target_mode: 'advisory', reason: '同档' });
    expect(same.status).toBe(409);
    expect((same.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'point.control_mode_same',
    );
    // 前进一档合法
    const forward = await adminPost(base, { target_mode: 'supervised', reason: '逐档前进（e2e）' });
    expect(forward.status).toBe(200);
    expect((forward.body as { point: { control_mode: string } }).point.control_mode).toBe(
      'supervised',
    );
    // 熔断期间前进封锁
    await exec(
      `INSERT INTO control_fuse (system_id, tenant_id, status, triggered_at, trigger_detail)
       VALUES ($1, $2, 'open', now(), '{}') ON CONFLICT (system_id) DO UPDATE SET status = 'open'`,
      [seed.systemId, world.tenantA],
    );
    const fused = await adminPost(base, { target_mode: 'auto', reason: '熔断中前进' });
    expect(fused.status).toBe(409);
    expect(
      (fused.body as { error: { reason_code: string; details: { cause: string } } }).error,
    ).toMatchObject({
      reason_code: 'point.control_mode_transition_invalid',
      details: { cause: 'fuse_open' },
    });
    // 回退自由（跨档）+ C2 落档
    const back = await adminPost(base, { target_mode: 'advisory', reason: '回退（e2e）' });
    expect(back.status).toBe(200);
    const audit = await queryRow<{
      field: string;
      old_value: unknown;
      new_value: unknown;
      actor_type: string;
    }>(
      `SELECT field, old_value, new_value, actor_type FROM config_audit
        WHERE point_id = $1 AND field = 'control_mode' ORDER BY id DESC LIMIT 1`,
      [seed.pointB],
    );
    expect(audit?.actor_type).toBe('human');
    expect(String(audit?.new_value)).toContain('advisory');
    await exec(`UPDATE control_fuse SET status = 'closed' WHERE system_id = $1`, [seed.systemId]);
  });

  it('shouldListControlPoints_andSearchConfigAudit（清单 + 变更历史检索）', async () => {
    const list = await adminGet('/control/points?is_controllable=true&limit=200');
    expect(list.status).toBe(200);
    const body = list.body as {
      items: Array<{ point_id: number; system_fuse: string; gate: { clamp_max: number | null } }>;
    };
    const hit = body.items.find((item) => item.point_id === seed.pointB);
    expect(hit).toBeDefined();
    expect(hit?.system_fuse).toBe('closed');
    expect(hit?.gate.clamp_max).toBe(9);
    const audit = await adminGet(
      `/config-audit?point_id=${String(seed.pointB)}&field=clamp_min&actor_type=human`,
    );
    expect(audit.status).toBe(200);
    // viewer 可读
    const viewerList = await adminGet('/control/points', viewerToken);
    expect(viewerList.status).toBe(200);
  });

  // -------------------------------------------------------------------
  // 熔断评估（§9.6）：trip → 降级 → 自动恢复
  // -------------------------------------------------------------------
  it('shouldTripFuse_onConsecutiveFails_andDegradeToAdvisory（连续 3 次异常）', async () => {
    // 置非 advisory 点位（模拟已爬档）
    await exec(`UPDATE point SET control_mode = 'supervised' WHERE id = $1`, [seed.pointB]);
    // 铺 3 连续 verify_failed（同系统）
    for (let i = 0; i < 3; i += 1) {
      await exec(
        `INSERT INTO control_audit (tenant_id, point_id, proposal_id, old_value, new_value, actor_type, result)
         VALUES ($1, $2, NULL, 6, 7, 'algo', 'verify_failed')`,
        [world.tenantA, seed.pointB],
      );
    }
    await fuseService.evaluateTenant(world.tenantA);
    const fuse = await queryRow<{ status: string; trigger_detail: Record<string, unknown> }>(
      `SELECT status, trigger_detail FROM control_fuse WHERE system_id = $1`,
      [seed.systemId],
    );
    expect(fuse?.status).toBe('open');
    const detail = fuse?.trigger_detail as Record<string, unknown> | null | undefined;
    const consecutiveFails: unknown =
      detail === null || detail === undefined ? 0 : detail['consecutive_fails'];
    expect(typeof consecutiveFails === 'number' ? consecutiveFails : 0).toBeGreaterThanOrEqual(3);
    // 点位被压回 advisory + config_audit system 行（ddl §9.3 联动）
    const degraded = await queryRow<{ control_mode: string }>(
      `SELECT control_mode FROM point WHERE id = $1`,
      [seed.pointB],
    );
    expect(degraded?.control_mode).toBe('advisory');
    const audit = await queryRow<{ actor_type: string; reason: string }>(
      `SELECT actor_type, reason FROM config_audit
        WHERE point_id = $1 AND field = 'control_mode' AND actor_type = 'system' ORDER BY id DESC`,
      [seed.pointB],
    );
    expect(audit?.reason).toContain('fuse_trip');
    // tripped 事件留痕
    const event = await queryRow<{ event_type: string; actor_type: string }>(
      `SELECT event_type, actor_type FROM control_fuse_event WHERE system_id = $1 ORDER BY id DESC`,
      [seed.systemId],
    );
    expect(event?.event_type).toBe('tripped');
    expect(event?.actor_type).toBe('system');
    // fuse-status 端点可见
    const statusView = await adminGet(`/control/systems/${seed.systemId}/fuse-status`);
    expect(statusView.status).toBe(200);
    expect((statusView.body as { status: string }).status).toBe('open');
    const eventsView = await adminGet(`/control/systems/${seed.systemId}/fuse-events`);
    expect(eventsView.status).toBe(200);
    expect((eventsView.body as { items: unknown[] }).items.length).toBeGreaterThan(0);
  });

  it('shouldAutoRelease_whenRatioRecovers_andNotRestoreModes（解除≠控制恢复）', async () => {
    // 铺恢复面：占比 < 5%（清窗口后 10 ok + 0 fail——前序用例的异常行会污染分子）
    await exec(`DELETE FROM control_audit WHERE tenant_id = $1`, [world.tenantA]);
    for (let i = 0; i < 10; i += 1) {
      await exec(
        `INSERT INTO control_audit (tenant_id, point_id, proposal_id, old_value, new_value, actor_type, result)
         VALUES ($1, $2, NULL, 6, 7, 'algo', 'ok')`,
        [world.tenantA, seed.pointB],
      );
    }
    // 首轮评估锚定 ratio_ok_since
    await fuseService.evaluateTenant(world.tenantA);
    // 拨回锚点（> FUSE_COOLDOWN_S=1800）
    await exec(
      `UPDATE control_fuse SET trigger_detail =
         jsonb_set(COALESCE(trigger_detail, '{}'::jsonb), '{ratio_ok_since}',
           to_jsonb((now() - interval '2000 seconds')::timestamptz::text))
       WHERE system_id = $1`,
      [seed.systemId],
    );
    await fuseService.evaluateTenant(world.tenantA);
    const fuse = await queryRow<{ status: string; released_at: Date | null }>(
      `SELECT status, released_at FROM control_fuse WHERE system_id = $1`,
      [seed.systemId],
    );
    expect(fuse?.status).toBe('closed');
    expect(fuse?.released_at).not.toBeNull();
    // 解除 ≠ 控制恢复：点位仍 advisory（ddl.md §9.3）
    const mode = await queryRow<{ control_mode: string }>(
      `SELECT control_mode FROM point WHERE id = $1`,
      [seed.pointB],
    );
    expect(mode?.control_mode).toBe('advisory');
    const released = await queryRow<{ event_type: string; actor_type: string }>(
      `SELECT event_type, actor_type FROM control_fuse_event WHERE system_id = $1 ORDER BY id DESC`,
      [seed.systemId],
    );
    expect(released?.event_type).toBe('released');
    expect(released?.actor_type).toBe('system');
    await exec(
      `DELETE FROM control_audit WHERE tenant_id = $1 AND point_id = $2 AND proposal_id IS NULL`,
      [world.tenantA, seed.pointB],
    );
  });

  // -------------------------------------------------------------------
  // 租约（§9.5）：心跳端点 + 过期接管
  // -------------------------------------------------------------------
  it('shouldServeHeartbeat_withServiceToken_andThreeOutcomes（〔R3〕端点）', async () => {
    const noToken = request(requireApp().getHttpServer())
      .post('/internal/control/leases/heartbeat')
      .send({ holder: 'algo-inst-1', point_ids: [seed.pointB] });
    expect((await noToken).status).toBe(401);
    const bad = await internalPost(
      '/internal/control/leases/heartbeat',
      {
        holder: 'algo-inst-1',
        point_ids: [seed.pointB],
      },
      'wrong-token',
    );
    expect(bad.status).toBe(401);
    expect((bad.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'auth.service_unauthorized',
    );
    // 空 holder → 422
    const malformed = await internalPost('/internal/control/leases/heartbeat', {
      holder: '',
      point_ids: [1],
    });
    expect(malformed.status).toBe(422);

    // 放租约（holder-1）→ renewed；他 holder → stale；未放点 → not_found
    await leaseService.acquire(world.tenantA, seed.pointB, 'algo-inst-1', 6.0);
    const ok = await internalPost('/internal/control/leases/heartbeat', {
      holder: 'algo-inst-1',
      point_ids: [seed.pointB, seed.pointRo],
    });
    expect(ok.status).toBe(200);
    const results = (ok.body as { results: Array<{ point_id: number; outcome: string }> }).results;
    expect(results).toEqual(
      expect.arrayContaining([
        { point_id: seed.pointB, outcome: 'renewed', expires_at: expect.any(String) },
        { point_id: seed.pointRo, outcome: 'not_found', expires_at: null },
      ]),
    );
    const stale = await internalPost('/internal/control/leases/heartbeat', {
      holder: 'algo-inst-2',
      point_ids: [seed.pointB],
    });
    expect((stale.body as { results: Array<{ outcome: string }> }).results[0]?.outcome).toBe(
      'stale',
    );
  });

  it('shouldTakeOverExpiredLease_andRevertToTakeoverValue（§6.3 过期接管）', async () => {
    fake.setRegister('CHW_ST_SP_B1', 8.0); // 设备当前被改到 8.0
    await exec(
      `UPDATE control_lease SET value_at_takeover = 6.0, expires_at = now() - interval '5 seconds'
       WHERE point_id = $1`,
      [seed.pointB],
    );
    await leaseService.sweep();
    const audit = await queryRow<{
      result: string;
      actor_type: string;
      reason: string;
      new_value: string;
    }>(
      `SELECT result, actor_type, reason, new_value::text FROM control_audit
        WHERE point_id = $1 AND actor_ref = 'lease-sweeper' ORDER BY id DESC LIMIT 1`,
      [seed.pointB],
    );
    expect(audit?.result).toBe('reverted');
    expect(audit?.actor_type).toBe('system');
    expect(audit?.reason).toBe('lease_expired');
    expect(Number(audit?.new_value)).toBe(6.0);
    // 回滚成功 → 租约行删除（§6.3-2）
    const lease = await queryRow<{ point_id: string }>(
      `SELECT point_id FROM control_lease WHERE point_id = $1`,
      [seed.pointB],
    );
    expect(lease).toBeUndefined();
    // 接管告警留痕（info 级，control_lease_rollback）
    const alarm = await queryRow<{ category: string }>(
      `SELECT category FROM alarm_event WHERE source_type = 'equipment' AND category = 'control_lease_rollback' ORDER BY id DESC`,
      [],
    );
    expect(alarm?.category).toBe('control_lease_rollback');
  });

  // -------------------------------------------------------------------
  // 执行详情读投影（M5 联动：闸门逐道 + 审计链）
  // -------------------------------------------------------------------
  // -------------------------------------------------------------------
  // 修单 B1：EXECUTION_BUDGET_S 预算兜底接线（僵尸提案随周期扫描自动收敛）
  // -------------------------------------------------------------------
  it('shouldReclaimZombieExecution_viaSweepWiring（B1：超预算中间态自动收敛）', async () => {
    fake.faultMode = () => 'apply';
    fake.setRegister('CHW_ST_SP_B1', 8.5); // 僵尸的写已落现场（8.5），接管须回写原值 6.0
    // 直插僵尸：approved + awaiting_readback + claimed_at 超预算（600s ≫ 10s）
    const claimedAt = new Date(Date.now() - 600_000).toISOString();
    const zombie = await queryRow<{ id: string }>(
      `INSERT INTO proposal
         (tenant_id, algo, algo_version, equipment_id, point_id, action, previous_value,
          rationale, expected_saving_kw, confidence, evidence, expires_at, status, decided_at,
          execution_result)
       VALUES ($1, 'optimizer/e2e', '0.1', $2, $3, $4, 6.0, '僵尸接管用例', 1, 0.5, '{}',
               now() + interval '1 hour', 'approved', now() - interval '700 seconds', $5)
       RETURNING id`,
      [
        world.tenantA,
        seed.equipmentB,
        seed.pointB,
        JSON.stringify({ op: 'set', value: 8.5, unit: 'degC' }),
        JSON.stringify({ phase: 'awaiting_readback', claimed_at: claimedAt, effective_value: 8.5 }),
      ],
    );
    expect(zombie).toBeDefined();
    // 不直调 reclaim——等 interval 组合扫描（150ms 节奏）自动接管（验证 B1 接线本体）
    const terminal = await awaitTerminal(zombie?.id as string, 15_000);
    expect(terminal.status).toBe('failed');
    expect(terminal.execution_result['outcome']).toBe('reverted');
    expect(terminal.execution_result['budget_reclaimed']).toBe(true);
    // §8 双行审计：verify_failed(algo) + reverted(system)，回写原值 6.0
    const audits = await queryRows<{ result: string; actor_type: string; new_value: string }>(
      `SELECT result, actor_type, new_value::text FROM control_audit WHERE proposal_id = $1 ORDER BY id ASC`,
      [zombie?.id],
    );
    expect(audits.map((a) => `${a.result}:${a.actor_type}`)).toEqual([
      'verify_failed:algo',
      'reverted:system',
    ]);
    expect(Number(audits[1]?.new_value)).toBe(6.0);
    // 队列互斥已释放：后续提案可正常派发执行（僵尸不再占住设备）
    const followUp = await submitAndApprove({ action: { op: 'set', value: 7.0, unit: 'degC' } });
    const followUpTerminal = await awaitTerminal(followUp, 15_000);
    expect(followUpTerminal.status).toBe('executed');
  });

  // -------------------------------------------------------------------
  // 修单 F1：闸门 4 溢出主判定在入队侧即时拒最新（§3.7 对齐）
  // -------------------------------------------------------------------
  it('shouldRejectNewestImmediately_onQueueOverflow（F1：入队侧即时拒第 4 条）', async () => {
    fake.faultMode = (ref) => (ref === 'CHW_ST_SP_02' ? 'silent' : 'apply');
    // blocker 占住设备A（power 点 silent）→ 同设备其余提案只能排队
    const blocker = await internalSubmitForEquipment(seed.equipmentA, 'power', 7.1);
    await adminPost(`/proposals/${blocker}/approve`, {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    // 排满队列（cap=3）：三条 waiting 落【不同点位】（同点位会触发合并顶位语义）
    const waitingQuantities = ['chw_supply_temp', 'load_rate', 'energy'] as const;
    const waiting: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const pid = await internalSubmitForEquipment(
        seed.equipmentA,
        waitingQuantities[i] as string,
        7.2,
      );
      await adminPost(`/proposals/${pid}/approve`, {});
      waiting.push(pid);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const pid of waiting) {
      const row = await queryRow<{ phase: string }>(
        `SELECT execution_result->>'phase' AS phase FROM proposal WHERE id = $1`,
        [pid],
      );
      expect(row?.phase).toBe('queued');
    }
    // 第 4 条（最新）→ 入队侧即时拒（onApproved 路径，不等扫描周期）
    const fourth = await internalSubmitForEquipment(seed.equipmentA, 'chw_supply_temp', 7.9);
    await adminPost(`/proposals/${fourth}/approve`, {});
    const fourthTerminal = await awaitTerminal(fourth, 10_000);
    expect(fourthTerminal.status).toBe('failed');
    expect(fourthTerminal.execution_result['reason_code']).toBe('proposal.gate_conflict_overflow');
    const gates = fourthTerminal.execution_result['gates'] as Array<{
      gate: number;
      outcome: string;
    }>;
    const conflictGate = gates.find((g) => g.gate === 4);
    expect(conflictGate?.outcome).toBe('overflow');
    // 已排队的 3 条不受损（仍 queued，等 blocker 终态后 FIFO 派发）
    for (const pid of waiting) {
      const row = await queryRow<{ status: string; phase: string }>(
        `SELECT status, execution_result->>'phase' AS phase FROM proposal WHERE id = $1`,
        [pid],
      );
      expect(row?.status).toBe('approved');
      expect(row?.phase).toBe('queued');
    }
    // 排空：blocker 终态 → 三条依序执行（apply 模式）
    fake.faultMode = () => 'apply';
    await awaitTerminal(blocker, 25_000);
    for (const pid of waiting) {
      const terminal = await awaitTerminal(pid, 25_000);
      expect(terminal.status).toBe('executed');
    }
  }, 90_000);

  // -------------------------------------------------------------------
  // 修单 F2：频率负例统一域码（0/负/非整数 → point.gate_rate_invalid）
  // -------------------------------------------------------------------
  it('shouldReturnRateDomainCode_forAllFormatViolations（F2：值域负例同码）', async () => {
    for (const bad of [0, -1, 2.5]) {
      const response = await adminPatch(`/points/${String(seed.pointB)}/gate`, {
        write_rate_limit_per_hour: bad,
        reason: `F2 负例 ${String(bad)}`,
      });
      expect(response.status).toBe(422);
      expect((response.body as { error: { reason_code: string } }).error.reason_code).toBe(
        'point.gate_rate_invalid',
      );
    }
    // 合法值仍通（正整数）
    const ok = await adminPatch(`/points/${String(seed.pointB)}/gate`, {
      write_rate_limit_per_hour: 60,
      reason: 'F2 正例',
    });
    expect(ok.status).toBe(200);
  });

  it('shouldExposeExecutionDetail_viaM5ReadModel（读投影 + 审计链内联）', async () => {
    const proposalId = await submitAndApprove({ action: { op: 'set', value: 7.1, unit: 'degC' } });
    await awaitTerminal(proposalId);
    const detail = await adminGet(`/proposals/${proposalId}/execution`);
    expect(detail.status).toBe(200);
    const body = detail.body as {
      status: string;
      gates: Array<{ gate: number; outcome: string }>;
      audit: Array<{ result: string }>;
      value_chain: { value_effective: number | null };
    };
    expect(body.status).toBe('executed');
    expect(body.gates.map((g) => g.gate)).toEqual([1, 2, 3, 4, 5]);
    expect(body.gates.every((g) => ['pass', 'clamped'].includes(g.outcome))).toBe(true);
    expect(body.audit.map((a) => a.result)).toContain('ok');
    expect(body.value_chain.value_effective).toBe(7.1);
  });
});

async function queryRows<T>(sql: string, params: readonly unknown[]): Promise<T[]> {
  const client = await (adminPool as pg.Pool).connect();
  try {
    const result = await client.query(sql, params as unknown[]);
    return result.rows as T[];
  } finally {
    client.release();
  }
}

async function internalSubmitForEquipment(
  equipmentId: string,
  point: string,
  value: number,
): Promise<string> {
  const submitted = await internalPost('/internal/proposals', {
    proposal_id: `pp_${Math.random().toString(36).slice(2, 10)}`,
    algo: 'optimizer/chiller-sequencer',
    algo_version: '0.1.0+abcdef12',
    target: { equipment_id: equipmentId, point },
    action: { op: 'set', value, unit: 'degC' },
    previous_value: 6.0,
    rationale: '闸门4用例',
    expected_saving_kw: 5,
    confidence: 0.7,
    evidence: {},
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  });
  expect(submitted.status).toBe(201);
  return (submitted.body as { proposal_id: string }).proposal_id;
}
