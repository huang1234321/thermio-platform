/**
 * 执行详情响应契约（shared-types ExecutionDetailView + 内联审计链，M5 §3.6）。
 *
 * api 返回 = ExecutionDetailView 字段 + audit: ControlAuditRow[]（执行详情一屏闭环，
 * 免二次请求）——shared-types 单形状不含内联审计（行形状被 /control-audit 复用），
 * 组合形状在消费侧扩展（字段只增不删，API-CT-02）；解析复用 shared-types 导出的
 * 两个 schema（本包不直接依赖 zod）。
 */
import {
  ControlAuditRowSchema,
  ExecutionDetailViewSchema,
  type ControlAuditRow,
  type ExecutionDetailView,
} from '@thermio/shared-types';

export interface ExecutionView extends ExecutionDetailView {
  readonly audit: readonly ControlAuditRow[];
}

export function parseExecutionView(input: unknown): ExecutionView | null {
  const base = ExecutionDetailViewSchema.safeParse(input);
  if (!base.success) return null;
  const auditRaw = (input as { audit?: unknown }).audit;
  if (!Array.isArray(auditRaw)) return null;
  const audit: ControlAuditRow[] = [];
  for (const row of auditRaw) {
    const parsed = ControlAuditRowSchema.safeParse(row);
    if (!parsed.success) return null;
    audit.push(parsed.data);
  }
  return { ...base.data, audit };
}
