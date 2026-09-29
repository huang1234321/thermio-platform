/**
 * 亮暗双主题 shell（ui/baseline.md §2 / FE-02，DAT-118 视觉轮 V2 裁决落地卡）：
 * - 单一事实源 ThemeMode：localStorage 持久化 → prefers-color-scheme → 浅色；
 * - data-theme 属性驱动 --ti-* token 双套（styles/tokens.css）；
 * - AntD ConfigProvider 双 algorithm + theme.token 映射同一组值（基线 §2「AntD 5 经
 *   theme.token 映射同一组值」）；深色实底按钮文字用同色相深青黑（白字 on #54C7D8 仅 1.99）。
 *
 * 存储键与 index.html 首屏预设脚本共用（thermio.theme），改动须两侧同步。
 *
 * AntD 组件文案 locale 全局收口 zh-CN（DAT-157 修单簇 2：RangePicker 等内置英文
 * 占位/按钮文案；antd 官方配方 = ConfigProvider locale + dayjs locale）。
 */
import { ConfigProvider, theme as antdTheme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

dayjs.locale('zh-cn');

export type ThemeMode = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'thermio.theme';

export function resolveInitialTheme(): ThemeMode {
  try {
    const stored = globalThis.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // 无存储（隐私模式等）：走系统偏好
  }
  if (
    typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(prefers-color-scheme: dark)').matches
  ) {
    return 'dark';
  }
  return 'light';
}

export function applyTheme(mode: ThemeMode): void {
  document.documentElement.dataset.theme = mode;
  document.documentElement.style.colorScheme = mode;
}

/** AntD token 映射（基线 §2.1 同一组值；border 圆角沿用现网 4px 不动） */
const ANT_TOKENS: Record<ThemeMode, Record<string, string | number>> = {
  light: {
    colorPrimary: '#0B7285',
    colorInfo: '#1668DC',
    colorSuccess: '#237804',
    colorWarning: '#9A5C00',
    colorError: '#CF1322',
    colorLink: '#0B7285',
    colorLinkHover: '#095E6F',
    colorLinkActive: '#095E6F',
    colorTextBase: '#1F2329',
    colorBgLayout: '#F5F6F8',
    colorBgContainer: '#FFFFFF',
    colorBgElevated: '#FFFFFF',
    colorBorder: '#D3D8DE',
    colorBorderSecondary: '#E4E7EB',
    colorTextSecondary: '#51565E',
    colorTextTertiary: '#646C76',
    borderRadius: 4,
  },
  dark: {
    colorPrimary: '#54C7D8',
    colorInfo: '#69B1FF',
    colorSuccess: '#95DE64',
    colorWarning: '#FFC53D',
    colorError: '#FF7875',
    colorLink: '#54C7D8',
    colorLinkHover: '#7AD6E3',
    colorLinkActive: '#7AD6E3',
    colorTextBase: '#E8EAED',
    colorBgLayout: '#121417',
    colorBgContainer: '#1B1F24',
    colorBgElevated: '#1F242B',
    colorBorder: '#3A4148',
    colorBorderSecondary: '#2C3238',
    colorTextSecondary: '#9AA1A9',
    colorTextTertiary: '#8B939C',
    // 深色实底文字：本档全部实底强调色为浅色系（primary/error/success…），白字仅 ~2:1，
    // 统一深青黑（Steps 过程图标/Button 实底/Badge 计数等 colorTextLightSolid 消费面）
    colorTextLightSolid: '#08252B',
    borderRadius: 4,
  },
};

interface ThemeContextValue {
  readonly mode: ThemeMode;
  readonly setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }): ReactNode {
  const [mode, setModeState] = useState<ThemeMode>(resolveInitialTheme);

  useEffect(() => {
    applyTheme(mode);
  }, [mode]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    try {
      globalThis.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // 持久化失败（隐私模式等）：仅会话内生效
    }
  }, []);

  const value = useMemo(() => ({ mode, setMode }), [mode, setMode]);

  return (
    <ThemeContext.Provider value={value}>
      <ConfigProvider
        locale={zhCN}
        theme={{
          algorithm: mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
          token: ANT_TOKENS[mode],
          components: {
            Menu: {
              itemSelectedColor: mode === 'dark' ? '#54C7D8' : '#0B7285',
              itemSelectedBg: mode === 'dark' ? '#12333A' : '#E6F3F5',
            },
          },
        }}
      >
        {children}
      </ConfigProvider>
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === null) throw new Error('useTheme 必须在 ThemeProvider 内使用');
  return value;
}
