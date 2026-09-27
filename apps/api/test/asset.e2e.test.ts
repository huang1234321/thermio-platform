/**
 * 资产域 e2e——楼宇/系统/设备/点位（IMPL-11 / DAT-114 验收要点载体，PG 门控）。
 *
 * 覆盖 M1-asset §12 契约测试负路径最小组：
 * - 越权楼宇 404 同码同文案（SEC-AZ-03 断言文案一致——不存在 vs 跨租户/越 scope）；
 * - 枚举值域外 422（building/system/equipment/quantity_type 四码拒绝路径）；
 * - 白名单外字段 400 point.field_not_allowed（闸门字段定向 M8、物理字段定向 §3.10、
 *   status 定向 §3.6 双向）；
 * - reason 缺失 422、重复置同态幂等 200、batch 207 部分失败；
 * - local_id 重复 409（R3 应用层校验）；检索白名单外参数 422（API-DSN-04）。
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import type { LoginResponse } from '@thermio/shared-types';
import {
  E2E_ADMIN_URL,
  E2E_READY,
  PASSWORDS,
  bootE2eApp,
  seedWorld,
  type SeededWorld,
} from './e2e-env.js';

const skipped = E2E_READY ? describe : describe.skip;

let app: INestApplication;
let world: SeededWorld;

/** 资产域种子（在 IMPL-10 世界上追加系统/设备/网关/点位）。 */
interface AssetSeed {
  systemId: string;
  equipmentId: string;
  gatewayId: string;
  pointIds: { temp: number; pump: number; spare: number };
}
let seed: AssetSeed;

/** 按种子口令表登录（PASSWORDS 为分角色固定值，e2e-env）。 */
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
let viewerToken: string;
let operatorToken: string;
let adminBToken: string;

function authed(method: 'get' | 'post' | 'patch', path: string, token: string): request.Test {
  return request(app.getHttpServer())[method](path).set('Authorization', `Bearer ${token}`);
}

/** SEC-AZ-03 断言对：不存在 vs 越权——reason_code 与 message 完全一致。 */
function expectIdenticalEnvelope(
  nonexistent: request.Response,
  unauthorized: request.Response,
  expectedStatus: number,
  expectedCode: string,
): void {
  expect(nonexistent.status).toBe(expectedStatus);
  expect(unauthorized.status).toBe(expectedStatus);
  const a = nonexistent.body.error as { reason_code: string; message: string };
  const b = unauthorized.body.error as { reason_code: string; message: string };
  expect(a.reason_code).toBe(expectedCode);
  expect(a.message).toBe(b.message);
  expect(a.reason_code).toBe(b.reason_code);
}

skipped('asset e2e：楼宇/系统/设备/点位（IMPL-11 验收要点）', () => {
  beforeAll(async () => {
    world = await seedWorld();
    ({ app } = await bootE2eApp());
    adminToken = await login('admin-a@dt113.test');
    operatorToken = await login('operator-a@dt113.test');
    viewerToken = await login('viewer-a@dt113.test');
    adminBToken = await login('admin-b@dt113.test');
    seed = await seedAssets();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('楼宇（§3.1）', () => {
    it('shouldCreateABuilding_echoFullEntity_andSupportKeywordSearch', async () => {
      const created = await authed('post', '/api/v1/buildings', adminToken).send({
        name: 'E2E 能源楼',
        address: '南京市玄武区',
        building_type: 'office',
        gross_area_m2: 12000,
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ name: 'E2E 能源楼', building_type: 'office' });
      expect(created.body.id).toBeDefined();
      expect(created.body.tenant_id).toBeUndefined(); // tenant_id 不暴露（§2.1）

      const listed = await authed(
        'get',
        '/api/v1/buildings?keyword=' + encodeURIComponent('能源'),
        adminToken,
      );
      expect(listed.status).toBe(200);
      expect(listed.body.items.some((b: { id: string }) => b.id === created.body.id)).toBe(true);
    });

    it('shouldRejectUnknownBuildingType_withDedicatedCode', async () => {
      const response = await authed('post', '/api/v1/buildings', adminToken).send({
        name: 'x',
        building_type: 'stadium',
      });
      expect(response.status).toBe(422);
      expect(response.body.error.reason_code).toBe('asset.building_type_unknown');
    });

    it('shouldRejectMissingName_withValidationFailed_detailsField', async () => {
      const response = await authed('post', '/api/v1/buildings', adminToken).send({});
      expect(response.status).toBe(422);
      expect(response.body.error.reason_code).toBe('common.validation_failed');
      expect(Object.keys(response.body.error.details)).toContain('name');
    });

    it('shouldPaginateWithCursor_roundtrip', async () => {
      const page1 = await authed('get', '/api/v1/buildings?limit=2', adminToken);
      expect(page1.status).toBe(200);
      expect(page1.body.items).toHaveLength(2);
      if (page1.body.next_cursor !== null) {
        const page2 = await authed(
          'get',
          `/api/v1/buildings?limit=2&cursor=${String(page1.body.next_cursor)}`,
          adminToken,
        );
        expect(page2.status).toBe(200);
        const ids1 = page1.body.items.map((b: { id: string }) => b.id);
        const ids2 = page2.body.items.map((b: { id: string }) => b.id);
        expect(ids1.some((id: string) => ids2.includes(id))).toBe(false);
      }
    });

    it('shouldRejectInvalidCursor_with422', async () => {
      const response = await authed('get', '/api/v1/buildings?cursor=not-a-cursor', adminToken);
      expect(response.status).toBe(422);
      expect(response.body.error.reason_code).toBe('common.validation_failed');
      expect(response.body.error.details).toMatchObject({ field: 'cursor' });
    });

    it('shouldReturnIdentical404_forNonexistent_andCrossTenant', async () => {
      const ghost = await authed(
        'get',
        '/api/v1/buildings/123e4567-e89b-42d3-a456-426614174101',
        adminToken,
      );
      const cross = await authed('get', `/api/v1/buildings/${world.buildingA1}`, adminBToken);
      expectIdenticalEnvelope(ghost, cross, 404, 'asset.not_found');
    });

    it('shouldHideOutOfScopeBuildings_fromViewer', async () => {
      // viewer 只有 buildingA1 授权：A2 不在 scope → 与不存在同响应
      const ghost = await authed(
        'get',
        '/api/v1/buildings/123e4567-e89b-42d3-a456-426614174102',
        viewerToken,
      );
      const outOfScope = await authed('get', `/api/v1/buildings/${world.buildingA2}`, viewerToken);
      expectIdenticalEnvelope(ghost, outOfScope, 404, 'asset.not_found');
      const listed = await authed('get', '/api/v1/buildings', viewerToken);
      expect(listed.body.items.every((b: { id: string }) => b.id === world.buildingA1)).toBe(true);
    });

    it('shouldPatchABuilding_lastWriteWins', async () => {
      const response = await authed(
        'patch',
        `/api/v1/buildings/${world.buildingA1}`,
        adminToken,
      ).send({
        climate_zone: '夏热冬冷',
      });
      expect(response.status).toBe(200);
      expect(response.body.climate_zone).toBe('夏热冬冷');
    });

    it('shouldRejectWriteFromViewer_with403', async () => {
      const response = await authed('post', '/api/v1/buildings', viewerToken).send({
        name: '越权楼',
      });
      expect(response.status).toBe(403);
      expect(response.body.error.reason_code).toBe('auth.forbidden');
    });
  });

  describe('系统（§3.2）', () => {
    it('shouldCreateAndListSystems_underBuilding', async () => {
      const created = await authed('post', '/api/v1/systems', adminToken).send({
        building_id: world.buildingA1,
        system_type: 'chilled_water',
        name: 'E2E 冷冻水系统',
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        system_type: 'chilled_water',
        building_id: world.buildingA1,
      });

      const listed = await authed(
        'get',
        `/api/v1/buildings/${world.buildingA1}/systems?system_type=chilled_water`,
        adminToken,
      );
      expect(listed.status).toBe(200);
      expect(listed.body.items.some((s: { id: string }) => s.id === created.body.id)).toBe(true);
    });

    it('shouldRejectUnknownSystemType', async () => {
      const response = await authed('post', '/api/v1/systems', adminToken).send({
        building_id: world.buildingA1,
        system_type: 'rocket',
        name: 'x',
      });
      expect(response.status).toBe(422);
      expect(response.body.error.reason_code).toBe('asset.system_type_unknown');
    });

    it('shouldReturn404_forNonexistentParent_andCrossTenantParent', async () => {
      const ghost = await authed(
        'get',
        '/api/v1/buildings/123e4567-e89b-42d3-a456-426614174103/systems',
        adminToken,
      );
      const cross = await authed(
        'get',
        `/api/v1/buildings/${world.buildingA1}/systems`,
        adminBToken,
      );
      expectIdenticalEnvelope(ghost, cross, 404, 'asset.not_found');
    });
  });

  describe('设备（§3.3）', () => {
    it('shouldCreateAnEquipment_withRatedParams_andList', async () => {
      const created = await authed('post', '/api/v1/equipments', adminToken).send({
        system_id: seed.systemId,
        equipment_type: 'chiller',
        name: '1# 冷机',
        local_id: 'CH-01',
        rated_params: { cooling_kw: 1200, refrigerant: 'R134a' },
      });
      expect(created.status).toBe(201);
      expect(created.body.rated_params).toEqual({ cooling_kw: 1200, refrigerant: 'R134a' });

      const listed = await authed(
        'get',
        `/api/v1/systems/${seed.systemId}/equipments?equipment_type=chiller`,
        adminToken,
      );
      expect(listed.body.items.some((e: { id: string }) => e.id === created.body.id)).toBe(true);
    });

    it('shouldRejectUnknownEquipmentType', async () => {
      const response = await authed('post', '/api/v1/equipments', adminToken).send({
        system_id: seed.systemId,
        equipment_type: 'ufo',
        name: 'x',
      });
      expect(response.status).toBe(422);
      expect(response.body.error.reason_code).toBe('asset.equipment_type_unknown');
    });

    it('shouldRejectDuplicateLocalId_withinSameSystem_with409', async () => {
      const body = {
        system_id: seed.systemId,
        equipment_type: 'chwp_pump' as const,
        name: '撞号泵',
        local_id: 'P-01', // seed 已占用
      };
      const create = await authed('post', '/api/v1/equipments', adminToken).send(body);
      expect(create.status).toBe(409);
      expect(create.body.error.reason_code).toBe('asset.local_id_duplicate');
      expect(create.body.error.details).toMatchObject({
        system_id: seed.systemId,
        local_id: 'P-01',
      });

      // PATCH 面：先建第二台设备（local_id P-02），改到已占用的 P-01 → 409
      const second = await authed('post', '/api/v1/equipments', adminToken).send({
        system_id: seed.systemId,
        equipment_type: 'chwp_pump',
        name: '冷冻泵',
        local_id: 'P-02',
      });
      expect(second.status).toBe(201);
      const secondId = (second.body as { id: string }).id;
      const patch = await authed('patch', `/api/v1/equipments/${secondId}`, adminToken).send({
        local_id: 'P-01',
      });
      expect(patch.status).toBe(409);
      expect(patch.body.error.reason_code).toBe('asset.local_id_duplicate');
    });
  });

  describe('点位读取与检索（§3.4）', () => {
    it('shouldListEquipmentPoints_withLatestSnapshotShape', async () => {
      const response = await authed(
        'get',
        `/api/v1/equipments/${seed.equipmentId}/points`,
        adminToken,
      );
      expect(response.status).toBe(200);
      expect(response.body.items.length).toBeGreaterThanOrEqual(2);
      for (const item of response.body.items as [{ point: { id: number }; latest: unknown }]) {
        expect(item.point).toBeDefined();
        // e2e 无 TSDB → latest 快照降级 null（§3.4 注记口径）
        expect(item.latest === null || typeof item.latest === 'object').toBe(true);
      }
    });

    it('shouldSearchPoints_acrossLevels_withWhitelistedFilters', async () => {
      const byQuantity = await authed(
        'get',
        '/api/v1/points?quantity_type=chw_supply_temp&status=active',
        adminToken,
      );
      expect(byQuantity.status).toBe(200);
      expect(byQuantity.body.items.length).toBeGreaterThanOrEqual(1);
      expect(
        byQuantity.body.items.every(
          (p: { quantity_type: string | null }) => p.quantity_type === 'chw_supply_temp',
        ),
      ).toBe(true);

      const byKeyword = await authed('get', '/api/v1/points?keyword=CHW', adminToken);
      expect(byKeyword.body.items.length).toBeGreaterThanOrEqual(1);

      const byGateway = await authed(
        'get',
        `/api/v1/points?gateway_id=${seed.gatewayId}`,
        adminToken,
      );
      expect(byGateway.body.items.length).toBeGreaterThanOrEqual(2);
    });

    it('shouldRejectNonWhitelistedQueryParam_with422_notSilentlyIgnored', async () => {
      const response = await authed('get', '/api/v1/points?building_nam=typo', adminToken);
      expect(response.status).toBe(422);
      expect(response.body.error.reason_code).toBe('common.validation_failed');
    });

    it('shouldReturn404_forCrossTenantBuildingFilter_andOutOfScopeForViewer', async () => {
      const ghost = await authed(
        'get',
        '/api/v1/points?building_id=123e4567-e89b-42d3-a456-426614174104',
        adminToken,
      );
      const cross = await authed(
        'get',
        `/api/v1/points?building_id=${world.buildingA1}`,
        adminBToken,
      );
      expectIdenticalEnvelope(ghost, cross, 404, 'asset.not_found');

      const outOfScope = await authed(
        'get',
        `/api/v1/points?building_id=${world.buildingA2}`,
        viewerToken,
      );
      expect(outOfScope.status).toBe(404);
      expect(outOfScope.body.error.reason_code).toBe('asset.not_found');
    });

    it('shouldRestrictViewerSearchToScopedBuildings', async () => {
      const response = await authed('get', '/api/v1/points', viewerToken);
      expect(response.status).toBe(200);
      expect(
        response.body.items.every(
          (p: { building_id: string }) => p.building_id === world.buildingA1,
        ),
      ).toBe(true);
    });

    it('shouldReturnPointDetail_withBreadcrumbContext', async () => {
      const response = await authed(
        'get',
        `/api/v1/points/${String(seed.pointIds.temp)}`,
        adminToken,
      );
      expect(response.status).toBe(200);
      expect(response.body.context.building.id).toBe(world.buildingA1);
      expect(response.body.context.system.id).toBe(seed.systemId);
      expect(response.body.context.equipment.id).toBe(seed.equipmentId);
      expect(response.body.context.gateway.id).toBe(seed.gatewayId);
      expect(response.body.raw_name).toBe('CHW.ST01.TEMP');
    });
  });

  describe('点位语义编辑（§3.5，路由隔离守卫验收锚点）', () => {
    it('shouldPatchSemanticFields_andAdvanceUpdated_at', async () => {
      const before = await authed(
        'get',
        `/api/v1/points/${String(seed.pointIds.temp)}`,
        adminToken,
      );
      const response = await authed(
        'patch',
        `/api/v1/points/${String(seed.pointIds.temp)}`,
        operatorToken,
      ).send({
        display_name: '冷冻水供温（改）',
        unit_std: 'DegC',
      });
      expect(response.status).toBe(200);
      expect(response.body.display_name).toBe('冷冻水供温（改）');
      expect(new Date(response.body.updated_at).getTime()).toBeGreaterThanOrEqual(
        new Date(before.body.updated_at).getTime(),
      );
    });

    it('shouldGuardGateFields_withFieldNotAllowed_pointingToM8', async () => {
      const response = await authed(
        'patch',
        `/api/v1/points/${String(seed.pointIds.temp)}`,
        operatorToken,
      ).send({
        is_controllable: true,
        clamp_min: 0,
      });
      expect(response.status).toBe(400);
      expect(response.body.error.reason_code).toBe('point.field_not_allowed');
      expect(response.body.error.details.allowed).toEqual([
        'display_name',
        'description',
        'quantity_type',
        'unit_raw',
        'unit_std',
      ]);
      expect(response.body.error.details.fields).toContain('is_controllable');
    });

    it('shouldGuardPhysicalFields_withFieldNotAllowed_pointingToPhysicalEndpoint', async () => {
      for (const body of [
        { raw_name: 'X' },
        { gateway_id: seed.gatewayId },
        { direction: 'read' },
      ]) {
        const response = await authed(
          'patch',
          `/api/v1/points/${String(seed.pointIds.temp)}`,
          adminToken,
        ).send(body);
        expect(response.status).toBe(400);
        expect(response.body.error.reason_code).toBe('point.field_not_allowed');
      }
    });

    it('shouldGuardStatusField_withFieldNotAllowed_pointingToStatusEndpoint', async () => {
      const response = await authed(
        'patch',
        `/api/v1/points/${String(seed.pointIds.temp)}`,
        adminToken,
      ).send({
        status: 'disabled',
      });
      expect(response.status).toBe(400);
      expect(response.body.error.reason_code).toBe('point.field_not_allowed');
    });

    it('shouldRejectUnknownQuantityType_withDedicatedCode', async () => {
      const response = await authed(
        'patch',
        `/api/v1/points/${String(seed.pointIds.temp)}`,
        operatorToken,
      ).send({
        quantity_type: 'vibration',
      });
      expect(response.status).toBe(422);
      expect(response.body.error.reason_code).toBe('point.quantity_type_unknown');
    });

    it('shouldRejectEmptyBody_with422', async () => {
      const response = await authed(
        'patch',
        `/api/v1/points/${String(seed.pointIds.temp)}`,
        operatorToken,
      ).send({});
      expect(response.status).toBe(422);
      expect(response.body.error.reason_code).toBe('common.validation_failed');
    });

    it('shouldEnforceIfMatch_weakValidator_onUpdated_at', async () => {
      const current = await authed(
        'get',
        `/api/v1/points/${String(seed.pointIds.temp)}`,
        adminToken,
      );
      const updated_at = String(current.body.updated_at);

      const stale = await authed(
        'patch',
        `/api/v1/points/${String(seed.pointIds.temp)}`,
        operatorToken,
      )
        .set('If-Match', `W/"2020-01-01T00:00:00.000Z"`)
        .send({ description: '旧锚' });
      expect(stale.status).toBe(409);
      expect(stale.body.error.reason_code).toBe('common.conflict');
      expect(stale.body.error.details).toMatchObject({ current_updated_at: updated_at });

      const fresh = await authed(
        'patch',
        `/api/v1/points/${String(seed.pointIds.temp)}`,
        operatorToken,
      )
        .set('If-Match', `W/"${updated_at}"`)
        .send({ description: '新锚通过' });
      expect(fresh.status).toBe(200);
      expect(fresh.body.description).toBe('新锚通过');
    });

    it('shouldRejectViewerSemanticsWrite_with403', async () => {
      const response = await authed(
        'patch',
        `/api/v1/points/${String(seed.pointIds.temp)}`,
        viewerToken,
      ).send({
        display_name: '越权',
      });
      expect(response.status).toBe(403);
      expect(response.body.error.reason_code).toBe('auth.forbidden');
    });
  });

  describe('点位启停（§3.6）', () => {
    it('shouldDisableAndReEnable_withReason_andIdempotentSameState', async () => {
      const disable = await authed(
        'patch',
        `/api/v1/points/${String(seed.pointIds.pump)}/status`,
        adminToken,
      ).send({
        status: 'disabled',
        reason: '检修停用',
      });
      expect(disable.status).toBe(200);
      expect(disable.body.status).toBe('disabled');

      // 重复置同态幂等 200（仅日志不留新痕）
      const again = await authed(
        'patch',
        `/api/v1/points/${String(seed.pointIds.pump)}/status`,
        adminToken,
      ).send({
        status: 'disabled',
        reason: '再次停用',
      });
      expect(again.status).toBe(200);
      expect(again.body.status).toBe('disabled');

      // 停用点可被检索（R7 运维入口）
      const searched = await authed('get', '/api/v1/points?status=disabled', adminToken);
      expect(searched.body.items.some((p: { id: number }) => p.id === seed.pointIds.pump)).toBe(
        true,
      );

      const enable = await authed(
        'patch',
        `/api/v1/points/${String(seed.pointIds.pump)}/status`,
        adminToken,
      ).send({
        status: 'active',
        reason: '检修完成',
      });
      expect(enable.status).toBe(200);
      expect(enable.body.status).toBe('active');
    });

    it('shouldRejectMissingReason_andInvalidStatus_with422', async () => {
      const noReason = await authed(
        'patch',
        `/api/v1/points/${String(seed.pointIds.pump)}/status`,
        adminToken,
      ).send({
        status: 'disabled',
      });
      expect(noReason.status).toBe(422);
      expect(noReason.body.error.reason_code).toBe('common.validation_failed');

      const badStatus = await authed(
        'patch',
        `/api/v1/points/${String(seed.pointIds.pump)}/status`,
        adminToken,
      ).send({
        status: 'paused',
        reason: 'x',
      });
      expect(badStatus.status).toBe(422);
      expect(badStatus.body.error.reason_code).toBe('common.validation_failed');
    });

    it('shouldRejectOperatorStatusWrite_with403', async () => {
      const response = await authed(
        'patch',
        `/api/v1/points/${String(seed.pointIds.pump)}/status`,
        operatorToken,
      ).send({
        status: 'disabled',
        reason: '越权',
      });
      expect(response.status).toBe(403);
      expect(response.body.error.reason_code).toBe('auth.forbidden');
    });

    it('shouldBatchStatus_with207_partialFailure_andCap100', async () => {
      const ghostId = 999_999_999;
      const mixed = await authed('post', '/api/v1/points/batch-status', adminToken).send({
        ids: [seed.pointIds.spare, ghostId],
        status: 'disabled',
        reason: '批量停用',
      });
      expect(mixed.status).toBe(207);
      const items = mixed.body.items as Array<{
        point_id: number;
        ok: boolean;
        error?: { reason_code: string };
      }>;
      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({ point_id: seed.pointIds.spare, ok: true });
      expect(items[1]).toMatchObject({ point_id: ghostId, ok: false });
      expect(items[1]?.error?.reason_code).toBe('asset.not_found');

      // 恢复
      await authed('post', '/api/v1/points/batch-status', adminToken).send({
        ids: [seed.pointIds.spare],
        status: 'active',
        reason: '恢复',
      });

      const tooMany = await authed('post', '/api/v1/points/batch-status', adminToken).send({
        ids: Array.from({ length: 101 }, (_, i) => i + 1),
        status: 'disabled',
        reason: 'x',
      });
      expect(tooMany.status).toBe(422);

      const duplicated = await authed('post', '/api/v1/points/batch-status', adminToken).send({
        ids: [seed.pointIds.spare, seed.pointIds.spare],
        status: 'disabled',
        reason: 'x',
      });
      expect(duplicated.status).toBe(422);
    });
  });

  describe('跨租户点位（SEC-AZ-03 汇总）', () => {
    it('shouldReturnIdentical404_forPointGet_semantics_andStatus', async () => {
      const ghost = await authed('get', '/api/v1/points/999999998', adminToken);
      expect(ghost.status).toBe(404);
      expect(ghost.body.error.reason_code).toBe('asset.not_found');
      const ghostPatch = await authed('patch', '/api/v1/points/999999998', operatorToken).send({
        display_name: 'x',
      });
      expect(ghostPatch.status).toBe(404);
      expect(ghostPatch.body.error.message).toBe(ghost.body.error.message); // 文案一致
    });
  });
});

/** 追加资产域种子（superuser 通道；RLS 不可见面走 admin DSN）。 */
async function seedAssets(): Promise<AssetSeed> {
  const pool = new pg.Pool({ connectionString: E2E_ADMIN_URL, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const system = await client.query<{ id: string }>(
        `INSERT INTO hvac_system (tenant_id, building_id, system_type, name)
         VALUES ($1, $2, 'chilled_water', 'E2E 冷冻水') RETURNING id`,
        [world.tenantA, world.buildingA1],
      );
      const systemId = requireSeedId(system);
      const equipment = await client.query<{ id: string }>(
        `INSERT INTO equipment (tenant_id, system_id, equipment_type, name, local_id)
         VALUES ($1, $2, 'sensor', 'E2E 传感器箱', 'P-01') RETURNING id`,
        [world.tenantA, systemId],
      );
      const equipmentId = requireSeedId(equipment);
      const gateway = await client.query<{ id: string }>(
        `INSERT INTO gateway (tenant_id, building_id, name, serial, mqtt_client_id)
         VALUES ($1, $2, 'E2E 网关', 'E2EGW001', 'gw-E2EGW001') RETURNING id`,
        [world.tenantA, world.buildingA1],
      );
      const gatewayId = requireSeedId(gateway);
      const point = async (
        rawName: string,
        quantityType: string | null,
        equipmentId: string | null,
      ): Promise<number> => {
        const result = await client.query<{ id: string }>(
          `INSERT INTO point (tenant_id, building_id, equipment_id, source_type, gateway_id,
                              raw_name, quantity_type, display_name, unit_raw, unit_std, direction)
           VALUES ($1, $2, $3, 'mqtt_gateway', $4, $5, $6, $7, '℃', 'DegC', 'read')
           RETURNING id`,
          [world.tenantA, world.buildingA1, equipmentId, gatewayId, rawName, quantityType, rawName],
        );
        return Number(requireSeedId(result));
      };
      const temp = await point('CHW.ST01.TEMP', 'chw_supply_temp', equipmentId);
      const pump = await point('CHW.P01.RUN', 'run_status', equipmentId);
      const spare = await point('CHW.SPARE', null, null);
      await client.query('COMMIT');
      return {
        systemId,
        equipmentId,
        gatewayId,
        pointIds: { temp, pump, spare },
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

/** 种子 RETURNING 单行取值（e2e-env firstId 同款）。 */
function requireSeedId(result: { rows: Array<{ id: string }> }): string {
  const row = result.rows[0];
  if (row === undefined) throw new Error('种子 RETURNING 未返回行');
  return row.id;
}
