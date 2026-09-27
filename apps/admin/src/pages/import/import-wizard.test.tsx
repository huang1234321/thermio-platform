/**
 * 向导步骤 5 自检按钮回归测试（QA 阻塞 #2 钉）：
 * loading 曾绑 `job.status === 'applied'`——applied 是**休息态**（等待用户发起
 * 自检），绑上后按钮永久 loading 死锁，applied→checked 无法从 UI 发起、报告
 * 视图不可达。修复后 loading 绑真实 in-flight 标志（selfCheckPending），完成
 * 信号 = 轮询观察到 checked_at 前进（checked→checked 重跑同判）。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { ImportJob, ImportRow, SelfCheckReport } from '@thermio/shared-types';

const apiFetchMock = vi.hoisted(() => vi.fn());

// jsdom 无 matchMedia（antd responsiveObserver 需要）——标准桩
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
});
vi.mock('../../app/api-client.js', () => ({
  apiFetch: apiFetchMock,
  apiUpload: vi.fn(),
  ApiError: class extends Error {},
}));
vi.mock('../../app/auth-context.js', () => ({
  useAuth: () => ({ state: { phase: 'authenticated' } }),
  useCapabilities: () => ['imports.read', 'imports.write', 'assets.read'],
}));

import { ImportWizardPage } from './import-wizard.js';

/** 可变作业剧本（轮询 GET /imports/:id 的返回源）。 */
let jobState: ImportJob;

function appliedJob(checkedAt: string | null): ImportJob {
  return {
    id: 'j1',
    building_id: 'b1',
    gateway_id: 'g1',
    file_name: 'pt.xlsx',
    row_count: 4,
    status: checkedAt === null ? 'applied' : 'checked',
    mapped_count: 4,
    issue_count: 0,
    hit_rate: checkedAt === null ? null : 0.5,
    failure: null,
    created_by: 'u1',
    created_at: '2026-09-27T05:00:00Z',
    updated_at: '2026-09-27T05:10:00Z',
    applied_at: '2026-09-27T05:09:00Z',
    checked_at: checkedAt,
  };
}

const rows: ImportRow[] = Array.from({ length: 4 }, (_, i) => ({
  id: i + 1,
  job_id: 'j1',
  row_no: i + 1,
  raw_name: `P${String(i + 1)}`,
  raw_description: null,
  unit_raw: null,
  is_write: false,
  equipment_id: null,
  quantity_type: 'power',
  unit_std: 'kW',
  map_status: 'manual' as const,
  issues: [],
  suggestions: [],
  mapped_at: null,
  mapped_by: null,
  created_at: '2026-09-27T05:00:00Z',
  updated_at: '2026-09-27T05:00:00Z',
}));

const report: SelfCheckReport = {
  job_id: 'j1',
  checked_at: '2026-09-27T05:20:00Z',
  hit_rate: 0.5,
  hit_count: 2,
  total_count: 4,
  window: { lookback_s: 900, as_of: '2026-09-27T05:21:00Z' },
  missed: [
    { row_no: 3, raw_name: 'P3', point_id: 103 },
    { row_no: 4, raw_name: 'P4', point_id: 104 },
  ],
};

/** apiFetch 剧本：按 path 分派到可变 jobState / 静态固件。 */
function scriptApiFetch(path: string): unknown {
  if (path.startsWith('/imports/j1?') || path === '/imports/j1') return jobState;
  if (path.startsWith('/imports/j1/rows')) return { items: rows, next_cursor: null };
  if (path === '/imports/j1/self-check') return report;
  if (path === '/buildings?limit=100') return { items: [], next_cursor: null };
  if (path === '/gateways?limit=100') return { items: [], next_cursor: null };
  if (path.startsWith('/buildings/b1/systems')) return { items: [], next_cursor: null };
  return { items: [], next_cursor: null };
}

/** self-check POST 调用计数（mock 参数面显式收窄，unsafe-member-access 边界）。 */
function countSelfCheckPosts(calls: ReadonlyArray<readonly unknown[]>): number {
  return calls.filter((call) => {
    const [path, , options] = call as [string, unknown, { method?: string } | undefined];
    return path === '/imports/j1/self-check' && options?.method === 'POST';
  }).length;
}

async function renderWizard(): Promise<void> {
  render(
    <MemoryRouter>
      <ImportWizardPage jobId="j1" />
    </MemoryRouter>,
  );
  // 续入装载（详情 + 行 + 装备候选）完成、步骤 5 呈现
  await waitFor(() => {
    expect(screen.getByText('采集自检（全点位读一遍 → 命中率报告）')).toBeTruthy();
  });
}

describe('自检按钮 in-flight 标志（QA 阻塞 #2 回归）', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string) => Promise.resolve(scriptApiFetch(path)));
  });

  afterEach(() => {
    cleanup();
  });

  /** 真实定时器等一轮轮询（1.5s 间隔 + 余量；fake timers 会断 antd 事件链，不用）。 */
  async function waitForNextPoll(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 1_700);
      });
    });
  }

  it('shouldKeepButtonAlive_atAppliedRestingState（修复前：loading 恒 true 死锁）', async () => {
    jobState = appliedJob(null);
    await renderWizard();
    const button = screen.getByRole('button', { name: /发起采集自检/ });
    // 修复本体：applied 休息态按钮可点、无 loading 死锁
    expect(button.getAttribute('class')).not.toContain('ant-btn-loading');
  });

  it('shouldCompleteCycle_dispatchToChecked_viaRealInFlightFlag', async () => {
    jobState = appliedJob(null);
    await renderWizard();
    const button = screen.getByRole('button', { name: /发起采集自检/ });

    // 派发 → 真实 in-flight（loading 由 pending 驱动，非作业状态）
    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve(); // flush async handler
    });
    expect(countSelfCheckPosts(apiFetchMock.mock.calls)).toBe(1);
    // 服务端窗口内（状态未跳变）：pending 保持
    expect(
      screen.getByRole('button', { name: /发起采集自检|重跑自检/ }).getAttribute('class'),
    ).toContain('ant-btn-loading');

    // 完成信号：轮询观察到 checked ∧ checked_at 前进（首轮 null → T1）
    jobState = appliedJob('2026-09-27T05:20:00Z');
    await waitForNextPoll();
    await waitFor(() => {
      const after = screen.getByRole('button', { name: /重跑自检（刷新命中率）/ });
      expect(after.getAttribute('class')).not.toContain('ant-btn-loading');
    });
    // 报告视图可达（阻塞 #2 的另一半）：报告卡 + missed 清单渲染
    expect(screen.getByText(/自检报告（/)).toBeTruthy();
    // 展示口径 = Excel 行号（row_no + 1，§2.2 注记）：row_no 4 → 第 5 行
    expect(screen.getByText(/未命中：第 5 行 P4/)).toBeTruthy();
  });

  it('shouldSupportRerun_checkedToChecked_byCheckedAtAdvance', async () => {
    jobState = appliedJob('2026-09-27T05:20:00Z');
    await renderWizard();
    // 续入即 checked：报告自动可达
    await waitFor(() => {
      expect(screen.getByText(/自检报告（/)).toBeTruthy();
    });

    const rerun = screen.getByRole('button', { name: /重跑自检（刷新命中率）/ });
    await act(async () => {
      fireEvent.click(rerun);
      await Promise.resolve();
    });
    expect(countSelfCheckPosts(apiFetchMock.mock.calls)).toBe(1);
    // 重跑进行中（checked_at 未前进 → 不提前解锁）
    expect(
      screen.getByRole('button', { name: /重跑自检（刷新命中率）/ }).getAttribute('class'),
    ).toContain('ant-btn-loading');

    // checked_at 前进（T1 → T2）→ 解锁 + 报告按新 checked_at 重拉
    jobState = appliedJob('2026-09-27T05:30:00Z');
    await waitForNextPoll();
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /重跑自检（刷新命中率）/ }).getAttribute('class'),
      ).not.toContain('ant-btn-loading');
    });
    expect(screen.getByText(/自检报告（/)).toBeTruthy();
  });
});
