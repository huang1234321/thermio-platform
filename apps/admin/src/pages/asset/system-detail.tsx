/**
 * 系统详情页 /assets/systems/:id（M1-asset §7 行 3）：设备列表（equipment_type 筛选）
 * + 新建设备（rated_params 键值编辑器——铭牌自由结构）。
 * 数据：GET /systems/{id}、GET /systems/{id}/equipments；写：POST /equipments。
 */
import {
  Alert,
  Button,
  Card,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Table,
  Typography,
  message,
} from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  EQUIPMENT_TYPES,
  EquipmentListResponseSchema,
  EquipmentCreateSchema,
  EquipmentSchema,
  HvacSystemSchema,
  type Equipment,
  type HvacSystem,
} from '@thermio/shared-types';
import { apiFetch } from '../../app/api-client.js';
import { errorText, useHasCapability } from './asset-shared.js';

interface KvRow {
  key: number;
  paramKey: string;
  paramValue: string;
}

export function SystemDetailPage(): React.ReactNode {
  const { systemId } = useParams<{ systemId: string }>();
  const canWrite = useHasCapability('assets.write');
  const [system, setSystem] = useState<HvacSystem | null>(null);
  const [items, setItems] = useState<Equipment[]>([]);
  const [typeFilter, setTypeFilter] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form] = Form.useForm();

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const [s, list] = await Promise.all([
        apiFetch(`/systems/${String(systemId)}`, HvacSystemSchema),
        apiFetch(`/systems/${String(systemId)}/equipments`, EquipmentListResponseSchema),
      ]);
      setSystem(s);
      setItems(list.items);
    } catch (cause) {
      setError(errorText(cause, '系统详情加载失败'));
    }
  }, [systemId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createEquipment(values: {
    equipment_type: string;
    name: string;
    local_id?: string;
    vendor_model?: string;
    commission_date?: string;
    ratedParams: KvRow[];
  }): Promise<void> {
    const ratedParams: Record<string, unknown> = {};
    for (const row of values.ratedParams) {
      if (row.paramKey.trim().length > 0) ratedParams[row.paramKey.trim()] = coerce(row.paramValue);
    }
    const parsed = EquipmentCreateSchema.safeParse({
      system_id: systemId,
      equipment_type: values.equipment_type,
      name: values.name,
      local_id: values.local_id,
      vendor_model: values.vendor_model,
      commission_date: values.commission_date,
      rated_params: Object.keys(ratedParams).length > 0 ? ratedParams : null,
    });
    if (!parsed.success) {
      void message.error('表单不符合契约（检查日期格式 YYYY-MM-DD）');
      return;
    }
    try {
      await apiFetch('/equipments', EquipmentSchema, { method: 'POST', body: parsed.data });
      void message.success('设备已创建');
      setCreating(false);
      form.resetFields();
      await load();
    } catch (cause) {
      void message.error(errorText(cause, '创建失败'));
    }
  }

  if (system === null) {
    return error !== null ? <Alert type="error" showIcon message={error} /> : <Spin />;
  }

  const filtered =
    typeFilter === undefined ? items : items.filter((e) => e.equipment_type === typeFilter);

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Typography.Title level={3} style={{ margin: 0 }}>
        {system.name}
        <Typography.Text type="secondary" style={{ marginLeft: 12, fontSize: 14 }}>
          {system.system_type}
        </Typography.Text>
      </Typography.Title>
      {error !== null && <Alert type="error" showIcon message={error} />}

      <Card
        title="设备"
        extra={
          <Space>
            <Select
              allowClear
              placeholder="类型筛选"
              style={{ width: 160 }}
              value={typeFilter}
              onChange={(value) => {
                setTypeFilter(value);
              }}
              options={EQUIPMENT_TYPES.map((value) => ({ value, label: value }))}
            />
            {canWrite && (
              <Button
                type="primary"
                onClick={() => {
                  setCreating(true);
                }}
              >
                新建设备
              </Button>
            )}
          </Space>
        }
      >
        {filtered.length === 0 ? (
          <Empty description="暂无设备" />
        ) : (
          <Table<Equipment>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={filtered}
            columns={[
              {
                title: '名称',
                dataIndex: 'name',
                render: (name: string, record) => (
                  <Link to={`/assets/equipments/${record.id}`}>{name}</Link>
                ),
              },
              { title: '类型', dataIndex: 'equipment_type' },
              { title: '现场编号', dataIndex: 'local_id', render: (v: string | null) => v ?? '—' },
              {
                title: '厂商型号',
                dataIndex: 'vendor_model',
                render: (v: string | null) => v ?? '—',
              },
              {
                title: '投运日期',
                dataIndex: 'commission_date',
                render: (v: string | null) => v ?? '—',
              },
            ]}
          />
        )}
      </Card>

      <Modal
        title="新建设备"
        open={creating}
        onCancel={() => {
          setCreating(false);
        }}
        onOk={() => {
          form.submit();
        }}
        destroyOnHidden
        width={560}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(values: Parameters<typeof createEquipment>[0]) => {
            void createEquipment(values);
          }}
        >
          <Form.Item name="equipment_type" label="设备类型" rules={[{ required: true }]}>
            <Select options={EQUIPMENT_TYPES.map((value) => ({ value, label: value }))} />
          </Form.Item>
          <Form.Item name="name" label="设备名称" rules={[{ required: true, min: 1, max: 128 }]}>
            <Input maxLength={128} />
          </Form.Item>
          <Form.Item name="local_id" label="现场编号（同系统内唯一）">
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item name="vendor_model" label="厂商型号">
            <Input maxLength={128} />
          </Form.Item>
          <Form.Item
            name="commission_date"
            label="投运日期"
            tooltip="ISO 日期，格式 YYYY-MM-DD；预投运可留空"
          >
            <Input placeholder="2026-01-15" />
          </Form.Item>
          <Form.Item label="铭牌参数（键值对，自由结构）">
            <Form.List name="ratedParams">
              {(fields, { add, remove }) => (
                <>
                  {fields.map((field) => (
                    <Space key={field.key} style={{ display: 'flex' }} align="baseline">
                      <Form.Item name={[field.name, 'paramKey']} noStyle>
                        <Input placeholder="参数名（如 cooling_kw）" style={{ width: 200 }} />
                      </Form.Item>
                      <Form.Item name={[field.name, 'paramValue']} noStyle>
                        <Input placeholder="值" style={{ width: 160 }} />
                      </Form.Item>
                      <Button
                        type="link"
                        danger
                        onClick={() => {
                          remove(field.name);
                        }}
                      >
                        删除
                      </Button>
                    </Space>
                  ))}
                  <Button
                    type="dashed"
                    block
                    onClick={() => {
                      add({ paramKey: '', paramValue: '' });
                    }}
                  >
                    添加参数
                  </Button>
                </>
              )}
            </Form.List>
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}

/** 铭牌值尽量转数值（自由结构允许字符串原样保留）。 */
function coerce(value: string): unknown {
  const num = Number(value);
  return value.trim().length > 0 && !Number.isNaN(num) ? num : value;
}
