/**
 * 全局骨架（ui/baseline.md §1.1：顶部栏 56px + 左侧导航 224px）。
 * 菜单/用户区只渲染 /me 下发能力许可的条目（SEC-AZ-05）。
 * 主题：--ti-primary 映射 AntD token（基线 §2 首版取主色/圆角两档，全量 token 表随
 * 前端工程章收口后增量对齐——基线 §8 对齐点 1）。
 */
import { ConfigProvider, Layout, Menu, theme } from 'antd';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth, useCapabilities } from '../app/auth-context.js';
import { selectedMenuKeys, visibleMenuEntries } from '../app/menu-model.js';
import { AlarmBadge } from './alarm/alarm-badge.js';

const THERMIO_PRIMARY = '#0B7285'; // --ti-primary（浅色档）

export function AppLayout(): React.ReactNode {
  const capabilities = useCapabilities();
  const { state, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const entries = visibleMenuEntries(capabilities);
  const me = state.phase === 'authenticated' ? state.me : null;

  return (
    <ConfigProvider
      theme={{
        token: { colorPrimary: THERMIO_PRIMARY, borderRadius: 4 },
        algorithm: theme.defaultAlgorithm,
      }}
    >
      <Layout style={{ minHeight: '100vh' }}>
        <Layout.Header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            color: '#fff',
            background: THERMIO_PRIMARY,
          }}
        >
          <span style={{ fontSize: 18, fontWeight: 600 }}>thermio 节能管理</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <AlarmBadge />
            {me !== null && (
              <button
                type="button"
                onClick={() => {
                  void logout();
                }}
                style={{
                  background: 'transparent',
                  color: '#fff',
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                {me.user.display_name}（{me.role}）· 登出
              </button>
            )}
          </div>
        </Layout.Header>
        <Layout>
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
    </ConfigProvider>
  );
}
