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

/**
 * 五道闸门的 cause 子串（ADR-009；§5.2「与 ADR-017 的咬合」）。
 * v1.5 改名（platform.md §5.2〔R1，DAT-132〕）：`gate_not_whitelisted` →
 * `gate_whitelist_denied`、`gate_circuit_open` → `gate_system_fused`、
 * `gate_conflict` → `gate_conflict_queued`，闸门 4 增溢出/超时两个拒绝子码——
 * 旧五码此前无消费方（IMPL-17 不触闸门），随 IMPL-18 一次入库。
 */
export const GATE_CAUSES = [
  'gate_whitelist_denied',
  'gate_clamped',
  'gate_rate_limited',
  'gate_conflict_queued',
  'gate_conflict_overflow',
  'gate_conflict_timeout',
  'gate_system_fused',
] as const;
export type GateCause = (typeof GATE_CAUSES)[number];

/**
 * 指标 label 值域（platform.md §5.2 v1.5/§7：label = cause 的闸门子串；
 * 闸门 4 三码同 `conflict`；clamp 非拒绝，独立计数器同用本值域）。
 */
export const GATE_LABELS = ['whitelist', 'clamp', 'rate', 'conflict', 'fuse'] as const;
export type GateLabel = (typeof GATE_LABELS)[number];

/** cause → 指标 label 机械映射（§5.2「label 取值 = gate_* cause 的闸门子串」）。 */
export const GATE_CAUSE_LABELS: Readonly<Record<GateCause, GateLabel>> = {
  gate_whitelist_denied: 'whitelist',
  gate_clamped: 'clamp',
  gate_rate_limited: 'rate',
  gate_conflict_queued: 'conflict',
  gate_conflict_overflow: 'conflict',
  gate_conflict_timeout: 'conflict',
  gate_system_fused: 'fuse',
};

/**
 * 闸门 reason_code（`proposal.<cause>`）。与 GATE_CAUSES 的同源性不由类型推导
 * （map 会丢字面量元组），由 reason-codes.test.ts 钉死：改一处必须同步另一处。
 */
export const PROPOSAL_GATE_REASON_CODES = [
  'proposal.gate_whitelist_denied',
  'proposal.gate_clamped',
  'proposal.gate_rate_limited',
  'proposal.gate_conflict_queued',
  'proposal.gate_conflict_overflow',
  'proposal.gate_conflict_timeout',
  'proposal.gate_system_fused',
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
 * 七批注册（IMPL-17 / DAT-163，建议提交与审批，modules/M5-proposal.md §1.2 落码值逐字；
 * 并集注记：八批（IMPL-15 / DAT-118 import 八码）与本批并行开发同号合入，编号顺延自此起算）：
 * - proposal.not_found（404，SEC-AZ-03 越权同码；execution 从属视图同码）；
 * - proposal.state_invalid（409，已决策再 approve/reject，details.current_status）；
 * - proposal.expired（409，approve/reject 时 expires_at 已过且仍 pending）；
 * - proposal.payload_invalid（422，internal 提交信封失败/必填缺失/target 解析零命中或
 *   歧义，细分 details.cause）；
 * - proposal.reason_required（422，reject 缺 reason——独立于 validation_failed 便于定位）；
 * - proposal.client_ref_duplicate（409，同 client_ref 信封不一致重放；〔R2〕依赖码，
 *   DDL 落列前不启用——注册占位随发版纪律先行）。
 *
 * 五批注册（IMPL-13 / DAT-116，告警引擎与告警中心，modules M4-alarm.md §1.2 落码值逐字）：
 * - alarm.not_found（404，SEC-AZ-03 越权同码；种子仅 rule_not_found）；
 * - alarm.state_invalid（409，状态机非法迁移）；
 * - 校验类 alarm.suppress_duration_invalid / alarm.rule_scope_invalid /
 *   alarm.rule_params_invalid / alarm.rule_type_unknown / alarm.severity_unknown（422）；
 * - alarm.rule_in_use（409，DELETE 被引用——FK RESTRICT 应用层映射）。
 * 七批注册（IMPL-15 / DAT-118，点表导入向导，modules M2-import.md §1.2 增量 8 码逐字；
 * `import.template_mismatch` **不落 HTTP 码**——表头不符为异步解析期发现，由作业
 * failure.code='template_mismatch' 承载（M2-import §1.3/R1），故不入本表）：
 * - import.not_found（404，details.entity ∈ {import_job, import_row}）；
 * - import.state_invalid（409，状态机守卫，details: {current_status, allowed}）；
 * - import.file_invalid（422，同步文件级校验：非 xlsx 容器/超 5 MB/空文件/容器损坏）；
 * - import.building_mismatch（422，gateway.building_id ≠ 请求 building_id）；
 * - import.gateway_offline（409，apply 同步预检：目标网关 offline）；
 * - import.apply_conflict（409，apply 同步预检主面 + 登记事务内竞态兜底，details.conflicts）；
 * - import.unit_conversion_unsupported（422，PATCH 即时校验 + apply 复核双面）；
 * - import.selfcheck_not_ready（404，details.reason ∈ {never_run, in_progress}）。
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
  // M8 控制安全域（IMPL-18 / DAT-164 注册；overview §4 M8 码列机械映射，
  // 规式第 4 条：闸门参数/模式为 point 实体字段 → point.* 域）
  'point.gate_reason_required',
  'point.gate_clamp_range_invalid',
  'point.gate_controllable_requires_clamp',
  'point.gate_rate_invalid',
  'point.control_mode_transition_invalid',
  'point.control_mode_same',
  'point.control_mode_point_not_controllable',
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
  // FDD 域（M6 查看端点，modules/M6-fdd.md §4.6；IMPL-16 切片 / DAT-212 注册）
  'fdd.finding_not_found',
  'fdd.report_not_found',
  'fdd.state_invalid',
  'proposal.not_found',
  'proposal.state_invalid',
  'proposal.expired',
  'proposal.payload_invalid',
  'proposal.reason_required',
  'proposal.client_ref_duplicate',
  'import.not_found',
  'import.state_invalid',
  'import.file_invalid',
  'import.building_mismatch',
  'import.gateway_offline',
  'import.apply_conflict',
  'import.unit_conversion_unsupported',
  'import.selfcheck_not_ready',
] as const;

export const ReasonCodeSchema = z.enum(REASON_CODES);
export type ReasonCode = (typeof REASON_CODES)[number];

/** reason_code 元数据：domain / HTTP 状态 / 闸门联动 / 语义（§5.2 表格第 2–4 列）。 */
export interface ReasonCodeMeta {
  readonly domain: string;
  readonly http: number;
  /**
   * 闸门码：`thermio_gate_rejections_total{gate}` / `thermio_gate_clamped_total{gate}`
   * 的 label 值（GATE_CAUSE_LABELS 机械映射；clamp 非拒绝走独立计数器）。
   */
  readonly gate?: GateLabel;
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
  'proposal.gate_whitelist_denied': {
    domain: 'proposal',
    http: 409,
    gate: 'whitelist',
    description:
      '闸门 1：受控白名单拒绝（v1.5 改名〔R1，DAT-132〕，旧码 gate_not_whitelisted 随 IMPL-18 退役）',
  },
  'proposal.gate_clamped': {
    domain: 'proposal',
    http: 200,
    gate: 'clamp',
    description: '闸门 2：值域 clamp（执行成功但被夹紧，details 带夹紧前后值；2xx 语义）',
  },
  'proposal.gate_rate_limited': {
    domain: 'proposal',
    http: 429,
    gate: 'rate',
    description: '闸门 3：频率限制',
  },
  'proposal.gate_conflict_queued': {
    domain: 'proposal',
    http: 409,
    gate: 'conflict',
    description: '闸门 4：同设备冲突提案排队（排队非失败；v1.5 改名〔R1，DAT-132〕）',
  },
  'proposal.gate_conflict_overflow': {
    domain: 'proposal',
    http: 409,
    gate: 'conflict',
    description:
      '闸门 4 拒绝子分支：排队溢出（>CONFLICT_QUEUE_MAX）→ status=failed（v1.5 入表〔R1，DAT-132〕）',
  },
  'proposal.gate_conflict_timeout': {
    domain: 'proposal',
    http: 409,
    gate: 'conflict',
    description:
      '闸门 4 拒绝子分支：排队等待超时（>CONFLICT_WAIT_TIMEOUT_S）→ status=failed（异步面终态；v1.5 入表〔R1，DAT-132〕）',
  },
  'proposal.gate_system_fused': {
    domain: 'proposal',
    http: 503,
    gate: 'fuse',
    description:
      '闸门 5：全局熔断，系统降级 advisory（v1.5 改名〔R1，DAT-132〕，旧码 gate_circuit_open 随 IMPL-18 退役）',
  },
  'point.gate_reason_required': {
    domain: 'point',
    http: 422,
    description: 'M8 闸门参数编辑/模式切换缺 reason（flows §4 reason 必填；IMPL-18 注册）',
  },
  'point.gate_clamp_range_invalid': {
    domain: 'point',
    http: 422,
    description: 'clamp_min ≥ clamp_max 或与 valid_range 矛盾（overview M8；IMPL-18 注册）',
  },
  'point.gate_controllable_requires_clamp': {
    domain: 'point',
    http: 422,
    description: '开启受控白名单必须先有值域（overview M8；IMPL-18 注册）',
  },
  'point.gate_rate_invalid': {
    domain: 'point',
    http: 422,
    description: '频率上限值非法（可控点必填频率上限，R8 语义扩展〔DAT-132〕；IMPL-18 注册）',
  },
  'point.control_mode_transition_invalid': {
    domain: 'point',
    http: 409,
    description:
      '控制模式非法迁移：前进跳档（details.cause=skip）或熔断期间前进封锁（details.cause=fuse_open，〔R6，DAT-132〕；IMPL-18 注册）',
  },
  'point.control_mode_same': {
    domain: 'point',
    http: 409,
    description: '控制模式目标档 = 当前档（并发兜底；IMPL-18 注册）',
  },
  'point.control_mode_point_not_controllable': {
    domain: 'point',
    http: 409,
    description: 'supervised/auto 前提：点位已入受控白名单（overview M8；IMPL-18 注册）',
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
  // FDD 域（M6 §4.6；IMPL-16 切片 / DAT-212 注册——overview §4 M6 草案码机械映射 + 新增 state_invalid）
  'fdd.finding_not_found': {
    domain: 'fdd',
    http: 404,
    description: '发现不存在或跨租户/越楼宇（SEC-AZ-03 不区分文案）',
  },
  'fdd.report_not_found': {
    domain: 'fdd',
    http: 404,
    description: '报告不存在或越权（SEC-AZ-03 不区分文案）',
  },
  'fdd.state_invalid': {
    domain: 'fdd',
    http: 409,
    description: 'ignore 作用于非 open 发现（resolved 终态不可忽略；已 ignored 幂等 200 不走本码）',
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
  'proposal.not_found': {
    domain: 'proposal',
    http: 404,
    description:
      '建议不存在或越权（SEC-AZ-03 同码同文案；execution 为 proposal 从属视图，无独立 404 语义，M5 §1.2）',
  },
  'proposal.state_invalid': {
    domain: 'proposal',
    http: 409,
    description: '已决策（approved/rejected/expired/executed/failed）再 approve/reject（M5 §1.2）',
  },
  'proposal.expired': {
    domain: 'proposal',
    http: 409,
    description: 'approve/reject 时 expires_at 已过且仍 pending（sweeper 60s 收敛，M5 §4.2）',
  },
  'proposal.payload_invalid': {
    domain: 'proposal',
    http: 422,
    description:
      'internal 提交信封失败：必填缺失 / expires_at 非法或已过 / target 解析零命中或歧义（细分 details.cause，M5 §1.3）',
  },
  'proposal.reason_required': {
    domain: 'proposal',
    http: 422,
    description:
      'reject 请求体缺 reason（PRD D1 驳回必填；独立于 validation_failed，M5 §1.2〔R6〕）',
  },
  'proposal.client_ref_duplicate': {
    domain: 'proposal',
    http: 409,
    description:
      'internal 提交同 client_ref 信封不一致重放（幂等重放应 201；M5 §1.2〔R2〕——DDL 落列前不启用，注册占位）',
  },
  'import.not_found': {
    domain: 'import',
    http: 404,
    description:
      '导入作业/行不存在或越权（details.entity ∈ {import_job, import_row}；SEC-AZ-03 不区分不存在与越界）',
  },
  'import.state_invalid': {
    domain: 'import',
    http: 409,
    description:
      '作业状态机守卫拒绝（details: {current_status, allowed}；守卫矩阵见 M2-import §4.2）',
  },
  'import.file_invalid': {
    domain: 'import',
    http: 422,
    description:
      '上传文件级校验失败：非 xlsx 容器、超 5 MB、空文件、容器损坏（details.reason ∈ {size_exceeded, not_xlsx, empty, corrupt}；同步拒绝、作业不入库）',
  },
  'import.building_mismatch': {
    domain: 'import',
    http: 422,
    description: '网关归属楼宇与请求楼宇不一致（ddl §9.1 应用层一致性校验的端点化）',
  },
  'import.gateway_offline': {
    domain: 'import',
    http: 409,
    description: 'apply 同步预检：目标网关 status=offline（推送必失败的前置拦截）',
  },
  'import.apply_conflict': {
    domain: 'import',
    http: 409,
    description:
      'apply 与已注册点位 raw_name 冲突（details.conflicts 行清单；同步预检主面 + 登记事务内竞态兜底双面）',
  },
  'import.unit_conversion_unsupported': {
    domain: 'import',
    http: 422,
    description:
      '单位对无转换规则（PATCH rows 即时校验 + apply 复核双面；行级 dry-run 形态为 issue unit_unsupported）',
  },
  'import.selfcheck_not_ready': {
    domain: 'import',
    http: 404,
    description:
      '自检报告未生成（details.reason ∈ {never_run, in_progress}；作业不存在走 import.not_found）',
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
  // v1.5 改名后三码均可机械直译（platform.md §5.2〔R1，DAT-132〕随 IMPL-18 落码；
  // 旧同义异名收口注释退役——seed 已按机械映射结果钉死）
  PROPOSAL_GATE_WHITELIST_DENIED: 'proposal.gate_whitelist_denied',
  PROPOSAL_GATE_RATE_LIMITED: 'proposal.gate_rate_limited',
  PROPOSAL_GATE_CONFLICT_QUEUED: 'proposal.gate_conflict_queued',
  PROPOSAL_GATE_CONFLICT_OVERFLOW: 'proposal.gate_conflict_overflow',
  PROPOSAL_GATE_CONFLICT_TIMEOUT: 'proposal.gate_conflict_timeout',
  PROPOSAL_GATE_SYSTEM_FUSED: 'proposal.gate_system_fused',
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
  FDD_STATE_INVALID: 'fdd.state_invalid',
  SCENE_NOT_FOUND: 'scene.not_found',
};
