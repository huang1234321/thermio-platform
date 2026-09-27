/**
 * M8 控制安全共享件（M8-safety-ui.md §1/§2.2，IMPL-18 / DAT-164）：
 * - 模式徽标词表（baseline §3.2：建议(蓝)/监督(琥珀)/自动(绿)）；
 * - 行实体的展示辅助（值域/频率空态、熔断降级徽标）；
 * - 写动作公共面（Idempotency-Key + reason 必填由各对话框承担）。
 */
import { Tag, Typography } from 'antd';
import type { ControlMode, ControlPointItem } from '@thermio/shared-types';
import { apiFetch } from '../../app/api-client.js';
import {
  ControlModeChangeResponseSchema,
  GatePatchResponseSchema,
  type ControlModeChangeResponse,
  type GatePatchResponse,
} from '@thermio/shared-types';
import { newIdempotencyKey } from '../proposal/proposal-actions.js';

/** 模式徽标（baseline §3.2 词表；§2.2 control_mode）。 */
export function ControlModeTag({ mode }: { mode: ControlMode }): React.ReactNode {
  const preset: Record<ControlMode, { color: string; label: string }> = {
    advisory: { color: 'blue', label: '建议' },
    supervised: { color: 'gold', label: '监督' },
    auto: { color: 'green', label: '自动' },
  };
  const { color, label } = preset[mode];
  return <Tag color={color}>{label}</Tag>;
}

/** 熔断降级徽标（§3.2：system_fuse=open 追加红「降级（熔断）」+ tooltip 前进封锁）。 */
export function FuseTag({ status }: { status: 'closed' | 'open' }): React.ReactNode {
  if (status === 'closed') return null;
  return <Tag color="red">降级（熔断）</Tag>;
}

/** 值域展示（§3.2 列定义：空显「—」+ 数据不完整态黄点提示归清单页）。 */
export function clampText(point: ControlPointItem): string {
  const { clamp_min: min, clamp_max: max } = point.gate;
  if (min === null && max === null) return '—';
  if (min === null) return `≤ ${String(max)}`;
  if (max === null) return `≥ ${String(min)}`;
  return `${String(min)} – ${String(max)}`;
}

/** 频率展示（§10-U4：空显「默认 6 次/h」灰）。 */
export function rateText(point: ControlPointItem): React.ReactNode {
  const rate = point.gate.write_rate_limit_per_hour;
  return rate === null ? (
    <Typography.Text type="secondary">默认 6 次/h</Typography.Text>
  ) : (
    `${String(rate)} 次/h`
  );
}

/** PATCH /points/{id}/gate（§4：仅变更字段 + reason 必填 + Idempotency-Key）。 */
export async function patchGate(
  pointId: number,
  body: Record<string, unknown> & { reason: string },
): Promise<GatePatchResponse> {
  return apiFetch(`/points/${String(pointId)}/gate`, GatePatchResponseSchema, {
    method: 'PATCH',
    headers: { 'idempotency-key': newIdempotencyKey() },
    body,
  });
}

/** POST /points/{id}/control-mode（§5：target_mode + reason 必填）。 */
export async function changeControlMode(
  pointId: number,
  targetMode: ControlMode,
  reason: string,
): Promise<ControlModeChangeResponse> {
  return apiFetch(`/points/${String(pointId)}/control-mode`, ControlModeChangeResponseSchema, {
    method: 'POST',
    headers: { 'idempotency-key': newIdempotencyKey() },
    body: { target_mode: targetMode, reason },
  });
}
