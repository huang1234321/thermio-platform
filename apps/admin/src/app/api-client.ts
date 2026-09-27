/**
 * api 客户端（platform.md §5.3 客户端面 / API-CT-01）：
 * - 响应一律 safeParse 后使用，不裸断言网络 JSON（畸形走通用兜底，API-ERR-02）；
 * - access 过期（auth.token_expired）自动刷新一次重放；刷新失败清会话回登录页；
 * - token 存放：access 内存 + refresh localStorage（MVP 形态；升级 httpOnly cookie
 *   随部署安全评审，属已知边界不在本卡范围）。
 */
import {
  GENERIC_FALLBACK_MESSAGE,
  LoginResponseSchema,
  parseApiError,
  type LoginResponse,
  type ParsedApiError,
} from '@thermio/shared-types';

const REFRESH_KEY = 'thermio.refresh_token';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly parsed: ParsedApiError,
  ) {
    super(parsed.message);
  }
}

interface TokenStore {
  accessToken: string | null;
  onAuthExpired: () => void;
}

/** 全局单例（模块级；main.tsx 装配 onAuthExpired 回调）。 */
export const tokenStore: TokenStore = { accessToken: null, onAuthExpired: () => undefined };

export function loadStoredRefreshToken(): string | null {
  return globalThis.localStorage.getItem(REFRESH_KEY);
}

export function storeTokens(tokens: LoginResponse): void {
  tokenStore.accessToken = tokens.access_token;
  globalThis.localStorage.setItem(REFRESH_KEY, tokens.refresh_token);
}

export function clearTokens(): void {
  tokenStore.accessToken = null;
  globalThis.localStorage.removeItem(REFRESH_KEY);
}

async function parseEnvelopeError(response: Response): Promise<ApiError> {
  const body: unknown = await response.json().catch(() => null);
  if (body === null) {
    return new ApiError(response.status, {
      reason_code: 'common.internal_error',
      message: GENERIC_FALLBACK_MESSAGE,
      request_id: null,
      details: null,
      known: false,
    });
  }
  const parsed = parseApiError(body);
  return new ApiError(response.status, parsed);
}

export async function doRefresh(): Promise<LoginResponse> {
  const refreshToken = loadStoredRefreshToken();
  if (refreshToken === null) throw new Error('no refresh token');
  const response = await fetch('/api/v1/auth/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!response.ok) throw await parseEnvelopeError(response);
  const parsed = LoginResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('refresh 响应不符合契约');
  storeTokens(parsed.data);
  return parsed.data;
}

export interface ApiCallOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly body?: unknown;
  /** 内部重放标记（自动刷新一次，不无限递归）。 */
  readonly retried?: boolean;
}

/** 统一请求入口：Bearer 注入 + 过期自动刷新重放 + 信封错误归一。 */
export async function apiFetch<TSchema>(
  path: string,
  schema: { safeParse: (input: unknown) => { success: true; data: TSchema } | { success: false } },
  options: ApiCallOptions = {},
): Promise<TSchema> {
  const init: RequestInit = {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(tokenStore.accessToken !== null
        ? { authorization: `Bearer ${tokenStore.accessToken}` }
        : {}),
    },
  };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(`/api/v1${path}`, init);

  if (response.status === 401 && !options.retried) {
    const error = await parseEnvelopeError(response);
    if (error.parsed.reason_code === 'auth.token_expired') {
      try {
        await doRefresh();
      } catch {
        clearTokens();
        tokenStore.onAuthExpired();
        throw error;
      }
      return apiFetch(path, schema, { ...options, retried: true });
    }
  }

  if (!response.ok) {
    throw await parseEnvelopeError(response);
  }
  if (response.status === 204) {
    return undefined as TSchema;
  }
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) {
    // API-CT-03 宽松回退：整体解析失败降级错误态并上报，不裸断言
    throw new ApiError(response.status, {
      reason_code: 'common.internal_error',
      message: GENERIC_FALLBACK_MESSAGE,
      request_id: null,
      details: null,
      known: false,
    });
  }
  return parsed.data;
}
