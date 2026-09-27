/**
 * 变更审计检索页 /control/config-audit（M8-safety-ui.md §6，UC-M8-4）。
 *
 * - 四筛选项（PRD D3「谁/何时/改了什么/为什么」检索口径）：点位 / 字段（CHECK
 *   封闭集五值）/ 操作者类型（human|system）/ 时间区间；
 * - 六列：时间（绝对时间——审计语境）/ 点位 / 字段（中英并陈）/ 变更（old→new）/
 *   操作者（human=用户名 / system 徽标）/ 原因；
 * - 双轨边界（flows §6）：本页只检索 config_audit；值写审计在 M5 /control-audit
 *   ——页头固定互链说明条。
 */
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Input,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ConfigAuditListResponseSchema, type ConfigAuditItem } from '@thermio/shared-types';
import { apiFetch } from '../../app/api-client.js';
import { errorText } from '../asset/asset-shared.js';

const FIELD_LABEL: Record<ConfigAuditItem['field'], string> = {
  control_mode: '控制模式 control_mode',
  is_controllable: '受控白名单 is_controllable',
  clamp_min: '值域下限 clamp_min',
  clamp_max: '值域上限 clamp_max',
  write_rate_limit_per_hour: '频率上限 write_rate_limit_per_hour',
};

function valueText(value: unknown): string {
  if (value === null || value === undefined) return '空';
  if (typeof value === 'boolean') return value ? '开' : '关';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

export function ConfigAuditPage(): React.ReactNode {
  const [searchParams] = useSearchParams();
  const [rows, setRows] = useState<readonly ConfigAuditItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pointId, setPointId] = useState(searchParams.get('point_id') ?? '');
  const [field, setField] = useState<string | undefined>(searchParams.get('field') ?? undefined);
  const [actorType, setActorType] = useState<string | undefined>(
    searchParams.get('actor_type') ?? undefined,
  );
  const [range, setRange] = useState<[Date | null, Date | null] | null>(null);

  const load = useCallback(
    async (nextCursor?: string): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ limit: '50' });
        if (pointId.trim().length > 0) params.set('point_id', pointId.trim());
        if (field !== undefined) params.set('field', field);
        if (actorType !== undefined) params.set('actor_type', actorType);
        if (range !== null && range[0] !== null) params.set('from', range[0].toISOString());
        if (range !== null && range[1] !== null) params.set('to', range[1].toISOString());
        if (nextCursor !== undefined && nextCursor.length > 0) params.set('cursor', nextCursor);
        const response = await apiFetch(
          `/config-audit?${params.toString()}`,
          ConfigAuditListResponseSchema,
        );
        setRows((prev) =>
          nextCursor === undefined ? response.items : [...prev, ...response.items],
        );
        setCursor(response.next_cursor);
      } catch (cause) {
        setError(errorText(cause, '变更历史加载失败'));
      } finally {
        setLoading(false);
      }
    },
    [pointId, field, actorType, range],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="双轨审计边界：本页检索参数/模式变更（config_audit）；值写与回滚审计请前往执行审计（/control-audit，M5）——两页不可互替"
      />
      <Card>
        <Space wrap size={12}>
          <Input
            placeholder="点位 point_id"
            style={{ width: 160 }}
            value={pointId}
            onChange={(event) => {
              setPointId(event.target.value);
            }}
            allowClear
          />
          <Select
            allowClear
            placeholder="字段"
            style={{ width: 220 }}
            value={field}
            onChange={setField}
            options={Object.entries(FIELD_LABEL).map(([value, label]) => ({ value, label }))}
          />
          <Select
            allowClear
            placeholder="操作者类型"
            style={{ width: 130 }}
            value={actorType}
            onChange={setActorType}
            options={[
              { value: 'human', label: '人工' },
              { value: 'system', label: '系统' },
            ]}
          />
          <DatePicker.RangePicker
            showTime
            onChange={(dates) => {
              setRange(
                dates === null ? null : [dates[0]?.toDate() ?? null, dates[1]?.toDate() ?? null],
              );
            }}
          />
          <Button
            type="primary"
            onClick={() => {
              void load();
            }}
            loading={loading}
          >
            检索
          </Button>
        </Space>
      </Card>

      {error !== null && <Alert type="error" showIcon message={error} />}

      <Card title="变更历史（config_audit · at DESC）">
        <Table<ConfigAuditItem>
          rowKey="id"
          size="middle"
          loading={loading}
          dataSource={rows}
          pagination={false}
          locale={{ emptyText: '暂无变更记录' }}
          columns={[
            {
              title: '时间',
              dataIndex: 'at',
              width: 200,
              render: (at: string) => (
                <Typography.Text style={{ fontSize: 12 }}>
                  {at.replace('T', ' ').slice(0, 19)}
                </Typography.Text>
              ),
            },
            {
              title: '点位',
              render: (_, row) => (
                <Space direction="vertical" size={0}>
                  <span>{row.point_display_name ?? row.point_raw_name}</span>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {row.point_raw_name}
                  </Typography.Text>
                </Space>
              ),
            },
            {
              title: '字段',
              dataIndex: 'field',
              render: (f: ConfigAuditItem['field']) => FIELD_LABEL[f],
            },
            {
              title: '变更',
              render: (_, row) => (
                <Space size={4}>
                  <Typography.Text delete type="secondary">
                    {valueText(row.old_value)}
                  </Typography.Text>
                  <span>→</span>
                  <Typography.Text strong>{valueText(row.new_value)}</Typography.Text>
                </Space>
              ),
            },
            {
              title: '操作者',
              render: (_, row) =>
                row.actor_type === 'human' ? (
                  (row.actor_name ?? row.actor_ref ?? '—')
                ) : (
                  <Tag color="red">system</Tag>
                ),
            },
            {
              title: '原因',
              dataIndex: 'reason',
              ellipsis: { showTitle: true },
              render: (reason: string | null) => reason ?? '—',
            },
          ]}
        />
        {cursor !== null && (
          <Button
            block
            style={{ marginTop: 12 }}
            onClick={() => void load(cursor)}
            loading={loading}
          >
            加载更多
          </Button>
        )}
      </Card>
    </Space>
  );
}
