/**
 * 能力显隐渲染用例（SEC-AZ-05 的 jsdom 面）：菜单按 capabilities 渲染，
 * 未授权项**不出现在 DOM**（非置灰）；角色名不参与判断。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigProvider, Layout, Menu } from 'antd';
import { visibleMenuEntries } from './menu-model.js';
import { ROLE_CAPABILITIES } from '@thermio/shared-types';

function renderMenu(capabilities: readonly string[]): void {
  const entries = visibleMenuEntries(capabilities);
  render(
    <ConfigProvider>
      <Layout>
        <Layout.Sider>
          <Menu
            mode="inline"
            items={entries.map((entry) => ({ key: entry.route, label: entry.label }))}
          />
        </Layout.Sider>
      </Layout>
    </ConfigProvider>,
  );
}

afterEach(cleanup);

describe('menu render（SEC-AZ-05）', () => {
  it('shouldNotRenderUsersManagement_forViewer', () => {
    renderMenu(ROLE_CAPABILITIES.viewer);
    expect(screen.queryByText('用户管理')).toBeNull();
    expect(screen.getByText('监控总览')).toBeDefined();
  });

  it('shouldRenderUsersManagement_forAdmin', () => {
    renderMenu(ROLE_CAPABILITIES.admin);
    expect(screen.getByText('用户管理')).toBeDefined();
  });
});
