/**
 * 双主题 shell 用例（DAT-169 / FE-02）：解析优先级（持久化 → 系统偏好 → 浅色）、
 * data-theme 落 DOM、切换持久化、顶栏切换入口可达（FE-03 键盘通道由 Switch 原生承载）。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from './auth-context.js';
import { THEME_STORAGE_KEY, ThemeProvider, resolveInitialTheme, useTheme } from './theme.js';
import { AppLayout } from '../pages/app-layout.js';

afterEach(cleanup);

function stubMediaQuery(dark: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: dark,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  );
}

function Probe(): React.ReactNode {
  const { mode, setMode } = useTheme();
  return (
    <button
      type="button"
      onClick={() => {
        setMode(mode === 'dark' ? 'light' : 'dark');
      }}
    >
      probe:{mode}
    </button>
  );
}

describe('resolveInitialTheme（解析优先级）', () => {
  it('persistedChoiceWins', () => {
    globalThis.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    stubMediaQuery(false);
    expect(resolveInitialTheme()).toBe('dark');
  });

  it('systemPreferenceFallsBack_whenNothingPersisted', () => {
    globalThis.localStorage.clear();
    stubMediaQuery(true);
    expect(resolveInitialTheme()).toBe('dark');
    stubMediaQuery(false);
    expect(resolveInitialTheme()).toBe('light');
  });

  it('defaultsToLight_whenNoStorageNoMatchMedia', () => {
    globalThis.localStorage.clear();
    vi.stubGlobal('matchMedia', undefined);
    expect(resolveInitialTheme()).toBe('light');
  });
});

describe('ThemeProvider（应用与持久化）', () => {
  it('appliesDataThemeToDocumentElement', () => {
    globalThis.localStorage.clear();
    stubMediaQuery(false);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('persistsAndApplies_onModeChange', () => {
    globalThis.localStorage.clear();
    stubMediaQuery(false);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByText('probe:light'));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(globalThis.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('restoresPersistedDark_onMount', () => {
    globalThis.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    stubMediaQuery(false);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});

describe('AppLayout 顶栏切换入口', () => {
  it('rendersThemeSwitch_andTogglesDataTheme', () => {
    globalThis.localStorage.clear();
    stubMediaQuery(false);
    render(
      <ThemeProvider>
        <AuthProvider>
          <MemoryRouter>
            <AppLayout />
          </MemoryRouter>
        </AuthProvider>
      </ThemeProvider>,
    );
    const toggle = screen.getByRole('switch', { name: '主题切换' });
    expect(document.documentElement.dataset.theme).toBe('light');
    fireEvent.click(toggle);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(globalThis.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });
});
