/**
 * 网关详情页 /assets/gateways/:id（M1-asset §7 行 6）：档案 + 在线状态 +
 * offline_action 展示（只读表格）+ 凭证表（元数据）；**轮换**：§4.2 二次确认
 * （「密钥仅本次返回」提示）→ 201 后弹窗展示 secret + 复制按钮，关闭即不可再取；
 * **吊销**：危险色按钮 + 确认（reason 可选）；吊销后 enabled=false 徽标。
 * 数据：GET /gateways/{id}（GatewayDetail 含 credentials 元数据）。
 */
import {
  Alert,
  Badge,
  Button,
  Card,
  Descriptions,
  Input,
  Modal,
  Popconfirm,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  CredentialIssueResponseSchema,
  CredentialMetaSchema,
  GatewayDetailSchema,
  type CredentialIssueResponse,
  type GatewayDetail,
} from '@thermio/shared-types';
import { apiFetch } from '../../app/api-client.js';
import { errorText, useHasCapability } from './asset-shared.js';

export function GatewayDetailPage(): React.ReactNode {
  const { gatewayId: rawGatewayId } = useParams<{ gatewayId: string }>();
  const gatewayId = rawGatewayId ?? '';
  const canManage = useHasCapability('gateways.manage');
  const [gateway, setGateway] = useState<GatewayDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secretShown, setSecretShown] = useState<CredentialIssueResponse | null>(null);
  const [revoking, setRevoking] = useState<{ id: string; username: string } | null>(null);
  const [revokeReason, setRevokeReason] = useState('');

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      setGateway(await apiFetch(`/gateways/${gatewayId}`, GatewayDetailSchema));
    } catch (cause) {
      setError(errorText(cause, '网关详情加载失败'));
    }
  }, [gatewayId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function issueCredential(): Promise<void> {
    try {
      const issued = await apiFetch(
        `/gateways/${gatewayId}/credentials`,
        CredentialIssueResponseSchema,
        { method: 'POST', body: {} },
      );
      setSecretShown(issued); // secret 仅本次展示（§3.9）
      await load();
    } catch (cause) {
      void message.error(errorText(cause, '发放失败（活跃凭证上限 2）'));
    }
  }

  async function revokeCredential(): Promise<void> {
    if (revoking === null) return;
    try {
      await apiFetch(`/credentials/${revoking.id}/disable`, CredentialMetaSchema, {
        method: 'POST',
        body: revokeReason.trim().length > 0 ? { reason: revokeReason.trim() } : {},
      });
      void message.success('凭证已吊销（在线会话 ≤5min 或断连后失效）');
      setRevoking(null);
      setRevokeReason('');
      await load();
    } catch (cause) {
      void message.error(errorText(cause, '吊销失败'));
    }
  }

  if (gateway === null) {
    return error !== null ? <Alert type="error" showIcon message={error} /> : <Spin />;
  }

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Typography.Title level={3} style={{ margin: 0 }}>
        {gateway.name}
        <Badge
          style={{ marginLeft: 12 }}
          status={gateway.status === 'online' ? 'success' : 'default'}
          text={gateway.status === 'online' ? '在线' : '离线'}
        />
      </Typography.Title>
      {error !== null && <Alert type="error" showIcon message={error} />}

      <Card title="档案" size="small">
        <Descriptions size="small" column={2}>
          <Descriptions.Item label="serial">
            <code>{gateway.serial}</code>
          </Descriptions.Item>
          <Descriptions.Item label="mqtt_client_id">
            <code>{gateway.mqtt_client_id}</code>
          </Descriptions.Item>
          <Descriptions.Item label="厂商型号">{gateway.vendor_model ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="最近在线">
            {gateway.last_seen_at ?? '从未上线'}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <Card title="断链兜底动作（offline_action，只读——value 为 unit_std 口径）" size="small">
        {gateway.offline_action === null || gateway.offline_action.writes.length === 0 ? (
          <Typography.Text type="secondary">未配置</Typography.Text>
        ) : (
          <Table
            rowKey="raw_name"
            size="small"
            pagination={false}
            dataSource={gateway.offline_action.writes}
            columns={[
              { title: 'raw_name', dataIndex: 'raw_name' },
              { title: '安全值（unit_std）', dataIndex: 'value' },
            ]}
          />
        )}
      </Card>

      <Card
        title="凭证"
        size="small"
        extra={
          canManage && (
            <Popconfirm
              title="发放新凭证？"
              description="密钥仅本次返回，关闭弹窗后不可再取。"
              onConfirm={() => {
                void issueCredential();
              }}
            >
              <Button type="primary">
                {gateway.credentials.length === 0 ? '发放凭证' : '轮换凭证'}
              </Button>
            </Popconfirm>
          )
        }
      >
        {gateway.credentials.length === 0 ? (
          <Space direction="vertical">
            <Typography.Text type="secondary">
              尚无凭证——登记不自动发放（避免无人知晓的密钥）。
            </Typography.Text>
            {canManage && (
              <Button
                onClick={() => {
                  void issueCredential();
                }}
              >
                发放首条凭证
              </Button>
            )}
          </Space>
        ) : (
          <Table
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={gateway.credentials}
            columns={[
              { title: 'username', dataIndex: 'username', render: (v: string) => <code>{v}</code> },
              {
                title: '状态',
                dataIndex: 'enabled',
                render: (enabled: boolean) =>
                  enabled ? <Tag color="green">enabled</Tag> : <Tag>disabled（已吊销）</Tag>,
              },
              { title: '发放时间', dataIndex: 'created_at' },
              {
                title: '操作',
                render: (_, record) =>
                  canManage &&
                  record.enabled && (
                    <Button
                      size="small"
                      danger
                      onClick={() => {
                        setRevoking({ id: record.id, username: record.username });
                        setRevokeReason('');
                      }}
                    >
                      吊销
                    </Button>
                  ),
              },
            ]}
          />
        )}
      </Card>

      <Modal
        title="新凭证（仅本次可见）"
        open={secretShown !== null}
        footer={null}
        onCancel={() => {
          setSecretShown(null);
        }}
        destroyOnHidden
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Alert type="warning" showIcon message="关闭弹窗后 secret 不可再取，请立即复制保存。" />
          <Typography.Paragraph>
            username：<code>{secretShown?.credential.username}</code>
          </Typography.Paragraph>
          <Input.TextArea
            readOnly
            autoSize
            value={secretShown?.secret ?? ''}
            style={{ fontFamily: 'monospace' }}
          />
          <Button
            onClick={() => {
              void navigator.clipboard
                .writeText(secretShown?.secret ?? '')
                .then(() => message.success('已复制'))
                .catch(() => message.error('复制失败，请手动选择'));
            }}
          >
            复制 secret
          </Button>
        </Space>
      </Modal>

      <Modal
        title="吊销凭证（单向，不可恢复）"
        open={revoking !== null}
        onCancel={() => {
          setRevoking(null);
        }}
        onOk={() => void revokeCredential()}
        okButtonProps={{ danger: true }}
        okText="确认吊销"
        destroyOnHidden
      >
        <Typography.Paragraph>
          即将吊销 <code>{revoking?.username}</code>。在线会话最长存活至断连或认证缓存过期（约 5
          分钟）。 需要再用 = 新发凭证。
        </Typography.Paragraph>
        <Input.TextArea
          placeholder="原因（可选）"
          value={revokeReason}
          maxLength={512}
          onChange={(event) => {
            setRevokeReason(event.target.value);
          }}
          rows={2}
        />
      </Modal>
    </Space>
  );
}
