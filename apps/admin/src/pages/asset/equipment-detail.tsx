/**
 * 设备详情页 /assets/equipments/:id（M1-asset §7 行 4）：铭牌 rated_params 键值表 +
 * 点位表（实时值列 tabular-nums 右对齐；quality≠0 灰化；disabled 点整行灰化）+
 * quantity/direction 筛选。数据：GET /equipments/{id}、GET /equipments/{id}/points。
 */
import { Alert, Card, Descriptions, Select, Space, Spin, Table, Tag, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  DIRECTIONS,
  QUANTITY_TYPES,
  EquipmentSchema,
  PointListResponseSchema,
  type Equipment,
  type PointListItem,
} from '@thermio/shared-types';
import { apiFetch } from '../../app/api-client.js';
import { errorText } from './asset-shared.js';

export function EquipmentDetailPage(): React.ReactNode {
  const { equipmentId } = useParams<{ equipmentId: string }>();
  const [equipment, setEquipment] = useState<Equipment | null>(null);
  const [items, setItems] = useState<PointListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [quantityFilter, setQuantityFilter] = useState<string | undefined>(undefined);
  const [directionFilter, setDirectionFilter] = useState<string | undefined>(undefined);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const [e, p] = await Promise.all([
        apiFetch(`/equipments/${String(equipmentId)}`, EquipmentSchema),
        apiFetch(`/equipments/${String(equipmentId)}/points`, PointListResponseSchema),
      ]);
      setEquipment(e);
      setItems(p.items);
    } catch (cause) {
      setError(errorText(cause, '设备详情加载失败'));
    }
  }, [equipmentId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (equipment === null) {
    return error !== null ? <Alert type="error" showIcon message={error} /> : <Spin />;
  }

  const filtered = items.filter((item) => {
    if (quantityFilter !== undefined && item.point.quantity_type !== quantityFilter) return false;
    if (directionFilter !== undefined && item.point.direction !== directionFilter) return false;
    return true;
  });

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Typography.Title level={3} style={{ margin: 0 }}>
        {equipment.name}
        <Tag style={{ marginLeft: 12 }}>{equipment.equipment_type}</Tag>
      </Typography.Title>
      {error !== null && <Alert type="error" showIcon message={error} />}

      <Card title="铭牌参数" size="small">
        {equipment.rated_params === null || Object.keys(equipment.rated_params).length === 0 ? (
          <Typography.Text type="secondary">未登记铭牌参数</Typography.Text>
        ) : (
          <Descriptions size="small" column={2}>
            {Object.entries(equipment.rated_params).map(([key, value]) => (
              <Descriptions.Item key={key} label={key}>
                <code>{renderParam(value)}</code>
              </Descriptions.Item>
            ))}
          </Descriptions>
        )}
      </Card>

      <Card
        title="点位"
        extra={
          <Space>
            <Select
              allowClear
              placeholder="量类型"
              style={{ width: 180 }}
              value={quantityFilter}
              onChange={(v) => {
                setQuantityFilter(v);
              }}
              options={QUANTITY_TYPES.map((value) => ({ value, label: value }))}
            />
            <Select
              allowClear
              placeholder="方向"
              style={{ width: 130 }}
              value={directionFilter}
              onChange={(v) => {
                setDirectionFilter(v);
              }}
              options={DIRECTIONS.map((value) => ({ value, label: value }))}
            />
          </Space>
        }
      >
        <Table<PointListItem>
          rowKey={(item) => item.point.id}
          size="small"
          pagination={false}
          dataSource={filtered}
          rowClassName={(item) => (item.point.status === 'disabled' ? 'point-row-disabled' : '')}
          columns={[
            {
              title: '点位',
              dataIndex: ['point', 'raw_name'],
              render: (rawName: string, item) => (
                <Link to={`/assets/points/${String(item.point.id)}`}>
                  {item.point.display_name ?? rawName}
                </Link>
              ),
            },
            {
              title: '量类型',
              dataIndex: ['point', 'quantity_type'],
              render: (v: string | null) => v ?? '—',
            },
            {
              title: '单位',
              dataIndex: ['point', 'unit_std'],
              render: (v: string | null) => v ?? '—',
            },
            { title: '方向', dataIndex: ['point', 'direction'] },
            {
              title: '实时值',
              render: (_, item) =>
                item.latest === null ? (
                  <Typography.Text type="secondary">—</Typography.Text>
                ) : (
                  <span
                    className={item.latest.quality !== 0 ? 'latest-quality-bad' : undefined}
                    style={{
                      fontVariantNumeric: 'tabular-nums',
                      float: 'right',
                      color: item.latest.quality !== 0 ? undefined : 'inherit',
                      opacity: item.latest.quality !== 0 ? 0.45 : 1,
                    }}
                    title={
                      item.latest.quality !== 0
                        ? `quality=${String(item.latest.quality)}`
                        : undefined
                    }
                  >
                    {item.latest.value_text ??
                      (item.latest.value !== null ? String(item.latest.value) : '—')}
                  </span>
                ),
            },
            {
              title: '状态',
              dataIndex: ['point', 'status'],
              render: (status: string) =>
                status === 'active' ? <Tag color="green">active</Tag> : <Tag>disabled</Tag>,
            },
          ]}
        />
      </Card>
    </Space>
  );
}

/** 铭牌值渲染：unknown 收窄（TS-02）——对象 JSON 化，基元字面量化。 */
function renderParam(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }
  return JSON.stringify(value);
}
