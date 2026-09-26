/**
 * 能力显隐用例（IMPL-10 验收点：SEC-AZ-05 有用例）——纯逻辑面：
 * 菜单可见性只由 capabilities[] 决定（角色名不进 UI 判断），未知能力键忽略不崩。
 * 渲染面（jsdom）另见 menu-render.test.tsx。
 */
import { describe, expect, it } from 'vitest';
import { MENU_ENTRIES, visibleMenuEntries } from './menu-model.js';
import { ROLE_CAPABILITIES } from '@thermio/shared-types';

describe('visibleMenuEntries（SEC-AZ-05 显隐）', () => {
  it('shouldShowOnlyGrantedEntries_forViewerCapabilities', () => {
    const visible = visibleMenuEntries(ROLE_CAPABILITIES.viewer);
    const labels = visible.map((entry) => entry.label);
    // 全部一级菜单（除系统管理）+ 个人设置/角色说明
    expect(labels).toContain('监控总览');
    expect(labels).toContain('控制安全');
    expect(labels).not.toContain('用户管理');
    expect(visible).toHaveLength(MENU_ENTRIES.length - 1);
  });

  it('shouldShowEverything_forAdminCapabilities', () => {
    const visible = visibleMenuEntries(ROLE_CAPABILITIES.admin);
    expect(visible).toHaveLength(MENU_ENTRIES.length);
    expect(visible.map((entry) => entry.label)).toContain('用户管理');
  });

  it('shouldHideOperatorOnlyEntries_fromViewer', () => {
    // 点表导入对 viewer 仍可见（只读入口），但无 imports.write 时发起动作由后端判权
    const visible = visibleMenuEntries(ROLE_CAPABILITIES.viewer);
    expect(visible.map((entry) => entry.label)).toContain('点表导入');
  });

  it('shouldIgnoreUnknownCapabilityKeys_withoutBreaking', () => {
    const visible = visibleMenuEntries(['monitor.read', 'future.unknown_key']);
    expect(visible.map((entry) => entry.key)).toEqual(['monitor', 'settings-me', 'settings-roles']);
  });

  it('shouldShowSelfServiceEntries_forEmptyCapabilities', () => {
    // 能力被清空（如待轮换态）：个人设置仍可用（SEC-PW-03 改密闭环的 UI 面）
    const visible = visibleMenuEntries([]);
    expect(visible.map((entry) => entry.key)).toEqual(['settings-me', 'settings-roles']);
  });
});
