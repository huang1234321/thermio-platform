/**
 * 处置弹窗动作名用例（ui/baseline §4.2 显式动作名，DAT-157 修单簇 2：
 * 抑制/关闭弹窗默认 OK/Cancel 英文按钮扣分——一处组件修两页 08/10）。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AlarmEventView } from '@thermio/shared-types';
import { CloseAlarmModal, SuppressModal } from './alarm-actions.js';

// jsdom 无 matchMedia，Modal 内部响应式观察器需要（同 theme.test.tsx 桩法）
vi.stubGlobal(
  'matchMedia',
  vi.fn().mockReturnValue({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }),
);

afterEach(cleanup);

const alarm = {
  id: 7,
  severity: 'critical',
  status: 'open',
  category: 'gateway',
  message: '网关离线',
  source_type: 'gateway',
  source_id: 'g1',
  source_name: 'G1',
  is_root: false,
  child_count_active: null,
  child_count_suppressed: null,
  suppression: null,
  opened_at: '2026-09-29T00:00:00Z',
  acked_at: null,
  acked_by: null,
  closed_at: null,
  closed_by: null,
  close_reason: null,
} as unknown as AlarmEventView;

describe('处置弹窗显式动作名（§4.2）', () => {
  it('SuppressModal_usesExplicitActionNames', () => {
    render(<SuppressModal alarm={alarm} onClose={() => {}} onDone={() => {}} />);
    expect(screen.getByRole('button', { name: '确认抑制' })).not.toBeNull();
    // AntD 对两字按钮文案自动加空格（「取 消」）
    expect(screen.getByRole('button', { name: /取\s*消/ })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'OK' })).toBeNull();
  });

  it('CloseAlarmModal_usesExplicitActionNames', () => {
    render(<CloseAlarmModal alarm={alarm} onClose={() => {}} onDone={() => {}} />);
    expect(screen.getByRole('button', { name: '确认关闭' })).not.toBeNull();
    expect(screen.getByRole('button', { name: /取\s*消/ })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'OK' })).toBeNull();
  });
});
