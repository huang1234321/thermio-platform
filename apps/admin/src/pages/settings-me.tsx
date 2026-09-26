/**
 * 个人设置（modules M7 页面地图 /settings/me）：会话信息 + 楼宇授权 + 能力清单 +
 * 修改密码（SEC-PW-03 的用户面闭环）。
 */
import { Alert, Card, Descriptions, List, Space, Tag, Typography } from 'antd';
import { useState } from 'react';
import { ChangePasswordForm } from './change-password-form.js';
import { useAuth } from '../app/auth-context.js';

export function SettingsMePage(): React.ReactNode {
  const { state } = useAuth();
  const [notice, setNotice] = useState<string | null>(null);
  if (state.phase !== 'authenticated' && state.phase !== 'must-change-password') {
    return <Alert type="error" message="未登录" />;
  }
  const { me } = state;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card title="会话信息">
        <Descriptions column={2}>
          <Descriptions.Item label="显示名">{me.user.display_name}</Descriptions.Item>
          <Descriptions.Item label="邮箱">{me.user.email}</Descriptions.Item>
          <Descriptions.Item label="角色">{me.role}</Descriptions.Item>
          <Descriptions.Item label="会话有效期至">
            {new Date(me.session.expires_at).toLocaleString('zh-CN')}
          </Descriptions.Item>
        </Descriptions>
      </Card>
      <Card title="楼宇授权（SEC-AZ-03：未授权楼宇不出现）">
        {me.building_scopes.length === 0 ? (
          <Typography.Text type="secondary">暂无授权楼宇</Typography.Text>
        ) : (
          <List
            size="small"
            dataSource={me.building_scopes}
            renderItem={(building) => (
              <List.Item>
                {building.name}（{building.id.slice(0, 8)}…）
              </List.Item>
            )}
          />
        )}
      </Card>
      <Card title="能力清单（驱动界面显隐，SEC-AZ-05）">
        {me.capabilities.map((capability) => (
          <Tag key={capability} style={{ marginBottom: 8 }}>
            {capability}
          </Tag>
        ))}
      </Card>
      <Card title="修改密码">
        {notice !== null && (
          <Alert type="success" message={notice} style={{ marginBottom: 16 }} showIcon />
        )}
        <ChangePasswordForm
          onDone={() => {
            setNotice('密码已更新，其他会话已登出。');
          }}
        />
      </Card>
    </Space>
  );
}
