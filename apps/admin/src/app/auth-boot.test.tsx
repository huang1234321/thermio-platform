/**
 * boot 会话恢复双发用例（DAT-160 附带证据，供 DAT-206 重新定界）：
 * dev StrictMode 下挂载 effect 双调用共享 single-flight 刷新——只发一次
 * /auth/refresh，且不再因第二次持已轮换 token 401 而弹回匿名（假登出）。
 */
import { StrictMode } from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth, type AuthState } from './auth-context.js';

const REFRESH_KEY = 'thermio.refresh_token';

const loginResponse = (suffix: string) => ({
  access_token: `access-${suffix}`,
  refresh_token: `refresh-${suffix}`,
  token_type: 'Bearer' as const,
  expires_in: 900,
  must_change_password: false,
  user: { id: 'u1', email: 'ops@example.com', display_name: '运维' },
});

const meResponse = {
  user: { id: 'u1', email: 'ops@example.com', display_name: '运维' },
  role: 'admin',
  must_change_password: false,
  building_scopes: [],
  capabilities: ['alarm.view'],
  session: {
    id: 's1',
    created_at: '2026-09-26T02:00:00Z',
    expires_at: '2026-10-10T02:00:00Z',
  },
};

/** 探针：把当前 phase 暴露给断言（不渲染任何 UI）。 */
let latestPhase: AuthState['phase'] | undefined;
function PhaseProbe(): ReactNode {
  const { state } = useAuth();
  latestPhase = state.phase;
  return null;
}

afterEach(cleanup);

describe('boot 会话恢复（DAT-160 / DAT-206 证据）', () => {
  it('StrictMode 双发挂载 effect：只发一次 refresh，不弹回匿名', async () => {
    localStorage.setItem(REFRESH_KEY, 'refresh-old');
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/auth/refresh')) {
        return Promise.resolve(
          new Response(JSON.stringify(loginResponse('boot')), { status: 200 }),
        );
      }
      if (url.endsWith('/me')) {
        return Promise.resolve(new Response(JSON.stringify(meResponse), { status: 200 }));
      }
      return Promise.resolve(new Response('{}', { status: 500 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <StrictMode>
        <AuthProvider>
          <PhaseProbe />
        </AuthProvider>
      </StrictMode>,
    );

    await waitFor(() => {
      expect(latestPhase).toBe('authenticated');
    });

    // 双发 effect 共享 single-flight：网络面上只有一次 refresh（无 200→401 成对）
    const refreshCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/auth/refresh'),
    );
    expect(refreshCalls).toHaveLength(1);
    expect(globalThis.localStorage.getItem(REFRESH_KEY)).toBe('refresh-boot');
  });
});
