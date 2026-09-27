/**
 * 告警域共享件（IMPL-13，M4-alarm.md §7 / ui/baseline §2 severity 色板）：
 * severity 色标签、状态标签、能力 hook 复用资产域 errorText/useHasCapability。
 */
import { Tag } from 'antd';
import type { AlarmEventStatus, AlarmSeverity, Capability } from '@thermio/shared-types';
import { useCapabilities } from '../../app/auth-context.js';

/** baseline §2 色板 token → antd 色（--ti-sev-* 语义映射，v1 就近取色）。 */
const SEVERITY_COLOR: Record<AlarmSeverity, string> = {
  critical: 'red',
  major: 'volcano',
  minor: 'orange',
  warning: 'gold',
  info: 'blue',
};

const SEVERITY_LABEL: Record<AlarmSeverity, string> = {
  critical: '紧急',
  major: '严重',
  minor: '较重',
  warning: '警告',
  info: '提示',
};

export function SeverityTag({ severity }: { severity: AlarmSeverity }): React.ReactNode {
  return <Tag color={SEVERITY_COLOR[severity]}>{SEVERITY_LABEL[severity]}</Tag>;
}

const STATUS_LABEL: Record<AlarmEventStatus, string> = {
  open: '未确认',
  acked: '已确认',
  closed: '已关闭',
  suppressed: '已抑制',
};

const STATUS_COLOR: Record<AlarmEventStatus, string> = {
  open: 'error',
  acked: 'warning',
  closed: 'default',
  suppressed: 'processing',
};

export function StatusTag({ status }: { status: AlarmEventStatus }): React.ReactNode {
  return <Tag color={STATUS_COLOR[status]}>{STATUS_LABEL[status]}</Tag>;
}

/** 能力显隐（M4 §1.5：ack/close=alarms.ack，suppress=alarms.suppress）。 */
export function useHasCapability(capability: Capability): boolean {
  const capabilities = useCapabilities();
  return capabilities.includes(capability);
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}
