/**
 * 接入域 e2e——网关与凭证（IMPL-11 / DAT-114 验收要点载体，PG 门控）。
 *
 * 覆盖 M1-asset §3.8/§3.9/§4：
 * - serial 全局唯一（跨租户）→ 409 gateway.serial_duplicate，details 不泄露对方租户；
 * - mqtt_client_id 服务端派生 `gw-{serial}`；
 * - offline_action loose schema 结构校验（引用校验在 M2 apply，R10）；
 * - 凭证：secret 仅生成响应返回一次（列表/详情零回显断言）、username 逐字
 *   `{serial}@{slug}` + 轮换 `.r{n}` 后缀（含已吊销）、每网关活跃 ≤2
 *   （超限 409 credential.limit_exceeded）、吊销单向幂等；
 * - Idempotency-Key：同键重试不铸出两枚凭证（API-DSN-01）。
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { LoginResponse } from '@thermio/shared-types';
import { E2E_READY, PASSWORDS, bootE2eApp, seedWorld, type SeededWorld } from './e2e-env.js';

const skipped = E2E_READY ? describe : describe.skip;

let app: INestApplication;
let world: SeededWorld;
let adminToken: string;
let viewerToken: string;
let adminBToken: string;
/** 本文件登记的网关 id（beforeAll 种入）。 */
let gatewayId: string;
const SERIAL = 'E2EGW-CRED-01';

async function login(email: string, password: string): Promise<string> {
  const response = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password });
  expect(response.status).toBe(200);
  return (response.body as LoginResponse).access_token;
}

function authed(method: 'get' | 'post' | 'patch', path: string, token: string): request.Test {
  return request(app.getHttpServer())[method](path).set('Authorization', `Bearer ${token}`);
}

skipped('asset-gateway e2e：网关与凭证（IMPL-11 验收要点）', () => {
  beforeAll(async () => {
    world = await seedWorld();
    ({ app } = await bootE2eApp());
    adminToken = await login('admin-a@dt113.test', PASSWORDS.admin);
    viewerToken = await login('viewer-a@dt113.test', PASSWORDS.viewer);
    adminBToken = await login('admin-b@dt113.test', PASSWORDS.admin);
    const created = await authed('post', '/api/v1/gateways', adminToken).send({
      serial: SERIAL,
      name: '凭证测试网关',
      building_id: world.buildingA1,
    });
    expect(created.status).toBe(201);
    gatewayId = String(created.body.id);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('网关登记与编辑（§3.8）', () => {
    it('shouldDeriveMqttClientId_fromSerial', async () => {
      const detail = await authed('get', `/api/v1/gateways/${gatewayId}`, adminToken);
      expect(detail.status).toBe(200);
      expect(detail.body.mqtt_client_id).toBe(`gw-${SERIAL}`);
      expect(detail.body.status).toBe('offline'); // 只读（EMQX 维护）
      expect(detail.body.credentials).toEqual([]); // 登记不自动发放凭证（R8）
    });

    it('shouldRejectDuplicateSerial_acrossTenants_withoutLeakingPeer', async () => {
      const same = await authed('post', '/api/v1/gateways', adminToken).send({
        serial: SERIAL,
        name: '撞号',
        building_id: world.buildingA1,
      });
      expect(same.status).toBe(409);
      expect(same.body.error.reason_code).toBe('gateway.serial_duplicate');
      expect(same.body.error.details).toEqual({ serial: SERIAL }); // 仅 serial 本身

      const cross = await authed('post', '/api/v1/gateways', adminBToken).send({
        serial: SERIAL,
        name: '跨租户撞号',
        building_id: world.buildingB1,
      });
      expect(cross.status).toBe(409);
      expect(cross.body.error.reason_code).toBe('gateway.serial_duplicate');
      expect(cross.body.error.details).not.toContain('dt113-a');
    });

    it('shouldRejectInvalidSerialCharset_with422', async () => {
      const response = await authed('post', '/api/v1/gateways', adminToken).send({
        serial: '坏 序列号!',
        name: 'x',
        building_id: world.buildingA1,
      });
      expect(response.status).toBe(422);
      expect(response.body.error.reason_code).toBe('common.validation_failed');
    });

    it('shouldReturn404_forNonexistent_andCrossTenantGateway', async () => {
      const ghost = await authed(
        'get',
        '/api/v1/gateways/123e4567-e89b-42d3-a456-426614174110',
        adminToken,
      );
      const cross = await authed('get', `/api/v1/gateways/${gatewayId}`, adminBToken);
      expect(ghost.status).toBe(404);
      expect(ghost.body.error.reason_code).toBe('gateway.not_found');
      expect(cross.status).toBe(404);
      expect(cross.body.error.message).toBe(ghost.body.error.message);
    });

    it('shouldListGateways_withBuildingFilter_and404ForOutOfScope', async () => {
      const listed = await authed(
        'get',
        `/api/v1/gateways?building_id=${world.buildingA1}&status=offline`,
        adminToken,
      );
      expect(listed.status).toBe(200);
      expect(listed.body.items.some((g: { id: string }) => g.id === gatewayId)).toBe(true);

      const outOfScope = await authed(
        'get',
        `/api/v1/gateways?building_id=${world.buildingA2}`,
        viewerToken,
      );
      expect(outOfScope.status).toBe(404);
      expect(outOfScope.body.error.reason_code).toBe('asset.not_found');
    });

    it('shouldPatchOfflineAction_withLooseSchema_andRejectMalformed', async () => {
      const ok = await authed('patch', `/api/v1/gateways/${gatewayId}`, adminToken).send({
        name: '凭证测试网关（改）',
        offline_action: { writes: [{ raw_name: 'CHW.P01.RUN', value: 0 }] },
      });
      expect(ok.status).toBe(200);
      expect(ok.body.offline_action).toEqual({
        writes: [{ raw_name: 'CHW.P01.RUN', value: 0 }],
      });

      const malformed = await authed('patch', `/api/v1/gateways/${gatewayId}`, adminToken).send({
        offline_action: { writes: [{ raw_name: 'X', value: 'zero' }] }, // value 非数值
      });
      expect(malformed.status).toBe(422);
      expect(malformed.body.error.reason_code).toBe('common.validation_failed');
    });

    it('shouldRejectImmutableFieldsInPatch_with422_strictSchema', async () => {
      const response = await authed('patch', `/api/v1/gateways/${gatewayId}`, adminToken).send({
        serial: 'REBRANDED-01',
      });
      expect(response.status).toBe(422); // serial/mqtt_client_id/building_id 不可改（strict 白名单外）
      expect(response.body.error.reason_code).toBe('common.validation_failed');
    });

    it('shouldRejectViewerGatewayManagement_with403', async () => {
      const response = await authed('post', '/api/v1/gateways', viewerToken).send({
        serial: 'VIEWER-GW',
        name: 'x',
        building_id: world.buildingA1,
      });
      expect(response.status).toBe(403);
      expect(response.body.error.reason_code).toBe('auth.forbidden');
    });
  });

  describe('凭证生命周期（§3.9/§4）', () => {
    it('shouldIssueFirstCredential_withEmqxUsernameConvention_andSecretOnce', async () => {
      const issued = await authed(
        'post',
        `/api/v1/gateways/${gatewayId}/credentials`,
        adminToken,
      ).send({});
      expect(issued.status).toBe(201);
      expect(issued.body.credential.username).toBe(`${SERIAL}@dt113-a`); // emqx §3.2 逐字
      expect(issued.body.credential.enabled).toBe(true);
      expect(typeof issued.body.secret).toBe('string');
      expect(String(issued.body.secret).length).toBeGreaterThanOrEqual(43); // 32B base64url

      // 列表/详情零回显（§2.6/§3.9 验收锚点）
      const detail = await authed('get', `/api/v1/gateways/${gatewayId}`, adminToken);
      expect(detail.body.credentials).toHaveLength(1);
      expect(JSON.stringify(detail.body)).not.toContain(String(issued.body.secret));
      expect(JSON.stringify(detail.body)).not.toContain('secret_hash');
    });

    it('shouldRotateWithSuffix_andEnforceActiveLimit2', async () => {
      const second = await authed(
        'post',
        `/api/v1/gateways/${gatewayId}/credentials`,
        adminToken,
      ).send({});
      expect(second.status).toBe(201);
      expect(second.body.credential.username).toBe(`${SERIAL}@dt113-a.r1`); // 轮换后缀（R13）

      const third = await authed(
        'post',
        `/api/v1/gateways/${gatewayId}/credentials`,
        adminToken,
      ).send({});
      expect(third.status).toBe(409);
      expect(third.body.error.reason_code).toBe('credential.limit_exceeded');
      expect(third.body.error.details).toEqual({ active_count: 2, limit: 2 });
    });

    it('shouldRevokeCredential_oneway_andIdempotent_thenIssueAgain_countsHistory', async () => {
      const detail = await authed('get', `/api/v1/gateways/${gatewayId}`, adminToken);
      const credentials = detail.body.credentials as Array<{ id: string; enabled: boolean }>;
      const first = credentials[0];
      const second = credentials[1];
      expect(first?.enabled).toBe(true);
      expect(second?.enabled).toBe(true);

      const revoked = await authed(
        'post',
        `/api/v1/credentials/${first?.id ?? ''}/disable`,
        adminToken,
      ).send({
        reason: '例行轮换收尾',
      });
      expect(revoked.status).toBe(200);
      expect(revoked.body.enabled).toBe(false);

      const again = await authed(
        'post',
        `/api/v1/credentials/${first?.id ?? ''}/disable`,
        adminToken,
      ).send({});
      expect(again.status).toBe(200); // 重复吊销幂等
      expect(again.body.enabled).toBe(false);

      // 吊销一枚后可再发；序号含已吊销历史 → .r2
      const third = await authed(
        'post',
        `/api/v1/gateways/${gatewayId}/credentials`,
        adminToken,
      ).send({});
      expect(third.status).toBe(201);
      expect(third.body.credential.username).toBe(`${SERIAL}@dt113-a.r2`);
      // 活跃数 = second + third = 2（first 已吊销）
    });

    it('shouldReturn404_forNonexistent_andCrossTenantCredential', async () => {
      const ghost = await authed(
        'post',
        '/api/v1/credentials/123e4567-e89b-42d3-a456-426614174120/disable',
        adminToken,
      ).send({});
      expect(ghost.status).toBe(404);
      expect(ghost.body.error.reason_code).toBe('credential.not_found');

      const detail = await authed('get', `/api/v1/gateways/${gatewayId}`, adminToken);
      const own = (detail.body.credentials as [{ id: string }])[0];
      const cross = await authed('post', `/api/v1/credentials/${own.id}/disable`, adminBToken).send(
        {},
      );
      expect(cross.status).toBe(404);
      expect(cross.body.error.message).toBe(ghost.body.error.message);
    });

    it('shouldNotMintTwice_onIdempotentRetry_sameKey', async () => {
      const detail = await authed('get', `/api/v1/gateways/${gatewayId}`, adminToken);
      const before = (detail.body.credentials as unknown[]).length;
      // 先腾出一个活跃位（上限 2 已满：second + third）
      const creds = detail.body.credentials as [{ id: string; enabled: boolean }];
      const active = creds.find((c) => c.enabled);
      if (active !== undefined) {
        await authed('post', `/api/v1/credentials/${active.id}/disable`, adminToken).send({});
      }
      const key = 'e2e-idem-key-001';
      const first = await request(app.getHttpServer())
        .post(`/api/v1/gateways/${gatewayId}/credentials`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('Idempotency-Key', key)
        .send({});
      expect(first.status).toBe(201);
      const replay = await request(app.getHttpServer())
        .post(`/api/v1/gateways/${gatewayId}/credentials`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('Idempotency-Key', key)
        .send({});
      expect(replay.status).toBe(201);
      expect(replay.body.credential.id).toBe(first.body.credential.id); // 回放同一结果
      expect(replay.body.secret).toBe(first.body.secret);

      const after = await authed('get', `/api/v1/gateways/${gatewayId}`, adminToken);
      expect((after.body.credentials as unknown[]).length).toBe(before + 1); // 只铸出一枚
    });
  });
});
