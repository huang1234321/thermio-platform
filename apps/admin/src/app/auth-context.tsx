/**
 * 会话上下文（SEC-AZ-05）：UI 只消费 /me 下发的 capabilities[]，
 * 不按角色名本地推断权限；must_change_password 时强制路由到改密页（SEC-PW-03）。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  LoginResponseSchema,
  MeResponseSchema,
  type Capability,
  type LoginResponse,
  type MeResponse,
} from '@thermio/shared-types';
import {
  ApiError,
  apiFetch,
  clearTokens,
  doRefresh,
  loadStoredRefreshToken,
  storeTokens,
} from './api-client.js';

export type AuthState =
  | { phase: 'loading' }
  | { phase: 'anonymous' }
  | { phase: 'authenticated'; me: MeResponse }
  | { phase: 'must-change-password'; me: MeResponse };

interface AuthContextValue {
  readonly state: AuthState;
  readonly login: (email: string, password: string) => Promise<void>;
  readonly logout: () => Promise<void>;
  readonly reloadMe: () => Promise<void>;
  readonly applyNewTokens: (tokens: LoginResponse) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** 204 无响应体：以恒真 schema 消费（登出失败也走本地清会话）。 */
const ACCEPT_ANY = {
  safeParse: () => ({ success: true as const, data: undefined }),
} as const;

export function AuthProvider({ children }: { children: ReactNode }): ReactNode {
  const [state, setState] = useState<AuthState>({ phase: 'loading' });

  const reloadMe = useCallback(async () => {
    try {
      const me = await apiFetch('/me', MeResponseSchema);
      setState(
        me.must_change_password
          ? { phase: 'must-change-password', me }
          : { phase: 'authenticated', me },
      );
    } catch {
      clearTokens();
      setState({ phase: 'anonymous' });
    }
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      const response = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const { parseApiError } = await import('@thermio/shared-types');
        throw new ApiError(response.status, parseApiError(body));
      }
      const parsed = LoginResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error('登录响应不符合契约');
      storeTokens(parsed.data);
      await reloadMe();
    },
    [reloadMe],
  );

  const logout = useCallback(async () => {
    try {
      await apiFetch('/auth/logout', ACCEPT_ANY, { method: 'POST' });
    } catch {
      // 登出失败也本地清会话（服务端会话终将过期）
    }
    clearTokens();
    setState({ phase: 'anonymous' });
  }, []);

  const applyNewTokens = useCallback(
    async (tokens: LoginResponse) => {
      storeTokens(tokens);
      await reloadMe();
    },
    [reloadMe],
  );

  // 会话恢复：启动时持 refresh token 先换发再拉 /me（main.tsx 装配 onAuthExpired）
  useEffect(() => {
    if (loadStoredRefreshToken() === null) {
      setState({ phase: 'anonymous' });
      return;
    }
    void (async () => {
      try {
        await doRefresh();
        await reloadMe();
      } catch {
        clearTokens();
        setState({ phase: 'anonymous' });
      }
    })();
  }, [reloadMe]);

  const value = useMemo<AuthContextValue>(
    () => ({ state, login, logout, reloadMe, applyNewTokens }),
    [state, login, logout, reloadMe, applyNewTokens],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === null) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return context;
}

/** 当前用户能力（SEC-AZ-05 的消费面：菜单/按钮显隐唯一依据）。 */
export function useCapabilities(): readonly Capability[] {
  const { state } = useAuth();
  if (state.phase === 'authenticated' || state.phase === 'must-change-password') {
    return state.me.capabilities as readonly Capability[];
  }
  return [];
}
