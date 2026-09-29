/**
 * 全局骨架（ui/baseline.md §1.1：顶部栏 56px + 左侧导航 224px）。
 * 菜单/用户区只渲染 /me 下发能力许可的条目（SEC-AZ-05）。
 * 主题：ConfigProvider 双 algorithm + --ti-* 双套由 app/theme.tsx 统一承载
 * （DAT-169，FE-02）；顶栏走 token 化容器底 + 描边（参照原型深浅切换形态）。
 */
import { Layout, Menu, Switch } from 'antd';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth, useCapabilities } from '../app/auth-context.js';
import { selectedMenuKeys, visibleMenuEntries } from '../app/menu-model.js';
import { useTheme } from '../app/theme.js';
import { AlarmBadge } from './alarm/alarm-badge.js';

export function AppLayout(): React.ReactNode {
  const capabilities = useCapabilities();
  const { state, logout } = useAuth();
  const { mode, setMode } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const entries = visibleMenuEntries(capabilities);
  const me = state.phase === 'authenticated' ? state.me : null;

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'var(--ti-bg-card)',
          color: 'var(--ti-text)',
          borderBottom: '1px solid var(--ti-border)',
          paddingInline: 20,
        }}
      >
        <span style={{ fontSize: 16, fontWeight: 600 }}>thermio 节能管理</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <AlarmBadge />
          <Switch
            checked={mode === 'dark'}
            checkedChildren="深"
            unCheckedChildren="浅"
            onChange={(checked) => {
              setMode(checked ? 'dark' : 'light');
            }}
            aria-label="主题切换"
            title={mode === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
          />
          {me !== null && (
            <button
              type="button"
              onClick={() => {
                void logout();
              }}
              style={{
                background: 'transparent',
                color: 'var(--ti-text-2)',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              {me.user.display_name}（{me.role}）· 登出
            </button>
          )}
        </div>
      </Layout.Header>
      <Layout>
        {/* Sider 恒走 light 主题面：深色下由 darkAlgorithm 派生为 --ti-bg-card 同源底（token 一致） */}
        <Layout.Sider width={224} theme="light">
          <Menu
            mode="inline"
            selectedKeys={selectedMenuKeys(location.pathname, entries)}
            items={entries.map((entry) => ({ key: entry.route, label: entry.label }))}
            onClick={({ key }) => {
              void navigate(key);
            }}
          />
        </Layout.Sider>
        <Layout.Content style={{ padding: 24 }}>
          <Outlet />
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
