/**
 * 认证会话 / RBAC / 租户上下文契约（modules/overview.md §4 M7、ADR-011、SEC-AZ-05）。
 *
 * 能力（capability）治理：
 * - 服务端按角色推导能力清单经 GET /me 下发，UI 只按 capabilities[] 显隐，
 *   **不按角色名本地推断**（SEC-AZ-05）；服务端守卫按能力判权（SEC-AZ-01 默认拒绝）；
 * - v1 目录取 ui/baseline.md §1.1 点名的能力键（菜单显隐 + imports.write/control.write
 *   两个动作键），零自造；后续模块（IMPL-11+）落码时按 platform.md §5.2「新增走 PR」
 *   同流程增补——只增不删（API-CT-02）；
 * - 推导表 ROLE_CAPABILITIES 与 overview §7 权限矩阵对应：viewer 只读、
 *   operator 加导入写、admin 再加控制安全写与用户管理。
 *
 * 令牌形状：
 * - access：JWT（短时效，默认 15min，AUTH_ACCESS_TTL_SECONDS 可配），
 *   每请求服务端回查会话状态（SEC-AZ-04 可撤销，登出即失效）；
 * - refresh：不透明随机数（sha256 落库，每次刷新轮换；轮换后旧 token 即作废）。
 */
import { z } from 'zod';
import { ROLES, USER_STATUSES, type Role } from './enums.js';

// ---------------------------------------------------------------------------
// 能力目录（v1）
// ---------------------------------------------------------------------------

/**
 * 能力目录 v1（ui/baseline.md §1.1 能力键列；只增不删，API-CT-02）。
 *
 * IMPL-11 增量（M7-auth §4.1 定稿键名逐字，M1-asset §1.5 v1.1 对齐）：
 * assets.write / points.semantics.write / points.status.write / gateways.manage
 * ——IMPL-10（/me 下发）与 IMPL-11（@RequireCapabilities）同源消费本目录。
 * points.physical.write（§3.10，R17 定稿）随 DAT-151 落码注册，本批不含。
 *
 * IMPL-13 增量（M7-auth §4.1 定稿键名逐字，M4-alarm.md §1.5）：
 * alarms.ack（operator+）/ alarms.suppress（admin）/ alarm_rules.write（admin）。
 *
 * IMPL-17 增量（M5-proposal.md §1.5 定稿键名逐字）：
 * proposals.decide.write（operator+：approve/reject）。
 */
export const CAPABILITIES = [
  'monitor.read',
  'alarms.read',
  'alarms.ack',
  'alarms.suppress',
  'alarm_rules.write',
  'proposals.read',
  'proposals.decide.write',
  'fdd.read',
  'assets.read',
  'assets.write',
  'points.semantics.write',
  'points.status.write',
  'gateways.manage',
  'imports.read',
  'imports.write',
  'control.read',
  'control.write',
  'users.manage',
] as const;
export type Capability = (typeof CAPABILITIES)[number];
export const CapabilitySchema = z.enum(CAPABILITIES);

/**
 * 能力键形状：小写蛇形段以点分层（`<domain>[.<sub>]*.<verb>`）。M7-auth §4.1 定稿
 * 含多段键（points.semantics.write 等），IMPL-10 期的单点形状随之放宽——段内字符
 * 规则不变（M1-asset §1.5 v1.1 对齐 M7 定稿键名）。
 */
export const CAPABILITY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/**
 * /me 的 capabilities 用 string[] 而非闭合 enum：服务端可先下发新能力键、
 * 客户端目录未收录也不崩（API-CT-02 枚举 default 分支 → 忽略渲染）。
 * 目录内取值由 CapabilitySchema 钉死，服务端推导只发目录内值。
 */
export const ME_UNKNOWN_CAPABILITY_NOTE =
  'capabilities 为开放集：未知键忽略渲染，不本地推断语义（SEC-AZ-05）';

/** viewer 只读目录（overview §7：viewer 全部一级菜单只读）。 */
const VIEWER_CAPABILITIES: readonly Capability[] = [
  'monitor.read',
  'alarms.read',
  'proposals.read',
  'fdd.read',
  'assets.read',
  'imports.read',
  'control.read',
];

/**
 * 角色 → 能力推导表（overview §7 权限矩阵；服务端唯一推导点，UI 不得复制此表本地推断）。
 * IMPL-11 增量：operator + points.semantics.write（M7 §4.1）；admin +
 * assets.write / points.status.write / gateways.manage（M7 §4.1 定稿列）。
 */
export const ROLE_CAPABILITIES: Readonly<Record<Role, readonly Capability[]>> = {
  viewer: VIEWER_CAPABILITIES,
  operator: [
    ...VIEWER_CAPABILITIES,
    'imports.write',
    'points.semantics.write',
    'alarms.ack',
    'proposals.decide.write',
  ],
  admin: [
    ...VIEWER_CAPABILITIES,
    'imports.write',
    'points.semantics.write',
    'alarms.ack',
    'proposals.decide.write',
    'alarms.suppress',
    'alarm_rules.write',
    'assets.write',
    'points.status.write',
    'gateways.manage',
    'control.write',
    'users.manage',
  ],
};

/** 按角色推导能力清单（服务端 /me 与守卫共用；SEC-AZ-05 唯一推导入口）。 */
export function capabilitiesForRole(role: Role): readonly Capability[] {
  return ROLE_CAPABILITIES[role];
}

// ---------------------------------------------------------------------------
// 分页上限（platform.md §12：列表分页默认 50、上限 200）
// ---------------------------------------------------------------------------

export const USER_LIST_DEFAULT_LIMIT = 50;
export const USER_LIST_MAX_LIMIT = 200;

// ---------------------------------------------------------------------------
// 认证端点（/auth/*）
// ---------------------------------------------------------------------------

/** SEC-PW-02：长度 ≥8 且含字母与数字（不强制定期更换；泄露/弱口令强制改）。 */
export const PASSWORD_MIN_LENGTH = 8;

export const PasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, '密码长度至少 8 位')
  .max(128, '密码长度过长')
  .refine((value) => /[A-Za-z]/.test(value) && /[0-9]/.test(value), '密码须同时包含字母与数字');

export const LoginRequestSchema = z.object({
  email: z.email().max(320),
  password: z.string().min(1).max(128),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const UserProfileSchema = z.object({
  id: z.string().min(1),
  email: z.email().max(320),
  display_name: z.string().min(1),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;

/** 登录成功响应（modules M7：200 access_token（短时效）+ 会话信息）。 */
export const LoginResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  token_type: z.literal('Bearer'),
  /** access token 剩余秒数。 */
  expires_in: z.number().int().positive(),
  must_change_password: z.boolean(),
  user: UserProfileSchema,
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const RefreshRequestSchema = z.object({
  refresh_token: z.string().min(1).max(2048),
});
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

export const ChangePasswordRequestSchema = z.object({
  old_password: z.string().min(1).max(128),
  new_password: PasswordSchema,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

export const CompleteResetRequestSchema = z.object({
  email: z.email().max(320),
  reset_token: z.string().min(1).max(2048),
  new_password: PasswordSchema,
});
export type CompleteResetRequest = z.infer<typeof CompleteResetRequestSchema>;

// ---------------------------------------------------------------------------
// 用户档案与 GET /me
// ---------------------------------------------------------------------------

/** 楼宇授权项（/me 下发；admin 隐式全楼宇，operator/viewer = user_building_scope）。 */
export const BuildingScopeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});
export type BuildingScope = z.infer<typeof BuildingScopeSchema>;

/**
 * GET /me 响应（UC-M7-5）：角色、楼宇授权与能力清单——UI 显隐的唯一依据（SEC-AZ-05）。
 * 客户端对未知能力键必须忽略渲染（API-CT-02 枚举 default 分支）。
 */
export const MeResponseSchema = z.object({
  user: UserProfileSchema,
  role: z.enum(ROLES),
  must_change_password: z.boolean(),
  building_scopes: z.array(BuildingScopeSchema),
  capabilities: z.array(z.string().min(1)),
  session: z.object({
    id: z.string().min(1),
    created_at: z.iso.datetime({ offset: true }),
    expires_at: z.iso.datetime({ offset: true }),
  }),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

// ---------------------------------------------------------------------------
// 用户管理（/users*，admin 专属：users.manage）
// ---------------------------------------------------------------------------

export const UserListItemSchema = z.object({
  id: z.string().min(1),
  email: z.email().max(320),
  display_name: z.string().min(1),
  status: z.enum(USER_STATUSES),
  role: z.enum(ROLES),
  must_change_password: z.boolean(),
  created_at: z.iso.datetime({ offset: true }),
});
export type UserListItem = z.infer<typeof UserListItemSchema>;

/** 游标分页信封（API-DSN-03：列表必须分页，cursor 透传取下一页）。 */
export const UserListResponseSchema = z.object({
  items: z.array(UserListItemSchema),
  next_cursor: z.string().min(1).nullable(),
});
export type UserListResponse = z.infer<typeof UserListResponseSchema>;

export const UserListQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(USER_LIST_MAX_LIMIT).default(USER_LIST_DEFAULT_LIMIT),
  role: z.enum(ROLES).optional(),
  status: z.enum(USER_STATUSES).optional(),
  keyword: z.string().max(120).optional(),
});
export type UserListQuery = z.infer<typeof UserListQuerySchema>;

export const CreateUserRequestSchema = z.object({
  email: z.email().max(320),
  display_name: z.string().min(1).max(120),
  /** 管理员设定的初始密码：SEC-PW-03 首登强制轮换（must_change_password=true）。 */
  password: PasswordSchema,
  role: z.enum(ROLES),
  building_ids: z.array(z.string().min(1)).max(200).default([]),
});
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;

export const UpdateUserRequestSchema = z
  .object({
    display_name: z.string().min(1).max(120).optional(),
    status: z.enum(USER_STATUSES).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, '至少提供一个字段');
export type UpdateUserRequest = z.infer<typeof UpdateUserRequestSchema>;

export const UpdateRolesRequestSchema = z.object({
  role: z.enum(ROLES),
});
export type UpdateRolesRequest = z.infer<typeof UpdateRolesRequestSchema>;

export const UpdateBuildingScopesRequestSchema = z.object({
  /** operator/viewer 必填非空（服务端校验）；admin 隐式全楼宇，可为空。 */
  building_ids: z.array(z.string().min(1)).max(200),
});
export type UpdateBuildingScopesRequest = z.infer<typeof UpdateBuildingScopesRequestSchema>;

/**
 * 重置密码响应：一次性 reset_token 仅本次返回（SEC-PW-05：≤15min、单用途；
 * MVP 无邮件通道，管理员转交，语义与 M1 凭证轮换「secret 仅本次返回」同构）。
 */
export const ResetPasswordResponseSchema = z.object({
  reset_token: z.string().min(1),
  expires_at: z.iso.datetime({ offset: true }),
});
export type ResetPasswordResponse = z.infer<typeof ResetPasswordResponseSchema>;
