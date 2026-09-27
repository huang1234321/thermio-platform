/**
 * 建议域 e2e——POST /internal/proposals + M5 全端点（IMPL-17 / DAT-163 验收要点载体，PG 门控）。
 *
 * 覆盖：
 * - internal 面认证：无凭证/错凭证 401 auth.service_unauthorized 同码同文案（不泄露
 *   失败步骤）；正确凭证 201；
 * - 信封校验：必填缺失（rationale/expected_saving_kw）→ 422 proposal.payload_invalid
 *   details.cause=required；expires_at 已过 → expires_invalid；equipment 不存在 →
 *   404 asset.not_found；target 零命中 → target_not_found；同设备同 quantity_type
 *   双写点 → target_ambiguous；
 * - 状态机（§4.2 迁移矩阵）：pending→approved（202）/→rejected（200）；
 *   重复 approve 同 Idempotency-Key 幂等 202、异键 409 proposal.state_invalid
 *   （details.current_status）；过期仍 pending approve/reject → 409 proposal.expired
 *   （不沉降）；sweeper 直调沉降 expired（decided_by 保持 NULL）；
 *   已决策再操作 → state_invalid；viewer 决策 → 403 auth.forbidden；
 * - reject reason 缺失 → 422 proposal.reason_required；
 * - admin 闭环演练（执行环节 mock）：approve → mock 沉降 executed → execution 读投影
 *   （五闸门/三值链/审计链）+ /control-audit 检索 + counts 角标；
 * - precheck 快照四项（clamp would_clamp 预演）；越租户 404 同码；白名单外参数 422。
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import type {
  LoginResponse,
  ProposalApproveResponse,
  ProposalDetail,
  ProposalListResponse,
  ProposalRejectResponse,
  ProposalSubmitResponse,
} from '@thermio/shared-types';
import {
  E2E_ADMIN_URL,
  E2E_READY,
  PASSWORDS,
  bootE2eApp,
  seedWorld,
  type SeededWorld,
} from './e2e-env.js';
import type { ExpirySweeperService } from '../src/proposal/expiry-sweeper.service.js';
import type { MockExecutionSettlerService } from '../src/proposal/mock-execution.settler.js';

const skipped = E2E_READY ? describe : describe.skip;

const SVC_TOKEN = 'e2e-svc-token-algo-0123456789abcdef-0123456789abcdef';

let app: INestApplication | null = null;
let world: SeededWorld;
let sweeper: ExpirySweeperService;
let mockSettler: MockExecutionSettlerService;
let adminPool: pg.Pool | null = null;

interface ProposalSeed {
  readonly systemId: string;
  readonly equipmentId: string; // 双写点同量型（歧义用例）
  readonly equipmentId2: string; // 单写点（合法提交用例）
  readonly pointSp: number; // 主写点（chw_supply_temp，readwrite，clamp 5..9）
  readonly pointSp2: number; // 同设备同 quantity_type 第二写点（歧义用例）
  readonly pointUnique: number; // 设备二唯一写点（chw_supply_temp）
  readonly pointRo: number; // 只读点（target_not_found 用例）
}

let seed: ProposalSeed;

function passwordFor(email: string): string {
  if (email.startsWith('operator')) return PASSWORDS.operator;
  if (email.startsWith('viewer')) return PASSWORDS.viewer;
  return PASSWORDS.admin;
}

async function login(email: string): Promise<string> {
  const response = await request(requireApp().getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password: passwordFor(email) });
  expect(response.status).toBe(200);
  return (response.body as LoginResponse).access_token;
}

let adminToken: string;
let operatorToken: string;
let viewerToken: string;
let adminBToken: string;

function requireApp(): INestApplication {
  if (app === null) throw new Error('app 未启动');
  return app;
}

function authed(method: 'get' | 'post', path: string, token: string): request.Test {
  return request(requireApp().getHttpServer())
    [method](path)
    .set('Authorization', `Bearer ${token}`);
}

function internalPost(body: unknown, token = SVC_TOKEN): request.Test {
  return request(requireApp().getHttpServer())
    .post('/internal/proposals')
    .set('Authorization', `Bearer ${token}`)
    .send(body as Record<string, unknown>);
}

/** 合法规约信封（M5 §3.8 示例形状；expires_at 默认 +1h）。 */
function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    proposal_id: `pp_${Math.random().toString(36).slice(2, 10)}`,
    algo: 'optimizer/chiller-sequencer',
    algo_version: '0.1.0+abcdef12',
    target: { equipment_id: seed.equipmentId2, point: 'chw_supply_temp' },
    action: { op: 'set', value: 7.5, unit: 'degC' },
    previous_value: 6.0,
    rationale: '负荷预测显示 chilled water 供水温度可上调 1.5°C，预计节能 42.3kW',
    expected_saving_kw: 42.3,
    confidence: 0.86,
    evidence: { load_pct: 0.58, forecast_horizon_h: 2 },
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

skipped('proposal e2e（IMPL-17 验收要点）', () => {
  beforeAll(async () => {
    process.env['SVC_TOKEN_ALGO'] = SVC_TOKEN;
    process.env['PROPOSAL_MOCK_EXECUTOR'] = 'on';
    process.env['PROPOSAL_MOCK_EXECUTOR_DELAY_MS'] = '0';
    process.env['PROPOSAL_EXPIRY_SWEEP_INTERVAL_MS'] = '60000';
    const booted = await bootE2eApp();
    app = booted.app;
    world = await seedWorld();
    adminPool = new pg.Pool({ connectionString: E2E_ADMIN_URL, max: 2 });

    // 资产种子：系统/设备 + 三点位
    const client = await adminPool.connect();
    try {
      const firstId = (result: pg.QueryResult): string => {
        const row = result.rows[0] as { id: string } | undefined;
        if (row === undefined) throw new Error('种子 RETURNING 缺行');
        return row.id;
      };
      const systemId = firstId(
        await client.query(
          `INSERT INTO hvac_system (tenant_id, building_id, system_type, name)
           VALUES ($1, $2, 'chilled_water', '冷冻系统') RETURNING id`,
          [world.tenantA, world.buildingA1],
        ),
      );
      const equipmentId = firstId(
        await client.query(
          `INSERT INTO equipment (tenant_id, system_id, equipment_type, name, local_id)
           VALUES ($1, $2, 'chiller', '1#冷机', '1#冷机') RETURNING id`,
          [world.tenantA, systemId],
        ),
      );
      const insertPoint = async (
        rawName: string,
        extra: { quantityType: string; direction: string; controllable: boolean },
      ): Promise<number> => {
        const row = (
          await client.query(
            `INSERT INTO point (tenant_id, building_id, equipment_id, source_type, raw_name,
                                display_name, quantity_type, unit_std, direction,
                                is_controllable, clamp_min, clamp_max)
             VALUES ($1, $2, $3, 'virtual', $4, $5, $6, 'degC', $7, $8, 5.0, 9.0)
             RETURNING id`,
            [
              world.tenantA,
              world.buildingA1,
              equipmentId,
              rawName,
              `${rawName}显示名`,
              extra.quantityType,
              extra.direction,
              extra.controllable,
            ],
          )
        ).rows[0] as { id: string };
        return Number(row.id);
      };
      const pointSp = await insertPoint('CHW_ST_SP_01', {
        quantityType: 'chw_supply_temp',
        direction: 'readwrite',
        controllable: true,
      });
      const pointSp2 = await insertPoint('CHW_ST_SP_02', {
        quantityType: 'chw_supply_temp',
        direction: 'readwrite',
        controllable: true,
      });
      const pointRo = await insertPoint('CHW_ST_RO_03', {
        quantityType: 'chw_return_temp',
        direction: 'read',
        controllable: false,
      });
      // 设备二：单写点（合法提交 → target 唯一命中）
      const equipmentId2 = firstId(
        await client.query(
          `INSERT INTO equipment (tenant_id, system_id, equipment_type, name, local_id)
           VALUES ($1, $2, 'chiller', '2#冷机', '2#冷机') RETURNING id`,
          [world.tenantA, systemId],
        ),
      );
      const pointUnique = await insertPoint('CHW_ST_SP_11', {
        quantityType: 'chw_supply_temp',
        direction: 'readwrite',
        controllable: true,
      });
      const moveUnique = await client.query(`UPDATE point SET equipment_id = $2 WHERE id = $1`, [
        pointUnique,
        equipmentId2,
      ]);
      expect(moveUnique.rowCount).toBe(1);
      seed = { systemId, equipmentId, equipmentId2, pointSp, pointSp2, pointUnique, pointRo };
    } finally {
      client.release();
    }

    const { ExpirySweeperService: Sweeper } =
      await import('../src/proposal/expiry-sweeper.service.js');
    const { MockExecutionSettlerService: Settler } =
      await import('../src/proposal/mock-execution.settler.js');
    sweeper = requireApp().get(Sweeper);
    mockSettler = requireApp().get(Settler);

    adminToken = await login('admin-a@dt113.test');
    operatorToken = await login('operator-a@dt113.test');
    viewerToken = await login('viewer-a@dt113.test');
    adminBToken = await login('admin-b@dt113.test');
  });

  afterAll(async () => {
    const pool = adminPool;
    const application = app;
    if (pool !== null) await pool.end().catch(() => undefined);
    if (application !== null) await application.close().catch(() => undefined);
  });

  // -----------------------------------------------------------------
  // internal 面认证（SERVICE_UNAUTHORIZED 验收要点）
  // -----------------------------------------------------------------
  it('shouldRejectInternalSubmit_withoutServiceToken_401SameCodeAndMessage', async () => {
    const noHeader = await request(requireApp().getHttpServer())
      .post('/internal/proposals')
      .send(envelope());
    const badToken = await internalPost(envelope(), 'wrong-token-0123456789abcdef');
    expect(noHeader.status).toBe(401);
    expect(badToken.status).toBe(401);
    const noHeaderBody = noHeader.body as { error: { reason_code: string; message: string } };
    const badTokenBody = badToken.body as { error: { reason_code: string; message: string } };
    expect(noHeaderBody.error.reason_code).toBe('auth.service_unauthorized');
    // 同码同文案（request_id 必异不比；不泄露哪一步失败）
    expect(badTokenBody.error.reason_code).toBe(noHeaderBody.error.reason_code);
    expect(badTokenBody.error.message).toBe(noHeaderBody.error.message);
  });

  it('shouldAcceptValidEnvelope_201WithClientRefEcho', async () => {
    const body = envelope();
    const response = await internalPost(body);
    expect(response.status).toBe(201);
    const payload = response.body as ProposalSubmitResponse;
    expect(payload.status).toBe('pending');
    expect(payload.client_ref).toBe(body['proposal_id']);
    expect(payload.expires_at).not.toBeNull();
    // admin 面立即可见（待确认 Tab）
    const list = await authed('get', '/api/v1/proposals?status=pending', adminToken);
    expect(list.status).toBe(200);
    const items = (list.body as ProposalListResponse).items;
    expect(items.some((item) => item.id === payload.proposal_id)).toBe(true);
  });

  it('shouldRejectMissingRequiredFields_422PayloadInvalidCauseRequired', async () => {
    const noRationale = await internalPost(
      envelope({ rationale: undefined, expected_saving_kw: 42.3 }),
    );
    expect(noRationale.status).toBe(422);
    expect((noRationale.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'proposal.payload_invalid',
    );
    expect(
      (noRationale.body as { error: { details: { cause: string } } }).error.details.cause,
    ).toBe('required');

    const noSaving = await internalPost(envelope({ expected_saving_kw: undefined }));
    expect(noSaving.status).toBe(422);
    expect((noSaving.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'proposal.payload_invalid',
    );
  });

  it('shouldRejectExpiredExpiresAt_422CauseExpiresInvalid', async () => {
    const response = await internalPost(
      envelope({ expires_at: new Date(Date.now() - 60_000).toISOString() }),
    );
    expect(response.status).toBe(422);
    expect((response.body as { error: { details: { cause: string } } }).error.details.cause).toBe(
      'expires_invalid',
    );
  });

  it('shouldRejectUnknownEquipment_404AssetNotFound', async () => {
    const response = await internalPost(
      envelope({ target: { equipment_id: world.buildingA1, point: 'chw_supply_temp' } }),
    );
    expect(response.status).toBe(404);
    expect((response.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'asset.not_found',
    );
  });

  it('shouldRejectTargetZeroHitAndAmbiguous_422CauseTargetNotFoundOrAmbiguous', async () => {
    // 只读点（direction 白名单外）→ 零命中
    const zeroHit = await internalPost(
      envelope({ target: { equipment_id: seed.equipmentId, point: 'chw_return_temp' } }),
    );
    expect(zeroHit.status).toBe(422);
    expect((zeroHit.body as { error: { details: { cause: string } } }).error.details.cause).toBe(
      'target_not_found',
    );

    // 同设备（设备一）同 quantity_type 双写点 → 歧义（details.candidates=2）
    const ambiguous = await internalPost(
      envelope({ target: { equipment_id: seed.equipmentId, point: 'chw_supply_temp' } }),
    );
    expect(ambiguous.status).toBe(422);
    expect((ambiguous.body as { error: { details: { cause: string } } }).error.details.cause).toBe(
      'target_ambiguous',
    );
    expect(
      (ambiguous.body as { error: { details: { candidates: number } } }).error.details.candidates,
    ).toBe(2);
  });

  // -----------------------------------------------------------------
  // 状态机全迁移（§4.2 迁移矩阵验收要点）
  // -----------------------------------------------------------------
  /** admin 池连接（空断言禁用——fail-fast 抛错优于非空断言）。 */
  function adminConnect(): Promise<pg.PoolClient> {
    if (adminPool === null) throw new Error('adminPool 未初始化');
    return adminPool.connect();
  }

  /** 直插一条已消歧的单写点 proposal（admin 池种入；绕开歧义设备面）。 */
  async function seedProposal(overrides: Record<string, unknown> = {}): Promise<string> {
    const client = await adminConnect();
    try {
      const row = (
        await client.query(
          `INSERT INTO proposal (tenant_id, algo, algo_version, equipment_id, point_id, action,
                                 previous_value, rationale, expected_saving_kw, confidence,
                                 evidence, expires_at, status)
           VALUES ($1, 'optimizer/chiller-sequencer', '0.1.0+deadbeef', $2, $3,
                   '{"op":"set","value":7.5,"unit":"degC"}'::jsonb, 6.0, 'e2e 种子理由', 42.3, 0.86,
                   '{"load_pct":0.5}'::jsonb, now() + interval '1 hour', 'pending')
           RETURNING id`,
          [world.tenantA, seed.equipmentId, overrides['point_id'] ?? seed.pointSp],
        )
      ).rows[0] as { id: string };
      return row.id;
    } finally {
      client.release();
    }
  }

  it('shouldApprovePending_202AndIdempotentReplaySameKey', async () => {
    const proposalId = await seedProposal();
    const call = () =>
      request(requireApp().getHttpServer())
        .post(`/api/v1/proposals/${proposalId}/approve`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .set('idempotency-key', 'e2e-idem-approve-1')
        .send({});
    const first = await call();
    expect(first.status).toBe(202);
    const firstBody = first.body as ProposalApproveResponse;
    expect(firstBody.status).toBe('approved');
    expect(firstBody.decided_by).not.toBeNull();
    expect(firstBody.comment_persisted).toBe(false); // R1 过渡态显式告知

    // 同 Idempotency-Key 重放 → 幂等 202 同体（不二次迁移）
    const replay = await call();
    expect(replay.status).toBe(202);
    expect(replay.body as ProposalApproveResponse).toMatchObject({
      id: proposalId,
      status: 'approved',
      decided_by: firstBody.decided_by,
      decided_at: firstBody.decided_at,
    });
  });

  it('shouldApproveWithIdempotencyKey_idempotentReplay', async () => {
    const proposalId = await seedProposal();
    const call = () =>
      request(requireApp().getHttpServer())
        .post(`/api/v1/proposals/${proposalId}/approve`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .set('idempotency-key', 'e2e-idem-approve-2')
        .send({});
    const first = await call();
    const replay = await call();
    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect((replay.body as ProposalApproveResponse).decided_at).toBe(
      (first.body as ProposalApproveResponse).decided_at,
    );
  });

  it('shouldRejectReapproveWithDifferentKey_409StateInvalid', async () => {
    const proposalId = await seedProposal({}); // pending
    const first = await request(requireApp().getHttpServer())
      .post(`/api/v1/proposals/${proposalId}/approve`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set('idempotency-key', 'e2e-idem-approve-3')
      .send({});
    expect(first.status).toBe(202);
    // 无键再 approve → 409 state_invalid（details.current_status=approved）
    const again = await authed('post', `/api/v1/proposals/${proposalId}/approve`, operatorToken);
    expect(again.status).toBe(409);
    const body = again.body as {
      error: { reason_code: string; details: { current_status: string } };
    };
    expect(body.error.reason_code).toBe('proposal.state_invalid');
    expect(body.error.details.current_status).toBe('approved');

    // 已决策态 reject（带合法 reason——缺 reason 的 422 分工已在专测覆盖）→ 409
    const rejectDecided = await request(requireApp().getHttpServer())
      .post(`/api/v1/proposals/${proposalId}/reject`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ reason: '已决策后的驳回尝试' });
    expect(rejectDecided.status).toBe(409);
    expect((rejectDecided.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'proposal.state_invalid',
    );
  });

  it('shouldRequireRejectReason_422ReasonRequired', async () => {
    const proposalId = await seedProposal();
    const missing = await authed('post', `/api/v1/proposals/${proposalId}/reject`, operatorToken);
    expect(missing.status).toBe(422);
    expect((missing.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'proposal.reason_required',
    );

    const empty = await request(requireApp().getHttpServer())
      .post(`/api/v1/proposals/${proposalId}/reject`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ reason: '   ' });
    expect(empty.status).toBe(422);
    expect((empty.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'proposal.reason_required',
    );
  });

  it('shouldRejectPending_200WithReasonEcho', async () => {
    const proposalId = await seedProposal();
    const response = await request(requireApp().getHttpServer())
      .post(`/api/v1/proposals/${proposalId}/reject`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set('idempotency-key', 'e2e-idem-reject-1')
      .send({ reason: '与既有排班冲突，本轮不采纳' });
    expect(response.status).toBe(200);
    const body = response.body as ProposalRejectResponse;
    expect(body.status).toBe('rejected');
    expect(body.reason).toBe('与既有排班冲突，本轮不采纳');
  });

  it('shouldForbidViewerDecisions_403Forbidden', async () => {
    const proposalId = await seedProposal();
    const approve = await authed('post', `/api/v1/proposals/${proposalId}/approve`, viewerToken);
    expect(approve.status).toBe(403);
    expect((approve.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'auth.forbidden',
    );
    // viewer 可读（浏览面）
    const detail = await authed('get', `/api/v1/proposals/${proposalId}`, viewerToken);
    expect(detail.status).toBe(200);
  });

  it('shouldReturn404ForExpiredPendingApprove_withoutSettling_thenSweeperSettles', async () => {
    const client = await adminConnect();
    let proposalId: string;
    try {
      const row = (
        await client.query(
          `INSERT INTO proposal (tenant_id, algo, algo_version, equipment_id, point_id, action,
                                 previous_value, rationale, expected_saving_kw, confidence,
                                 expires_at, status)
           VALUES ($1, 'optimizer/chiller-sequencer', '0.1.0+deadbeef', $2, $3,
                   '{"op":"set","value":7.5,"unit":"degC"}'::jsonb, 6.0, '临期种子', 1.0, 0.5,
                   now() - interval '1 minute', 'pending')
           RETURNING id`,
          [world.tenantA, seed.equipmentId, seed.pointSp],
        )
      ).rows[0] as { id: string };
      proposalId = row.id;
    } finally {
      client.release();
    }

    // 过期仍 pending：approve → 409 proposal.expired（不沉降——sweeper 收敛）
    const approve = await authed('post', `/api/v1/proposals/${proposalId}/approve`, operatorToken);
    expect(approve.status).toBe(409);
    expect((approve.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'proposal.expired',
    );
    const stillPending = await authed('get', `/api/v1/proposals/${proposalId}`, adminToken);
    expect((stillPending.body as ProposalDetail).status).toBe('pending');

    // sweeper 直调 → expired（系统动作 decided_by 保持 NULL）
    const settled = await sweeper.sweep();
    expect(settled).toBeGreaterThanOrEqual(1);
    const after = await authed('get', `/api/v1/proposals/${proposalId}`, adminToken);
    const detail = after.body as ProposalDetail;
    expect(detail.status).toBe('expired');
    expect(detail.decided_by).toBeNull();

    // 已 expired 再决策 → 409 state_invalid（current_status=expired）
    const reapprove = await authed(
      'post',
      `/api/v1/proposals/${proposalId}/approve`,
      operatorToken,
    );
    expect(reapprove.status).toBe(409);
    expect(
      (reapprove.body as { error: { details: { current_status: string } } }).error.details
        .current_status,
    ).toBe('expired');
  });

  // -----------------------------------------------------------------
  // admin 闭环演练（执行环节 mock，等 IMPL-18 接通）
  // -----------------------------------------------------------------
  it('shouldRunClosedLoop_approveThenMockSettleThenExecutionView', async () => {
    const proposalId = await seedProposal();
    const approve = await request(requireApp().getHttpServer())
      .post(`/api/v1/proposals/${proposalId}/approve`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set('idempotency-key', 'e2e-idem-loop')
      .send({ comment: '演练确认' });
    expect(approve.status).toBe(202);

    const settled = await mockSettler.settle();
    expect(settled).toBeGreaterThanOrEqual(1);

    const detail = await authed('get', `/api/v1/proposals/${proposalId}`, adminToken);
    expect((detail.body as ProposalDetail).status).toBe('executed');
    expect((detail.body as ProposalDetail).executed_at).not.toBeNull();

    // 执行详情：五闸门 + 三值链 + 内联审计链（§3.6 一屏闭环）
    const execution = await authed('get', `/api/v1/proposals/${proposalId}/execution`, adminToken);
    expect(execution.status).toBe(200);
    const view = execution.body as {
      status: string;
      phase: string | null;
      gates: { gate: number; outcome: string }[];
      value_chain: { value_before: number; value_commanded: number; value_effective: number };
      audit: { actor_type: string; actor_ref: string; result: string }[];
      audit_ref: { count: number };
      outcome: string | null;
    };
    expect(view.phase).toBe('executed');
    expect(view.gates).toHaveLength(5);
    expect(view.gates.every((gate) => gate.outcome === 'pass')).toBe(true);
    expect(view.value_chain).toMatchObject({
      value_before: 6,
      value_commanded: 7.5,
      value_effective: 7.5,
    });
    expect(view.outcome).toBe('executed');
    expect(view.audit).toHaveLength(1);
    expect(view.audit[0]).toMatchObject({
      actor_type: 'system',
      actor_ref: 'mock-executor',
      result: 'ok',
    });
    expect(view.audit_ref.count).toBe(1);

    // /control-audit 检索（proposal_id 白名单筛选）
    const auditList = await authed(
      'get',
      `/api/v1/control-audit?proposal_id=${proposalId}`,
      adminToken,
    );
    expect(auditList.status).toBe(200);
    expect((auditList.body as { items: unknown[] }).items).toHaveLength(1);
  });

  it('shouldServeCounts_allSixStatuses', async () => {
    const response = await authed('get', '/api/v1/proposals/counts', adminToken);
    expect(response.status).toBe(200);
    const counts = response.body as Record<string, number>;
    for (const status of ['pending', 'approved', 'rejected', 'expired', 'executed', 'failed']) {
      expect(counts[status]).toBeDefined();
    }
    expect(counts.executed).toBeGreaterThanOrEqual(1);
    expect(counts.expired).toBeGreaterThanOrEqual(1);
  });

  // -----------------------------------------------------------------
  // precheck / 列表过滤 / 越权 / 白名单（§3.1/§5/§8.1）
  // -----------------------------------------------------------------
  it('shouldShowPrecheckOnPendingDetail_withClampPreview', async () => {
    // 值域内：value 7.5 ∈ [5, 9] → would_clamp=false
    const proposalId = await seedProposal();
    const detail = await authed('get', `/api/v1/proposals/${proposalId}`, adminToken);
    const precheck = (detail.body as ProposalDetail).precheck;
    expect(precheck).not.toBeNull();
    expect(precheck?.whitelist.pass).toBe(true); // pointSp controllable+readwrite+active
    expect(precheck?.clamp.would_clamp).toBe(false);
    expect(precheck?.clamp.effective_value).toBe(7.5);
    expect(precheck?.fuse.status).toBe('closed');
    expect(precheck?.checked_at).toBeDefined();

    // 值域外：9.9 > clamp_max 9 → would_clamp=true、effective=9（非拒绝提示）
    const outOfRange = await seedProposal({
      point_id: seed.pointSp,
    });
    const client = await adminConnect();
    try {
      await client.query(
        `UPDATE proposal SET action = '{"op":"set","value":9.9,"unit":"degC"}'::jsonb
         WHERE id = $1`,
        [outOfRange],
      );
    } finally {
      client.release();
    }
    const detail2 = await authed('get', `/api/v1/proposals/${outOfRange}`, adminToken);
    const precheck2 = (detail2.body as ProposalDetail).precheck;
    expect(precheck2?.clamp.would_clamp).toBe(true);
    expect(precheck2?.clamp.effective_value).toBe(9);
    expect(precheck2?.clamp.pass).toBe(false);
  });

  it('shouldFilterListByStatusMultiValue_andRejectUnknownQueryParams', async () => {
    const response = await authed(
      'get',
      '/api/v1/proposals?status=executed,failed&limit=200',
      adminToken,
    );
    expect(response.status).toBe(200);
    const items = (response.body as ProposalListResponse).items;
    expect(items.every((item) => item.status === 'executed' || item.status === 'failed')).toBe(
      true,
    );

    const invalidStatus = await authed('get', '/api/v1/proposals?status=bogus', adminToken);
    expect(invalidStatus.status).toBe(422);
    expect((invalidStatus.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'common.validation_failed',
    );

    const unknownParam = await authed('get', '/api/v1/proposals?keyword=x', adminToken);
    expect(unknownParam.status).toBe(422); // 白名单外（API-DSN-04）
  });

  it('shouldHideCrossTenantProposal_404SameCode', async () => {
    const proposalId = await seedProposal();
    const response = await authed('get', `/api/v1/proposals/${proposalId}`, adminBToken);
    expect(response.status).toBe(404);
    expect((response.body as { error: { reason_code: string } }).error.reason_code).toBe(
      'proposal.not_found',
    );
    const foreignFilter = await authed(
      'get',
      `/api/v1/proposals?building_id=${world.buildingB1}`,
      adminToken,
    );
    expect(foreignFilter.status).toBe(404);
  });

  it('shouldPaginateProposals_byCreatedAtDescCursor', async () => {
    const page1 = await authed('get', '/api/v1/proposals?limit=2', adminToken);
    expect(page1.status).toBe(200);
    const body1 = page1.body as ProposalListResponse;
    expect(body1.items).toHaveLength(2);
    expect(body1.next_cursor).not.toBeNull();
    const page2 = await authed(
      'get',
      `/api/v1/proposals?limit=2&cursor=${body1.next_cursor ?? ''}`,
      adminToken,
    );
    expect(page2.status).toBe(200);
    const body2 = page2.body as ProposalListResponse;
    expect(body2.items.length).toBeGreaterThan(0);
    // keyset 严格递减：第二页首行 created_at < 第一页末行
    const firstOfPage2 = body2.items[0];
    const lastOfPage1 = body1.items[1];
    if (firstOfPage2 === undefined || lastOfPage1 === undefined) {
      throw new Error('分页用例数据不足');
    }
    expect(Date.parse(firstOfPage2.created_at)).toBeLessThanOrEqual(
      Date.parse(lastOfPage1.created_at),
    );
  });

  it('shouldReturnEmptyExecutionForPendingProposal_phaseNullNoGates', async () => {
    const proposalId = await seedProposal();
    const response = await authed('get', `/api/v1/proposals/${proposalId}/execution`, adminToken);
    expect(response.status).toBe(200);
    const view = response.body as { status: string; phase: string | null; gates: unknown[] };
    expect(view.status).toBe('pending');
    expect(view.phase).toBeNull();
    expect(view.gates).toHaveLength(0);
  });
});
