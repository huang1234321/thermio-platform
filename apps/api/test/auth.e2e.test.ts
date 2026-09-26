/**
 * 认证/RBAC/租户上下文 e2e（IMPL-10 验收要点，PG 门控；modules M7 × SEC-AZ/PW）。
 *
 * 覆盖蓝本验收点：
 * 1. 越租户/越楼宇资源一律 404 且文案不区分（SEC-AZ-03）；
 * 2. 登录失败不区分账号不存在/密码错/停用（SEC-PW-04）+ 防爆破限速；
 * 3. 能力显隐：/me 能力清单按角色下发（SEC-AZ-05），users.manage 判权 403；
 * 4. 会话可撤销：登出即失效、refresh 轮换 + 复用检测（SEC-AZ-04）；
 * 5. SEC-PW-03 首登强制轮换闭环；SEC-PW-05 一次性重置令牌。
 *
 * 信封断言复用 shared-types 契约（API-CT-01 客户端面：safeParse 后消费）。
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import {
  ApiErrorEnvelopeSchema,
  parseApiError,
  type LoginResponse,
  type MeResponse,
} from '@thermio/shared-types';
import { E2E_READY, PASSWORDS, bootE2eApp, seedWorld, type SeededWorld } from './e2e-env.js';

const skipped = E2E_READY ? describe : describe.skip;

let app: INestApplication;
let world: SeededWorld;

async function login(email: string, password: string): Promise<request.Response> {
  return request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password });
}

function authedGet(path: string, token: string): request.Test {
  return request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`);
}

function expectEnvelope(response: request.Response): { reason_code: string; message: string } {
  const parsed = ApiErrorEnvelopeSchema.safeParse(response.body);
  if (!parsed.success) {
    throw new Error('错误信封不符合契约：' + JSON.stringify(response.body));
  }
  return { reason_code: parsed.data.error.reason_code, message: parsed.data.error.message };
}

/** 登录响应窄化（supertest body 是 any，TS-02：边界处一次收窄）。 */
async function loginSession(email: string, password: string): Promise<LoginResponse> {
  const response = await login(email, password);
  expect(response.status).toBe(200);
  return response.body as LoginResponse;
}

skipped('auth/rbac/tenant e2e（IMPL-10 验收要点）', () => {
  beforeAll(async () => {
    world = await seedWorld();
    ({ app } = await bootE2eApp());
  });

  afterAll(async () => {
    await app.close();
  });

  describe('登录（SEC-PW-04 统一失败语义）', () => {
    it('shouldLoginAnActiveAdmin_andReturnSessionMaterial', async () => {
      const response = await login('admin-a@dt113.test', PASSWORDS.admin);
      expect(response.status).toBe(200);
      expect(response.body.access_token).toBeDefined();
      expect(response.body.refresh_token).toBeDefined();
      expect(response.body.token_type).toBe('Bearer');
      expect(response.body.user.email).toBe('admin-a@dt113.test');
    });

    it('shouldReturnIdenticalEnvelopes_forUnknownEmail_wrongPassword_andDisabledUser', async () => {
      const unknown = await login('ghost@dt113.test', 'whatever-pass-1');
      const wrongPw = await login('admin-a@dt113.test', 'wrong-password-9');
      const disabled = await login('disabled-a@dt113.test', PASSWORDS.disabled);

      expect(unknown.status).toBe(401);
      expect(wrongPw.status).toBe(401);
      expect(disabled.status).toBe(401);
      const envelopes = [unknown, wrongPw, disabled].map((r) => expectEnvelope(r));
      // 三类失败同 code 同文案（账号存在性零泄露，SEC-PW-04）
      expect(new Set(envelopes.map((e) => e.reason_code))).toEqual(
        new Set(['auth.invalid_credentials']),
      );
      expect(new Set(envelopes.map((e) => e.message))).toHaveLength(1);
    });

    it('shouldRateLimitAfterRepeatedFailures_429CommonRateLimited', async () => {
      const email = 'bruteforce-target@dt113.test';
      // 50/300 窗口：灌满 50 次失败后第 51 次被拒
      for (let i = 0; i < 50; i += 1) {
        const response = await login(email, 'wrong-password-9');
        expect(response.status).toBe(401);
      }
      const blocked = await login(email, 'wrong-password-9');
      expect(blocked.status).toBe(429);
      expect(expectEnvelope(blocked).reason_code).toBe('common.rate_limited');
    });
  });

  describe('会话生命周期（SEC-AZ-04）', () => {
    it('shouldInvalidateAccessOnLogout_serverSideRevocation', async () => {
      const session = await loginSession('admin-a@dt113.test', PASSWORDS.admin);
      expect((await authedGet('/api/v1/me', session.access_token)).status).toBe(200);
      const logout = await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${session.access_token}`);
      expect(logout.status).toBe(204);
      const after = await authedGet('/api/v1/me', session.access_token);
      expect(after.status).toBe(401);
      expect(expectEnvelope(after).reason_code).toBe('auth.invalid_credentials');
    });

    it('shouldRotateRefreshTokens_andKillSessionOnReuse', async () => {
      const session = await loginSession('admin-a@dt113.test', PASSWORDS.admin);
      const refresh = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refresh_token: session.refresh_token });
      expect(refresh.status).toBe(200);
      const refreshed = refresh.body as LoginResponse;
      expect(refresh.body.refresh_token).not.toBe(session.refresh_token);

      // 旧 refresh 复用 = 失窃信号 → auth.refresh_revoked 且会话整体撤销
      const reuse = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refresh_token: session.refresh_token });
      expect(reuse.status).toBe(401);
      expect(expectEnvelope(reuse).reason_code).toBe('auth.refresh_revoked');

      const deadAccess = await authedGet('/api/v1/me', refreshed.access_token);
      expect(deadAccess.status).toBe(401);
      expect(expectEnvelope(deadAccess).reason_code).toBe('auth.invalid_credentials');
    });

    it('shouldRejectRefreshGarbage_withoutLeakingShape', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refresh_token: 'garbage-token' });
      expect(response.status).toBe(401);
      expect(expectEnvelope(response).reason_code).toBe('auth.refresh_revoked');
    });
  });

  describe('/me 能力清单（SEC-AZ-05）', () => {
    it('shouldDeliverAdminCapabilities_andImplicitAllBuildings', async () => {
      const session = await loginSession('admin-a@dt113.test', PASSWORDS.admin);
      const me = await authedGet('/api/v1/me', session.access_token);
      expect(me.status).toBe(200);
      const meBody = me.body as MeResponse;
      expect(meBody.role).toBe('admin');
      expect(me.body.capabilities).toContain('users.manage');
      expect(me.body.capabilities).toContain('control.write');
      // admin 隐式全楼宇：A1 + A2（不含 B 租户楼宇）
      const ids = meBody.building_scopes.map((b: { id: string }) => b.id);
      expect(ids).toEqual(expect.arrayContaining([world.buildingA1, world.buildingA2]));
      expect(ids).not.toContain(world.buildingB1);
    });

    it('shouldScopeViewerToExplicitBuildings_andViewerCapabilitiesOnly', async () => {
      const session = await loginSession('viewer-a@dt113.test', PASSWORDS.viewer);
      const me = await authedGet('/api/v1/me', session.access_token);
      expect(me.status).toBe(200);
      expect((me.body as MeResponse).role).toBe('viewer');
      const caps = (me.body as MeResponse).capabilities;
      expect(caps).not.toContain('users.manage');
      expect(caps).not.toContain('imports.write');
      expect(caps).toContain('monitor.read');
      // 越楼宇不出现（SEC-AZ-03）：viewer 只见 A1，不见 A2/B1
      const scopeIds = (me.body as MeResponse).building_scopes.map((b: { id: string }) => b.id);
      expect(scopeIds).toEqual([world.buildingA1]);
    });

    it('shouldRejectMissingOrGarbageTokens_withAuthUnauthenticated', async () => {
      const noToken = await request(app.getHttpServer()).get('/api/v1/me');
      expect(noToken.status).toBe(401);
      expect(expectEnvelope(noToken).reason_code).toBe('auth.unauthenticated');
      const garbage = await authedGet('/api/v1/me', 'not-a-jwt');
      expect(garbage.status).toBe(401);
      expect(expectEnvelope(garbage).reason_code).toBe('auth.unauthenticated');
    });
  });

  describe('用户管理判权（users.manage，overview §7）', () => {
    it('shouldForbidNonAdmin_403AuthForbidden', async () => {
      const viewer = await loginSession('viewer-a@dt113.test', PASSWORDS.viewer);
      const response = await authedGet('/api/v1/users', viewer.access_token);
      expect(response.status).toBe(403);
      expect(expectEnvelope(response).reason_code).toBe('auth.forbidden');
    });

    it('shouldListUsersForAdmin_withFiltersAndCursorPagination', async () => {
      const admin = await loginSession('admin-a@dt113.test', PASSWORDS.admin);
      const first = await authedGet('/api/v1/users?limit=2', admin.access_token);
      expect(first.status).toBe(200);
      expect(first.body.items).toHaveLength(2);
      expect(first.body.items.every((u: { role: string }) => typeof u.role === 'string')).toBe(
        true,
      );

      const byRole = await authedGet('/api/v1/users?role=viewer', admin.access_token);
      expect(byRole.status).toBe(200);
      expect(byRole.body.items.every((u: { role: string }) => u.role === 'viewer')).toBe(true);

      const byKeyword = await authedGet('/api/v1/users?keyword=operator-a', admin.access_token);
      expect(byKeyword.status).toBe(200);
      expect(byKeyword.body.items).toHaveLength(1);

      // 游标走完两页（limit=2，租户 A 共 4 用户）
      const seen: string[] = [...first.body.items.map((u: { id: string }) => u.id)];
      let cursor: string | null = first.body.next_cursor;
      while (cursor !== null) {
        const page = await authedGet(
          `/api/v1/users?limit=2&cursor=${encodeURIComponent(cursor)}`,
          admin.access_token,
        );
        expect(page.status).toBe(200);
        seen.push(...page.body.items.map((u: { id: string }) => u.id));
        cursor = page.body.next_cursor;
      }
      expect(seen).toHaveLength(4);
      expect(new Set(seen).size).toBe(4); // 无重复无遗漏（keyset 正确性）
    });

    it('shouldRejectInvalidListParams_asValidationFailed', async () => {
      const admin = await loginSession('admin-a@dt113.test', PASSWORDS.admin);
      const badRole = await authedGet('/api/v1/users?role=bogus', admin.access_token);
      expect(badRole.status).toBe(422);
      expect(expectEnvelope(badRole).reason_code).toBe('common.validation_failed');
      const badCursor = await authedGet(
        `/api/v1/users?cursor=${encodeURIComponent('%%%')}`,
        admin.access_token,
      );
      expect(badCursor.status).toBe(422);
    });
  });

  describe('建用户与首登强制轮换（SEC-PW-02/03）', () => {
    it('shouldRejectWeakPassword_withDedicatedReasonCode', async () => {
      const admin = await loginSession('admin-a@dt113.test', PASSWORDS.admin);
      const response = await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', `Bearer ${admin.access_token}`)
        .send({
          email: 'newbie@dt113.test',
          display_name: '新用户',
          password: 'short1',
          role: 'viewer',
          building_ids: [world.buildingA1],
        });
      expect(response.status).toBe(422);
      expect(expectEnvelope(response).reason_code).toBe('user.password_policy_failed');
    });

    it('shouldRejectDuplicateEmail_409', async () => {
      const admin = await loginSession('admin-a@dt113.test', PASSWORDS.admin);
      const response = await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', `Bearer ${admin.access_token}`)
        .send({
          email: 'viewer-a@dt113.test',
          display_name: '重复邮箱',
          password: 'valid-pass-123',
          role: 'viewer',
          building_ids: [world.buildingA1],
        });
      expect(response.status).toBe(409);
      expect(expectEnvelope(response).reason_code).toBe('user.email_duplicate');
    });

    it('shouldForcePasswordRotationOnFirstLogin_untilChangeCompletes', async () => {
      const admin = await loginSession('admin-a@dt113.test', PASSWORDS.admin);
      const created = await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', `Bearer ${admin.access_token}`)
        .send({
          email: 'rotating@dt113.test',
          display_name: '轮换用户',
          password: 'initial-pass-123',
          role: 'operator',
          building_ids: [world.buildingA1],
        });
      expect(created.status).toBe(201);
      expect(created.body.must_change_password).toBe(true);

      const session = await loginSession('rotating@dt113.test', 'initial-pass-123');
      expect(session.must_change_password).toBe(true);

      // 未轮换：业务端点 403（fail-closed），/me 仍可用驱动 UI
      const blocked = await authedGet('/api/v1/users', session.access_token);
      expect(blocked.status).toBe(403);
      expect(expectEnvelope(blocked).reason_code).toBe('auth.forbidden');
      const me = await authedGet('/api/v1/me', session.access_token);
      expect(me.status).toBe(200);

      // 错旧密码 → 401；正确改密 → 新令牌对，标记清除
      const wrongOld = await request(app.getHttpServer())
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${session.access_token}`)
        .send({ old_password: 'wrong-old-pass-1', new_password: 'rotated-pass-456' });
      expect(wrongOld.status).toBe(401);

      const changed = await request(app.getHttpServer())
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${session.access_token}`)
        .send({ old_password: 'initial-pass-123', new_password: 'rotated-pass-456' });
      expect(changed.status).toBe(200);
      const renewed = changed.body as LoginResponse;
      expect(renewed.must_change_password).toBe(false);
      expect(renewed.access_token).toBeDefined();

      const unblocked = await authedGet('/api/v1/me', renewed.access_token);
      expect(unblocked.status).toBe(200);
      expect(unblocked.body.must_change_password).toBe(false);
    });
  });

  describe('越租户/越楼宇 404 统一（SEC-AZ-03）', () => {
    it('shouldReturnIndistinguishableUser404_forCrossTenant_andNonexistent', async () => {
      const admin = await loginSession('admin-a@dt113.test', PASSWORDS.admin);
      const crossTenant = await request(app.getHttpServer())
        .patch(`/api/v1/users/${world.adminB}`)
        .set('Authorization', `Bearer ${admin.access_token}`)
        .send({ display_name: '越租户改名' });
      const nonexistent = await request(app.getHttpServer())
        .patch(`/api/v1/users/00000000-0000-4000-8000-00000000000f`)
        .set('Authorization', `Bearer ${admin.access_token}`)
        .send({ display_name: '不存在改名' });

      expect(crossTenant.status).toBe(404);
      expect(nonexistent.status).toBe(404);
      const a = expectEnvelope(crossTenant);
      const b = expectEnvelope(nonexistent);
      expect(a.reason_code).toBe('user.not_found');
      expect(b.reason_code).toBe('user.not_found');
      expect(a.message).toBe(b.message); // 文案不区分（SEC-AZ-03）
    });

    it('shouldReturnUniformScopeMismatch_forForeignBuilding_andGarbageUuid', async () => {
      const admin = await loginSession('admin-a@dt113.test', PASSWORDS.admin);
      const foreign = await request(app.getHttpServer())
        .put(`/api/v1/users/${world.viewerA}/building-scopes`)
        .set('Authorization', `Bearer ${admin.access_token}`)
        .send({ building_ids: [world.buildingB1] });
      const garbage = await request(app.getHttpServer())
        .put(`/api/v1/users/${world.viewerA}/building-scopes`)
        .set('Authorization', `Bearer ${admin.access_token}`)
        .send({ building_ids: ['not-a-uuid'] });

      expect(foreign.status).toBe(404);
      expect(garbage.status).toBe(404);
      const a = expectEnvelope(foreign);
      const b = expectEnvelope(garbage);
      expect(a.reason_code).toBe('user.scope_building_mismatch');
      expect(b.reason_code).toBe('user.scope_building_mismatch');
      expect(a.message).toBe(b.message);
    });

    it('shouldRejectEmptyScopes_forOperatorAndViewer_only', async () => {
      const admin = await loginSession('admin-a@dt113.test', PASSWORDS.admin);
      const emptyForViewer = await request(app.getHttpServer())
        .put(`/api/v1/users/${world.viewerA}/building-scopes`)
        .set('Authorization', `Bearer ${admin.access_token}`)
        .send({ building_ids: [] });
      expect(emptyForViewer.status).toBe(422);
      expect(expectEnvelope(emptyForViewer).reason_code).toBe('common.validation_failed');

      const okForViewer = await request(app.getHttpServer())
        .put(`/api/v1/users/${world.viewerA}/building-scopes`)
        .set('Authorization', `Bearer ${admin.access_token}`)
        .send({ building_ids: [world.buildingA2] });
      expect(okForViewer.status).toBe(200);
      // 生效：viewer 的 /me 楼宇授权随写随读
      const viewer = await loginSession('viewer-a@dt113.test', PASSWORDS.viewer);
      const me = await authedGet('/api/v1/me', viewer.access_token);
      expect((me.body as MeResponse).building_scopes.map((b: { id: string }) => b.id)).toEqual([
        world.buildingA2,
      ]);
    });

    it('shouldChangeRoles_andReflectInNextSession', async () => {
      const admin = await loginSession('admin-a@dt113.test', PASSWORDS.admin);
      const response = await request(app.getHttpServer())
        .put(`/api/v1/users/${world.viewerA}/roles`)
        .set('Authorization', `Bearer ${admin.access_token}`)
        .send({ role: 'operator' });
      expect(response.status).toBe(200);
      const viewer = await loginSession('viewer-a@dt113.test', PASSWORDS.viewer);
      const me = await authedGet('/api/v1/me', viewer.access_token);
      const meBody = me.body as MeResponse;
      expect(meBody.role).toBe('operator');
      expect(meBody.capabilities).toContain('imports.write');
      expect(meBody.capabilities).not.toContain('users.manage');
    });
  });

  describe('一次性重置令牌（SEC-PW-05）', () => {
    it('shouldIssueConsumeAndBurnResetTokens', async () => {
      const admin = await loginSession('admin-a@dt113.test', PASSWORDS.admin);
      const issued = await request(app.getHttpServer())
        .post(`/api/v1/users/${world.operatorA}/reset-password`)
        .set('Authorization', `Bearer ${admin.access_token}`);
      expect(issued.status).toBe(200);
      expect(issued.body.reset_token).toBeDefined();
      expect(issued.body.expires_at).toBeDefined();

      const wrongToken = await request(app.getHttpServer())
        .post('/api/v1/auth/complete-reset')
        .send({
          email: 'operator-a@dt113.test',
          reset_token: 'wrong-token',
          new_password: 'reset-pass-789',
        });
      expect(wrongToken.status).toBe(401);

      const consumed = await request(app.getHttpServer()).post('/api/v1/auth/complete-reset').send({
        email: 'operator-a@dt113.test',
        reset_token: issued.body.reset_token,
        new_password: 'reset-pass-789',
      });
      expect(consumed.status).toBe(204);

      // 单用途：第二次消费拒绝；新口令可登录
      const replay = await request(app.getHttpServer()).post('/api/v1/auth/complete-reset').send({
        email: 'operator-a@dt113.test',
        reset_token: issued.body.reset_token,
        new_password: 'another-pass-012',
      });
      expect(replay.status).toBe(401);

      const relogin = await login('operator-a@dt113.test', 'reset-pass-789');
      expect(relogin.status).toBe(200);
    });

    it('shouldReturnUser404_forResetOnCrossTenantUser', async () => {
      const admin = await loginSession('admin-a@dt113.test', PASSWORDS.admin);
      const response = await request(app.getHttpServer())
        .post(`/api/v1/users/${world.adminB}/reset-password`)
        .set('Authorization', `Bearer ${admin.access_token}`);
      expect(response.status).toBe(404);
      expect(expectEnvelope(response).reason_code).toBe('user.not_found');
    });
  });

  describe('客户端契约兜底（API-CT-01/02）', () => {
    it('shouldParseErrorBodiesViaSharedTypes_withKnownFlag', async () => {
      const response = await login('admin-a@dt113.test', 'wrong-password-9');
      const parsed = parseApiError(response.body);
      expect(parsed.known).toBe(true);
      expect(parsed.reason_code).toBe('auth.invalid_credentials');
      expect(parsed.request_id).toMatch(/^req_/);
    });
  });
});
