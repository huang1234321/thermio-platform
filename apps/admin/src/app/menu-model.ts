/**
 * 一级导航模型（ui/baseline.md §1.1：菜单按 capabilities 显隐，SEC-AZ-05）。
 * 能力键与 shared-types CAPABILITIES 同源；未授权菜单**不出现**（非置灰）。
 */
import type { Capability } from '@thermio/shared-types';

export interface MenuEntry {
  readonly key: string;
  readonly label: string;
  readonly route: string;
  /** 无能力键 = 登录即可见（登录后的自管理面）。 */
  readonly capability: Capability | null;
}

/** 顺序固定按 baseline §1.1（监控 → 告警 → 建议 → FDD → 资产 → 导入 → 控制安全 → 系统管理）。 */
export const MENU_ENTRIES: readonly MenuEntry[] = [
  { key: 'monitor', label: '监控总览', route: '/monitor', capability: 'monitor.read' },
  { key: 'alarms', label: '告警中心', route: '/alarms', capability: 'alarms.read' },
  { key: 'proposals', label: '控制建议', route: '/proposals', capability: 'proposals.read' },
  { key: 'fdd', label: 'FDD 报告', route: '/fdd', capability: 'fdd.read' },
  { key: 'assets', label: '资产管理', route: '/assets', capability: 'assets.read' },
  { key: 'imports', label: '点表导入', route: '/imports', capability: 'imports.read' },
  { key: 'control', label: '控制安全', route: '/control/points', capability: 'control.read' },
  { key: 'settings-me', label: '个人设置', route: '/settings/me', capability: null },
  { key: 'settings-roles', label: '角色说明', route: '/settings/roles', capability: null },
  {
    key: 'settings-users',
    label: '用户管理',
    route: '/settings/users',
    capability: 'users.manage',
  },
];

/** 按能力清单过滤菜单（SEC-AZ-05 显隐唯一入口；未知能力键忽略）。 */
export function visibleMenuEntries(capabilities: readonly string[]): readonly MenuEntry[] {
  const granted = new Set(capabilities);
  return MENU_ENTRIES.filter((entry) => entry.capability === null || granted.has(entry.capability));
}

/**
 * 当前路由的菜单选中键：取 route 为 pathname 前缀的最长条目——子路由
 * （如 /monitor/equipments/:id）归属父菜单高亮，不再整栏全平（视觉门 r1 页3-4）。
 * 返回条目 route（app-layout 的 Menu 以 route 为 item key）；无前缀命中返回空。
 */
export function selectedMenuKeys(
  pathname: string,
  entries: readonly MenuEntry[] = MENU_ENTRIES,
): string[] {
  let best: MenuEntry | null = null;
  for (const entry of entries) {
    if (pathname !== entry.route && !pathname.startsWith(`${entry.route}/`)) continue;
    if (best === null || entry.route.length > best.route.length) best = entry;
  }
  return best === null ? [] : [best.route];
}
