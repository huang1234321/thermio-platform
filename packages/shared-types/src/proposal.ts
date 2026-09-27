/**
 * 算法提案信封（ADR-008「proposal 数据结构」原文落地）。
 *
 * rationale + expected_saving_kw 必填：建议必须可解释、带预期收益，否则运维不采纳。
 * action.op / action.unit 保持 string（不自造闭合——枚举扩充走发版流程，同 enums.ts 治理）。
 */
import { z } from 'zod';
import { PROPOSAL_STATUSES, ProposalStatusSchema, type ProposalStatus } from './enums.js';

/** 提案动作：写什么值到哪个点位（DATA-MODEL §3.5 action jsonb；可写点限数值量，评审 P2-3）。 */
export const ProposalActionSchema = z.object({
  op: z.string().min(1),
  value: z.number(),
  unit: z.string().min(1),
});
export type ProposalAction = z.infer<typeof ProposalActionSchema>;

/** 提案目标：设备 + 点位。 */
export const ProposalTargetSchema = z.object({
  equipment_id: z.string().min(1),
  point: z.string().min(1),
});
export type ProposalTarget = z.infer<typeof ProposalTargetSchema>;

/** 提案信封（wire 格式，ADR-008 示例逐字段对应；evidence 为自由结构上下文）。 */
export const ProposalEnvelopeSchema = z.object({
  proposal_id: z.string().min(1),
  algo: z.string().min(1),
  algo_version: z.string().min(1),
  target: ProposalTargetSchema,
  action: ProposalActionSchema,
  previous_value: z.number(),
  rationale: z.string().min(1),
  expected_saving_kw: z.number(),
  confidence: z.number().min(0).max(1),
  evidence: z.record(z.string(), z.unknown()),
  expires_at: z.iso.datetime({ offset: true }),
});
export type ProposalEnvelope = z.infer<typeof ProposalEnvelopeSchema>;

// ---------------------------------------------------------------------------
// M5 读侧契约（modules/M5-proposal.md §1.4/§2/§3，IMPL-17 / DAT-163）。
// 单源纪律：本节形状即 api 与 admin 的共同契约面；改形状 = 发版动作。
// ---------------------------------------------------------------------------

/** 分页参数（游标分页组件：limit 1–200 默认 50，M5 §1.4）。 */
const LIMIT = z.coerce.number().int().min(1).max(200).default(50);
const CURSOR = z.string().min(1).max(512);
const RFC3339 = z.iso.datetime({ offset: true });

/** 列表行联查点位精简投影（M5 §3.1 ProposalCard.point）。 */
export const ProposalPointRefSchema = z.object({
  raw_name: z.string(),
  display_name: z.string().nullable(),
  unit_std: z.string().nullable(),
});
export type ProposalPointRef = z.infer<typeof ProposalPointRefSchema>;

/**
 * 建议卡片（列表行 = 详情精简；DDL 直传列见 M5 §2.1）。
 * reason_code：终态失败时的展示码（闸门行异步面码，M5 §1.2）；其余态 null。
 */
export const ProposalCardSchema = z.object({
  id: z.uuid(),
  status: ProposalStatusSchema,
  algo: z.string(),
  algo_version: z.string(),
  equipment_id: z.uuid(),
  point_id: z.number().int(),
  point: ProposalPointRefSchema,
  action: ProposalActionSchema,
  previous_value: z.number().nullable(),
  expected_saving_kw: z.number().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  expires_at: RFC3339.nullable(),
  decided_by: z.uuid().nullable(),
  decided_by_name: z.string().nullable(),
  decided_at: RFC3339.nullable(),
  executed_at: RFC3339.nullable(),
  created_at: RFC3339,
  reason_code: z.string().nullable(),
});
export type ProposalCard = z.infer<typeof ProposalCardSchema>;

export const ProposalListResponseSchema = z.object({
  items: z.array(ProposalCardSchema),
  next_cursor: z.string().nullable(),
});
export type ProposalListResponse = z.infer<typeof ProposalListResponseSchema>;

/**
 * GET /proposals 筛选白名单（M5 §3.1 表逐项；strict = 白名单外参数 422）。
 * status 为逗号分隔多值（Tabs「已决策」= approved,rejected,expired 一次拉取）。
 */
export const ProposalListQuerySchema = z
  .object({
    status: z
      .string()
      .refine(
        (value) =>
          value.split(',').every((part) => (PROPOSAL_STATUSES as readonly string[]).includes(part)),
        { message: 'status 取值必须是六值封闭集的逗号分隔列表' },
      )
      .optional(),
    building_id: z.uuid().optional(),
    equipment_id: z.uuid().optional(),
    point_id: z.coerce.number().int().positive().optional(),
    algo: z.string().min(1).optional(),
    algo_version: z.string().min(1).optional(),
    decided_by: z.uuid().optional(),
    from: RFC3339.optional(),
    to: RFC3339.optional(),
    limit: LIMIT,
    cursor: CURSOR.optional(),
  })
  .strict();
export type ProposalListQuery = z.infer<typeof ProposalListQuerySchema>;

/** GET /proposals/counts（M5 §3.2：Tabs 角标，六键全给 0 也给）。 */
export const ProposalCountsSchema = z.object(
  Object.fromEntries(PROPOSAL_STATUSES.map((status) => [status, z.number().int()])) as {
    [K in ProposalStatus]: z.ZodNumber;
  },
);
export type ProposalCounts = z.infer<typeof ProposalCountsSchema>;

/** 闸门预检快照四项（M5 §5；pass=false 不阻塞 approve——仲裁才是判决）。 */
export const ProposalPrecheckSchema = z.object({
  whitelist: z.object({
    pass: z.boolean(),
    is_controllable: z.boolean(),
    point_status: z.string(),
    direction: z.string(),
  }),
  clamp: z.object({
    pass: z.boolean(),
    value: z.number(),
    clamp_min: z.number().nullable(),
    clamp_max: z.number().nullable(),
    would_clamp: z.boolean(),
    effective_value: z.number(),
  }),
  rate: z.object({
    pass: z.boolean(),
    used: z.number().int(),
    limit: z.number().int(),
    window_s: z.number().int(),
  }),
  fuse: z.object({
    pass: z.boolean(),
    status: z.enum(['closed', 'open']),
  }),
  checked_at: RFC3339,
});
export type ProposalPrecheck = z.infer<typeof ProposalPrecheckSchema>;

/** 详情 = 卡片全字段 + rationale/evidence + precheck（仅 pending 非 null，M5 §3.3）。 */
export const ProposalDetailSchema = ProposalCardSchema.extend({
  rationale: z.string(),
  evidence: z.record(z.string(), z.unknown()).nullable(),
  precheck: ProposalPrecheckSchema.nullable(),
});
export type ProposalDetail = z.infer<typeof ProposalDetailSchema>;

/** POST /proposals/{id}/approve 请求体（comment 可选，M5 §3.4）。 */
export const ProposalApproveSchema = z
  .object({ comment: z.string().max(2000).optional() })
  .strict();
export type ProposalApprove = z.infer<typeof ProposalApproveSchema>;

/** 202 响应（R1 未落地：comment 仅入结构化日志，显式告知未持久化）。 */
export const ProposalApproveResponseSchema = z.object({
  id: z.uuid(),
  status: ProposalStatusSchema,
  decided_by: z.uuid(),
  decided_at: RFC3339,
  comment_persisted: z.boolean(),
});
export type ProposalApproveResponse = z.infer<typeof ProposalApproveResponseSchema>;

/** POST /proposals/{id}/reject 请求体（reason 必填 1..2000，M5 §3.5）。 */
export const ProposalRejectSchema = z.object({ reason: z.string().min(1).max(2000) }).strict();
export type ProposalReject = z.infer<typeof ProposalRejectSchema>;

/** 200 响应（R1 过渡态：reason 入结构化日志 + 回显，不持久化）。 */
export const ProposalRejectResponseSchema = z.object({
  id: z.uuid(),
  status: ProposalStatusSchema,
  decided_by: z.uuid(),
  decided_at: RFC3339,
  reason: z.string(),
});
export type ProposalRejectResponse = z.infer<typeof ProposalRejectResponseSchema>;

/** POST /internal/proposals 201 响应（M5 §3.8；字段只增不删）。 */
export const ProposalSubmitResponseSchema = z.object({
  proposal_id: z.uuid(),
  client_ref: z.string(),
  status: ProposalStatusSchema,
  expires_at: RFC3339.nullable(),
});
export type ProposalSubmitResponse = z.infer<typeof ProposalSubmitResponseSchema>;

// ---------------------------------------------------------------------------
// 执行详情读投影（M5 §2.3 ExecutionDetailView；宽松解析 + 兜底，不回写）
// ---------------------------------------------------------------------------

/** gates[].outcome 读侧词表（M5 §2.3-3；unevaluated = 前置闸门拒绝后短路）。 */
export const EXECUTION_GATE_OUTCOMES = [
  'pass',
  'clamped',
  'queued',
  'denied',
  'overflow',
  'timeout',
  'superseded',
  'unevaluated',
] as const;
export type ExecutionGateOutcome = (typeof EXECUTION_GATE_OUTCOMES)[number];
export const ExecutionGateOutcomeSchema = z.enum(EXECUTION_GATE_OUTCOMES);

export const ExecutionGateViewSchema = z.object({
  gate: z.number().int().min(1).max(5),
  name: z.string(),
  outcome: ExecutionGateOutcomeSchema,
  detail: z.record(z.string(), z.unknown()).nullable(),
});
export type ExecutionGateView = z.infer<typeof ExecutionGateViewSchema>;

export const ExecutionDetailViewSchema = z.object({
  proposal_id: z.uuid(),
  status: ProposalStatusSchema,
  phase: z.string().nullable(),
  gates: z.array(ExecutionGateViewSchema),
  value_chain: z.object({
    value_before: z.number().nullable(),
    value_commanded: z.number().nullable(),
    value_effective: z.number().nullable(),
    clamped: z.boolean(),
  }),
  verify: z.object({
    readings: z.array(
      z.object({
        at: z.string().nullable(),
        value: z.number().nullable(),
        quality: z.string().nullable(),
        match: z.boolean().nullable(),
      }),
    ),
    retries_write: z.number().int(),
  }),
  cmds: z.array(
    z.object({
      cmd_id: z.string().nullable(),
      kind: z.string(),
      at: z.string().nullable(),
      ack: z.string().nullable(),
    }),
  ),
  reason_code: z.string().nullable(),
  outcome: z.string().nullable(),
  executed_at: RFC3339.nullable(),
  audit_ref: z.object({ proposal_id: z.uuid(), count: z.number().int() }),
});
export type ExecutionDetailView = z.infer<typeof ExecutionDetailViewSchema>;

/** 审计行（DDL 直传 + 点位联查精简，M5 §3.7）。 */
export const ControlAuditRowSchema = z.object({
  id: z.number().int(),
  point_id: z.number().int(),
  proposal_id: z.uuid().nullable(),
  point: ProposalPointRefSchema,
  old_value: z.number().nullable(),
  new_value: z.number().nullable(),
  actor_type: z.enum(['algo', 'human', 'system']),
  actor_ref: z.string().nullable(),
  result: z.enum(['ok', 'verify_failed', 'reverted', 'rejected']),
  reason: z.string().nullable(),
  at: RFC3339,
});
export type ControlAuditRow = z.infer<typeof ControlAuditRowSchema>;

export const ControlAuditListResponseSchema = z.object({
  items: z.array(ControlAuditRowSchema),
  next_cursor: z.string().nullable(),
});
export type ControlAuditListResponse = z.infer<typeof ControlAuditListResponseSchema>;

/** GET /control-audit 筛选白名单（M5 §3.7）。 */
export const ControlAuditListQuerySchema = z
  .object({
    point_id: z.coerce.number().int().positive().optional(),
    proposal_id: z.uuid().optional(),
    actor_type: z.enum(['algo', 'human', 'system']).optional(),
    result: z.enum(['ok', 'verify_failed', 'reverted', 'rejected']).optional(),
    from: RFC3339.optional(),
    to: RFC3339.optional(),
    limit: LIMIT,
    cursor: CURSOR.optional(),
  })
  .strict();
export type ControlAuditListQuery = z.infer<typeof ControlAuditListQuerySchema>;
