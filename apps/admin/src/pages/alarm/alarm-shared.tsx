/**
 * 告警域共享件（IMPL-13，M4-alarm.md §7 / ui/baseline §2 severity 色板）：
 * severity 色标签、状态标签、能力 hook 复用资产域 errorText/useHasCapability。
 */
import { Tag } from 'antd';
import type { AlarmEventStatus, AlarmSeverity, Capability } from '@thermio/shared-types';
import { useCapabilities } from '../../app/auth-context.js';

/**
 * severity 五级 → --ti-sev-* token（DAT-157 修单：v1 的 antd 预设色名属硬编码，
 * FE-02 收口；major/minor token 双主题值见 styles/tokens.css）。M3 设备工况在用
 * 告警徽标同源消费（跨页一致性）。
 */
export const SEVERITY_COLOR: Record<AlarmSeverity, string> = {
  critical: 'var(--ti-sev-critical)',
  major: 'var(--ti-sev-major)',
  minor: 'var(--ti-sev-minor)',
  warning: 'var(--ti-sev-warning)',
  info: 'var(--ti-sev-info)',
};

export const SEVERITY_LABEL: Record<AlarmSeverity, string> = {
  critical: '紧急',
  major: '严重',
  minor: '较重',
  warning: '警告',
  info: '提示',
};

export function SeverityTag({ severity }: { severity: AlarmSeverity }): React.ReactNode {
  const color = SEVERITY_COLOR[severity];
  return (
    <Tag style={{ color, borderColor: color, background: 'transparent' }}>
      {SEVERITY_LABEL[severity]}
    </Tag>
  );
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
