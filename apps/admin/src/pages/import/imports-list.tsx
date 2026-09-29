/**
 * 导入历史页 /imports（M2-import §10.3；原型「导入历史」屏）：
 * GET /imports 列表（状态筛选 + 状态/行数/命中率列）+ 状态机徽标；行点击 → /imports/:id
 * （向导恢复态或报告态合一）；游标分页「加载更多 + 已加载计数」（§3.1，DAT-157 修单）；
 * 列表时间相对显示（§2.2，hover 完整时间戳）；发起按钮显隐 = imports.write。
 */
import { Alert, Button, Card, Empty, Select, Space, Spin, Table, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  IMPORT_JOB_STATUSES,
  ImportJobListResponseSchema,
  type ImportJob,
  type ImportJobStatus,
} from '@thermio/shared-types';
import { apiFetch } from '../../app/api-client.js';
import { useHasCapability } from '../asset/asset-shared.js';
import { RelativeTime } from '../relative-time.js';
import { JobStatusTag } from './import-shared.js';

export function ImportsListPage(): React.ReactNode {
  const canWrite = useHasCapability('imports.write');
  const navigate = useNavigate();
  const [items, setItems] = useState<ImportJob[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<ImportJobStatus | undefined>(undefined);

  const load = useCallback(
    async (nextCursor?: string): Promise<void> => {
      try {
        const params = new URLSearchParams({ limit: '50' });
        if (status !== undefined) params.set('status', status);
        if (nextCursor !== undefined && nextCursor.length > 0) params.set('cursor', nextCursor);
        const result = await apiFetch(`/imports?${params.toString()}`, ImportJobListResponseSchema);
        setItems((prev) => (nextCursor === undefined ? result.items : [...prev, ...result.items]));
        setTotal((prev) =>
          nextCursor === undefined ? result.items.length : (prev ?? 0) + result.items.length,
        );
        setCursor(result.next_cursor);
        setError(null);
      } catch {
        setError('导入历史加载失败');
      } finally {
        setLoading(false);
      }
    },
    [status],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Typography.Title level={3} style={{ margin: 0 }}>
        点表导入
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
        Excel → 语义映射 → 单位换算 → 登记 + 采集自检（ADR-015）。状态机：parsed → mapping →
        validated → applied → checked / failed
      </Typography.Paragraph>
      <Space wrap>
        <Select
          allowClear
          placeholder="状态筛选"
          style={{ width: 160 }}
          value={status}
          onChange={(value) => {
            setStatus(value);
          }}
          options={IMPORT_JOB_STATUSES.map((s) => ({ value: s, label: s }))}
        />
        {canWrite && (
          <Button
            type="primary"
            onClick={() => {
              void navigate('/imports/new');
            }}
          >
            ＋ 新建导入（向导）
          </Button>
        )}
        {total !== null && (
          <Typography.Text type="secondary">已加载 {String(items.length)} 条</Typography.Text>
        )}
      </Space>
      {error !== null && <Alert type="error" showIcon message={error} />}
      <Card title="导入历史">
        {loading ? (
          <Spin />
        ) : items.length === 0 ? (
          <Empty description="暂无导入作业——从现场 Excel 点表开始（ADR-015）" />
        ) : (
          <Table<ImportJob>
            rowKey="id"
            size="small"
            dataSource={items}
            onRow={(record) => ({
              onClick: () => {
                void navigate(`/imports/${record.id}`);
              },
              style: { cursor: 'pointer' },
            })}
            pagination={false}
            columns={[
              {
                title: '作业',
                dataIndex: 'file_name',
                render: (_, job) => (
                  <Space direction="vertical" size={0}>
                    <Link to={`/imports/${job.id}`}>{job.id.slice(0, 8)}</Link>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {job.file_name}
                    </Typography.Text>
                  </Space>
                ),
              },
              { title: '行数', dataIndex: 'row_count', width: 80, align: 'right' },
              { title: '已映射', dataIndex: 'mapped_count', width: 80, align: 'right' },
              {
                title: '状态',
                dataIndex: 'status',
                width: 150,
                render: (s: ImportJobStatus, job) => (
                  <Space direction="vertical" size={0}>
                    <JobStatusTag status={s} />
                    {job.failure !== null && (
                      // V5：机器码不断词（word-break 会把 template_mismatch 断成 misma/tch）
                      <Typography.Text type="danger" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                        {job.failure.code}
                      </Typography.Text>
                    )}
                  </Space>
                ),
              },
              {
                title: '自检命中率',
                dataIndex: 'hit_rate',
                width: 110,
                align: 'right',
                render: (rate: number | null) =>
                  rate === null ? '—' : `${(rate * 100).toFixed(1)}%`,
              },
              {
                title: '时间',
                dataIndex: 'created_at',
                width: 170,
                render: (value: string) => <RelativeTime iso={value} />,
              },
            ]}
          />
        )}
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
