/**
 * 根路径路由回归钉（DAT-247）：admin 无营销落地页——`/` 先走 RequireAuth
 * 认证门：匿名 → /login 登录表单；已登录 → /monitor 工作区。
 * monitor-overview mock 成占位：本用例只钉路由树与守卫，不把 three/jsdom 拖进来。
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { App } from './app.js';
import { AuthProvider } from './auth-context.js';
import { ThemeProvider } from './theme.js';

vi.mock('../pages/monitor/monitor-overview.js', () => ({
  MonitorOverviewPage: function MonitorOverviewPageStub(): ReactNode {
    return <div>monitor-stub</div>;
  },
}));

const REFRESH_KEY = 'thermio.refresh_token';

const loginResponse = {
  access_token: 'access-boot',
  refresh_token: 'refresh-boot',
  token_type: 'Bearer' as const,
  expires_in: 900,
  must_change_password: false,
  user: { id: 'u1', email: 'ops@example.com', display_name: '运维' },
};

const meResponse = {
  user: { id: 'u1', email: 'ops@example.com', display_name: '运维' },
  role: 'admin',
  must_change_password: false,
  building_scopes: [],
  capabilities: ['monitor.read'],
  session: {
    id: 's1',
    created_at: '2026-09-26T02:00:00Z',
    expires_at: '2026-10-26T02:00:00Z',
  },
};

/** 探针：把当前路由暴露给断言（不渲染任何 UI）。 */
let currentPath: string | null = null;
function LocationProbe(): ReactNode {
  const location = useLocation();
  currentPath = location.pathname;
  return null;
}

/** antd responsiveObserver 需要 matchMedia（jsdom 缺省无，theme.test.tsx 同款 stub）。 */
function stubMediaQuery(): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  );
}

function renderAt(path: string): void {
  render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <LocationProbe />
          <App />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  globalThis.localStorage.clear();
});

describe('根路径路由（DAT-247）', () => {
  it('匿名访问 / → /login 登录表单', async () => {
    // 无 refresh token：不应发出任何请求，恢复期一过即匿名重定向
    stubMediaQuery();
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);

    renderAt('/');

    // 路径与表单断言放同一 waitFor 谓词：LocationProbe 在渲染期赋值，React 18
    // 并发渲染下可先于提交可观测——若在此之后同步查 DOM，CI 高负载会拉开
    // 「变量已变、DOM 未提交」竞态窗口（DAT-247 首轮 CI flake 根因）。
    await waitFor(() => {
      expect(currentPath).toBe('/login');
      expect(screen.getByText('邮箱')).toBeDefined();
      expect(screen.getByText('密码')).toBeDefined();
      expect(screen.getByText('登 录')).toBeDefined();
    });
  });

  it('已登录访问 / → /monitor 工作区', async () => {
    stubMediaQuery();
    globalThis.localStorage.setItem(REFRESH_KEY, 'refresh-old');
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/auth/refresh')) {
        return Promise.resolve(new Response(JSON.stringify(loginResponse), { status: 200 }));
      }
      if (url.endsWith('/me')) {
        return Promise.resolve(new Response(JSON.stringify(meResponse), { status: 200 }));
      }
      // 工作区数据请求：挂起即可（路由断言不等数据）
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('/');

    // 同上：路径断言与工作区铬断言同谓词重试，通过即代表提交态一致。
    await waitFor(() => {
      expect(currentPath).toBe('/monitor');
      expect(screen.getByText('monitor-stub')).toBeDefined();
      expect(screen.getByText('监控总览')).toBeDefined();
    });
  });
});
