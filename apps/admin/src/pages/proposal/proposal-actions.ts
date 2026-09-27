/**
 * 建议决策动作（M5-proposal.md §3.4/§3.5，IMPL-17 / DAT-163）。
 *
 * - approve/reject 均带 Idempotency-Key（API-DSN-01：crypto.randomUUID 每次打开
 *   弹窗生成一次，提交失败重试复用同一键——幂等重放语义）；
 * - approve 202（异步走仲裁，前端进轮询）；reject 200 终态；
 * - state_invalid → 「建议已被处理或已过期」（baseline §4.4 映射），由调用方
 *   按 ApiError.reason_code 呈现。
 */
import {
  ProposalApproveResponseSchema,
  ProposalRejectResponseSchema,
  type ProposalApproveResponse,
  type ProposalRejectResponse,
} from '@thermio/shared-types';
import { apiFetch } from '../../app/api-client.js';

/** 浏览器原生 CSPRNG uuid（安全上下文；退化路径手工拼装保持唯一性）。 */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ik-${String(Date.now())}-${String(Math.random()).slice(2, 12)}`;
}

/** 确认执行建议（202；comment 可选——R1 过渡期仅入日志，comment_persisted=false）。 */
export async function approveProposal(
  proposalId: string,
  idempotencyKey: string,
  comment?: string,
): Promise<ProposalApproveResponse> {
  return apiFetch(`/proposals/${proposalId}/approve`, ProposalApproveResponseSchema, {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
    body: comment !== undefined && comment.length > 0 ? { comment } : {},
  });
}

/** 驳回建议（200；reason 必填 1..2000——R1 过渡期入日志 + 回显）。 */
export async function rejectProposal(
  proposalId: string,
  reason: string,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<ProposalRejectResponse> {
  return apiFetch(`/proposals/${proposalId}/reject`, ProposalRejectResponseSchema, {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
    body: { reason },
  });
}
