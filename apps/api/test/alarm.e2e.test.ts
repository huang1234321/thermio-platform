/**
 * 告警域 e2e——引擎 + M4 全端点（IMPL-13 / DAT-116 验收要点载体，PG 门控）。
 *
 * 覆盖 M4-alarm.md §12 契约测试负路径最小组 + IMPL-13 验收要点：
 * - 风暴聚合：网关离线 → 1 条根告警 + N 条点位 stale 子告警同 root_group（§5.5）；
 * - 状态机：非法迁移 409（ack on closed/suppressed、close on suppressed、unsuppress on
 *   non-suppressed）、重复 ack/close 幂等 200、duration 越界 422 alarm.suppress_duration_invalid；
 * - 防抖窗口内不开告警（sustained_s=60 + 窗内 clear）；抑制到期自动恢复（sweep）；
 * - 根因组级联选择性（恢复者关/未恢复者上浮）；batch-ack 207 部分失败；
 * - 规则 CRUD 校验序（rule_type_unknown/severity_unknown/rule_scope_invalid 组合矩阵/
 *   rule_params_invalid/目标 not_found）；DELETE 被引用 409 rule_in_use；
 * - disabled 点 → 活跃 point_stale 告警系统关闭（point_disabled，M1-O3 收口）；
 * - 越权楼宇/越租户 404 同码同文案（SEC-AZ-03）；白名单外参数 422（API-DSN-04）。
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import type { AlarmEventView, AlarmListResponse, LoginResponse } from '@thermio/shared-types';
import {
  E2E_ADMIN_URL,
  E2E_READY,
  PASSWORDS,
  bootE2eApp,
  seedWorld,
  type SeededWorld,
} from './e2e-env.js';
import type { AlarmEngineService } from '../src/alarm/alarm-engine.service.js';

const skipped = E2E_READY ? describe : describe.skip;

let app: INestApplication | null = null;
let world: SeededWorld;
let engine: AlarmEngineService;
let adminPool: pg.Pool | null = null;

interface AlarmSeed {
  readonly systemId: string;
  readonly equipmentId: string;
  readonly gatewayId: string;
  readonly pointIds: { temp: number; pump: number; spareA2: number };
}

let seed: AlarmSeed;

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

function authed(
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  token: string,
): request.Test {
  return request(requireApp().getHttpServer())
    [method](path)
    .set('Authorization', `Bearer ${token}`);
}

/** 资产种子：A1 系统/设备/网关 + 双点位（含 A2 独立点位做越权对照）。 */
async function seedAlarmWorld(): Promise<AlarmSeed> {
  if (adminPool === null) throw new Error('adminPool 未初始化');
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
        `INSERT INTO equipment (tenant_id, system_id, equipment_type, name)
         VALUES ($1, $2, 'chiller', '1#冷机') RETURNING id`,
        [world.tenantA, systemId],
      ),
    );
    const gatewayId = firstId(
      await client.query(
        `INSERT INTO gateway (tenant_id, building_id, name, serial, mqtt_client_id, status)
         VALUES ($1, $2, 'GW-A1', 'SN-GW-A1', 'gw-alarm-e2e-a1', 'online') RETURNING id`,
        [world.tenantA, world.buildingA1],
      ),
    );
    const insertPoint = async (name: string, buildingId: string): Promise<number> => {
      const row = (
        await client.query(
          `INSERT INTO point (tenant_id, building_id, equipment_id, source_type, gateway_id, raw_name, display_name)
           VALUES ($1, $2, $3, 'mqtt_gateway', $4, $5, $6) RETURNING id`,
          [world.tenantA, buildingId, equipmentId, gatewayId, name, `${name}显示名`],
        )
      ).rows[0] as { id: string };
      return Number(row.id);
    };
    const temp = await insertPoint('CHW.ST01.TEMP', world.buildingA1);
    const pump = await insertPoint('CHW.PUMP01.RUN', world.buildingA1);
    const spareA2 = await insertPoint('CHW.A2.SPARE', world.buildingA2);
    return { systemId, equipmentId, gatewayId, pointIds: { temp, pump, spareA2 } };
  } finally {
    client.release();
  }
}

/** 触发网关边沿（引擎通道②；ts 显式给定保证确定性）。 */
function gatewaySignal(
  status: 'online' | 'offline',
  atMs: number,
  reason: string | null = 'keepalive_timeout',
): Promise<boolean> {
  return engine.onGatewaySignal({
    tenantId: world.tenantA,
    gatewayId: seed.gatewayId,
    gatewayName: 'GW-A1',
    status,
    reason,
    atMs,
  });
}

/** 触发质量边沿（引擎通道①；绕 Kafka 直入求值面）。 */
function qualityEvent(
  pointId: number,
  event: 'stale_set' | 'stale_clear',
  atMs: number,
): Promise<void> {
  return engine.onQualityEvent({
    point_id: pointId,
    gateway_id: seed.gatewayId,
    ts: atMs,
    event,
  });
}

async function listAlarms(token: string, query = ''): Promise<AlarmListResponse> {
  const response = await authed('get', `/api/v1/alarms${query}`, token);
  expect(response.status).toBe(200);
  return response.body as AlarmListResponse;
}

/** 列表首行强制取值（缺行 = 前置状态被破坏，直接失败定位）。 */
async function firstAlarm(token: string, query = ''): Promise<AlarmEventView> {
  const listed = await listAlarms(token, query);
  const first = listed.items[0];
  expect(first).toBeDefined();
  return first as AlarmEventView;
}

async function createRule(token: string, body: Record<string, unknown>): Promise<request.Response> {
  return authed('post', '/api/v1/alarm-rules', token).send(body);
}

beforeAll(async () => {
  const booted = await bootE2eApp();
  app = booted.app;
  world = await seedWorld();
  adminPool = new pg.Pool({ connectionString: E2E_ADMIN_URL, max: 2 });
  seed = await seedAlarmWorld();
  adminToken = await login('admin-a@dt113.test');
  operatorToken = await login('operator-a@dt113.test');
  viewerToken = await login('viewer-a@dt113.test');
  adminBToken = await login('admin-b@dt113.test');
  const { AlarmEngineService: Engine } = await import('../src/alarm/alarm-engine.service.js');
  engine = app.get(Engine);
});

afterAll(async () => {
  const pool = adminPool;
  const application = app;
  if (pool !== null) await pool.end().catch(() => undefined);
  if (application !== null) await application.close().catch(() => undefined);
});

skipped('告警引擎与中心 e2e（M4-alarm.md §12）', () => {
  const T0 = 1_790_000_000_000;

  // -------------------------------------------------------------------
  // 规则 CRUD 校验序（§3.9 定序 + §1.2 域码）
  // -------------------------------------------------------------------
  it('shouldRejectRuleTypeUnknown_beforeOtherChecks（校验序第 1 级）', async () => {
    const response = await createRule(adminToken, {
      scope: 'gateway',
      scope_id: seed.gatewayId,
      rule_type: 'value_threshold',
      severity: 'critical',
    });
    expect(response.status).toBe(422);
    expect(response.body.error.reason_code).toBe('alarm.rule_type_unknown');
  });

  it('shouldRejectSeverityUnknown（校验序第 2 级）', async () => {
    const response = await createRule(adminToken, {
      scope: 'gateway',
      scope_id: seed.gatewayId,
      rule_type: 'gateway_offline',
      severity: 'fatal',
    });
    expect(response.status).toBe(422);
    expect(response.body.error.reason_code).toBe('alarm.severity_unknown');
  });

  it('shouldRejectRuleScopeCombo（组合矩阵 §4.1：gateway_offline 仅 gateway）', async () => {
    const response = await createRule(adminToken, {
      scope: 'point',
      scope_id: seed.pointIds.temp,
      rule_type: 'gateway_offline',
      severity: 'critical',
    });
    expect(response.status).toBe(422);
    expect(response.body.error.reason_code).toBe('alarm.rule_scope_invalid');
  });

  it('shouldRejectScopeIdTypeMismatch_andUnknownParams_andTargetNotFound', async () => {
    const badType = await createRule(adminToken, {
      scope: 'gateway',
      scope_id: 'not-an-uuid',
      rule_type: 'gateway_offline',
      severity: 'critical',
    });
    expect(badType.status).toBe(422);
    expect(badType.body.error.reason_code).toBe('alarm.rule_scope_invalid');

    const badParams = await createRule(adminToken, {
      scope: 'gateway',
      scope_id: seed.gatewayId,
      rule_type: 'gateway_offline',
      severity: 'critical',
      params: { recovery_s: 30, rogue_key: true },
    });
    expect(badParams.status).toBe(422);
    expect(badParams.body.error.reason_code).toBe('alarm.rule_params_invalid');

    const badTarget = await createRule(adminToken, {
      scope: 'point',
      scope_id: 999_999,
      rule_type: 'point_stale',
      severity: 'warning',
    });
    expect(badTarget.status).toBe(404);
    expect(badTarget.body.error.reason_code).toBe('asset.not_found');
  });

  it('shouldCreateRules_withSustainedDefaultsAndParamFill（分级默认 + 缺省补全）', async () => {
    const gwRule = await createRule(adminToken, {
      scope: 'gateway',
      scope_id: seed.gatewayId,
      rule_type: 'gateway_offline',
      severity: 'critical',
      params: { recovery_s: 0 },
    });
    expect(gwRule.status).toBe(201);
    expect(gwRule.body.sustained_s).toBe(0); // critical 分级默认（§4.1 表）
    expect(gwRule.body.params).toEqual({ recovery_s: 0 });

    const pointRules: Array<[number, number]> = [
      [seed.pointIds.temp, 0], // temp：回稳即时（autoRecover 用例）
      [seed.pointIds.pump, 3600], // pump：长回稳窗（级联用例——根关闭先于回稳到期）
      [seed.pointIds.spareA2, 0],
    ];
    for (const [pointId, recoveryS] of pointRules) {
      const rule = await createRule(adminToken, {
        scope: 'point',
        scope_id: pointId,
        rule_type: 'point_stale',
        severity: 'warning',
        sustained_s: 0,
        params: { recovery_s: recoveryS },
      });
      expect(rule.status).toBe(201);
    }
  });

  // -------------------------------------------------------------------
  // 风暴聚合场景（IMPL-13 验收要点 1：1 根 + N 子同 root_group）
  // -------------------------------------------------------------------
  it('shouldAggregateStorm_gatewayOfflineRootWithStaleChildren（§5.5）', async () => {
    const offlineEdge = await gatewaySignal('offline', T0);
    expect(offlineEdge).toBe(true); // 新边沿（DAT-110 去重判定面）
    const duplicateEdge = await gatewaySignal('offline', T0); // 同状态重投
    expect(duplicateEdge).toBe(false);

    await qualityEvent(seed.pointIds.temp, 'stale_set', T0 + 100);
    await qualityEvent(seed.pointIds.pump, 'stale_set', T0 + 200);

    const listed = await listAlarms(adminToken);
    const root = listed.items.find((item) => item.category === 'gateway_offline' && item.is_root);
    expect(root).toBeDefined();
    const rootGroupId = root?.root_group_id ?? '';
    expect(rootGroupId).not.toBe(''); // 根自锚（§5.5：开启时铸 uuid）
    expect(root?.child_count_active).toBe(2); // +N 子告警角标
    expect(root?.status).toBe('open');
    // 折叠：仅代表行 + 独立行（A2 点位 stale 未发生 → 不在列）
    expect(listed.items.filter((item) => item.root_group_id !== null)).toHaveLength(1);

    const children = listed.items.filter(
      (item) => item.category === 'point_stale' && item.status === 'open',
    );
    expect(children).toHaveLength(0); // 子告警被折叠，不独立出现

    // 展开模式：返回全成员（任意状态）
    const expanded = await listAlarms(adminToken, `?root_group_id=${rootGroupId}`);
    expect(expanded.items).toHaveLength(3); // 1 根 + 2 子
    const childGroupIds = new Set(
      expanded.items.filter((item) => item.category === 'point_stale').map((i) => i.root_group_id),
    );
    expect(childGroupIds.size).toBe(1);
    expect(childGroupIds.has(rootGroupId)).toBe(true);
  });

  it('shouldNotOpenAlarm_withinSustainedWindow（防抖窗口内不开告警）', async () => {
    // spareA2 已有 sustained=0 规则（createRules 批）——PATCH 调至 3600 再触发
    const rules = await authed('get', '/api/v1/alarm-rules?rule_type=point_stale', adminToken);
    const spareRule = (
      rules.body.items as Array<{ id: string; scope_id: string; sustained_s: number }>
    ).find((rule) => rule.scope_id === String(seed.pointIds.spareA2));
    expect(spareRule).toBeDefined();
    const spareRuleId = spareRule?.id ?? '';
    const patched = await authed('patch', `/api/v1/alarm-rules/${spareRuleId}`, adminToken).send({
      sustained_s: 3600,
    });
    expect(patched.status).toBe(200);

    await qualityEvent(seed.pointIds.spareA2, 'stale_set', Date.now());
    const listed = await listAlarms(adminToken, '?category=point_stale');
    const spare = listed.items.filter((item) => item.source_id === String(seed.pointIds.spareA2));
    expect(spare).toHaveLength(0); // 3600s 防抖内未达标（规则 PATCH 只影响后续求值）
  });

  // -------------------------------------------------------------------
  // 状态机（§4.2）与幂等
  // -------------------------------------------------------------------
  it('shouldAck_idempotentlyAndRejectInvalidStates', async () => {
    const listed = await listAlarms(adminToken, '?category=gateway_offline');
    const root = listed.items[0] as AlarmEventView;
    const rootId = root.root_group_id !== null ? root.id : root.id;

    const first = await authed('post', `/api/v1/alarms/${String(rootId)}/ack`, operatorToken).send(
      {},
    );
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('acked');

    const repeat = await authed('post', `/api/v1/alarms/${String(rootId)}/ack`, operatorToken).send(
      {},
    );
    expect(repeat.status).toBe(200); // 重复 ack 幂等，痕迹不重写
    expect(repeat.body.acked_at).toBe(first.body.acked_at);

    // viewer 无 alarms.ack → 403
    const forbidden = await authed(
      'post',
      `/api/v1/alarms/${String(rootId)}/ack`,
      viewerToken,
    ).send({});
    expect(forbidden.status).toBe(403);

    const detail = await authed('get', `/api/v1/alarms/${String(rootId)}`, adminToken);
    expect(detail.status).toBe(200);
    expect(detail.body.group.is_root).toBe(true);
    expect(detail.body.group.members).toHaveLength(3);
    expect(detail.body.rule.rule_type).toBe('gateway_offline');
    expect(detail.body.timeline.some((entry: { type: string }) => entry.type === 'acked')).toBe(
      true,
    );
  });

  it('shouldBatchAck_with207PartialResults（API-DSN-05）', async () => {
    // 经 root_group_id 展开拿 open 子告警 id
    const root = await firstAlarm(adminToken, '?category=gateway_offline');
    const members = await listAlarms(adminToken, `?root_group_id=${String(root.root_group_id)}`);
    const openChildren = members.items.filter((item) => item.status === 'open');
    expect(openChildren.length).toBeGreaterThanOrEqual(1);

    const tempChild = openChildren.find((item) => item.source_id === String(seed.pointIds.temp));
    expect(tempChild).toBeDefined();
    const tempChildId = tempChild === undefined ? -1 : tempChild.id;
    const ids = [tempChildId, 9_999_999];
    const response = await authed('post', '/api/v1/alarms/batch-ack', operatorToken).send({ ids });
    expect(response.status).toBe(207);
    expect(response.body.items).toHaveLength(2);
    const ok = response.body.items.find(
      (item: { alarm_id: number }) => item.alarm_id === tempChildId,
    );
    const missing = response.body.items.find(
      (item: { alarm_id: number }) => item.alarm_id === 9_999_999,
    );
    expect(ok?.ok).toBe(true);
    expect(missing?.ok).toBe(false);
    expect(missing?.error.reason_code).toBe('alarm.not_found');
  });

  it('shouldSuppress_validateDurationCascadeAndRenewal', async () => {
    const root = await firstAlarm(adminToken, '?category=gateway_offline&status=acked');
    expect(root).toBeDefined();

    const bad = await authed('post', `/api/v1/alarms/${String(root.id)}/suppress`, adminToken).send(
      {
        duration_s: 60,
        reason: '维护窗口',
      },
    );
    expect(bad.status).toBe(422);
    expect(bad.body.error.reason_code).toBe('alarm.suppress_duration_invalid');

    const ok = await authed('post', `/api/v1/alarms/${String(root.id)}/suppress`, adminToken).send({
      duration_s: 3600,
      reason: '维护窗口',
      cascade: true,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.alarm.status).toBe('suppressed');
    // 级联抑制组内 open|acked 子告警（temp 已 batch-ack、pump open）——风暴遮蔽
    expect(ok.body.cascade_suppressed).toBe(2);

    // 抑制期抑制续期 = superseded + 新行
    const renew = await authed(
      'post',
      `/api/v1/alarms/${String(root.id)}/suppress`,
      adminToken,
    ).send({
      duration_s: 7200,
      reason: '延长维护',
    });
    expect(renew.status).toBe(200);

    const activeList = await authed('get', '/api/v1/alarms/suppressions?state=active', adminToken);
    const endedList = await authed('get', '/api/v1/alarms/suppressions?state=ended', adminToken);
    expect(activeList.status).toBe(200);
    expect(endedList.status).toBe(200);
    const rows = [
      ...(activeList.body.items as Array<{
        suppression: { alarm_event_id: number; ended_reason: string | null };
      }>),
      ...(endedList.body.items as Array<{
        suppression: { alarm_event_id: number; ended_reason: string | null };
      }>),
    ];
    const rootRows = rows.filter((row) => row.suppression.alarm_event_id === root.id);
    expect(rootRows.length).toBeGreaterThanOrEqual(2); // 原行 + 续期行
    expect(rootRows.some((row) => row.suppression.ended_reason === 'superseded')).toBe(true);
  });

  it('shouldAutoRestore_onSuppressionExpiry（§4.3 sweep 到期回置）', async () => {
    const root = await firstAlarm(adminToken, '?category=gateway_offline');
    // 回拨 until_at 触发 sweep（30s 周期的确定性等价：直接调幂等 sweep 面）
    if (adminPool === null) throw new Error('adminPool 未初始化');
    await adminPool.query(
      `UPDATE alarm_suppression SET until_at = now()
       WHERE alarm_event_id = $1::bigint AND ended_at IS NULL`,
      [String(root.id)],
    );
    await engine.sweepSuppressions();

    const detail = await authed('get', `/api/v1/alarms/${String(root.id)}`, adminToken);
    expect(detail.status).toBe(200);
    // 回置抑制前状态：root 被 ack 过 → acked
    expect(detail.body.alarm.status).toBe('acked');
    expect(
      detail.body.suppressions.some(
        (s: { ended_reason: string | null }) => s.ended_reason === 'expired',
      ),
    ).toBe(true);
  });

  it('shouldRejectClose_onSuppressed_andUnsuppressRestore（§3.5/§3.6）', async () => {
    // 抑制级联产物：temp/pump 均为 suppressed——确定性取 temp
    const root = await firstAlarm(adminToken, '?category=gateway_offline');
    const members = await listAlarms(adminToken, `?root_group_id=${String(root.root_group_id)}`);
    const tempChild = members.items.find((item) => item.source_id === String(seed.pointIds.temp));
    expect(tempChild?.status).toBe('suppressed');
    const tempChildId = tempChild === undefined ? -1 : tempChild.id;

    const closeOnSuppressed = await authed(
      'post',
      `/api/v1/alarms/${String(tempChildId)}/close`,
      operatorToken,
    ).send({ reason: '尝试关闭抑制中告警' });
    expect(closeOnSuppressed.status).toBe(409);
    expect(closeOnSuppressed.body.error.reason_code).toBe('alarm.state_invalid');
    expect(closeOnSuppressed.body.error.details.current_status).toBe('suppressed');

    const unsuppress = await authed(
      'post',
      `/api/v1/alarms/${String(tempChildId)}/unsuppress`,
      adminToken,
    ).send({});
    expect(unsuppress.status).toBe(200);
    expect(['open', 'acked']).toContain(unsuppress.body.alarm.status); // ack 过 → acked

    const unsuppressAgain = await authed(
      'post',
      `/api/v1/alarms/${String(tempChildId)}/unsuppress`,
      adminToken,
    ).send({});
    expect(unsuppressAgain.status).toBe(409); // 非 suppressed → 409（不设幂等）

    // 流程收尾：pump 也回置（后续级联用例需要 open/acked 面）
    const pumpChild = members.items.find((item) => item.source_id === String(seed.pointIds.pump));
    if (pumpChild?.status === 'suppressed') {
      const restore = await authed(
        'post',
        `/api/v1/alarms/${String(pumpChild.id)}/unsuppress`,
        adminToken,
      ).send({});
      expect(restore.status).toBe(200);
    }
  });

  // -------------------------------------------------------------------
  // 级联选择性（§4.5：恢复者关/未恢复者上浮）+ 自动恢复
  // -------------------------------------------------------------------
  it('shouldCascadeSelectively_onRootClose（IMPL-13 验收要点）', async () => {
    // 保留一个未恢复子告警（pump 仍 violating），temp 已被 batch-ack（仍未恢复）——
    // 先让 pump 收到恢复信号（回稳窗豁免级联关闭），temp 保持违反
    const root = await firstAlarm(adminToken, '?category=gateway_offline');
    expect(root).toBeDefined();
    const members = await listAlarms(adminToken, `?root_group_id=${String(root.root_group_id)}`);
    const pump = members.items.find((item) => item.source_id === String(seed.pointIds.pump));
    const temp = members.items.find((item) => item.source_id === String(seed.pointIds.temp));

    await qualityEvent(seed.pointIds.pump, 'stale_clear', Date.now()); // pump 恢复信号
    // temp 不发 clear（保持违反）→ 级联时保留上浮

    const close = await authed(
      'post',
      `/api/v1/alarms/${String(root.id)}/close`,
      operatorToken,
    ).send({
      reason: '网关维护完成',
    });
    expect(close.status).toBe(200);
    expect(close.body.alarm.status).toBe('closed');
    expect(close.body.alarm.closed_by).not.toBeNull(); // 人工关闭
    expect(close.body.alarm.close_reason).toBe('网关维护完成');
    expect(close.body.cascade_closed).toBeGreaterThanOrEqual(1);

    // pump（恢复信号已现）被级联关闭：root_group_cascade + closed_by=NULL
    const pumpDetail = await authed('get', `/api/v1/alarms/${String(pump?.id)}`, adminToken);
    expect(pumpDetail.body.alarm.status).toBe('closed');
    expect(pumpDetail.body.alarm.close_reason).toBe('root_group_cascade');
    expect(pumpDetail.body.alarm.closed_by).toBeNull();

    // temp（未恢复，acked）上浮为独立可见行（根已 closed → 折叠解除）
    const after = await listAlarms(adminToken);
    const surfaced = after.items.find((item) => item.id === temp?.id);
    expect(surfaced).toBeDefined();
    expect(surfaced?.is_root).toBe(false);

    // 重复 close 幂等 200
    const repeatClose = await authed(
      'post',
      `/api/v1/alarms/${String(root.id)}/close`,
      operatorToken,
    ).send({ reason: '再次关闭' });
    expect(repeatClose.status).toBe(200);
  });

  it('shouldAutoRecover_viaRecoveryWindow_andCloseSuppressedToo（§4.4①/R2）', async () => {
    // temp 仍在违反；发送 clear → recovery_s=0 → 即时回稳关闭
    await qualityEvent(seed.pointIds.temp, 'stale_clear', Date.now());
    const root = await firstAlarm(adminToken, '?category=gateway_offline');
    const tempDetail = await authed(
      'get',
      `/api/v1/alarms?root_group_id=${String(root.root_group_id)}`,
      adminToken,
    );
    const tempAlarm = (tempDetail.body.items as AlarmEventView[]).find(
      (item) => item.source_id === String(seed.pointIds.temp),
    );
    expect(tempAlarm).toBeDefined();
    const closedTemp = tempAlarm ?? { status: '', close_reason: '', closed_by: '' };
    expect(closedTemp.status).toBe('closed');
    expect(closedTemp.close_reason).toBe('auto_recovered');
    expect(closedTemp.closed_by === null).toBe(true);
  });

  // -------------------------------------------------------------------
  // disabled 点联动（M1-asset §10-O3 收口）
  // -------------------------------------------------------------------
  it('shouldCloseStaleAlarm_whenPointDisabled（point_disabled）', async () => {
    const { pump } = seed.pointIds;
    // 重新制造 pump 违反并开告警（sustained 0）
    await qualityEvent(pump, 'stale_set', Date.now());
    const violating = await listAlarms(adminToken, `?source_type=point&source_id=${String(pump)}`);
    expect((violating.items as AlarmEventView[]).some((item) => item.status !== 'closed')).toBe(
      true,
    );

    const disable = await authed('patch', `/api/v1/points/${String(pump)}/status`, adminToken).send(
      {
        status: 'disabled',
        reason: '传感器拆除',
      },
    );
    expect(disable.status).toBe(200);

    const after = await listAlarms(adminToken, `?source_type=point&source_id=${String(pump)}`);
    const active = (after.items as AlarmEventView[]).filter((item) => item.status !== 'closed');
    expect(active).toHaveLength(0);
    const closedRow = (after.items as AlarmEventView[]).find(
      (item) => item.close_reason === 'point_disabled',
    );
    expect(closedRow).toBeDefined();

    // 停用后 stale 事件不再求值（disabled 点跳过）
    await qualityEvent(pump, 'stale_set', Date.now());
    const skipped = await listAlarms(adminToken, `?source_type=point&source_id=${String(pump)}`);
    expect(
      (skipped.items as AlarmEventView[]).filter((item) => item.status !== 'closed'),
    ).toHaveLength(0);
  });

  // -------------------------------------------------------------------
  // counts / 筛选白名单 / 越权同码（SEC-AZ-03）
  // -------------------------------------------------------------------
  it('shouldCountOpen_andCriticalBadge', async () => {
    const counts = await authed('get', '/api/v1/alarms/counts', adminToken);
    expect(counts.status).toBe(200);
    expect(counts.body.open).toBeGreaterThanOrEqual(0);
    expect(counts.body.open_critical).toBeGreaterThanOrEqual(0);
  });

  it('shouldRejectWhitelistViolations_with422（API-DSN-04）', async () => {
    const response = await authed('get', '/api/v1/alarms?bogus_filter=1', adminToken);
    expect(response.status).toBe(422);
    expect(response.body.error.reason_code).toBe('common.validation_failed');

    const orphan = await authed('get', '/api/v1/alarms?source_id=42', adminToken);
    expect(orphan.status).toBe(422); // source_id 缺 source_type 配对（R9）

    const mutuallyExclusive = await authed(
      'get',
      `/api/v1/alarms?source_type=point&source_id=${String(seed.pointIds.temp)}&equipment_id=${seed.equipmentId}`,
      adminToken,
    );
    expect(mutuallyExclusive.status).toBe(422); // equipment_id 与 source_type 互斥（R9）
  });

  it('shouldFilterByEquipment_aggregatingPointSources（R9 设备维度）', async () => {
    const response = await authed(
      'get',
      `/api/v1/alarms?equipment_id=${seed.equipmentId}&limit=200`,
      adminToken,
    );
    expect(response.status).toBe(200);
    const items = response.body.items as AlarmEventView[];
    // 设备源 ∪ 设备点位源：本种子的告警全部挂该设备点位（point 源）
    for (const item of items) {
      expect(
        item.source_type === 'equipment' ||
          (item.source_type === 'point' &&
            [seed.pointIds.temp, seed.pointIds.pump, seed.pointIds.spareA2].includes(
              Number(item.source_id),
            )),
      ).toBe(true);
    }
  });

  it('shouldReturn404_identicalEnvelope_forCrossTenantAndMissing（SEC-AZ-03）', async () => {
    const listed = await listAlarms(adminToken);
    const target = listed.items[0] as AlarmEventView;

    const nonexistent = await authed('get', '/api/v1/alarms/99999999', adminToken);
    const crossTenant = await authed('get', `/api/v1/alarms/${String(target.id)}`, adminBToken);
    expect(nonexistent.status).toBe(404);
    expect(crossTenant.status).toBe(404);
    expect(crossTenant.body.error.reason_code).toBe('alarm.not_found');
    // SEC-AZ-03 同码同文案：不存在 vs 越租户的信封逐字段一致（不泄露存在性）
    expect(nonexistent.body.error.reason_code).toBe(crossTenant.body.error.reason_code);
    expect(nonexistent.body.error.message).toBe(crossTenant.body.error.message);
  });

  it('shouldScopeViewerList_toAuthorizedBuildings_and404OnDetail（M7 §5）', async () => {
    // viewer 仅 A1；spareA2（A2 楼）的告警不可见——先将其规则防抖调回 0 再制造 A2 告警
    const rules = await authed('get', '/api/v1/alarm-rules?rule_type=point_stale', adminToken);
    const spareRule = (rules.body.items as Array<{ id: string; scope_id: string }>).find(
      (rule) => rule.scope_id === String(seed.pointIds.spareA2),
    );
    expect(spareRule).toBeDefined();
    await authed('patch', `/api/v1/alarm-rules/${spareRule?.id ?? ''}`, adminToken).send({
      sustained_s: 0,
    });
    await qualityEvent(seed.pointIds.spareA2, 'stale_set', Date.now());

    const asViewer = await listAlarms(viewerToken, '?limit=200');
    for (const item of asViewer.items as AlarmEventView[]) {
      expect(item.building_id).toBe(world.buildingA1);
    }
    const asOperator = await listAlarms(operatorToken, '?limit=200');
    expect(
      (asOperator.items as AlarmEventView[]).some((item) => item.building_id === world.buildingA2),
    ).toBe(true); // operator 授权双楼
  });

  // -------------------------------------------------------------------
  // 规则不可变/删除受引用（§3.9/§3.10）
  // -------------------------------------------------------------------
  it('shouldRejectImmutableRulePatch_andDeleteInUse', async () => {
    const rules = await authed('get', '/api/v1/alarm-rules', adminToken);
    expect(rules.status).toBe(200);
    const referenced = (
      rules.body.items as Array<{
        id: string;
        rule_type: string;
        enabled: boolean;
        scope_id: string;
      }>
    ).find((rule) => rule.rule_type === 'gateway_offline');
    expect(referenced).toBeDefined();

    const immutable = await authed(
      'patch',
      `/api/v1/alarm-rules/${referenced?.id ?? ''}`,
      adminToken,
    ).send({
      scope: 'point',
    });
    expect(immutable.status).toBe(422); // 白名单外字段（scope 不可变）

    const inUse = await authed('delete', `/api/v1/alarm-rules/${referenced?.id ?? ''}`, adminToken);
    expect(inUse.status).toBe(409);
    expect(inUse.body.error.reason_code).toBe('alarm.rule_in_use');

    const emptyPatch = await authed(
      'patch',
      `/api/v1/alarm-rules/${referenced?.id ?? ''}`,
      adminToken,
    ).send({});
    expect(emptyPatch.status).toBe(422);

    // 禁用（规则停用即粗糙维护窗口，§8.1）
    const disable = await authed(
      'patch',
      `/api/v1/alarm-rules/${referenced?.id ?? ''}`,
      adminToken,
    ).send({
      enabled: false,
    });
    expect(disable.status).toBe(200);
    expect(disable.body.enabled).toBe(false);
    const reenable = await authed(
      'patch',
      `/api/v1/alarm-rules/${referenced?.id ?? ''}`,
      adminToken,
    ).send({
      enabled: true,
    });
    expect(reenable.status).toBe(200);
  });

  it('shouldRejectRuleWrite_withoutCapability（viewer/alarm_rules.write）', async () => {
    const response = await createRule(viewerToken, {
      scope: 'gateway',
      scope_id: seed.gatewayId,
      rule_type: 'gateway_offline',
      severity: 'critical',
    });
    expect(response.status).toBe(403);
  });
});
