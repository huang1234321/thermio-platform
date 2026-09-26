/**
 * 角色说明页（modules M7 页面地图 /settings/roles：三角色只读说明，自定义角色 P2）。
 * 文案与 overview §7 权限矩阵一致；能力集从 shared-types 推导表取（单一来源）。
 */
import { Card, Table, Tag } from 'antd';
import { ROLE_CAPABILITIES } from '@thermio/shared-types';

const ROLE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  admin:
    '租户管理员——资产结构、接入凭证、闸门参数、用户与授权、告警规则的唯一写者；隐式拥有全部楼宇权限。',
  operator: '运维——授权楼宇内的日常闭环主体（确认 proposal、处置告警、导入点表）。',
  viewer: '只读——授权楼宇内浏览（监控/告警/建议/报告/资产）。',
};

export function SettingsRolesPage(): React.ReactNode {
  const rows = (['admin', 'operator', 'viewer'] as const).map((role) => ({
    key: role,
    role,
    description: ROLE_DESCRIPTIONS[role] ?? '',
    capabilities: ROLE_CAPABILITIES[role],
  }));
  return (
    <Card title="MVP 三角色（ADR-011 / DM §3.1）">
      <Table
        pagination={false}
        dataSource={rows}
        columns={[
          { title: '角色', dataIndex: 'role', key: 'role', width: 120 },
          { title: '职责', dataIndex: 'description', key: 'description' },
          {
            title: '能力清单（/me 下发）',
            dataIndex: 'capabilities',
            key: 'capabilities',
            render: (capabilities: readonly string[]) => (
              <>
                {capabilities.map((capability) => (
                  <Tag key={capability}>{capability}</Tag>
                ))}
              </>
            ),
          },
        ]}
      />
    </Card>
  );
}
