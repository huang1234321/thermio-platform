/**
 * 算法提案信封（ADR-008「proposal 数据结构」原文落地）。
 *
 * rationale + expected_saving_kw 必填：建议必须可解释、带预期收益，否则运维不采纳。
 * action.op / action.unit 保持 string（不自造闭合——枚举扩充走发版流程，同 enums.ts 治理）。
 */
import { z } from 'zod';

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
