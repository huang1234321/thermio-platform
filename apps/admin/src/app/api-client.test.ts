/**
 * 会话刷新 single-flight 用例（DAT-160）：boot 恢复与 401 重试并发时共享同一
 * in-flight 刷新，只发一次网络请求；轮换竞态下不清活会话；真过期仍清回登录。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, doRefresh, loadStoredRefreshToken, tokenStore } from './api-client.js';

const REFRESH_KEY = 'thermio.refresh_token';

const tokensOf = (suffix: string) => ({
  access_token: `access-${suffix}`,
  refresh_token: `refresh-${suffix}`,
  token_type: 'Bearer' as const,
  expires_in: 900,
  must_change_password: false,
  user: { id: 'u1', email: 'ops@example.com', display_name: '运维' },
});

const envelope = (reason_code: string) => ({
  error: { reason_code, message: reason_code, request_id: null },
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const refreshTokenFromBody = (init: RequestInit | undefined): string => {
  const body = init?.body;
  if (typeof body !== 'string') throw new Error('测试桩：refresh 请求体应为 JSON 字符串');
  return (JSON.parse(body) as { refresh_token: string }).refresh_token;
};

/** 挂起中的响应句柄：竞态窗口内后续断言用。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  tokenStore.accessToken = null;
  tokenStore.onAuthExpired = () => undefined;
});

describe('刷新 single-flight（DAT-160）', () => {
  it('boot 与并发调用共享同一 in-flight Promise，只发一次 refresh', async () => {
    localStorage.setItem(REFRESH_KEY, 'refresh-old');
    const pending = deferred<string>();
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/auth/refresh')) {
        return pending.promise.then((suffix) => json(200, tokensOf(suffix)));
      }
      return Promise.resolve(json(500, envelope('common.internal_error')));
    });
    vi.stubGlobal('fetch', fetchMock);

    // boot 恢复先行发起，401 重试路径随后并发到达（整页 reload 竞态窗口）
    const boot = doRefresh();
    const retry = doRefresh();
    expect(retry).toBe(boot);

    pending.resolve('rotated');
    const [bootResult, retryResult] = await Promise.all([boot, retry]);
    expect(bootResult).toEqual(tokensOf('rotated'));
    expect(retryResult).toEqual(tokensOf('rotated'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(loadStoredRefreshToken()).toBe('refresh-rotated');
  });

  it('401 重试与 boot 在途刷新共用：不二次刷新、重放成功、不清会话', async () => {
    localStorage.setItem(REFRESH_KEY, 'refresh-old');
    const pending = deferred<string>();
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/auth/refresh')) {
        return pending.promise.then((suffix) => json(200, tokensOf(suffix)));
      }
      const auth = new Headers(init?.headers).get('authorization');
      // 无有效 access（boot 未完成）→ 401 token_expired，触发 401 重试路径
      if (auth !== 'Bearer access-rotated') {
        return Promise.resolve(json(401, envelope('auth.token_expired')));
      }
      return Promise.resolve(json(200, { ok: true }));
    });
    vi.stubGlobal('fetch', fetchMock);
    tokenStore.onAuthExpired = vi.fn();

    // boot 恢复先启动（挂起中）；并发首批请求走 apiFetch 撞 401
    void doRefresh();
    const first = apiFetch('/demo', {
      safeParse: (v: unknown) => ({ success: true as const, data: v }),
    });
    // 拍平微任务：让 apiFetch 走完 401 解析、进入共享的在途刷新后再放行
    await new Promise((done) => setTimeout(done, 0));
    pending.resolve('rotated');

    await expect(first).resolves.toEqual({ ok: true });
    // 核心断言：全程只有 boot 那一次 refresh（不再出现 refresh 200→401 成对）
    const refreshCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/auth/refresh'),
    );
    expect(refreshCalls).toHaveLength(1);
    expect(tokenStore.onAuthExpired).not.toHaveBeenCalled();
    expect(loadStoredRefreshToken()).toBe('refresh-rotated');
    expect(tokenStore.accessToken).toBe('access-rotated');
  });

  it('轮换竞态兜底：所用 token 失败但本地已被换新 → 用新 token 重试成功', async () => {
    localStorage.setItem(REFRESH_KEY, 'refresh-old');
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (!url.endsWith('/auth/refresh')) {
        return Promise.resolve(json(500, envelope('common.internal_error')));
      }
      const used = refreshTokenFromBody(init);
      if (used === 'refresh-old') {
        // 他路（如 applyNewTokens 改密换发）恰在本次在途期间轮换了本地 token
        localStorage.setItem(REFRESH_KEY, 'refresh-new');
        return Promise.resolve(json(401, envelope('auth.refresh_revoked')));
      }
      return Promise.resolve(json(200, tokensOf(used.replace('refresh-', ''))));
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await doRefresh();
    expect(result).toEqual(tokensOf('new'));
    expect(loadStoredRefreshToken()).toBe('refresh-new');
  });

  it('真过期（本地 token 未变）仍抛错：apiFetch 清会话并回调重登', async () => {
    localStorage.setItem(REFRESH_KEY, 'refresh-dead');
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/auth/refresh')) {
        return Promise.resolve(json(401, envelope('auth.refresh_revoked')));
      }
      return Promise.resolve(json(401, envelope('auth.token_expired')));
    });
    vi.stubGlobal('fetch', fetchMock);
    tokenStore.onAuthExpired = vi.fn();

    await expect(
      apiFetch('/demo', {
        safeParse: (v: unknown) => ({ success: true as const, data: v }),
      }),
    ).rejects.toMatchObject({ parsed: { reason_code: 'auth.token_expired' } });

    expect(tokenStore.onAuthExpired).toHaveBeenCalledTimes(1);
    expect(loadStoredRefreshToken()).toBeNull();
    expect(tokenStore.accessToken).toBeNull();
  });
});
