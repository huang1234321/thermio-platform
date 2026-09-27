/**
 * 建议域共享件（M5-proposal.md §6，IMPL-17 / DAT-163）：
 * 状态徽标（六值词表沿 baseline §3.2 纪律）、actor 徽标（§2.2）、格式化助手。
 */
import { Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import type {
  Capability,
  ControlAuditRow,
  ProposalCard,
  ProposalStatus,
} from '@thermio/shared-types';
import { useCapabilities } from '../../app/auth-context.js';

/** 六值状态徽标（§6.1：pending 蓝/approved 琥珀/rejected·expired 灰/executed 绿/failed 红）。 */
const STATUS_META: Record<ProposalStatus, { label: string; color: string }> = {
  pending: { label: '待确认', color: 'blue' },
  approved: { label: '执行中', color: 'gold' },
  rejected: { label: '已驳回', color: 'default' },
  expired: { label: '已过期', color: 'default' },
  executed: { label: '已执行', color: 'green' },
  failed: { label: '失败', color: 'red' },
};

export function ProposalStatusTag({ status }: { status: ProposalStatus }): React.ReactNode {
  const meta = STATUS_META[status];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

/** actor 徽标（§6.3：algo 蓝 / human 琥珀 / system 红）。 */
const ACTOR_META: Record<ControlAuditRow['actor_type'], { label: string; color: string }> = {
  algo: { label: '算法', color: 'blue' },
  human: { label: '人工', color: 'gold' },
  system: { label: '系统', color: 'red' },
};

export function ActorTag({ actor }: { actor: ControlAuditRow['actor_type'] }): React.ReactNode {
  const meta = ACTOR_META[actor];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

const RESULT_META: Record<ControlAuditRow['result'], { label: string; color: string }> = {
  ok: { label: '成功', color: 'green' },
  verify_failed: { label: '验证失败', color: 'red' },
  reverted: { label: '已回滚', color: 'gold' },
  rejected: { label: '已拒绝', color: 'default' },
};

export function AuditResultTag({ result }: { result: ControlAuditRow['result'] }): React.ReactNode {
  const meta = RESULT_META[result];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

/** 闸门 outcome 图标词表（§6.3：pass ✓绿 / clamped ⤵琥珀 / denied ✗红 / …）。 */
export const GATE_OUTCOME_META: Record<
  string,
  { label: string; color: 'green' | 'gold' | 'red' | 'default' }
> = {
  pass: { label: '通过', color: 'green' },
  clamped: { label: '被钳制', color: 'gold' },
  queued: { label: '排队中', color: 'default' },
  denied: { label: '拒绝', color: 'red' },
  overflow: { label: '队列溢出', color: 'red' },
  timeout: { label: '排队超时', color: 'red' },
  superseded: { label: '已被取代', color: 'red' },
  unevaluated: { label: '未求值', color: 'default' },
};

const GATE_TITLES = ['受控白名单', '值域 clamp', '频率限制', '冲突检测', '全局熔断'] as const;

export function gateTitle(gate: number): string {
  return GATE_TITLES[gate - 1] ?? `闸门 ${String(gate)}`;
}

/** 值链文案：6.0 → 7.5 degC（§6.2-Z1/Z4）。 */
export function valueChainText(
  previous: number | null,
  value: number | null,
  unit: string | null | undefined,
): string {
  const fmt = (value: number | null): string => (value === null ? '—' : String(value));
  return `${fmt(previous)} → ${fmt(value)}${unit ?? ''}`;
}

/** 失效倒计时（§6.2-Z6：<10min 琥珀、已过红；仅展示不推断状态）。 */
export function ExpiresCountdown({ expiresAt }: { expiresAt: string | null }): React.ReactNode {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 30_000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  if (expiresAt === null) return <Typography.Text type="secondary">不失效</Typography.Text>;
  const remainMs = Date.parse(expiresAt) - now;
  if (remainMs <= 0) return <Typography.Text type="danger">已过期</Typography.Text>;
  const minutes = Math.floor(remainMs / 60_000);
  const text =
    minutes >= 60
      ? `还有 ${String(Math.floor(minutes / 60))} 小时失效`
      : `还有 ${String(minutes)} 分钟失效`;
  return (
    <Typography.Text type={remainMs < 10 * 60_000 ? 'warning' : 'secondary'}>
      {text}
    </Typography.Text>
  );
}

/** 置信度 0–1 → 百分比（§6.2-Z4：缺失显示 —，不显示 0%）。 */
export function confidenceText(confidence: number | null): string {
  return confidence === null ? '—' : `${String(Math.round(confidence * 100))}%`;
}

export function expectedSavingText(saving: number | null): string {
  return saving === null ? '—' : `+${String(saving)} kW`;
}

/** 行内算法标识：algo@version（§6.2-Z7 凭据）。 */
export function algoText(card: ProposalCard): string {
  return `${card.algo}@${card.algo_version}`;
}

/** 能力显隐（§1.5：decide=proposals.decide.write）。 */
export function useHasCapability(capability: Capability): boolean {
  const capabilities = useCapabilities();
  return capabilities.includes(capability);
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}
