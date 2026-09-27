/**
 * 导入域 e2e——五步向导全流程（IMPL-15 / DAT-118 验收要点载体，PG 门控）。
 *
 * 覆盖 M2-import §15 契约测试负路径最小组 + 蓝本验收三要点：
 * - 样例 Excel → apply → point 表登记正确（§8.2 推导表断言）+ 网关配置产物生成
 *   （fake 下行通道捕获 retained 全量快照）；
 * - IMPORT_APPLY_CONFLICT 冲突清单 / dry-run 阻塞项（未映射、写点数值量 P2-3）逐条；
 * - 自检命中率报告 + 未命中清单 + 重跑（fake TSDB presence——真实 TSDB 读路径归
 *   dev 栈 E2E，见交付说明边界）；
 * - 状态守卫 409（每非法源状态一枚）、file_invalid 三因、building_mismatch、
 *   幂等键 422/同键重放/ack 收敛三态（ok/partial/timeout → 登记保留）。
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import ExcelJS from 'exceljs';
import pg from 'pg';
import {
  type GatewayConfigArtifact,
  type GatewayConfigAck,
  type ImportJob,
  type LoginResponse,
} from '@thermio/shared-types';
import { E2E_ADMIN_URL, E2E_READY, PASSWORDS, seedWorld, type SeededWorld } from './e2e-env.js';
import { TELEMETRY_STORE } from '../src/telemetry/telemetry.tokens.js';
import type { TelemetryStore } from '../src/telemetry/tsdb-read.repository.js';
import { DOWN_CHANNEL } from '../src/import/import.tokens.js';
import type { DownChannel } from '../src/import/down-channel.publisher.js';
import { AcksExhaustedError } from '../src/import/down-channel.publisher.js';
import { ImportsService } from '../src/import/imports.service.js';

const skipped = E2E_READY ? describe : describe.skip;

/** 流程测试含轮询完成信号（§4.3）与多轮 HTTP 往返——统一放宽单测超时。 */
const FLOW_TIMEOUT_MS = 30_000;

let app: INestApplication;
let world: SeededWorld;

/** 导入域种子：目标网关（A1 楼）+ 错楼网关（A2）+ A1 内设备 + 预注册冲突点。 */
interface ImportSeed {
  gatewayId: string;
  gatewayOtherBuildingId: string;
  equipmentId: string;
  conflictRawName: string;
}
let seed: ImportSeed;

function passwordFor(email: string): string {
  if (email.startsWith('operator')) return PASSWORDS.operator;
  if (email.startsWith('viewer')) return PASSWORDS.viewer;
  return PASSWORDS.admin;
}

async function login(email: string): Promise<string> {
  const response = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password: passwordFor(email) });
  expect(response.status).toBe(200);
  return (response.body as LoginResponse).access_token;
}

let adminToken: string;
let operatorToken: string;
let viewerToken: string;
let adminBToken: string;

function authed(method: 'get' | 'post' | 'patch', path: string, token: string): request.Test {
  return request(app.getHttpServer())[method](path).set('Authorization', `Bearer ${token}`);
}

// ---------------------------------------------------------------------------
// fake 下行通道（捕获产物/读指令 + 可编剧应答）与 fake TSDB presence
// ---------------------------------------------------------------------------

interface FakeChannelState {
  configPushes: Array<{ clientId: string; artifact: GatewayConfigArtifact }>;
  readCommands: Array<{ clientId: string; points: string[] }>;
  ackScript: 'ok' | 'partial' | 'timeout';
}

const channelState: FakeChannelState = {
  configPushes: [],
  readCommands: [],
  ackScript: 'ok',
};

const fakeChannel: DownChannel = {
  enabled: true,
  async publishConfigAndWaitAck(clientId, artifact) {
    await Promise.resolve();
    channelState.configPushes.push({ clientId, artifact });
    if (channelState.ackScript === 'timeout') throw new AcksExhaustedError(3);
    const ack: GatewayConfigAck =
      channelState.ackScript === 'partial'
        ? {
            job_id: artifact.job_id,
            ok_count: Math.max(artifact.points.length - 1, 0),
            failed: [
              {
                raw_name: (artifact.points.at(-1) ?? first(artifact.points, 'points')).raw_name,
                reason: '地址不可达',
              },
            ],
          }
        : { job_id: artifact.job_id, ok_count: artifact.points.length, failed: [] };
    return ack;
  },
  async publishRead(clientId, command) {
    await Promise.resolve();
    channelState.readCommands.push({ clientId, points: command.points });
  },
};

/** presence 剧场：point_id → 窗口内是否有行（测试按需拨动）。 */
const presence = new Set<number>();
const fakeTelemetry: TelemetryStore = {
  latest: () => Promise.resolve(null),
  latestBatch: () => Promise.resolve(new Map()),
  listRaw: () => Promise.resolve([]),
  listAggregate: () => Promise.resolve([]),
  presentInWindow: async (pointIds) => {
    await Promise.resolve();
    return new Set(pointIds.filter((id) => presence.has(id)));
  },
};

// ---------------------------------------------------------------------------
// xlsx 固件
// ---------------------------------------------------------------------------

async function buildXlsx(headers: string[], rows: Array<Array<string | null>>): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('点表');
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** 样例点表：3 行（供温/功率/运行状态——规则全命中）+ 1 行写点。 */
function sampleWorkbook(): Promise<Buffer> {
  return buildXlsx(
    ['点号', '描述', '单位', '方向'],
    [
      ['CHWS_T_1F', '冷冻水供水温度', '℃', '只读'],
      ['PUMP_PWR', '水泵功率', 'kW', 'ro'],
      ['PUMP_RUN', '水泵运行状态', null, 'read'],
      // 不命中任何规则（raw_name 无 chws/power、描述无关键词）→ 留给人工映射步
      ['TANK_LVL_SET', '水箱液位设定', 'm', '写'],
    ],
  );
}

/** 轮询作业直至谓词成立（解析/映射/apply/自检完成信号，§4.3）。 */
async function pollJob(
  token: string,
  jobId: string,
  predicate: (job: ImportJob) => boolean,
  timeoutMs = 8_000,
): Promise<ImportJob> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await authed('get', `/api/v1/imports/${jobId}`, token);
    expect(response.status).toBe(200);
    const job = response.body as ImportJob;
    if (predicate(job)) return job;
    if (Date.now() > deadline)
      throw new Error(`轮询超时：status=${job.status} rows=${String(job.row_count)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

skipped('import e2e：五步向导全流程（IMPL-15 验收要点）', { timeout: FLOW_TIMEOUT_MS }, () => {
  let importsService: ImportsService;

  beforeAll(async () => {
    world = await seedWorld();
    const { Test } = await import('@nestjs/testing');
    const { AppModule } = await import('../src/app.module.js');
    const { configureApp } = await import('../src/bootstrap.js');
    process.env['PG_API_URL'] = process.env['PG_E2E_API_URL'] ?? '';
    process.env['PG_AUTH_URL'] = process.env['PG_E2E_AUTH_URL'] ?? '';
    process.env['AUTH_JWT_SECRET'] =
      process.env['AUTH_JWT_SECRET'] ?? 'e2e-test-secret-0123456789abcdef-0123456789abcdef';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TELEMETRY_STORE)
      .useValue(fakeTelemetry)
      .overrideProvider(DOWN_CHANNEL)
      .useValue(fakeChannel)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    importsService = app.get(ImportsService);
    importsService.selfCheckWindowMsValue = 30; // 采集窗测试化（§9.3 默认 90s）

    adminToken = await login('admin-a@dt113.test');
    operatorToken = await login('operator-a@dt113.test');
    viewerToken = await login('viewer-a@dt113.test');
    adminBToken = await login('admin-b@dt113.test');
    seed = await seedImportWorld();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('§3.1 上传（同步校验分界 §5.3）', () => {
    it('shouldRejectNotXxxFile_with422FileInvalid', async () => {
      const response = await authed('post', '/api/v1/imports', operatorToken)
        .field('building_id', world.buildingA1)
        .field('gateway_id', seed.gatewayId)
        .attach('file', Buffer.from('not an xlsx'), { filename: 't.csv', contentType: 'text/csv' });
      expect(response.status).toBe(422);
      expect(response.body.error).toMatchObject({
        reason_code: 'import.file_invalid',
      });
      expect(response.body.error.details.reason).toBe('not_xlsx');
    });

    it('shouldRejectZipWithoutOpcParts_withCorrupt', async () => {
      const zipMagic = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(128)]);
      const response = await authed('post', '/api/v1/imports', operatorToken)
        .field('building_id', world.buildingA1)
        .field('gateway_id', seed.gatewayId)
        .attach('file', zipMagic, { filename: 'fake.zip' });
      expect(response.status).toBe(422);
      expect(response.body.error.details.reason).toBe('corrupt');
    });

    it('shouldRejectMissingFile_withEmpty', async () => {
      const response = await authed('post', '/api/v1/imports', operatorToken)
        .field('building_id', world.buildingA1)
        .field('gateway_id', seed.gatewayId);
      expect(response.status).toBe(422);
      expect(response.body.error.details.reason).toBe('empty');
    });

    it('shouldRejectBuildingMismatch_with422', async () => {
      const response = await authed('post', '/api/v1/imports', operatorToken)
        .field('building_id', world.buildingA1)
        .field('gateway_id', seed.gatewayOtherBuildingId)
        .attach('file', await sampleWorkbook(), { filename: 'pt.xlsx' });
      expect(response.status).toBe(422);
      expect(response.body.error.reason_code).toBe('import.building_mismatch');
    });

    it('shouldRejectViewer_withoutWriteCapability', async () => {
      const response = await authed('post', '/api/v1/imports', viewerToken)
        .field('building_id', world.buildingA1)
        .field('gateway_id', seed.gatewayId)
        .attach('file', await sampleWorkbook(), { filename: 'pt.xlsx' });
      expect(response.status).toBe(403);
    });
  });

  describe('五步主流程（样例 Excel → apply → 登记 + 产物）', () => {
    let jobId: string;

    it('shouldAcceptUpload_with202ParsedAndZeroRows', async () => {
      const response = await authed('post', '/api/v1/imports', operatorToken)
        .field('building_id', world.buildingA1)
        .field('gateway_id', seed.gatewayId)
        .attach('file', await sampleWorkbook(), { filename: '点表-示例大厦A-v1.xlsx' });
      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({
        status: 'parsed',
        row_count: 0,
      });
      // supertest 以 latin1 写 multipart 文件名（真实浏览器 UTF-8 无此形态）——仅断言非空
      expect(typeof response.body.file_name).toBe('string');
      expect(response.body.file_name.length).toBeGreaterThan(0);
      jobId = response.body.id;
    });

    it('shouldCompleteAsyncParse_withRowEntrance', async () => {
      const job = await pollJob(
        operatorToken,
        jobId,
        (j) => j.row_count > 0 || j.status === 'failed',
      );
      expect(job.status).toBe('parsed');
      expect(job.row_count).toBe(4);
    });

    it('shouldListRows_inExcelOrder_withFilters', async () => {
      const response = await authed(
        'get',
        `/api/v1/imports/${jobId}/rows?limit=200`,
        operatorToken,
      );
      expect(response.status).toBe(200);
      const items = response.body.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(4);
      expect(items.map((r) => r.row_no)).toEqual([1, 2, 3, 4]);
      expect(items[0]).toMatchObject({
        raw_name: 'CHWS_T_1F',
        raw_description: '冷冻水供水温度',
        unit_raw: '℃',
        is_write: false,
        map_status: 'unmapped',
      });
      expect(items[3]).toMatchObject({ raw_name: 'TANK_LVL_SET', is_write: true });
      // mapped=false 过滤（未映射全量）
      const unmapped = await authed(
        'get',
        `/api/v1/imports/${jobId}/rows?mapped=false`,
        operatorToken,
      );
      expect((unmapped.body.items as unknown[]).length).toBe(4);
    });

    it('shouldRunAutoMapping_withKeywordRules_andReachMapping', async () => {
      const response = await authed(
        'post',
        `/api/v1/imports/${jobId}/mapping/auto`,
        operatorToken,
      ).send({});
      expect(response.status).toBe(202);
      expect(response.body.status).toBe('mapping');
      const job = await pollJob(operatorToken, jobId, (j) => j.mapped_count >= 3);
      expect(job.mapped_count).toBe(3); // TANK_LVL_SET 不命中规则，留人工
      const rows = await authed(
        'get',
        `/api/v1/imports/${jobId}/rows?mapped=true&limit=200`,
        operatorToken,
      );
      for (const row of rows.body.items as Array<Record<string, unknown>>) {
        expect(row.map_status).toBe('auto');
        expect(row.mapped_at).toBeNull(); // auto 映射 mapped_at/by 为 NULL（ddl 注）
      }
    });

    it('shouldPatchRowManually_withStatusTransitionAndCountRecompute', async () => {
      const rows = await authed('get', `/api/v1/imports/${jobId}/rows?mapped=false`, operatorToken);
      const target = first(rows.body.items as Array<{ id: number }>, 'unmapped row');
      const response = await authed(
        'patch',
        `/api/v1/imports/${jobId}/rows/${String(target.id)}`,
        operatorToken,
      ).send({ quantity_type: 'chw_supply_temp', equipment_id: seed.equipmentId });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        map_status: 'manual',
        quantity_type: 'chw_supply_temp',
      });
      expect(response.body.mapped_by).toBeDefined();
      const job = await pollJob(operatorToken, jobId, (j) => j.mapped_count === 4);
      expect(job.status).toBe('mapping');
    });

    it('shouldRejectPhysicalFields_andUnknownQuantity_andUnsupportedUnit', async () => {
      const rows = await authed('get', `/api/v1/imports/${jobId}/rows?limit=1`, operatorToken);
      const rowId = first(rows.body.items as Array<{ id: number }>, 'first row').id;

      const physical = await authed(
        'patch',
        `/api/v1/imports/${jobId}/rows/${String(rowId)}`,
        operatorToken,
      ).send({ raw_name: 'HACK' });
      expect(physical.status).toBe(422);
      expect(physical.body.error.reason_code).toBe('common.validation_failed');
      expect(physical.body.error.details.fields).toEqual(['raw_name']);

      const unknownQty = await authed(
        'patch',
        `/api/v1/imports/${jobId}/rows/${String(rowId)}`,
        operatorToken,
      ).send({ quantity_type: 'flow_rate' });
      expect(unknownQty.status).toBe(422);
      expect(unknownQty.body.error.reason_code).toBe('point.quantity_type_unknown');

      // unit_raw=℃（解析期定格）× unit_std=kW 无转换对 → 422
      const badUnit = await authed(
        'patch',
        `/api/v1/imports/${jobId}/rows/${String(rowId)}`,
        operatorToken,
      ).send({ unit_std: 'kW' });
      expect(badUnit.status).toBe(422);
      expect(badUnit.body.error.reason_code).toBe('import.unit_conversion_unsupported');
    });

    it('shouldDryRun_toValidated_whenNoBlockers', async () => {
      const response = await authed('post', `/api/v1/imports/${jobId}/dry-run`, operatorToken);
      expect(response.status).toBe(200);
      const report = response.body;
      expect(report.passed).toBe(true);
      expect(report.blocking_count).toBe(0);
      expect(report.warning_count).toBeGreaterThan(0); // equipment_unassigned/clamp_pending
      const job = await authed('get', `/api/v1/imports/${jobId}`, operatorToken);
      expect(job.body.status).toBe('validated');
      expect(job.body.issue_count).toBe(
        Number(report.blocking_count) + Number(report.warning_count),
      );
    });

    it('shouldRejectApply_withoutIdempotencyKey', async () => {
      const response = await authed('post', `/api/v1/imports/${jobId}/apply`, operatorToken);
      expect(response.status).toBe(422);
      expect(response.body.error.details.field).toBe('Idempotency-Key');
    });

    it('shouldApply_registerPoints_generateArtifact_andStayApplied_onAckOk', async () => {
      channelState.ackScript = 'ok';
      channelState.configPushes.length = 0;
      const response = await authed('post', `/api/v1/imports/${jobId}/apply`, operatorToken).set(
        'Idempotency-Key',
        'e2e-apply-1',
      );
      expect(response.status).toBe(202);
      const job = await pollJob(
        operatorToken,
        jobId,
        (j) => j.status === 'applied' || j.status === 'failed',
      );
      expect(job.status).toBe('applied');
      expect(job.applied_at).not.toBeNull();

      // §8.2 推导表断言（point 表登记正确）
      const admin = new pg.Pool({ connectionString: E2E_ADMIN_URL, max: 1 });
      const points = await admin.query<{
        raw_name: string;
        quantity_type: string | null;
        unit_raw: string | null;
        unit_std: string | null;
        direction: string;
        display_name: string | null;
        protocol_address: { ref: string; source: string } | null;
        is_controllable: boolean;
        control_mode: string;
        equipment_id: string | null;
      }>(
        `SELECT raw_name, quantity_type, unit_raw, unit_std, direction, display_name,
                protocol_address, is_controllable, control_mode, equipment_id
         FROM point WHERE tenant_id = $1 AND gateway_id = $2 ORDER BY id`,
        [world.tenantA, seed.gatewayId],
      );
      await admin.end();
      const byName = new Map(points.rows.map((p) => [p.raw_name, p]));
      expect(points.rows).toHaveLength(5); // 4 新点 + 1 预注册冲突点种子
      const chws = byName.get('CHWS_T_1F');
      expect(chws).toMatchObject({
        quantity_type: 'chw_supply_temp',
        unit_raw: '℃',
        unit_std: 'degC',
        direction: 'read',
        display_name: '冷冻水供水温度',
        is_controllable: false,
        control_mode: 'advisory',
      });
      expect(chws?.protocol_address).toEqual({ ref: 'CHWS_T_1F', source: 'import' });
      expect(chws?.equipment_id).toBe(seed.equipmentId);
      expect(byName.get('TANK_LVL_SET')).toMatchObject({ direction: 'write' });

      // 配置产物生成（§8.4：retained 全量快照含预注册点）
      expect(channelState.configPushes).toHaveLength(1);
      const artifact = first(channelState.configPushes, 'configPushes').artifact;
      expect(artifact.schema_version).toBe(1);
      expect(artifact.job_id).toBe(jobId);
      expect(artifact.points).toHaveLength(5);
      expect(artifact.points.map((p) => p.raw_name)).toContain(seed.conflictRawName);
    });

    it('shouldReplaySameIdempotencyKey_withoutDuplicateRegistration', async () => {
      const admin = new pg.Pool({ connectionString: E2E_ADMIN_URL, max: 1 });
      const before = await admin.query<{ count: string }>(
        `SELECT count(*) AS count FROM point WHERE tenant_id = $1 AND gateway_id = $2`,
        [world.tenantA, seed.gatewayId],
      );
      const response = await authed('post', `/api/v1/imports/${jobId}/apply`, operatorToken).set(
        'Idempotency-Key',
        'e2e-apply-1',
      );
      expect(response.status).toBe(202);
      const after = await admin.query<{ count: string }>(
        `SELECT count(*) AS count FROM point WHERE tenant_id = $1 AND gateway_id = $2`,
        [world.tenantA, seed.gatewayId],
      );
      await admin.end();
      expect(first(after.rows, 'after').count).toBe(first(before.rows, 'before').count);
    });

    it('shouldGuardStateTransitions_afterApplied', async () => {
      const patch = await authed('patch', `/api/v1/imports/${jobId}/rows/1`, operatorToken).send({
        quantity_type: 'power',
      });
      expect(patch.status).toBe(409);
      expect(patch.body.error.reason_code).toBe('import.state_invalid');
      expect(patch.body.error.details.current_status).toBe('applied');

      const dry = await authed('post', `/api/v1/imports/${jobId}/dry-run`, operatorToken);
      expect(dry.status).toBe(409);
      const auto = await authed('post', `/api/v1/imports/${jobId}/mapping/auto`, operatorToken);
      expect(auto.status).toBe(409);
    });

    it('shouldReportSelfcheckNotReady_beforeAnyRun', async () => {
      const response = await authed('get', `/api/v1/imports/${jobId}/self-check`, operatorToken);
      expect(response.status).toBe(404);
      expect(response.body.error.reason_code).toBe('import.selfcheck_not_ready');
      expect(response.body.error.details.reason).toBe('never_run');
    });

    it('shouldSelfCheck_produceHitRateReport_withMissed_andRerun', async () => {
      // 剧场：本作业 4 点中前 2 点命中（报告口径 = 本作业已登记点，预注册点不计入）
      const admin = new pg.Pool({ connectionString: E2E_ADMIN_URL, max: 1 });
      const ids = await admin.query<{ raw_name: string; id: string }>(
        `SELECT raw_name, id FROM point WHERE tenant_id = $1 AND gateway_id = $2 ORDER BY id`,
        [world.tenantA, seed.gatewayId],
      );
      await admin.end();
      const byName = new Map(ids.rows.map((r) => [r.raw_name, Number(r.id)]));
      presence.clear();
      presence.add(requireByName(byName, 'CHWS_T_1F'));
      presence.add(requireByName(byName, 'PUMP_PWR'));

      const post = await authed('post', `/api/v1/imports/${jobId}/self-check`, operatorToken);
      expect(post.status).toBe(202);
      const job = await pollJob(operatorToken, jobId, (j) => j.status === 'checked');
      expect(job.hit_rate).toBeCloseTo(2 / 4, 3);

      const reportResponse = await authed(
        'get',
        `/api/v1/imports/${jobId}/self-check`,
        operatorToken,
      );
      expect(reportResponse.status).toBe(200);
      const report = reportResponse.body;
      expect(report.hit_count).toBe(2);
      expect(report.total_count).toBe(4);
      expect(report.window.lookback_s).toBe(900); // 15 min 回看窗
      const missedNames = (report.missed as Array<{ raw_name: string }>).map((m) => m.raw_name);
      expect(missedNames.sort()).toEqual(['PUMP_RUN', 'TANK_LVL_SET'].sort());
      expect(channelState.readCommands.length).toBeGreaterThan(0); // 读指令分批下发（≤500/条）
      expect(first(channelState.readCommands, 'readCommands').points.length).toBeLessThanOrEqual(
        500,
      );

      // 重跑（checked → checked 刷新）：全部命中后 hit_rate = 1
      for (const id of byName.values()) presence.add(id);
      const rerun = await authed('post', `/api/v1/imports/${jobId}/self-check`, operatorToken);
      expect(rerun.status).toBe(202);
      const job2 = await pollJob(
        operatorToken,
        jobId,
        (j) => j.status === 'checked' && j.hit_rate !== null && j.hit_rate >= 1,
      );
      expect(job2.hit_rate).toBe(1);
    });
  });

  describe('dry-run 阻塞项与 apply 冲突（验收要点 2）', () => {
    it('shouldBlockDryRun_onUnmappedRows_andStayMapping', async () => {
      const jobId = await uploadWorkbook(
        buildXlsx(
          ['点号', '描述'],
          [
            ['Mystery_1', '未知量'], // 不命中规则 → row_unmapped 阻塞
          ],
        ),
      );
      await pollJob(operatorToken, jobId, (j) => j.row_count > 0);
      await authed('post', `/api/v1/imports/${jobId}/mapping/auto`, operatorToken).send({});
      await pollJob(operatorToken, jobId, (j) => j.mapped_count >= 0 && j.status === 'mapping');
      const dry = await authed('post', `/api/v1/imports/${jobId}/dry-run`, operatorToken);
      expect(dry.status).toBe(200);
      expect(dry.body.passed).toBe(false);
      expect(dry.body.blocking_count).toBeGreaterThanOrEqual(1);
      // 行级 issue 明细经 ?issue=* 可见
      const issueRows = await authed(
        'get',
        `/api/v1/imports/${jobId}/rows?issue=*&limit=200`,
        operatorToken,
      );
      const codes = (issueRows.body.items as Array<{ issues: Array<{ code: string }> }>).flatMap(
        (r) => r.issues.map((i) => i.code),
      );
      expect(codes).toContain('row_unmapped');
      const job = await authed('get', `/api/v1/imports/${jobId}`, operatorToken);
      expect(job.body.status).toBe('mapping'); // 停留
    });

    it('shouldBlockDryRun_onWritePointWithEnumQuantity_p23', async () => {
      const jobId = await uploadWorkbook(
        buildXlsx(
          ['点号', '描述', '方向'],
          [
            ['VALVE_CMD', '阀门运行状态指令', '写'], // 写点 × run_status 枚态 → P2-3 阻塞
          ],
        ),
      );
      await pollJob(operatorToken, jobId, (j) => j.row_count > 0);
      await authed('post', `/api/v1/imports/${jobId}/mapping/auto`, operatorToken).send({});
      await pollJob(operatorToken, jobId, (j) => j.mapped_count === 1);
      const dry = await authed('post', `/api/v1/imports/${jobId}/dry-run`, operatorToken);
      expect(dry.body.passed).toBe(false);
      const rows = await authed(
        'get',
        `/api/v1/imports/${jobId}/rows?issue=write_point_not_numeric`,
        operatorToken,
      );
      expect((rows.body.items as unknown[]).length).toBe(1);
    });

    it('shouldRejectApplyWith409Conflict_whenRawNamePreRegistered_afterValidation', async () => {
      // 干净作业过 dry-run → 竞态面：预注册同名点 → apply 同步预检 409 主面
      const jobId = await uploadWorkbook(
        buildXlsx(['点号', '描述'], [['LATE_REG_1', '冷冻水供水温度']]),
      );
      await pollJob(operatorToken, jobId, (j) => j.row_count > 0);
      await authed('post', `/api/v1/imports/${jobId}/mapping/auto`, operatorToken).send({});
      await pollJob(operatorToken, jobId, (j) => j.mapped_count === 1);
      const dry = await authed('post', `/api/v1/imports/${jobId}/dry-run`, operatorToken);
      expect(dry.body.passed).toBe(true);

      const admin = new pg.Pool({ connectionString: E2E_ADMIN_URL, max: 1 });
      await admin.query(
        `INSERT INTO point (tenant_id, building_id, source_type, gateway_id, raw_name)
         VALUES ($1, $2, 'mqtt_gateway', $3, 'LATE_REG_1')`,
        [world.tenantA, world.buildingA1, seed.gatewayId],
      );
      const apply = await authed('post', `/api/v1/imports/${jobId}/apply`, operatorToken).set(
        'Idempotency-Key',
        'e2e-conflict-1',
      );
      await admin.end();
      expect(apply.status).toBe(409);
      expect(apply.body.error.reason_code).toBe('import.apply_conflict');
      expect(apply.body.error.details.conflicts).toEqual([{ row_no: 1, raw_name: 'LATE_REG_1' }]);
      const job = await authed('get', `/api/v1/imports/${jobId}`, operatorToken);
      expect(job.body.status).toBe('validated'); // 拒绝受理、停留 validated
    });
  });

  describe('apply 推送应答收敛（§8.3-d：登记保留）', () => {
    it('shouldFailJobWithAckPartial_keepRegistration', async () => {
      channelState.ackScript = 'partial';
      const jobId = await runToApplied(
        buildXlsx(['点号', '描述'], [['ACK_P_1', '冷冻水供水温度']]),
      );
      const job = await pollJob(operatorToken, jobId, (j) => j.status === 'failed');
      expect(job.failure).toMatchObject({ stage: 'apply_push', code: 'gateway_ack_partial' });
      expect((job.failure?.rows ?? []).map((r) => r.raw_name)).toEqual(['ACK_P_1']);
      const admin = new pg.Pool({ connectionString: E2E_ADMIN_URL, max: 1 });
      const kept = await admin.query<{ count: string }>(
        `SELECT count(*) AS count FROM point WHERE tenant_id = $1 AND gateway_id = $2 AND raw_name = 'ACK_P_1'`,
        [world.tenantA, seed.gatewayId],
      );
      await admin.end();
      expect(first(kept.rows, 'kept').count).toBe('1'); // 登记保留定夺（R5）
      channelState.ackScript = 'ok';
    });

    it('shouldFailJobWithAckTimeout_afterRetries', async () => {
      channelState.ackScript = 'timeout';
      const jobId = await runToApplied(buildXlsx(['点号', '描述'], [['ACK_T_1', '水泵功率']]));
      const job = await pollJob(operatorToken, jobId, (j) => j.status === 'failed');
      expect(job.failure).toMatchObject({ stage: 'apply_push', code: 'gateway_ack_timeout' });
      channelState.ackScript = 'ok';
    });
  });

  describe('解析段失败（§4.4 failure 形状）', () => {
    it('shouldFailJobWithTemplateMismatch_whenRawNameColumnMissing', async () => {
      const jobId = await uploadWorkbook(buildXlsx(['描述', '单位'], [['x', 'y']]));
      const job = await pollJob(operatorToken, jobId, (j) => j.status === 'failed');
      expect(job.failure).toMatchObject({ stage: 'parse', code: 'template_mismatch' });
      expect(job.failure?.detail).toMatchObject({ missing: ['点号'] });
    });
  });

  describe('历史知识库（§6.1 一级/§6.4 沉淀）', () => {
    it('shouldAdoptHistoryExactMapping_onSecondUpload', async () => {
      const jobId = await uploadWorkbook(
        buildXlsx(
          ['点号', '描述', '单位'],
          [
            ['CHWS_T_1F', '一号供温', '℃'], // 与已 applied 作业 raw_name 一致
            // 描述与历史行 token 重叠（供水/温度）但不命中关键词规则 → suggestions 面
            ['NEW_AFTER_HIST', '供水温度备份', null],
          ],
        ),
      );
      await pollJob(operatorToken, jobId, (j) => j.row_count > 0);
      await authed('post', `/api/v1/imports/${jobId}/mapping/auto`, operatorToken).send({});
      await pollJob(operatorToken, jobId, (j) => j.mapped_count === 1);
      const rows = await authed('get', `/api/v1/imports/${jobId}/rows?mapped=true`, operatorToken);
      const adopted = first(rows.body.items as Array<Record<string, unknown>>, 'adopted row');
      expect(adopted.raw_name).toBe('CHWS_T_1F');
      expect(adopted.quantity_type).toBe('chw_supply_temp'); // 历史整组采纳
      // 未命中行带 suggestions（历史相似）
      const unmapped = await authed(
        'get',
        `/api/v1/imports/${jobId}/rows?mapped=false`,
        operatorToken,
      );
      const withSuggestions = (unmapped.body.items as Array<{ suggestions: unknown[] }>).filter(
        (r) => r.suggestions.length > 0,
      );
      expect(withSuggestions.length).toBeGreaterThan(0);
    });
  });

  describe('越权与存在性（SEC-AZ-02/03）', () => {
    it('shouldAnswer404Identically_forNonexistent_vsCrossTenant_vsOutOfScope', async () => {
      const jobs = await authed('get', '/api/v1/imports', adminToken);
      const someJob = first(jobs.body.items as Array<{ id: string }>, 'jobs');
      const nonexistent = await authed(
        'get',
        '/api/v1/imports/00000000-0000-7000-8000-000000000000',
        adminToken,
      );
      const crossTenant = await authed('get', `/api/v1/imports/${someJob.id}`, adminBToken);
      expect(nonexistent.status).toBe(404);
      expect(crossTenant.status).toBe(404);
      expect(nonexistent.body.error.reason_code).toBe('import.not_found');
      expect(nonexistent.body.error.message).toBe(crossTenant.body.error.message);
      expect(nonexistent.body.error.reason_code).toBe(crossTenant.body.error.reason_code);
    });

    it('shouldListJobs_withStatusFilter_andPaginationEnvelope', async () => {
      const response = await authed('get', '/api/v1/imports?status=checked', adminToken);
      expect(response.status).toBe(200);
      expect(response.body.items.every((j: ImportJob) => j.status === 'checked')).toBe(true);
      expect(response.body).toHaveProperty('next_cursor');
    });
  });

  // -------------------------------------------------------------------
  // 助手
  // ------------------------------------------------------------------

  async function uploadWorkbook(buffer: Promise<Buffer> | Buffer): Promise<string> {
    const response = await authed('post', '/api/v1/imports', operatorToken)
      .field('building_id', world.buildingA1)
      .field('gateway_id', seed.gatewayId)
      .attach('file', await buffer, { filename: 'pt.xlsx' });
    expect(response.status).toBe(202);
    return response.body.id as string;
  }

  /** 上传 → 解析 → auto → dry-run → apply（ack ok 脚本外的收敛由调用方随后拨动）。 */
  async function runToApplied(buffer: Promise<Buffer>): Promise<string> {
    const jobId = await uploadWorkbook(buffer);
    await pollJob(operatorToken, jobId, (j) => j.row_count > 0);
    await authed('post', `/api/v1/imports/${jobId}/mapping/auto`, operatorToken).send({});
    await pollJob(operatorToken, jobId, (j) => j.mapped_count > 0);
    const dry = await authed('post', `/api/v1/imports/${jobId}/dry-run`, operatorToken);
    expect(dry.body.passed).toBe(true);
    const apply = await authed('post', `/api/v1/imports/${jobId}/apply`, operatorToken).set(
      'Idempotency-Key',
      `e2e-${jobId}`,
    );
    expect(apply.status).toBe(202);
    return jobId;
  }
});

/** 导入域种子（superuser 运维通道，e2e-env 同款纪律）。 */
async function seedImportWorld(): Promise<ImportSeed> {
  const pool = new pg.Pool({ connectionString: E2E_ADMIN_URL, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const gateway = await client.query<{ id: string }>(
        `INSERT INTO gateway (tenant_id, building_id, name, serial, mqtt_client_id, status)
         VALUES ($1, $2, 'E2E 导入网关', 'E2EIMP001', 'gw-E2EIMP001', 'online') RETURNING id`,
        [world.tenantA, world.buildingA1],
      );
      const gatewayId = requireSeedId(gateway);
      const gateway2 = await client.query<{ id: string }>(
        `INSERT INTO gateway (tenant_id, building_id, name, serial, mqtt_client_id, status)
         VALUES ($1, $2, 'E2E 他楼网关', 'E2EIMP002', 'gw-E2EIMP002', 'online') RETURNING id`,
        [world.tenantA, world.buildingA2],
      );
      const system = await client.query<{ id: string }>(
        `INSERT INTO hvac_system (tenant_id, building_id, system_type, name)
         VALUES ($1, $2, 'chilled_water', 'E2E 导入冷冻水') RETURNING id`,
        [world.tenantA, world.buildingA1],
      );
      const equipment = await client.query<{ id: string }>(
        `INSERT INTO equipment (tenant_id, system_id, equipment_type, name, local_id)
         VALUES ($1, $2, 'chwp_pump', 'E2E 冷冻水泵P1', 'IMP-P1') RETURNING id`,
        [world.tenantA, requireSeedId(system)],
      );
      const conflictRawName = 'PRE_EXISTING_1';
      await client.query(
        `INSERT INTO point (tenant_id, building_id, source_type, gateway_id, raw_name)
         VALUES ($1, $2, 'mqtt_gateway', $3, $4)`,
        [world.tenantA, world.buildingA1, gatewayId, conflictRawName],
      );
      await client.query('COMMIT');
      return {
        gatewayId,
        gatewayOtherBuildingId: requireSeedId(gateway2),
        equipmentId: requireSeedId(equipment),
        conflictRawName,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

function requireSeedId(result: { rows: Array<{ id: string }> }): string {
  const row = result.rows[0];
  if (row === undefined) throw new Error('种子 RETURNING 未返回行');
  return row.id;
}

/** 按名取点 id（固件断言面，替非空断言）。 */
function requireByName(byName: Map<string, number>, rawName: string): number {
  const id = byName.get(rawName);
  if (id === undefined) throw new Error(`固件缺点位：${rawName}`);
  return id;
}

/** 数组首元素强制取值（测试固件断言面，替非空断言）。 */
function first<T>(items: readonly T[], what: string): T {
  const item = items[0];
  if (item === undefined) throw new Error(`期望非空：${what}`);
  return item;
}
