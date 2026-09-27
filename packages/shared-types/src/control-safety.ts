/**
 * control-safety 域契约（docs/design/control-safety.md，IMPL-18 / DAT-164）。
 *
 * - §11 系统级运行参数：默认值以本包常量钉死（platform.md §12 同机制——
 *   「默认值以 shared-types 常量钉死（进枚举快照测试）」；env（CONTROL_SAFETY__*
 *   前缀）可覆盖，数值修订走蓝本 PR，不散落代码常量（CODE-ST-03）；
 * - §4 MQTT 消息契约（down/write 信封 + up/event 应答，zod 单源）；
 * - §10 Kafka thermio.control.executed 消息体（flows.md §7-4 收口）；
 * - §2 execution_result.phase 实现层阶段机值集（proposal.status 封闭集不动）；
 * - M8 API 形状（overview §4 M8 / M8-safety-ui.md §2.2/§7.2/§8）。
 */
import { z } from 'zod';
import { ControlFuseStatusSchema } from './enums.js';

// ---------------------------------------------------------------------------
// §11 系统级运行参数（shared-types 常量钉死默认值；api 侧 env 可覆盖）
// ---------------------------------------------------------------------------

/** §5.1 回读等待（write_ack 后等寄存器稳定再发 read_cmd 的 N 秒）。 */
export const CONTROL_VERIFY_DELAY_S = 5;
/** §4.4 read_result 等待窗。 */
export const CONTROL_READ_TIMEOUT_S = 10;
/** §4.4 write_ack 等待窗（超时不中止——回读让事实仲裁）。 */
export const CONTROL_ACK_TIMEOUT_S = 10;
/** §5.1 回读比对容差（unit_std 数值；默认精确相等）。 */
export const CONTROL_VERIFY_TOLERANCE = 0;
/** §5.2 回读不一致后的整段重写次数上限。 */
export const CONTROL_WRITE_RETRY_MAX = 1;
/** §2/§3.7 单次执行全链路硬上限（秒）。 */
export const CONTROL_EXECUTION_BUDGET_S = 90;
/** §3.7 每设备同时排队上限。 */
export const CONTROL_CONFLICT_QUEUE_MAX = 3;
/** §3.7 排队等待超时（秒）。 */
export const CONTROL_CONFLICT_WAIT_TIMEOUT_S = 300;
/** §3.3 write_rate_limit_per_hour 列空时的全局兜底（安全默认而非不限）。 */
export const CONTROL_RATE_LIMIT_DEFAULT = 6;
/** §6 租约 TTL（ADR-009 默认 15min）。 */
export const CONTROL_LEASE_TTL_S = 900;
/** §6.2 心跳节奏（algo 侧任务，ADR-008；服务端仅消费心跳端点）。 */
export const CONTROL_LEASE_HEARTBEAT_INTERVAL_S = 30;
/** §6.3 租约清扫节奏（秒）。 */
export const CONTROL_LEASE_SWEEP_INTERVAL_S = 30;
/** §7.2 熔断评估节奏（秒）。 */
export const CONTROL_FUSE_EVAL_INTERVAL_S = 60;
/** §7.2 熔断评估窗口（ddl.md §9.3 默认 15min）。 */
export const CONTROL_FUSE_WINDOW_S = 900;
/** §7.2 trip 阈值：窗口异常占比（ddl.md §9.3 默认 30%）。 */
export const CONTROL_FUSE_RATE_THRESHOLD = 0.3;
/** §7.2 trip 阈值：最近连续失败次数（ddl.md §9.3 默认 3）。 */
export const CONTROL_FUSE_CONSECUTIVE_FAILS = 3;
/** §7.4 自动恢复阈值：占比回落（ddl.md §9.3 默认 <5%）。 */
export const CONTROL_FUSE_RELEASE_RATE = 0.05;
/** §7.4 自动恢复冷却窗（ddl.md §9.3 默认持续 30min）。 */
export const CONTROL_FUSE_COOLDOWN_S = 1800;

/** §11 参数全集快照（发版动作锚点：改默认值必须显式改快照）。 */
export const CONTROL_SAFETY_PARAMS = {
  CONTROL_VERIFY_DELAY_S,
  CONTROL_READ_TIMEOUT_S,
  CONTROL_ACK_TIMEOUT_S,
  CONTROL_VERIFY_TOLERANCE,
  CONTROL_WRITE_RETRY_MAX,
  CONTROL_EXECUTION_BUDGET_S,
  CONTROL_CONFLICT_QUEUE_MAX,
  CONTROL_CONFLICT_WAIT_TIMEOUT_S,
  CONTROL_RATE_LIMIT_DEFAULT,
  CONTROL_LEASE_TTL_S,
  CONTROL_LEASE_HEARTBEAT_INTERVAL_S,
  CONTROL_LEASE_SWEEP_INTERVAL_S,
  CONTROL_FUSE_EVAL_INTERVAL_S,
  CONTROL_FUSE_WINDOW_S,
  CONTROL_FUSE_RATE_THRESHOLD,
  CONTROL_FUSE_CONSECUTIVE_FAILS,
  CONTROL_FUSE_RELEASE_RATE,
  CONTROL_FUSE_COOLDOWN_S,
} as const;

// ---------------------------------------------------------------------------
// §2 execution_result.phase 实现层阶段机（proposal.status 封闭集不动）
// ---------------------------------------------------------------------------

/**
 * 执行器内部阶段（control-safety §2）：非终态 6 + 终态 4 + 入口 queued。
 * 崩溃恢复与多副本并发以条件 UPDATE 单赢家锚定本字段。
 */
export const CONTROL_EXECUTION_PHASES = [
  'queued',
  'arbitrating',
  'dispatching',
  'awaiting_ack',
  'awaiting_readback',
  'retrying',
  'reverting',
  // 终态（phase 视角；proposal.status 映射 executed/failed）
  'executed',
  'rejected',
  'verify_failed',
  'reverted',
] as const;
export type ControlExecutionPhase = (typeof CONTROL_EXECUTION_PHASES)[number];

/** §3.7 非终态执行集合（闸门 4 判定「同设备存在非终态执行」的口径）。 */
export const CONTROL_ACTIVE_PHASES: readonly ControlExecutionPhase[] = [
  'arbitrating',
  'dispatching',
  'awaiting_ack',
  'awaiting_readback',
  'retrying',
  'reverting',
];

// ---------------------------------------------------------------------------
// §4 MQTT 消息契约（down/write 信封 + up/event 应答）
// ---------------------------------------------------------------------------

/** §4.2 下行写/读指令时效（秒）——过期指令网关丢弃并回 CMD_EXPIRED。 */
export const CONTROL_CMD_EXPIRES_IN_S = 30;

/** 网关侧拒绝原因码（厂商模板映射；§4.3）。 */
export const CONTROL_GW_REJECT_CODES = ['POINT_UNKNOWN', 'WRITE_REFUSED', 'CMD_EXPIRED'] as const;
export type ControlGwRejectCode = (typeof CONTROL_GW_REJECT_CODES)[number];

const RFC3339_STAMP = z.string().min(1);

/** §4.2 down/write 信封（write_cmd / read_cmd 同 topic，msg_type 区分）。 */
export const ControlWriteCommandSchema = z.object({
  msg_type: z.enum(['write_cmd', 'read_cmd']),
  ver: z.literal(1),
  cmd_id: z.uuid(),
  point_ref: z.string().min(1),
  value: z.number().optional(),
  unit: z.string().min(1).optional(),
  issued_at: RFC3339_STAMP,
  expires_in_s: z.number().int().positive(),
});
export type ControlWriteCommand = z.infer<typeof ControlWriteCommandSchema>;

/** §4.3 up/event write_ack。 */
export const ControlWriteAckSchema = z.object({
  msg_type: z.literal('write_ack'),
  ver: z.literal(1),
  cmd_id: z.uuid(),
  gw: z.string().min(1),
  result: z.enum(['accepted', 'rejected']),
  code: z.enum(CONTROL_GW_REJECT_CODES).nullable(),
  at: RFC3339_STAMP,
});
export type ControlWriteAck = z.infer<typeof ControlWriteAckSchema>;

/** §4.3 up/event read_result（quality ≠ good 按「读失败」处理，§5.2）。 */
export const ControlReadResultSchema = z.object({
  msg_type: z.literal('read_result'),
  ver: z.literal(1),
  cmd_id: z.uuid(),
  gw: z.string().min(1),
  value: z.number().nullable(),
  unit: z.string().min(1).nullable(),
  quality: z.enum(['good', 'bad', 'uncertain']),
  ts: RFC3339_STAMP.nullable(),
  at: RFC3339_STAMP,
});
export type ControlReadResult = z.infer<typeof ControlReadResultSchema>;

/** up/event 载荷联合（payload.gw 必须与 topic clientid 解析一致，§4.3 纪律）。 */
export const ControlUpEventSchema = z.discriminatedUnion('msg_type', [
  ControlWriteAckSchema,
  ControlReadResultSchema,
]);
export type ControlUpEvent = z.infer<typeof ControlUpEventSchema>;

/** 下行 topic（ingest.md §2 既有 topic，零新增下行空间）。 */
export function controlDownWriteTopic(gatewayClientId: string): string {
  return `thermio/gw/${gatewayClientId}/down/write`;
}

/** svc-control 共享订阅 filter（§4.1〔R2〕；$share/control 前缀多副本水平分摊）。 */
export const CONTROL_UP_EVENT_SUBSCRIBE_FILTER = '$share/control/thermio/gw/+/up/event';

// ---------------------------------------------------------------------------
// §10 Kafka thermio.control.executed 消息体（flows.md §7-4 收口）
// ---------------------------------------------------------------------------

/** §10 outcome：对齐 control_audit.result 四值 + 闸门拒绝细分。 */
export const CONTROL_EXECUTED_OUTCOMES = [
  'executed',
  'verify_failed',
  'reverted',
  'rejected_by_gate',
] as const;
export type ControlExecutedOutcome = (typeof CONTROL_EXECUTED_OUTCOMES)[number];

/** 回读时间线行（execution_result.verify.readings 同形）。 */
export const ControlVerifyReadingSchema = z.object({
  at: z.string().nullable(),
  value: z.number().nullable(),
  match: z.boolean().nullable(),
});
export type ControlVerifyReading = z.infer<typeof ControlVerifyReadingSchema>;

export const ControlExecutedEventSchema = z.object({
  proposal_id: z.uuid(),
  tenant_id: z.uuid(),
  trace_id: z.string().min(1),
  point_id: z.number().int(),
  equipment_id: z.uuid(),
  system_id: z.uuid().nullable(),
  algo: z.string().min(1),
  algo_version: z.string().min(1),
  outcome: z.enum(CONTROL_EXECUTED_OUTCOMES),
  reason_code: z.string().nullable(),
  value_before: z.number().nullable(),
  value_commanded: z.number().nullable(),
  value_effective: z.number().nullable(),
  clamped: z.boolean(),
  decided_by: z.uuid().nullable(),
  actor_type: z.enum(['algo', 'human', 'system']),
  verify: z.object({
    readings: z.array(ControlVerifyReadingSchema),
    retries_write: z.number().int(),
  }),
  at: RFC3339_STAMP,
});
export type ControlExecutedEvent = z.infer<typeof ControlExecutedEventSchema>;

// ---------------------------------------------------------------------------
// M8 API 形状（overview §4 M8 / M8-safety-ui.md §2.2/§7.2/§8）
// ---------------------------------------------------------------------------

/** §2.2 可控点清单行（列表/编辑/模式三页共用形状）。 */
export const ControlPointItemSchema = z.object({
  point_id: z.number().int(),
  raw_name: z.string(),
  display_name: z.string().nullable(),
  quantity_type: z.string().nullable(),
  unit_std: z.string().nullable(),
  equipment: z
    .object({
      id: z.uuid(),
      name: z.string(),
      equipment_type: z.string(),
    })
    .nullable(),
  system: z
    .object({
      id: z.uuid(),
      name: z.string(),
      system_type: z.string(),
    })
    .nullable(),
  building_id: z.uuid(),
  gate: z.object({
    is_controllable: z.boolean(),
    clamp_min: z.number().nullable(),
    clamp_max: z.number().nullable(),
    write_rate_limit_per_hour: z.number().int().nullable(),
  }),
  control_mode: z.enum(['advisory', 'supervised', 'auto']),
  point_status: z.enum(['active', 'disabled']),
  direction: z.enum(['read', 'write', 'readwrite']),
  system_fuse: ControlFuseStatusSchema,
});
export type ControlPointItem = z.infer<typeof ControlPointItemSchema>;

export const ControlPointsListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  building_id: z.uuid().optional(),
  control_mode: z.enum(['advisory', 'supervised', 'auto']).optional(),
  is_controllable: z.coerce.boolean().optional(),
  system_id: z.uuid().optional(),
  equipment_id: z.uuid().optional(),
  keyword: z.string().max(100).optional(),
});
export type ControlPointsListQuery = z.infer<typeof ControlPointsListQuerySchema>;

export const ControlPointsListResponseSchema = z.object({
  items: z.array(ControlPointItemSchema),
  next_cursor: z.string().nullable(),
});
export type ControlPointsListResponse = z.infer<typeof ControlPointsListResponseSchema>;

/** §4.1 闸门参数编辑请求（仅变更字段进请求体；reason 必填）。 */
export const GatePatchRequestSchema = z.object({
  is_controllable: z.boolean().optional(),
  clamp_min: z.number().nullable().optional(),
  clamp_max: z.number().nullable().optional(),
  // F2（修单）：值域（正整数或 null）由服务端统一判 point.gate_rate_invalid
  // （M8-safety-ui §4.3：0/负/非整数 → 字段级红字域码，不走 DTO 通用码）；
  // schema 层只收窄类型形状
  write_rate_limit_per_hour: z.number().nullable().optional(),
  // reason 必填由服务端域码 point.gate_reason_required 兜底（M8 §1.2：
  // 空值提交 → 字段级错误；schema 层只限长度）
  reason: z.string().trim().max(2000),
});
export type GatePatchRequest = z.infer<typeof GatePatchRequestSchema>;

export const GatePatchResponseSchema = z.object({
  point: ControlPointItemSchema,
  config_audit_ids: z.array(z.number().int()),
});
export type GatePatchResponse = z.infer<typeof GatePatchResponseSchema>;

/** §5 控制模式切换请求（target_mode + reason 必填）。 */
export const ControlModeChangeRequestSchema = z.object({
  target_mode: z.enum(['advisory', 'supervised', 'auto']),
  reason: z.string().trim().max(2000),
});
export type ControlModeChangeRequest = z.infer<typeof ControlModeChangeRequestSchema>;

export const ControlModeChangeResponseSchema = z.object({
  point: ControlPointItemSchema,
  config_audit_id: z.number().int(),
});
export type ControlModeChangeResponse = z.infer<typeof ControlModeChangeResponseSchema>;

/** §6 变更审计行（ddl §4 config_audit）。 */
export const ConfigAuditItemSchema = z.object({
  id: z.number().int(),
  point_id: z.number().int(),
  point_raw_name: z.string(),
  point_display_name: z.string().nullable(),
  field: z.enum([
    'control_mode',
    'is_controllable',
    'clamp_min',
    'clamp_max',
    'write_rate_limit_per_hour',
  ]),
  old_value: z.unknown().nullable(),
  new_value: z.unknown().nullable(),
  actor_type: z.enum(['human', 'system']),
  actor_ref: z.string().nullable(),
  actor_name: z.string().nullable(),
  reason: z.string().nullable(),
  at: z.string(),
});
export type ConfigAuditItem = z.infer<typeof ConfigAuditItemSchema>;

export const ConfigAuditListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  point_id: z.coerce.number().int().optional(),
  field: z
    .enum([
      'control_mode',
      'is_controllable',
      'clamp_min',
      'clamp_max',
      'write_rate_limit_per_hour',
    ])
    .optional(),
  actor_type: z.enum(['human', 'system']).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
export type ConfigAuditListQuery = z.infer<typeof ConfigAuditListQuerySchema>;

export const ConfigAuditListResponseSchema = z.object({
  items: z.array(ConfigAuditItemSchema),
  next_cursor: z.string().nullable(),
});
export type ConfigAuditListResponse = z.infer<typeof ConfigAuditListResponseSchema>;

/** §7.2 熔断状态（fuse-status 响应）。 */
export const FuseEventItemSchema = z.object({
  id: z.number().int(),
  event_type: z.enum(['tripped', 'released']),
  actor_type: z.enum(['system', 'human']),
  actor_ref: z.string().nullable(),
  reason: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()).nullable(),
  at: z.string(),
});
export type FuseEventItem = z.infer<typeof FuseEventItemSchema>;

export const FuseStatusResponseSchema = z.object({
  system: z.object({
    id: z.uuid(),
    name: z.string(),
    system_type: z.string(),
  }),
  status: ControlFuseStatusSchema,
  triggered_at: z.string().nullable(),
  trigger_detail: z.record(z.string(), z.unknown()).nullable(),
  released_at: z.string().nullable(),
  recent_events: z.array(FuseEventItemSchema),
});
export type FuseStatusResponse = z.infer<typeof FuseStatusResponseSchema>;

export const FuseEventsResponseSchema = z.object({
  items: z.array(FuseEventItemSchema),
  next_cursor: z.string().nullable(),
});
export type FuseEventsResponse = z.infer<typeof FuseEventsResponseSchema>;

// ---------------------------------------------------------------------------
// §6.2 租约心跳（platform.md §11〔R3〕内部端点）
// ---------------------------------------------------------------------------

export const LeaseHeartbeatRequestSchema = z.object({
  holder: z.string().min(1).max(200),
  point_ids: z.array(z.coerce.number().int()).min(1).max(500),
});
export type LeaseHeartbeatRequest = z.infer<typeof LeaseHeartbeatRequestSchema>;

/** 逐点续租结果三态（§6.2）。 */
export const LEASE_HEARTBEAT_OUTCOMES = ['renewed', 'not_found', 'stale'] as const;
export type LeaseHeartbeatOutcome = (typeof LEASE_HEARTBEAT_OUTCOMES)[number];

export const LeaseHeartbeatResponseSchema = z.object({
  results: z.array(
    z.object({
      point_id: z.number().int(),
      outcome: z.enum(LEASE_HEARTBEAT_OUTCOMES),
      expires_at: z.string().nullable(),
    }),
  ),
});
export type LeaseHeartbeatResponse = z.infer<typeof LeaseHeartbeatResponseSchema>;
