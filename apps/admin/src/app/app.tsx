/**
 * 应用路由与守卫（modules M7：路由守卫按能力显隐——本卡 UI 验收点）。
 *
 * - RequireAuth：无会话 → /login（保留回跳地址；baseline §4.4 TOKEN_EXPIRED 行为）；
 * - MustChangePassword：SEC-PW-03 未轮换 → 只放行 /settings/me（改密闭环）与公共页；
 * - RequireCapability：能力缺失 → 403 页（服务端同源判权，UI 不本地推断角色）。
 */
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { Capability } from '@thermio/shared-types';
import { useAuth, useCapabilities } from './auth-context.js';
import { AppLayout } from '../pages/app-layout.js';
import { LoginPage } from '../pages/login-page.js';
import { ModulePlaceholderPage, NotFoundPage, ForbiddenPage } from '../pages/status-pages.js';
import { AssetsOverviewPage } from '../pages/asset/assets-overview.js';
import { BuildingDetailPage } from '../pages/asset/building-detail.js';
import { SystemDetailPage } from '../pages/asset/system-detail.js';
import { EquipmentDetailPage } from '../pages/asset/equipment-detail.js';
import { PointDetailPage } from '../pages/asset/point-detail.js';
import { GatewayDetailPage } from '../pages/asset/gateway-detail.js';
import { SettingsMePage } from '../pages/settings-me.js';
import { SettingsRolesPage } from '../pages/settings-roles.js';
import { SettingsUsersPage } from '../pages/settings-users.js';

function RequireAuth(): ReactNode {
  const { state } = useAuth();
  const location = useLocation();
  if (state.phase === 'loading') return <ModulePlaceholderPage title="会话恢复中…" />;
  if (state.phase === 'anonymous') {
    return <Navigate to="/login" replace state={{ returnTo: location.pathname }} />;
  }
  return <Outlet />;
}

/** SEC-PW-03：未完成首登轮换 → 圈在个人设置页（改密表单所在）。 */
function RequirePasswordRotation(): ReactNode {
  const { state } = useAuth();
  const location = useLocation();
  if (state.phase === 'must-change-password' && location.pathname !== '/settings/me') {
    return <Navigate to="/settings/me" replace />;
  }
  return <Outlet />;
}

function RequireCapability({ capability }: { capability: Capability }): ReactNode {
  const granted = useCapabilities();
  if (!granted.includes(capability)) {
    return <ForbiddenPage />;
  }
  return <Outlet />;
}

const PLACEHOLDER_ROUTES: readonly { path: string; title: string }[] = [
  { path: '/monitor', title: '监控总览（M3）' },
  { path: '/alarms', title: '告警中心（M4）' },
  { path: '/proposals', title: '控制建议（M5）' },
  { path: '/fdd', title: 'FDD 报告（M6）' },
  { path: '/imports', title: '点表导入（M2）' },
  { path: '/control/points', title: '控制安全（M8）' },
];

export function App(): ReactNode {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<RequirePasswordRotation />}>
          <Route element={<AppLayout />}>
            <Route index element={<Navigate to="/monitor" replace />} />
            {PLACEHOLDER_ROUTES.map((route) => (
              <Route
                key={route.path}
                path={route.path}
                element={<ModulePlaceholderPage title={route.title} />}
              />
            ))}
            {/* 资产组（M1-asset §7：6 页路由 + 能力显隐） */}
            <Route element={<RequireCapability capability="assets.read" />}>
              <Route path="/assets" element={<AssetsOverviewPage />} />
              <Route path="/assets/buildings/:buildingId" element={<BuildingDetailPage />} />
              <Route path="/assets/systems/:systemId" element={<SystemDetailPage />} />
              <Route path="/assets/equipments/:equipmentId" element={<EquipmentDetailPage />} />
              <Route path="/assets/points/:pointId" element={<PointDetailPage />} />
              <Route path="/assets/gateways/:gatewayId" element={<GatewayDetailPage />} />
            </Route>
            <Route path="/settings/me" element={<SettingsMePage />} />
            <Route path="/settings/roles" element={<SettingsRolesPage />} />
            <Route element={<RequireCapability capability="users.manage" />}>
              <Route path="/settings/users" element={<SettingsUsersPage />} />
            </Route>
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Route>
      </Route>
    </Routes>
  );
}
