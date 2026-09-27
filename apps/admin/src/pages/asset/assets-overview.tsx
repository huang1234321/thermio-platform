/**
 * 资产总览页 /assets（M1-asset §7 行 1）：楼宇卡片 + 关键词检索 + 新建/编辑楼宇弹窗。
 * 数据：GET /buildings（?keyword）；写操作 POST/PATCH /buildings（assets.write）。
 * 枚举 Select 选 building_type（枚举单一来源 shared-types，CODE-ST-03）。
 */
import {
  Alert,
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
  Typography,
  message,
} from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  BUILDING_TYPES,
  BuildingListResponseSchema,
  BuildingSchema,
  type Building,
} from '@thermio/shared-types';
import { apiFetch } from '../../app/api-client.js';
import { errorText, useHasCapability } from './asset-shared.js';

export function AssetsOverviewPage(): React.ReactNode {
  const canWrite = useHasCapability('assets.write');
  const [items, setItems] = useState<Building[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Building | null>(null);
  const [form] = Form.useForm();

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (keyword.trim().length > 0) params.set('keyword', keyword.trim());
      const result = await apiFetch(`/buildings?${params.toString()}`, BuildingListResponseSchema);
      setItems(result.items);
    } catch (cause) {
      setError(errorText(cause, '楼宇列表加载失败'));
    } finally {
      setLoading(false);
    }
  }, [keyword]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(values: Record<string, unknown>): Promise<void> {
    const payload = Object.fromEntries(
      Object.entries(values).filter(([, v]) => v !== undefined && v !== ''),
    );
    try {
      if (editing !== null) {
        await apiFetch(`/buildings/${editing.id}`, BuildingSchema, {
          method: 'PATCH',
          body: payload,
        });
      } else {
        await apiFetch('/buildings', BuildingSchema, { method: 'POST', body: payload });
      }
      void message.success(editing !== null ? '楼宇已更新' : '楼宇已创建');
      setCreating(false);
      setEditing(null);
      form.resetFields();
      await load();
    } catch (cause) {
      void message.error(errorText(cause, '保存失败'));
    }
  }

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Typography.Title level={3} style={{ margin: 0 }}>
        资产总览
      </Typography.Title>
      <Space wrap>
        <Input.Search
          placeholder="楼宇名称 / 地址检索"
          allowClear
          style={{ width: 260 }}
          onSearch={(value) => {
            setKeyword(value);
          }}
        />
        {canWrite && (
          <Button
            type="primary"
            onClick={() => {
              setEditing(null);
              setCreating(true);
              form.resetFields();
            }}
          >
            新建楼宇
          </Button>
        )}
      </Space>
      {error !== null && <Alert type="error" showIcon message={error} />}
      <Row gutter={[16, 16]}>
        {items.map((building) => (
          <Col key={building.id} xs={24} sm={12} lg={8} xl={6}>
            <Card
              hoverable
              title={<Link to={`/assets/buildings/${building.id}`}>{building.name}</Link>}
              extra={
                canWrite && (
                  <Button
                    size="small"
                    onClick={() => {
                      setEditing(building);
                      setCreating(true);
                      form.setFieldsValue(building);
                    }}
                  >
                    编辑
                  </Button>
                )
              }
            >
              <p>类型：{building.building_type ?? '—'}</p>
              <p>地址：{building.address ?? '—'}</p>
              <p>
                建筑面积：
                {building.gross_area_m2 !== null ? `${String(building.gross_area_m2)} m²` : '—'}
              </p>
              <p>气候区：{building.climate_zone ?? '—'}</p>
            </Card>
          </Col>
        ))}
      </Row>
      {!loading && items.length === 0 && error === null && <Empty description="暂无楼宇" />}

      <Modal
        title={editing !== null ? '编辑楼宇' : '新建楼宇'}
        open={creating}
        onCancel={() => {
          setCreating(false);
          setEditing(null);
        }}
        onOk={() => {
          form.submit();
        }}
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(values: Parameters<typeof submit>[0]) => {
            void submit(values);
          }}
        >
          <Form.Item name="name" label="楼宇名称" rules={[{ required: true, min: 1, max: 128 }]}>
            <Input maxLength={128} />
          </Form.Item>
          <Form.Item name="address" label="地址">
            <Input maxLength={256} />
          </Form.Item>
          <Form.Item name="building_type" label="楼宇类型">
            <Select allowClear options={BUILDING_TYPES.map((value) => ({ value, label: value }))} />
          </Form.Item>
          <Form.Item name="gross_area_m2" label="建筑面积（m²）">
            <Input type="number" />
          </Form.Item>
          <Form.Item name="climate_zone" label="气候区">
            <Input maxLength={32} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
