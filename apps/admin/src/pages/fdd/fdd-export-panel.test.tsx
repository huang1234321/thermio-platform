/**
 * FDD 导出面板取数时机用例（DAT-250 O4 回归锚）：
 * 挂载期零请求（挂载即取 latest 属不必要请求，已收口）——列表只在「导出记录」
 * 抽屉打开时拉取（打开时/需要时取数）；202 后的 latest 刷新见 requestExport 路径。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App as AntdApp } from 'antd';
import { AuthProvider } from '../../app/auth-context.js';
import { FddExportPanel } from './fdd-export-panel.js';

const REFRESH_KEY = 'thermio.refresh_token';
const REPORT_ID = '018f3a1b-0000-7000-8000-000000000001';

const loginResponse = {
  access_token: 'access-export',
  refresh_token: 'refresh-export',
  token_type: 'Bearer' as const,
  expires_in: 900,
  must_change_password: false,
  user: { id: 'u1', email: 'ops@example.com', display_name: '运维' },
};

/** operator 能力集（fdd.export 在列，M11 §5.0）。 */
const meResponse = {
  user: { id: 'u1', email: 'ops@example.com', display_name: '运维' },
  role: 'operator',
  must_change_password: false,
  building_scopes: [],
  capabilities: ['fdd.view', 'fdd.export'],
  session: {
    id: 's1',
    created_at: '2026-10-16T00:00:00Z',
    expires_at: '2026-10-30T00:00:00Z',
  },
};

const exportJob = {
  id: '018f3a1b-0000-7000-8000-000000000002',
  resource_type: 'fdd_report',
  resource_id: REPORT_ID,
  format: 'pdf',
  status: 'succeeded',
  failure: null,
  file_bytes: 2048,
  created_at: '2026-10-15T02:00:00+00:00',
  started_at: '2026-10-15T02:00:01+00:00',
  finished_at: '2026-10-15T02:00:05+00:00',
  expires_at: '2026-11-14T02:00:05+00:00',
};

afterEach(cleanup);

// jsdom 无 matchMedia：antd Table/Drawer（responsiveObserver）需要——最小 stub
let matchMediaOriginal: PropertyDescriptor | undefined;
beforeAll(() => {
  matchMediaOriginal = Object.getOwnPropertyDescriptor(window, 'matchMedia');
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
afterAll(() => {
  if (matchMediaOriginal !== undefined) {
    Object.defineProperty(window, 'matchMedia', matchMediaOriginal);
  }
});

function exportJobsCalls(fetchMock: ReturnType<typeof vi.fn>): unknown[][] {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes('/kpi/export-jobs'));
}

describe('FddExportPanel 取数时机（DAT-250 O4）', () => {
  it('挂载期零请求：认证就绪后面板渲染，不发 /kpi/export-jobs', async () => {
    localStorage.setItem(REFRESH_KEY, 'refresh-old');
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/auth/refresh')) {
        return Promise.resolve(new Response(JSON.stringify(loginResponse), { status: 200 }));
      }
      if (url.endsWith('/me')) {
        return Promise.resolve(new Response(JSON.stringify(meResponse), { status: 200 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ items: [exportJob], next_cursor: null }), { status: 200 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <AuthProvider>
        <AntdApp>
          <FddExportPanel reportId={REPORT_ID} />
        </AntdApp>
      </AuthProvider>,
    );

    // 认证就绪 → canExport → 面板渲染（按钮出现即挂载完成）
    await waitFor(() => {
      expect(screen.getByText('导出 PDF')).toBeDefined();
    });
    // 挂载静默：不预取 latest（O4 收口点——此前挂载即发一次 limit=1 请求）
    expect(exportJobsCalls(fetchMock)).toHaveLength(0);
  });

  it('打开时取数：点开「导出记录」抽屉才拉 /kpi/export-jobs', async () => {
    localStorage.setItem(REFRESH_KEY, 'refresh-old');
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/auth/refresh')) {
        return Promise.resolve(new Response(JSON.stringify(loginResponse), { status: 200 }));
      }
      if (url.endsWith('/me')) {
        return Promise.resolve(new Response(JSON.stringify(meResponse), { status: 200 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ items: [exportJob], next_cursor: null }), { status: 200 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <AuthProvider>
        <AntdApp>
          <FddExportPanel reportId={REPORT_ID} />
        </AntdApp>
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('导出记录')).toBeDefined();
    });
    expect(exportJobsCalls(fetchMock)).toHaveLength(0);

    fireEvent.click(screen.getByText('导出记录'));
    await waitFor(() => {
      expect(screen.getByText('已完成')).toBeDefined(); // 抽屉列表渲染（任务行状态列）
    });
    const calls = exportJobsCalls(fetchMock);
    expect(calls).toHaveLength(1); // 打开时取数（首次打开一次）
  });
});
