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
import { ImportsListPage } from '../pages/import/imports-list.js';
import { ImportWizardPage, ImportWizardResumePage } from '../pages/import/import-wizard.js';
import { SettingsMePage } from '../pages/settings-me.js';
import { AlarmsPage } from '../pages/alarm/alarms-page.js';
import { ProposalsPage } from '../pages/proposal/proposals-page.js';
import { ProposalDetailPage } from '../pages/proposal/proposal-detail-page.js';
import { ProposalExecutionPage } from '../pages/proposal/proposal-execution-page.js';
import { ControlAuditPage } from '../pages/proposal/control-audit-page.js';
import { ControlPointsPage } from '../pages/control/control-points-page.js';
import { GateEditPage } from '../pages/control/gate-edit-page.js';
import { ModeChangePage } from '../pages/control/mode-change-page.js';
import { ConfigAuditPage } from '../pages/control/config-audit-page.js';
import { FusePage } from '../pages/control/fuse-page.js';
import { AlarmDetailPage } from '../pages/alarm/alarm-detail-page.js';
import { AlarmRulesPage } from '../pages/alarm/alarm-rules-page.js';
import { AlarmSuppressionsPage } from '../pages/alarm/alarm-suppressions-page.js';
import { SettingsRolesPage } from '../pages/settings-roles.js';
import { SettingsUsersPage } from '../pages/settings-users.js';
import { MonitorOverviewPage } from '../pages/monitor/monitor-overview.js';
import { EquipmentConditionsPage } from '../pages/monitor/equipment-conditions.js';
import { EquipmentConditionDetailPage } from '../pages/monitor/equipment-condition-detail.js';

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
  { path: '/fdd', title: 'FDD 报告（M6）' },
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
            {/* 告警组（M4-alarm §7：3 页 + 抑制记录入口，能力 alarms.read） */}
            <Route element={<RequireCapability capability="alarms.read" />}>
              <Route path="/alarms" element={<AlarmsPage />} />
              <Route path="/alarms/:alarmId" element={<AlarmDetailPage />} />
              <Route path="/alarm-rules" element={<AlarmRulesPage />} />
              <Route path="/alarms/suppressions" element={<AlarmSuppressionsPage />} />
            </Route>
            {/* 监控组（M3-monitor §8：页面 1 总览 + 页面 2 检索/详情） */}
            <Route element={<RequireCapability capability="monitor.read" />}>
              <Route path="/monitor" element={<MonitorOverviewPage />} />
              <Route path="/monitor/equipments" element={<EquipmentConditionsPage />} />
              <Route
                path="/monitor/equipments/:equipmentId"
                element={<EquipmentConditionDetailPage />}
              />
            </Route>
            {/* 建议组（M5-proposal §6：4 页路由，能力 proposals.read） */}
            <Route element={<RequireCapability capability="proposals.read" />}>
              <Route path="/proposals" element={<ProposalsPage />} />
              <Route path="/proposals/:proposalId" element={<ProposalDetailPage />} />
              <Route path="/proposals/:proposalId/execution" element={<ProposalExecutionPage />} />
              <Route path="/control-audit" element={<ControlAuditPage />} />
            </Route>
            {/* 控制安全组（M8-safety-ui §2.1：5 页路由，读 control.read / 写 control.write） */}
            <Route element={<RequireCapability capability="control.read" />}>
              <Route path="/control/points" element={<ControlPointsPage />} />
              <Route element={<RequireCapability capability="control.write" />}>
                <Route path="/control/points/:pointId/gate" element={<GateEditPage />} />
                <Route path="/control/points/:pointId/mode" element={<ModeChangePage />} />
              </Route>
              <Route path="/control/config-audit" element={<ConfigAuditPage />} />
              <Route path="/control/fuse" element={<FusePage />} />
            </Route>
            {/* 资产组（M1-asset §7：6 页路由 + 能力显隐） */}
            <Route element={<RequireCapability capability="assets.read" />}>
              <Route path="/assets" element={<AssetsOverviewPage />} />
              <Route path="/assets/buildings/:buildingId" element={<BuildingDetailPage />} />
              <Route path="/assets/systems/:systemId" element={<SystemDetailPage />} />
              <Route path="/assets/equipments/:equipmentId" element={<EquipmentDetailPage />} />
              <Route path="/assets/points/:pointId" element={<PointDetailPage />} />
              <Route path="/assets/gateways/:gatewayId" element={<GatewayDetailPage />} />
            </Route>
            {/* 导入组（M2-import §10：历史 + 五步向导 + 作业详情/续入合一，baseline §1.2 R9） */}
            <Route element={<RequireCapability capability="imports.read" />}>
              <Route path="/imports" element={<ImportsListPage />} />
              <Route element={<RequireCapability capability="imports.write" />}>
                <Route path="/imports/new" element={<ImportWizardPage />} />
              </Route>
              <Route path="/imports/:jobId" element={<ImportWizardResumePage />} />
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
