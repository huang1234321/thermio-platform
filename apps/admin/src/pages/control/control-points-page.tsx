/**
 * 可控点清单页 /control/points（M8-safety-ui.md §3，UC-M8-1；IMPL-18 / DAT-164）。
 *
 * - 筛选：control_mode / is_controllable（默认 true）/ keyword / system_id（熔断卡
 *   跳入携带）；楼宇随全局上下文（MVP 全量形态）；
 * - 列（§3.2）：点位（display_name + raw_name 副行 + 停用徽标）/ 设备·系统 /
 *   模式（+熔断降级徽标）/ 白名单 / 值域（空 = 数据不完整黄点）/ 频率 / 操作；
 * - 行操作「编辑闸门」「切换模式」仅 control.write 渲染（SEC-AZ-05 不置灰）；
 * - 游标 + 加载更多（API-DSN-03 默认 50）。
 */
import { Alert, Badge, Button, Card, Input, Select, Space, Table, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ControlPointsListResponseSchema, type ControlPointItem } from '@thermio/shared-types';
import { apiFetch } from '../../app/api-client.js';
import { useCapabilities } from '../../app/auth-context.js';
import { errorText } from '../asset/asset-shared.js';
import { ControlModeTag, FuseTag, clampText, rateText } from './control-shared.js';

export function ControlPointsPage(): React.ReactNode {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const capabilities = useCapabilities();
  const canWrite = capabilities.includes('control.write');

  const [rows, setRows] = useState<readonly ControlPointItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<string | undefined>(undefined);
  const [controllable, setControllable] = useState<string>('true');
  const [keyword, setKeyword] = useState('');

  const systemId = searchParams.get('system_id');
  const modeFromUrl = searchParams.get('control_mode') ?? undefined;

  const load = useCallback(
    async (nextCursor?: string): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ limit: '50' });
        const effMode = mode ?? modeFromUrl;
        if (effMode !== undefined) params.set('control_mode', effMode);
        if (controllable !== 'all') params.set('is_controllable', controllable);
        if (keyword.trim().length > 0) params.set('keyword', keyword.trim());
        if (systemId !== null) params.set('system_id', systemId);
        if (nextCursor !== undefined && nextCursor.length > 0) params.set('cursor', nextCursor);
        const response = await apiFetch(
          `/control/points?${params.toString()}`,
          ControlPointsListResponseSchema,
        );
        setRows((prev) =>
          nextCursor === undefined ? response.items : [...prev, ...response.items],
        );
        setTotal((prev) =>
          nextCursor === undefined ? response.items.length : (prev ?? 0) + response.items.length,
        );
        setCursor(response.next_cursor);
      } catch (cause) {
        setError(errorText(cause, '可控点清单加载失败'));
      } finally {
        setLoading(false);
      }
    },
    [mode, modeFromUrl, controllable, keyword, systemId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card>
        <Space wrap size={12}>
          <Select
            allowClear
            placeholder="控制模式"
            style={{ width: 140 }}
            value={mode ?? modeFromUrl}
            onChange={(value) => {
              setMode(value);
            }}
            options={[
              { value: 'advisory', label: '建议' },
              { value: 'supervised', label: '监督' },
              { value: 'auto', label: '自动' },
            ]}
          />
          <Select
            style={{ width: 140 }}
            value={controllable}
            onChange={setControllable}
            options={[
              { value: 'true', label: '受控白名单内' },
              { value: 'all', label: '全部点位' },
            ]}
          />
          <Input.Search
            placeholder="raw_name / 显示名前缀"
            style={{ width: 220 }}
            value={keyword}
            onChange={(event) => {
              setKeyword(event.target.value);
            }}
            onSearch={() => {
              void load();
            }}
            allowClear
          />
          <Button
            onClick={() => {
              void load();
            }}
            loading={loading}
          >
            刷新
          </Button>
          {total !== null && (
            <Typography.Text type="secondary">已加载 {String(rows.length)} 条</Typography.Text>
          )}
        </Space>
      </Card>

      {error !== null && <Alert type="error" showIcon message={error} />}

      <Card title={systemId !== null ? '可控点清单（按系统过滤）' : '可控点清单'}>
        <Table<ControlPointItem>
          rowKey="point_id"
          size="middle"
          loading={loading}
          dataSource={rows}
          pagination={false}
          locale={{
            emptyText: '暂无可控点——点位入控前，请先在闸门编辑中开启受控白名单并配置值域',
          }}
          columns={[
            {
              title: '点位',
              render: (_, row) => (
                <Space direction="vertical" size={0}>
                  <Space size={6}>
                    <Typography.Text strong>{row.display_name ?? row.raw_name}</Typography.Text>
                    {row.point_status === 'disabled' && <Badge status="default" text="已停用" />}
                  </Space>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {row.raw_name}
                  </Typography.Text>
                </Space>
              ),
            },
            {
              title: '设备 / 系统',
              render: (_, row) => (
                <Space direction="vertical" size={0}>
                  <span>{row.equipment?.name ?? '—'}</span>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {row.system?.name ?? '—'}
                  </Typography.Text>
                </Space>
              ),
            },
            {
              title: '模式',
              render: (_, row) => (
                <Space size={4}>
                  <ControlModeTag mode={row.control_mode} />
                  <FuseTag status={row.system_fuse} />
                </Space>
              ),
            },
            {
              title: '白名单',
              dataIndex: ['gate', 'is_controllable'],
              width: 80,
              render: (value: boolean) => (value ? '✓' : '—'),
            },
            {
              title: '值域',
              render: (_, row) =>
                row.gate.is_controllable &&
                row.gate.clamp_min === null &&
                row.gate.clamp_max === null ? (
                  <Space size={4}>
                    <Badge status="warning" />
                    <span>—</span>
                  </Space>
                ) : (
                  `${clampText(row)}${row.unit_std ?? ''}`
                ),
            },
            { title: '频率', render: (_, row) => rateText(row) },
            {
              title: '操作',
              width: 180,
              render: (_, row) =>
                canWrite ? (
                  <Space size={8}>
                    <Button
                      size="small"
                      disabled={row.point_status === 'disabled'}
                      onClick={() => {
                        void navigate(`/control/points/${String(row.point_id)}/gate`);
                      }}
                    >
                      编辑闸门
                    </Button>
                    <Button
                      size="small"
                      disabled={row.point_status === 'disabled'}
                      onClick={() => {
                        void navigate(`/control/points/${String(row.point_id)}/mode`);
                      }}
                    >
                      切换模式
                    </Button>
                  </Space>
                ) : null,
            },
          ]}
        />
        {cursor !== null && (
          <Button
            block
            style={{ marginTop: 12 }}
            onClick={() => {
              void load(cursor);
            }}
            loading={loading}
          >
            加载更多
          </Button>
        )}
      </Card>
    </Space>
  );
}
