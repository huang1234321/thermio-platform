/**
 * 认证/RBAC 契约测试（modules M7 / SEC-AZ-05 / SEC-PW-02）：
 * - 能力目录与推导表：角色包含关系 + 目录内取值（overview §7 权限矩阵）；
 * - 密码策略 schema 的正/负路径（SEC-PW-02）；
 * - wire schema 的边界（login/me/users）。
 */
import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  CAPABILITY_PATTERN,
  ChangePasswordRequestSchema,
  CreateUserRequestSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  ME_UNKNOWN_CAPABILITY_NOTE,
  MeResponseSchema,
  PASSWORD_MIN_LENGTH,
  PasswordSchema,
  ROLE_CAPABILITIES,
  USER_LIST_MAX_LIMIT,
  UserListQuerySchema,
  capabilitiesForRole,
} from './auth.js';
import { ROLES, RoleSchema } from './enums.js';

describe('capability catalog（SEC-AZ-05）', () => {
  it('shouldKeepEveryCapabilityInDotVerbShape', () => {
    for (const capability of CAPABILITIES) {
      expect(capability).toMatch(CAPABILITY_PATTERN);
    }
  });

  it('shouldDeriveMonotonicCapabilitySets_perOverviewS7Matrix', () => {
    const viewer = new Set(ROLE_CAPABILITIES.viewer);
    const operator = new Set(ROLE_CAPABILITIES.operator);
    const admin = new Set(ROLE_CAPABILITIES.admin);
    // operator ⊇ viewer；admin ⊇ operator（矩阵单调）
    for (const capability of viewer) expect(operator.has(capability)).toBe(true);
    for (const capability of operator) expect(admin.has(capability)).toBe(true);
    // 关键分界（§7）：users.manage/control.write 仅 admin；imports.write 到 operator
    expect(admin.has('users.manage')).toBe(true);
    expect(operator.has('users.manage')).toBe(false);
    expect(viewer.has('users.manage')).toBe(false);
    expect(admin.has('control.write')).toBe(true);
    expect(operator.has('control.write')).toBe(false);
    expect(operator.has('imports.write')).toBe(true);
    expect(viewer.has('imports.write')).toBe(false);
  });

  it('shouldAnswerDerivation_forEveryMvpRole', () => {
    for (const role of ROLES) {
      expect(capabilitiesForRole(RoleSchema.parse(role))).toEqual(ROLE_CAPABILITIES[role]);
    }
  });
});

describe('password policy（SEC-PW-02）', () => {
  it('shouldAcceptLettersPlusDigits_atMinimumLength', () => {
    expect(PasswordSchema.safeParse('a1b2c3d9').success).toBe(true);
    expect(PasswordSchema.safeParse('abcdefgh1').success).toBe(true);
  });

  it('shouldRejectTooShort_orMissingDigits_orMissingLetters', () => {
    expect(PasswordSchema.safeParse('a1b2c3d').success).toBe(false); // 7 位 < 8
    expect(PasswordSchema.safeParse('12345678').success).toBe(false); // 无字母
    expect(PasswordSchema.safeParse('abcdefgh').success).toBe(false); // 无数字
    expect(PasswordSchema.safeParse('').success).toBe(false);
  });

  it('shouldStateTheMinimumLength_inTheContract', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
  });
});

describe('wire schemas（M7 API 草案）', () => {
  it('shouldParseALoginRoundtrip', () => {
    const request = LoginRequestSchema.parse({ email: 'admin@example.com', password: 'secret1' });
    expect(request.email).toBe('admin@example.com');
    const response = LoginResponseSchema.safeParse({
      access_token: 'jwt',
      refresh_token: 'opaque',
      token_type: 'Bearer',
      expires_in: 900,
      must_change_password: false,
      user: { id: 'u1', email: 'admin@example.com', display_name: 'Admin' },
    });
    expect(response.success).toBe(true);
  });

  it('shouldRejectInvalidEmails_onLogin', () => {
    expect(LoginRequestSchema.safeParse({ email: 'not-an-email', password: 'x' }).success).toBe(
      false,
    );
  });

  it('shouldParseMe_withKnownAndUnknownCapabilities', () => {
    // 未知能力键必须可解析（API-CT-02 枚举 default 分支：忽略渲染，不崩）
    const me = MeResponseSchema.safeParse({
      user: { id: 'u1', email: 'v@example.com', display_name: 'Viewer' },
      role: 'viewer',
      must_change_password: false,
      building_scopes: [{ id: 'b1', name: '1# 楼' }],
      capabilities: ['monitor.read', 'future.capability'],
      session: {
        id: 's1',
        created_at: '2026-09-26T02:00:00Z',
        expires_at: '2026-09-26T02:15:00Z',
      },
    });
    expect(me.success).toBe(true);
  });

  it('shouldCapUserListLimit_atPlatformS12Ceiling', () => {
    expect(UserListQuerySchema.safeParse({ limit: USER_LIST_MAX_LIMIT }).success).toBe(true);
    expect(UserListQuerySchema.safeParse({ limit: USER_LIST_MAX_LIMIT + 1 }).success).toBe(false);
  });

  it('shouldDefaultCreateUserBuildingIds_toEmptyArray', () => {
    const parsed = CreateUserRequestSchema.parse({
      email: 'new@example.com',
      display_name: '新用户',
      password: 'init1234',
      role: 'viewer',
    });
    expect(parsed.building_ids).toEqual([]);
  });

  it('shouldRejectChangePassword_whenNewPasswordReusesPolicyViolations', () => {
    expect(
      ChangePasswordRequestSchema.safeParse({ old_password: 'x', new_password: 'short' }).success,
    ).toBe(false);
  });

  it('shouldDocumentWhyMeCapabilityIsPlainString', () => {
    // capabilities 用 string[] 而非 enum：新能力先下发后进目录（只增演进，API-CT-02）
    expect(ME_UNKNOWN_CAPABILITY_NOTE.length).toBeGreaterThan(0);
  });
});
