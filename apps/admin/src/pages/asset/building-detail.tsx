/**
 * 楼宇详情页 /assets/buildings/:id（M1-asset §7 行 2）：
 * 系统列表（system_type 分组）+ 网关卡片区（在线徽标 / last_seen_at 相对时间）+
 * 新建系统 / 登记网关入口。数据：GET /buildings/{id}、GET /buildings/{id}/systems、
 * GET /gateways?building_id=；写：POST /systems、POST /gateways。
 */
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  SYSTEM_TYPES,
  BuildingSchema,
  GatewayListResponseSchema,
  GatewaySchema,
  HvacSystemSchema,
  SystemListResponseSchema,
  SystemCreateSchema,
  GatewayCreateSchema,
  type Building,
  type Gateway,
  type HvacSystem,
} from '@thermio/shared-types';
import { apiFetch } from '../../app/api-client.js';
import { errorText, useHasCapability } from './asset-shared.js';

function relativeTime(iso: string | null): string {
  if (iso === null) return '从未上线';
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${String(minutes)} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} 小时前`;
  return `${String(Math.floor(hours / 24))} 天前`;
}

export function BuildingDetailPage(): React.ReactNode {
  const { buildingId } = useParams<{ buildingId: string }>();
  const canWrite = useHasCapability('assets.write');
  const canGateway = useHasCapability('gateways.manage');
  const [building, setBuilding] = useState<Building | null>(null);
  const [systems, setSystems] = useState<HvacSystem[]>([]);
  const [gateways, setGateways] = useState<Gateway[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [systemModal, setSystemModal] = useState(false);
  const [gatewayModal, setGatewayModal] = useState(false);
  const [systemForm] = Form.useForm();
  const [gatewayForm] = Form.useForm();

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const [b, s, g] = await Promise.all([
        apiFetch(`/buildings/${String(buildingId)}`, BuildingSchema),
        apiFetch(`/buildings/${String(buildingId)}/systems`, SystemListResponseSchema),
        apiFetch(`/gateways?building_id=${String(buildingId)}`, GatewayListResponseSchema),
      ]);
      setBuilding(b);
      setSystems(s.items);
      setGateways(g.items);
    } catch (cause) {
      setError(errorText(cause, '楼宇详情加载失败'));
    }
  }, [buildingId]);

  useEffect(() => {
    void load();
  }, [load]);

  const grouped = new Map<string, HvacSystem[]>();
  for (const system of systems) {
    const bucket = grouped.get(system.system_type) ?? [];
    bucket.push(system);
    grouped.set(system.system_type, bucket);
  }

  async function createSystem(values: { system_type: string; name: string }): Promise<void> {
    const parsed = SystemCreateSchema.safeParse({
      building_id: buildingId,
      system_type: values.system_type,
      name: values.name,
    });
    if (!parsed.success) {
      void message.error('表单不符合契约');
      return;
    }
    try {
      await apiFetch('/systems', HvacSystemSchema, { method: 'POST', body: parsed.data });
      void message.success('系统已创建');
      setSystemModal(false);
      systemForm.resetFields();
      await load();
    } catch (cause) {
      void message.error(errorText(cause, '创建失败'));
    }
  }

  async function registerGateway(values: {
    serial: string;
    name: string;
    vendor_model?: string;
  }): Promise<void> {
    const parsed = GatewayCreateSchema.safeParse({
      serial: values.serial,
      name: values.name,
      building_id: buildingId,
      vendor_model: values.vendor_model,
    });
    if (!parsed.success) {
      void message.error('serial 字符集或长度不合规（字母数字开头，可含 . _ -，≤64）');
      return;
    }
    try {
      await apiFetch('/gateways', GatewaySchema, { method: 'POST', body: parsed.data });
      void message.success('网关已登记（凭证需在详情页显式发放）');
      setGatewayModal(false);
      gatewayForm.resetFields();
      await load();
    } catch (cause) {
      void message.error(errorText(cause, '登记失败'));
    }
  }

  if (building === null) {
    return error !== null ? <Alert type="error" showIcon message={error} /> : <Spin />;
  }

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Typography.Title level={3} style={{ margin: 0 }}>
        {building.name}
        <Tag style={{ marginLeft: 12 }}>{building.building_type ?? '未分类'}</Tag>
      </Typography.Title>
      {error !== null && <Alert type="error" showIcon message={error} />}

      <Card
        title="系统（按类型分组）"
        extra={
          canWrite && (
            <Button
              type="primary"
              onClick={() => {
                setSystemModal(true);
              }}
            >
              新建系统
            </Button>
          )
        }
      >
        {systems.length === 0 ? (
          <Empty description="暂无系统" />
        ) : (
          [...grouped.entries()].map(([type, group]) => (
            <div key={type} style={{ marginBottom: 16 }}>
              <Typography.Text strong>{type}</Typography.Text>
              <Row gutter={[12, 12]} style={{ marginTop: 8 }}>
                {group.map((system) => (
                  <Col key={system.id} xs={24} sm={12} lg={8}>
                    <Card size="small" hoverable>
                      <Link to={`/assets/systems/${system.id}`}>
                        <Space>{system.name}</Space>
                      </Link>
                    </Card>
                  </Col>
                ))}
              </Row>
            </div>
          ))
        )}
      </Card>

      <Card
        title="网关"
        extra={
          canGateway && (
            <Button
              type="primary"
              onClick={() => {
                setGatewayModal(true);
              }}
            >
              登记网关
            </Button>
          )
        }
      >
        {gateways.length === 0 ? (
          <Empty description="暂无网关" />
        ) : (
          <Row gutter={[12, 12]}>
            {gateways.map((gateway) => (
              <Col key={gateway.id} xs={24} sm={12} lg={8}>
                <Card
                  size="small"
                  hoverable
                  title={<Link to={`/assets/gateways/${gateway.id}`}>{gateway.name}</Link>}
                  extra={
                    <Badge
                      status={gateway.status === 'online' ? 'success' : 'default'}
                      text={gateway.status === 'online' ? '在线' : '离线'}
                    />
                  }
                >
                  <p>serial：{gateway.serial}</p>
                  <p>最近在线：{relativeTime(gateway.last_seen_at)}</p>
                </Card>
              </Col>
            ))}
          </Row>
        )}
      </Card>

      <Modal
        title="新建系统"
        open={systemModal}
        onCancel={() => {
          setSystemModal(false);
        }}
        onOk={() => {
          systemForm.submit();
        }}
        destroyOnHidden
      >
        <Form
          form={systemForm}
          layout="vertical"
          onFinish={(values: Parameters<typeof createSystem>[0]) => {
            void createSystem(values);
          }}
        >
          <Form.Item name="system_type" label="系统类型" rules={[{ required: true }]}>
            <Select options={SYSTEM_TYPES.map((value) => ({ value, label: value }))} />
          </Form.Item>
          <Form.Item name="name" label="系统名称" rules={[{ required: true, min: 1, max: 128 }]}>
            <Input maxLength={128} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="登记网关"
        open={gatewayModal}
        onCancel={() => {
          setGatewayModal(false);
        }}
        onOk={() => {
          gatewayForm.submit();
        }}
        destroyOnHidden
      >
        <Form
          form={gatewayForm}
          layout="vertical"
          onFinish={(values: Parameters<typeof registerGateway>[0]) => {
            void registerGateway(values);
          }}
        >
          <Form.Item
            name="serial"
            label="序列号（全局唯一）"
            rules={[
              { required: true },
              { pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, message: '字母数字开头，可含 . _ -' },
            ]}
          >
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item name="name" label="网关名称" rules={[{ required: true, min: 1, max: 128 }]}>
            <Input maxLength={128} />
          </Form.Item>
          <Form.Item name="vendor_model" label="厂商型号">
            <Input maxLength={128} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
