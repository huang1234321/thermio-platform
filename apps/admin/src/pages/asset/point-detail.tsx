/**
 * 点位详情页 /assets/points/:id（M1-asset §7 行 5——baseline §3.2 原型重点页）：
 * 头卡（控制模式徽标 + status 徽标）→ 物理层卡（只读）→ 语义层卡（编辑，operator+）→
 * 闸门参数面板（只读 + 「在控制安全中编辑」跳 M8，写能力者可见）→ 实时值卡 →
 * 趋势图（interval 切换 raw/5min/1h，内联 SVG 无新依赖）；
 * 启停（admin）：§4.2 二次确认 diff=status old→new + reason 必填；disabled 顶部横幅。
 */
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  QUANTITY_TYPES,
  PointDetailSchema,
  PointLatestSchema,
  PointSchema,
  type PointDetail,
  type PointLatest,
} from '@thermio/shared-types';
import { apiFetch } from '../../app/api-client.js';
import { errorText, useHasCapability } from './asset-shared.js';
import { PointTrend, type TrendSample } from './point-trend.js';

const TELEMETRY_SCHEMA = {
  parse: (body: unknown): { items: TrendSample[] } | null => {
    if (typeof body !== 'object' || body === null) return null;
    const items = (body as { items?: unknown }).items;
    if (!Array.isArray(items)) return null;
    return { items: items as TrendSample[] };
  },
  // apiFetch 需要 safeParse 形状
  safeParse: (input: unknown) => {
    const parsed = TELEMETRY_SCHEMA.parse(input);
    return parsed === null ? { success: false as const } : { success: true as const, data: parsed };
  },
};

async function loadTrend(pointId: string, interval: 'raw' | '5min' | '1h'): Promise<TrendSample[]> {
  const to = new Date();
  const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    interval,
    from: from.toISOString(),
    to: to.toISOString(),
    limit: '500',
  });
  const page = await apiFetch<{ items: TrendSample[] }>(
    `/points/${pointId}/telemetry?${params.toString()}`,
    TELEMETRY_SCHEMA,
  );
  return page.items;
}

export function PointDetailPage(): React.ReactNode {
  const { pointId: rawPointId } = useParams<{ pointId: string }>();
  const pointId = rawPointId ?? '';
  const navigate = useNavigate();
  const canSemantics = useHasCapability('points.semantics.write');
  const canStatus = useHasCapability('points.status.write');
  const canControl = useHasCapability('control.read');
  const [point, setPoint] = useState<PointDetail | null>(null);
  const [latest, setLatest] = useState<PointLatest | null>(null);
  const [latestError, setLatestError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [statusModal, setStatusModal] = useState(false);
  const [trendInterval, setTrendInterval] = useState<'raw' | '5min' | '1h'>('raw');
  const [trend, setTrend] = useState<TrendSample[]>([]);
  /** 详情重载计数：语义/启停变更后联动刷新趋势。 */
  const [revision, setRevision] = useState(0);
  const [form] = Form.useForm();
  const [statusForm] = Form.useForm();

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const detail = await apiFetch(`/points/${pointId}`, PointDetailSchema);
      setPoint(detail);
      try {
        setLatest(await apiFetch(`/points/${pointId}/latest`, PointLatestSchema));
        setLatestError(null);
      } catch {
        setLatest(null); // point.no_data / 存储未配置 → 无数据态
        setLatestError('暂无遥测数据');
      }
    } catch (cause) {
      setError(errorText(cause, '点位详情加载失败'));
    } finally {
      setRevision((n) => n + 1);
    }
  }, [pointId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    loadTrend(pointId, trendInterval)
      .then(setTrend)
      .catch(() => {
        setTrend([]);
      });
  }, [pointId, trendInterval, revision]);

  async function saveSemantics(values: {
    display_name?: string;
    description?: string;
    quantity_type?: string;
    unit_raw?: string;
    unit_std?: string;
  }): Promise<void> {
    const payload: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(values)) {
      payload[key] = typeof value === 'string' && value.length > 0 ? value : null;
    }
    try {
      await apiFetch(`/points/${pointId}`, PointSchema, { method: 'PATCH', body: payload });
      void message.success('语义已更新（ingest 配置缓存 ≤30s 收敛）');
      setEditing(false);
      await load();
    } catch (cause) {
      void message.error(errorText(cause, '保存失败'));
    }
  }

  async function applyStatus(values: { reason: string }): Promise<void> {
    const target = point?.status === 'active' ? 'disabled' : 'active';
    try {
      await apiFetch(`/points/${pointId}/status`, PointSchema, {
        method: 'PATCH',
        body: { status: target, reason: values.reason },
      });
      void message.success(target === 'disabled' ? '点位已停用' : '点位已启用');
      setStatusModal(false);
      statusForm.resetFields();
      await load();
    } catch (cause) {
      void message.error(errorText(cause, '启停失败'));
    }
  }

  if (point === null) {
    return error !== null ? <Alert type="error" showIcon message={error} /> : <Spin />;
  }

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      {point.status === 'disabled' && (
        <Alert
          type="warning"
          showIcon
          message="该点位已停用：新数据走 DLQ POINT_INACTIVE 等待重放，不可作为控制建议目标。"
        />
      )}
      <Typography.Title level={3} style={{ margin: 0 }}>
        {point.display_name ?? point.raw_name}
        <Space style={{ marginLeft: 12 }}>
          <Tag color={point.control_mode === 'advisory' ? 'blue' : 'orange'}>
            {point.control_mode}
          </Tag>
          <Tag color={point.status === 'active' ? 'green' : 'default'}>{point.status}</Tag>
          <Tag>{point.direction}</Tag>
        </Space>
      </Typography.Title>
      <Typography.Text type="secondary">
        面包屑：
        <Link to={`/assets/buildings/${point.context.building.id}`}>
          {point.context.building.name}
        </Link>
        {point.context.system !== null && (
          <>
            {' '}
            /{' '}
            <Link to={`/assets/systems/${point.context.system.id}`}>
              {point.context.system.name}
            </Link>
          </>
        )}
        {point.context.equipment !== null && (
          <>
            {' '}
            /{' '}
            <Link to={`/assets/equipments/${point.context.equipment.id}`}>
              {point.context.equipment.name}
            </Link>
          </>
        )}
        {point.context.gateway !== null && <> · 网关 {point.context.gateway.name}</>}
      </Typography.Text>
      {error !== null && <Alert type="error" showIcon message={error} />}

      <Card
        title="物理层（只读）"
        size="small"
        extra={
          canStatus && (
            <Popconfirm
              title={`确认${point.status === 'active' ? '停用' : '启用'}该点位？`}
              onConfirm={() => {
                setStatusModal(true);
              }}
            >
              <Button danger={point.status === 'active'}>
                {point.status === 'active' ? '停用点位' : '启用点位'}
              </Button>
            </Popconfirm>
          )
        }
      >
        <Descriptions size="small" column={2}>
          <Descriptions.Item label="raw_name">
            <code>{point.raw_name}</code>
          </Descriptions.Item>
          <Descriptions.Item label="source_type">{point.source_type}</Descriptions.Item>
          <Descriptions.Item label="采集周期">
            {point.sample_interval_s !== null ? `${String(point.sample_interval_s)} s` : '—'}
          </Descriptions.Item>
          <Descriptions.Item label="protocol_address">
            <code>
              {point.protocol_address === null ? '—' : JSON.stringify(point.protocol_address)}
            </code>
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <Card
        title="语义层"
        size="small"
        extra={
          canSemantics && (
            <Button
              onClick={() => {
                setEditing(true);
                form.setFieldsValue({
                  display_name: point.display_name ?? '',
                  description: point.description ?? '',
                  quantity_type: point.quantity_type ?? undefined,
                  unit_raw: point.unit_raw ?? '',
                  unit_std: point.unit_std ?? '',
                });
              }}
            >
              编辑语义
            </Button>
          )
        }
      >
        <Descriptions size="small" column={2}>
          <Descriptions.Item label="显示名">{point.display_name ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="量类型">{point.quantity_type ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="原始单位">{point.unit_raw ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="标准单位">{point.unit_std ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="描述" span={2}>
            {point.description ?? '—'}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <Card
        title="闸门参数（只读）"
        size="small"
        extra={
          canControl && (
            <Button
              onClick={() => {
                void navigate('/control/points');
              }}
            >
              在控制安全中编辑（M8）
            </Button>
          )
        }
      >
        <Descriptions size="small" column={3}>
          <Descriptions.Item label="可控白名单">
            {point.is_controllable ? <Tag color="green">可控</Tag> : '不可控'}
          </Descriptions.Item>
          <Descriptions.Item label="值域 clamp">
            {point.clamp_min !== null && point.clamp_max !== null
              ? `[${String(point.clamp_min)}, ${String(point.clamp_max)}]`
              : '—'}
          </Descriptions.Item>
          <Descriptions.Item label="写频率上限">
            {point.write_rate_limit_per_hour !== null
              ? `${String(point.write_rate_limit_per_hour)} 次/时`
              : '—'}
          </Descriptions.Item>
          <Descriptions.Item label="stale_timeout">
            {String(point.stale_timeout_s)} s
          </Descriptions.Item>
          <Descriptions.Item label="valid_range">
            {point.valid_range_min !== null && point.valid_range_max !== null
              ? `[${String(point.valid_range_min)}, ${String(point.valid_range_max)}]`
              : '—'}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <Card title="实时值" size="small">
        {latest === null ? (
          <Typography.Text type="secondary">{latestError ?? '暂无数据'}</Typography.Text>
        ) : (
          <Space size="large">
            <Typography.Title level={2} style={{ margin: 0, fontVariantNumeric: 'tabular-nums' }}>
              {latest.value_text ?? (latest.value !== null ? String(latest.value) : '—')}
              {point.unit_std !== null && <span style={{ fontSize: 14 }}> {point.unit_std}</span>}
            </Typography.Title>
            <Typography.Text type="secondary">
              ts {latest.ts} · quality {String(latest.quality)}
              {latest.quality !== 0 ? '（非 good，灰化）' : ''}
            </Typography.Text>
          </Space>
        )}
      </Card>

      <Card
        title="趋势"
        size="small"
        extra={
          <Select
            size="small"
            style={{ width: 110 }}
            value={trendInterval}
            onChange={(value) => {
              setTrendInterval(value);
            }}
            options={[
              { value: 'raw', label: '原始' },
              { value: '5min', label: '5 分钟' },
              { value: '1h', label: '1 小时' },
            ]}
          />
        }
      >
        <PointTrend samples={trend} unit={point.unit_std} />
      </Card>

      <Modal
        title="编辑语义"
        open={editing}
        onCancel={() => {
          setEditing(false);
        }}
        onOk={() => {
          form.submit();
        }}
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(values: Parameters<typeof saveSemantics>[0]) => {
            void saveSemantics(values);
          }}
        >
          <Form.Item name="display_name" label="显示名">
            <Input maxLength={128} />
          </Form.Item>
          <Form.Item name="quantity_type" label="量类型">
            <Select allowClear options={QUANTITY_TYPES.map((value) => ({ value, label: value }))} />
          </Form.Item>
          <Form.Item name="unit_raw" label="原始单位">
            <Input maxLength={32} />
          </Form.Item>
          <Form.Item name="unit_std" label="标准单位">
            <Input maxLength={32} />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea maxLength={1024} rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={point.status === 'active' ? '停用点位（二次确认）' : '启用点位（二次确认）'}
        open={statusModal}
        onCancel={() => {
          setStatusModal(false);
        }}
        onOk={() => {
          statusForm.submit();
        }}
        destroyOnHidden
      >
        <Descriptions size="small" column={1} style={{ marginBottom: 16 }}>
          <Descriptions.Item label="status 变更">
            <code>{point.status}</code> →{' '}
            <code>{point.status === 'active' ? 'disabled' : 'active'}</code>
          </Descriptions.Item>
        </Descriptions>
        <Form
          form={statusForm}
          layout="vertical"
          onFinish={(values: Parameters<typeof applyStatus>[0]) => {
            void applyStatus(values);
          }}
        >
          <Form.Item
            name="reason"
            label="原因（必填，入结构化日志）"
            rules={[{ required: true, min: 1, max: 512 }]}
          >
            <Input.TextArea maxLength={512} rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
