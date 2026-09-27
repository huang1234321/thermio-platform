/**
 * reason_code 种子表与命名规则（platform.md §5.2，IMPL-2 / DAT-96 落地）。
 *
 * 治理规则：
 * - 命名 `<domain>.<cause>`，全 snake_case 小写（§8 对齐事项 1 的收口结论：
 *   modules/overview §2 的大写蛇形码为设计期语义清单，落码一律采用本表小写风格）；
 * - 首版种子 18 码取值严格来自 platform.md §5.2（common.not_found 随 DAT-96
 *   收尾增补入 §5.2，DAT-119）；随模块落码注册的增量码在 REASON_CODES 数组
 *   注释中逐批留痕（新增走 PR，改义视为破坏性变更，API-CT-02/05 同构承诺）；
 * - 闸门码与指标 label 同源：`proposal.gate_*` 的 cause 子串同时是
 *   `thermio_gate_rejections_total{gate=…}` 的 label 取值（ADR-017，一次定义两处消费）。
 */
import { z } from 'zod';
import { ALARM_SUPPRESS_DURATION_S } from './enums.js';

/** 五道闸门的 cause 子串（ADR-009；§5.2「与 ADR-017 的咬合」）。 */
export const GATE_CAUSES = [
  'gate_not_whitelisted',
  'gate_clamped',
  'gate_rate_limited',
  'gate_conflict',
  'gate_circuit_open',
] as const;
export type GateCause = (typeof GATE_CAUSES)[number];

/**
 * 闸门 reason_code（`proposal.<cause>`）。与 GATE_CAUSES 的同源性不由类型推导
 * （map 会丢字面量元组），由 reason-codes.test.ts 钉死：改一处必须同步另一处。
 */
export const PROPOSAL_GATE_REASON_CODES = [
  'proposal.gate_not_whitelisted',
  'proposal.gate_clamped',
  'proposal.gate_rate_limited',
  'proposal.gate_conflict',
  'proposal.gate_circuit_open',
] as const;
export type ProposalGateReasonCode = (typeof PROPOSAL_GATE_REASON_CODES)[number];

/**
 * 首版种子表全集（platform.md §5.2 表格 18 码 + 随模块落码注册的草案码）。
 * 改这张表 = 发版动作：同步 reason-codes.snapshot.test.ts 快照，评审可见。
 *
 * 首批注册（IMPL-12 / DAT-115，遥测查询服务落码，§5.2 治理走本 PR）：
 * point.no_data / telemetry.range_invalid / telemetry.store_unavailable——
 * 目标码与 OVERVIEW_DESIGN_CODE_ALIASES 映射（IMPL-2 预留）逐字一致。
 *
 * 二批注册（IMPL-7 / DAT-110，EMQX 内部端点服务认证，platform.md §11-2）：
 * auth.service_unauthorized——OVERVIEW_DESIGN_CODE_ALIASES 的 SERVICE_UNAUTHORIZED
 * 草案映射自此指向种子码。
 *
 * §5.2 增补（DAT-119 / DAT-96 收尾）：common.not_found——路由级 404 信封码，
 * 骨架期在 api 异常过滤器以本地常量占位（刻意不入表保持 17 码对齐），本批转正，
 * 种子表 17 → 18 码。
 *
 * 三批注册（IMPL-10 / DAT-113，认证会话与 RBAC，modules M7 + platform.md §12 限速骨架）：
 * - common.rate_limited：§12「命中限速 429」落码（登录防爆破，SEC-PW-04）；
 * - auth.unauthenticated / auth.refresh_revoked：M7 草案（UNAUTHENTICATED / REFRESH_REVOKED）；
 * - user.password_policy_failed / user.not_found / user.email_duplicate / user.scope_building_mismatch；
 * - role.unknown：M7 草案（ROLE_UNKNOWN）。
 *
 * 四批注册（IMPL-11 / DAT-114，资产与接入管理，modules M1-asset.md §1.2 落码值逐字）：
 * - common.conflict：point If-Match 弱校验失配（R4，409）；
 * - 枚举治理三码 asset.building_type_unknown / asset.system_type_unknown /
 *   asset.equipment_type_unknown + point.quantity_type_unknown（422，值域外拒绝路径）；
 * - asset.local_id_duplicate（同系统 local_id 重复，409，R3——DDL 无唯一索引，应用层校验）；
 * - point.field_not_allowed（语义 PATCH 白名单外字段，400——schema 合法但违反端点策略）；
 * - 接入域三码 gateway.not_found / gateway.serial_duplicate / credential.not_found /
 *   credential.limit_exceeded（R6：platform 种子未覆盖接入域）。
 *
 * 六批注册（IMPL-14 api 包 / DAT-117，实时监控 M3-monitor.md §1.2 落码值逐字）：
 * - stream.limit_exceeded（400，SSE 单连接订阅点数 >500，整单拒绝不部分放行）；
 * - point.not_found（400，SSE 订阅点集含越界/不存在点，整单 + details.point_ids——
 *   platform §10 在用码，与 M1 单资源 asset.not_found 的分工见 M3-monitor R4）；
 * - stream.server_busy（503，SSE 每实例并发连接 ≥100，响应附 Retry-After: 5，M3-monitor R5）。
 *
 * 五批注册（IMPL-13 / DAT-116，告警引擎与告警中心，modules M4-alarm.md §1.2 落码值逐字）：
 * - alarm.not_found（404，SEC-AZ-03 越权同码；种子仅 rule_not_found）；
 * - alarm.state_invalid（409，状态机非法迁移）；
 * - 校验类 alarm.suppress_duration_invalid / alarm.rule_scope_invalid /
 *   alarm.rule_params_invalid / alarm.rule_type_unknown / alarm.severity_unknown（422）；
 * - alarm.rule_in_use（409，DELETE 被引用——FK RESTRICT 应用层映射）。
 */
export const REASON_CODES = [
  'common.validation_failed',
  'common.internal_error',
  'common.not_found',
  'common.rate_limited',
  'common.conflict',
  'auth.invalid_credentials',
  'auth.token_expired',
  'auth.unauthenticated',
  'auth.refresh_revoked',
  'auth.forbidden',
  'auth.service_unauthorized',
  'user.password_policy_failed',
  'user.not_found',
  'user.email_duplicate',
  'user.scope_building_mismatch',
  'role.unknown',
  'asset.not_found',
  'asset.duplicate_raw_name',
  'asset.building_type_unknown',
  'asset.system_type_unknown',
  'asset.equipment_type_unknown',
  'asset.local_id_duplicate',
  'point.quantity_type_unknown',
  'point.field_not_allowed',
  'gateway.not_found',
  'gateway.serial_duplicate',
  'credential.not_found',
  'credential.limit_exceeded',
  'point.not_controllable',
  'point.write_not_numeric',
  ...PROPOSAL_GATE_REASON_CODES,
  'mv.baseline_not_active',
  'mv.period_invalid',
  'alarm.rule_not_found',
  'alarm.not_found',
  'alarm.state_invalid',
  'alarm.suppress_duration_invalid',
  'alarm.rule_scope_invalid',
  'alarm.rule_params_invalid',
  'alarm.rule_type_unknown',
  'alarm.severity_unknown',
  'alarm.rule_in_use',
  'point.no_data',
  'telemetry.range_invalid',
  'telemetry.store_unavailable',
  'stream.limit_exceeded',
  'point.not_found',
  'stream.server_busy',
] as const;

export const ReasonCodeSchema = z.enum(REASON_CODES);
export type ReasonCode = (typeof REASON_CODES)[number];

/** reason_code 元数据：domain / HTTP 状态 / 闸门联动 / 语义（§5.2 表格第 2–4 列）。 */
export interface ReasonCodeMeta {
  readonly domain: string;
  readonly http: number;
  /** 闸门码：cause 子串同时是 thermio_gate_rejections_total{gate} 的 label 值。 */
  readonly gate?: GateCause;
  readonly description: string;
}

/**
 * §5.2 种子注册表：code → 元数据。
 * 注意 `proposal.gate_clamped` 的 http=200——仲裁通过后的执行路径被值域夹紧，
 * 提案本身接受，2xx + reason_code 表达「成功但被修正」，不违反 API-ERR-03（非错误）。
 */
export const REASON_CODE_REGISTRY: Readonly<Record<ReasonCode, ReasonCodeMeta>> = {
  'common.validation_failed': {
    domain: 'common',
    http: 422,
    description: '请求体/参数 schema 校验失败（details 带字段级错误）',
  },
  'common.internal_error': {
    domain: 'common',
    http: 500,
    description: '未知异常兜底（只此一个 5xx 文案出口）',
  },
  'common.not_found': {
    domain: 'common',
    http: 404,
    description:
      '路由级 404：无匹配路由的信封兜底（资源级不存在走各域 not_found 码，如 asset.not_found；SEC-AZ-03 不泄露存在性）',
  },
  'common.rate_limited': {
    domain: 'common',
    http: 429,
    description: '命中限速（platform.md §12 骨架码；登录防爆破，SEC-PW-04）',
  },
  'common.conflict': {
    domain: 'common',
    http: 409,
    description: '乐观并发失配（point If-Match 弱校验，锚 updated_at；M1-asset §1.2 增量〔R4〕）',
  },
  'auth.invalid_credentials': {
    domain: 'auth',
    http: 401,
    description: '登录凭证无效（登录与鉴权）',
  },
  'auth.token_expired': {
    domain: 'auth',
    http: 401,
    description: '会话过期（可刷新）',
  },
  'auth.unauthenticated': {
    domain: 'auth',
    http: 401,
    description: '未认证（缺 Bearer 令牌或令牌不可用，M7 UNAUTHENTICATED）',
  },
  'auth.refresh_revoked': {
    domain: 'auth',
    http: 401,
    description: 'refresh token 已撤销/已轮换/不匹配（M7 REFRESH_REVOKED；复用检测即撤销会话）',
  },
  'auth.forbidden': {
    domain: 'auth',
    http: 403,
    description: '已认证但权限不足',
  },
  'auth.service_unauthorized': {
    domain: 'auth',
    http: 401,
    description: '内部端点服务凭证校验失败（platform.md §11-2：不泄露具体失败步骤，API-ERR-04）',
  },
  'user.password_policy_failed': {
    domain: 'user',
    http: 422,
    description: '密码不符合策略（SEC-PW-01/02：自适应慢哈希口径 + 长度 ≥8 含字母数字）',
  },
  'user.not_found': {
    domain: 'user',
    http: 404,
    description: '用户不存在或不在本租户（越租户同 404，文案不区分，SEC-AZ-03）',
  },
  'user.email_duplicate': {
    domain: 'user',
    http: 409,
    description: '租户内邮箱已存在（UNIQUE (tenant_id, email)）',
  },
  'user.scope_building_mismatch': {
    domain: 'user',
    http: 404,
    description: '楼宇范围含无效/越租户项（统一 404 不区分成因，SEC-AZ-03）',
  },
  'role.unknown': {
    domain: 'role',
    http: 422,
    description: '角色取值不在 MVP 三角色集（admin/operator/viewer）',
  },
  'asset.not_found': {
    domain: 'asset',
    http: 404,
    description:
      '资产域资源不存在：building/system/equipment/point（越租户/越楼宇同 404，不泄露存在性 SEC-AZ-03）',
  },
  'asset.duplicate_raw_name': {
    domain: 'asset',
    http: 409,
    description: '资产域原始名重复（唯一性冲突）',
  },
  'asset.building_type_unknown': {
    domain: 'asset',
    http: 422,
    description: 'building_type 不在 BUILDING_TYPES 清单（M1-asset §1.2 增量）',
  },
  'asset.system_type_unknown': {
    domain: 'asset',
    http: 422,
    description: 'system_type 不在 SYSTEM_TYPES 清单（枚举治理拒绝路径）',
  },
  'asset.equipment_type_unknown': {
    domain: 'asset',
    http: 422,
    description: 'equipment_type 不在 EQUIPMENT_TYPES 清单（枚举治理拒绝路径）',
  },
  'asset.local_id_duplicate': {
    domain: 'asset',
    http: 409,
    description: '同系统内设备 local_id 重复（EQUIPMENT_LOCAL_ID_DUPLICATE 映射；应用层校验，R3）',
  },
  'point.quantity_type_unknown': {
    domain: 'point',
    http: 422,
    description: 'quantity_type 不在 QUANTITY_TYPES 清单（枚举治理拒绝路径）',
  },
  'point.field_not_allowed': {
    domain: 'point',
    http: 400,
    description:
      '语义 PATCH 提交白名单外字段（闸门字段走 M8、物理层字段走 §3.10、status 走 §3.6 专用端点；400 而非 422：schema 合法但违反端点策略）',
  },
  'gateway.not_found': {
    domain: 'gateway',
    http: 404,
    description: '网关不存在或越权（接入域；越界与不存在同响应，SEC-AZ-03，M1-asset R6）',
  },
  'gateway.serial_duplicate': {
    domain: 'gateway',
    http: 409,
    description:
      '网关 serial 全局重复（跨租户 UNIQUE；details 仅含 serial 本身，不泄露对方租户信息）',
  },
  'credential.not_found': {
    domain: 'credential',
    http: 404,
    description: '凭证不存在或越权（CREDENTIAL_NOT_FOUND 映射，SEC-AZ-03）',
  },
  'credential.limit_exceeded': {
    domain: 'credential',
    http: 409,
    description: '每网关活跃凭证超上限（CREDENTIAL_LIMIT_EXCEEDED 映射；上限 2，M1-asset §4）',
  },
  'point.not_controllable': {
    domain: 'point',
    http: 409,
    description: '写入前置校验失败：点位未登记可控（P2-3 可写点限数值量）',
  },
  'point.write_not_numeric': {
    domain: 'point',
    http: 422,
    description: '写入值非数值（可写点限数值量）',
  },
  'proposal.gate_not_whitelisted': {
    domain: 'proposal',
    http: 409,
    gate: 'gate_not_whitelisted',
    description: '闸门 1：受控白名单拒绝',
  },
  'proposal.gate_clamped': {
    domain: 'proposal',
    http: 200,
    gate: 'gate_clamped',
    description: '闸门 2：值域 clamp（执行成功但被夹紧，details 带夹紧前后值；2xx 语义）',
  },
  'proposal.gate_rate_limited': {
    domain: 'proposal',
    http: 429,
    gate: 'gate_rate_limited',
    description: '闸门 3：频率限制',
  },
  'proposal.gate_conflict': {
    domain: 'proposal',
    http: 409,
    gate: 'gate_conflict',
    description: '闸门 4：同设备冲突提案排队',
  },
  'proposal.gate_circuit_open': {
    domain: 'proposal',
    http: 503,
    gate: 'gate_circuit_open',
    description: '闸门 5：全局熔断，系统降级 advisory',
  },
  'mv.baseline_not_active': {
    domain: 'mv',
    http: 409,
    description: 'M&V 基线不在有效期',
  },
  'mv.period_invalid': {
    domain: 'mv',
    http: 422,
    description: 'M&V 核证期参数无效',
  },
  'alarm.rule_not_found': {
    domain: 'alarm',
    http: 404,
    description: '告警规则不存在',
  },
  'alarm.not_found': {
    domain: 'alarm',
    http: 404,
    description: '告警事件不存在或越权（SEC-AZ-03 不区分，M4-alarm.md §1.2）',
  },
  'alarm.state_invalid': {
    domain: 'alarm',
    http: 409,
    description: '告警状态机非法迁移（ack/close/suppress/unsuppress 前置状态不满足）',
  },
  'alarm.suppress_duration_invalid': {
    domain: 'alarm',
    http: 422,
    description: `抑制时长越界 [${String(ALARM_SUPPRESS_DURATION_S.min)}, ${String(ALARM_SUPPRESS_DURATION_S.max)}] 秒`,
  },
  'alarm.rule_scope_invalid': {
    domain: 'alarm',
    http: 422,
    description: 'scope 取值非法、scope_id 类型不符或 rule_type × scope 组合不合法',
  },
  'alarm.rule_params_invalid': {
    domain: 'alarm',
    http: 422,
    description: '规则 params 不符合 rule_type schema（未知键/越界）',
  },
  'alarm.rule_type_unknown': {
    domain: 'alarm',
    http: 422,
    description: 'rule_type 不在 ALARM_RULE_TYPES（沿 asset.*_unknown 先例）',
  },
  'alarm.severity_unknown': {
    domain: 'alarm',
    http: 422,
    description: 'severity 不在 ALARM_SEVERITIES',
  },
  'alarm.rule_in_use': {
    domain: 'alarm',
    http: 409,
    description: '规则仍被 alarm_event 引用（FK RESTRICT 应用层映射；归档式停用 = enabled=false）',
  },
  'point.no_data': {
    domain: 'point',
    http: 404,
    description: '点位已登记但尚无遥测数据（IMPL-12 latest 空态；区别于 asset.not_found 的未登记）',
  },
  'telemetry.range_invalid': {
    domain: 'telemetry',
    http: 422,
    description:
      '遥测查询跨度超限或 from/to 时间参数无效（跨度上限按 interval 分档，shared-types TELEMETRY_SPAN_LIMIT_DAYS）',
  },
  'telemetry.store_unavailable': {
    domain: 'telemetry',
    http: 503,
    description:
      '遥测查询所需存储不可用或未配置（TSDB 只读连接 / PG 点位档案；dev 无栈时显式降级口径，ADR-005 read replica 配置位）',
  },
  'stream.limit_exceeded': {
    domain: 'stream',
    http: 400,
    description:
      'SSE 单连接订阅点数超上限（platform §12：≤500，整单拒绝不部分放行；M3-monitor §1.2）',
  },
  'point.not_found': {
    domain: 'point',
    http: 400,
    description:
      'SSE 订阅点集含越界/不存在点（platform §10 逐字：整单 400 + details.point_ids；单资源端点仍用 asset.not_found，分工见 M3-monitor R4）',
  },
  'stream.server_busy': {
    domain: 'stream',
    http: 503,
    description:
      'SSE 每实例并发连接达上限（platform §12：≤100；响应附 Retry-After: 5，客户端退避重连任意实例，M3-monitor R5）',
  },
};

/** 值是否在首版种子表内（客户端 API-ERR-02 兜底分支的判据）。 */
export function isReasonCode(value: string): value is ReasonCode {
  return (REASON_CODES as readonly string[]).includes(value);
}

/** 种子码的 HTTP 状态（种子表外取值编译期即拒绝；运行时未知值先过 isReasonCode）。 */
export function httpStatusForReasonCode(code: ReasonCode): number {
  return REASON_CODE_REGISTRY[code].http;
}

/**
 * modules/overview.md 设计期大写码 → 落码小写风格的映射表（platform.md §5.2 末段、
 * implementation-plan §8 对齐事项 1：IMPL-2 做一次映射随 shared-types 入库）。
 *
 * 映射规式（§5.2 四个机械示例的一般化，DAT-102 成文；逐条定档见各组注释）：
 * 1. 目标码取 `<domain>.<cause>` 小写蛇形；domain 取该码所属业务域/端点域；
 * 2. **种子优先**：语义与种子表某码逐条对照一致（含**同义异名**）→ 用种子码原字。
 *    同义双码是 API-ERR-01 稳定性事故——设计期清单码与 seed 落码不同名时，机械
 *    直译结果（如 `PROPOSAL_GATE_SYSTEM_FUSED` → `proposal.gate_system_fused`）为
 *    **非法码**，一律以 seed 钉死的码为准（见闸门组注释）；
 * 3. overview §2 通用表码（无业务域归属：UNAUTHENTICATED/VALIDATION_FAILED 等）→
 *    `common.*`（个别与域种子语义完全重合的除外，如 NOT_FOUND → asset.not_found）；
 * 4. 域归属逐条定档：跨 building/system/equipment/point 的资源类 → `asset.*`；
 *    枚举取值校验类 → `<枚举名小写>.unknown`（system_type/equipment_type/
 *    quantity_type/role 各自独立域）；网关/凭证/导入/FDD/组态各自独立域；
 * 5. 目标不在种子表内的为**草案码**：随对应模块落码时按 §5.2 治理走 PR 注册进种子表，
 *    注册前不得由服务端发出。
 *
 * 快照治理（DAT-102）：全表闭集快照 + 上述定档断言见
 * reason-code-aliases.snapshot.test.ts——改映射 = 发版动作，CI 面评审可见。
 */
export const OVERVIEW_DESIGN_CODE_ALIASES: Readonly<Record<string, string>> = {
  // ── 通用（overview §2 通用 reason_code 表）→ 种子码 ──
  VALIDATION_FAILED: 'common.validation_failed',
  INTERNAL_ERROR: 'common.internal_error',
  TOKEN_EXPIRED: 'auth.token_expired',
  FORBIDDEN: 'auth.forbidden',
  LOGIN_FAILED: 'auth.invalid_credentials',
  NOT_FOUND: 'asset.not_found', // overview §2：资源不存在或跨租户/越楼宇（SEC-AZ-03 统一 404）
  BUILDING_NAME_REQUIRED: 'common.validation_failed',
  // ── 资产域 → 种子码（asset.not_found 覆盖 building/system/equipment/point，§5.2）──
  BUILDING_NOT_FOUND: 'asset.not_found',
  SYSTEM_NOT_FOUND: 'asset.not_found',
  POINT_NOT_FOUND: 'asset.not_found',
  // ── 通用表其余（overview §2；无业务域归属 → common.*，规式第 3 条）草案码 ──
  // CONFLICT 目标随 IMPL-11 注册为 common.conflict（M1-asset §1.2/§1.3 落码值；
  // 仅 point If-Match 场景承载——R4 承载限定）。
  CONFLICT: 'common.conflict',
  RATE_LIMITED: 'common.rate_limited', // platform.md §6 明示骨架码原字；IMPL-10 注册入种子表
  // ── 闸门 → 种子码（执行结果侧展示码，overview M5；与 §5.2 逐条对照）──
  PROPOSAL_GATE_WHITELIST_DENIED: 'proposal.gate_not_whitelisted',
  PROPOSAL_GATE_RATE_LIMITED: 'proposal.gate_rate_limited',
  PROPOSAL_GATE_CONFLICT_QUEUED: 'proposal.gate_conflict',
  // 双名收口（DAT-92 评审建议 1）：本清单码（ddl.md §9.3 / flows.md §2）与 seed
  // `proposal.gate_circuit_open`（v1.0 既有）同义异名——机械直译
  // `proposal.gate_system_fused` 是非法码，映射以 seed 钉死的码为准（规式第 2 条）。
  PROPOSAL_GATE_SYSTEM_FUSED: 'proposal.gate_circuit_open',
  // ── 告警域 → 种子码 ──
  ALARM_RULE_NOT_FOUND: 'alarm.rule_not_found',
  // ── platform.md §5.2 明示的四个机械映射（目标为草案码，随模块落码注册；
  //    auth.service_unauthorized 已随 IMPL-7 内部端点注册进种子表）──
  PROPOSAL_STATE_INVALID: 'proposal.state_invalid',
  IMPORT_FILE_INVALID: 'import.file_invalid',
  STREAM_LIMIT_EXCEEDED: 'stream.limit_exceeded',
  SERVICE_UNAUTHORIZED: 'auth.service_unauthorized',
  // ── 认证/用户（M7）草案码 ──
  UNAUTHENTICATED: 'auth.unauthenticated',
  REFRESH_REVOKED: 'auth.refresh_revoked',
  PASSWORD_POLICY_FAILED: 'user.password_policy_failed',
  USER_NOT_FOUND: 'user.not_found',
  USER_EMAIL_DUPLICATE: 'user.email_duplicate',
  SCOPE_BUILDING_MISMATCH: 'user.scope_building_mismatch',
  // ── 资产/网关/凭证（M1）草案码 ──
  EQUIPMENT_LOCAL_ID_DUPLICATE: 'asset.local_id_duplicate',
  GATEWAY_NOT_FOUND: 'gateway.not_found',
  GATEWAY_SERIAL_DUPLICATE: 'gateway.serial_duplicate',
  CREDENTIAL_NOT_FOUND: 'credential.not_found',
  CREDENTIAL_LIMIT_EXCEEDED: 'credential.limit_exceeded',
  // ── 枚举取值未知（M1 校验类；details 指明字段）草案码 ──
  // M1 三码目标随 IMPL-11 注册入种子表（M1-asset §1.3 落码值：枚举域归资产/点位域，
  // 规式第 4 条「跨实体资源类 → asset.*」优先于旧草案的独立小域名）。
  SYSTEM_TYPE_UNKNOWN: 'asset.system_type_unknown',
  EQUIPMENT_TYPE_UNKNOWN: 'asset.equipment_type_unknown',
  QUANTITY_TYPE_UNKNOWN: 'point.quantity_type_unknown',
  ROLE_UNKNOWN: 'role.unknown',
  // ── 点位域（M1/M3/M8）草案码 ──
  POINT_NO_DATA: 'point.no_data',
  POINT_INACTIVE: 'point.inactive',
  POINT_FIELD_NOT_ALLOWED: 'point.field_not_allowed',
  GATE_REASON_REQUIRED: 'point.gate_reason_required',
  GATE_CLAMP_RANGE_INVALID: 'point.gate_clamp_range_invalid',
  GATE_CONTROLLABLE_REQUIRES_CLAMP: 'point.gate_controllable_requires_clamp',
  GATE_RATE_INVALID: 'point.gate_rate_invalid',
  CONTROL_MODE_TRANSITION_INVALID: 'point.control_mode_transition_invalid',
  CONTROL_MODE_SAME: 'point.control_mode_same',
  CONTROL_MODE_POINT_NOT_CONTROLLABLE: 'point.control_mode_point_not_controllable',
  TELEMETRY_RANGE_INVALID: 'telemetry.range_invalid',
  // ── 导入域（M2）草案码 ──
  IMPORT_NOT_FOUND: 'import.not_found',
  IMPORT_STATE_INVALID: 'import.state_invalid',
  IMPORT_TEMPLATE_MISMATCH: 'import.template_mismatch',
  IMPORT_APPLY_CONFLICT: 'import.apply_conflict',
  SELFCHECK_NOT_READY: 'import.selfcheck_not_ready',
  UNIT_CONVERSION_UNSUPPORTED: 'import.unit_conversion_unsupported',
  // ── 告警域其余（M4）草案码 ──
  ALARM_NOT_FOUND: 'alarm.not_found',
  ALARM_STATE_INVALID: 'alarm.state_invalid',
  ALARM_RULE_SCOPE_INVALID: 'alarm.rule_scope_invalid',
  ALARM_RULE_PARAMS_INVALID: 'alarm.rule_params_invalid',
  SUPPRESS_DURATION_INVALID: 'alarm.suppress_duration_invalid',
  // ── 提案域其余（M5）草案码 ──
  PROPOSAL_NOT_FOUND: 'proposal.not_found',
  PROPOSAL_EXPIRED: 'proposal.expired',
  PROPOSAL_VERIFY_FAILED: 'proposal.verify_failed',
  PROPOSAL_PAYLOAD_INVALID: 'proposal.payload_invalid',
  // ── FDD（M6）/ 组态（M3）草案码 ──
  FDD_FINDING_NOT_FOUND: 'fdd.finding_not_found',
  FDD_REPORT_NOT_FOUND: 'fdd.report_not_found',
  SCENE_NOT_FOUND: 'scene.not_found',
};
