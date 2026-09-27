/**
 * 建议列表页 /proposals（M5-proposal.md §6.1，UC-M5-1/5；ui/baseline §3.1）。
 *
 * - Tabs：待确认(pending) / 已决策(approved,rejected,expired) / 已执行(executed,failed)
 *   / 全部——角标计数来自 /proposals/counts（§3.2），进入页面与写操作成功后重取；
 * - 筛选区（白名单 = §3.1 一一对应，全部可清空，无 keyword）：楼宇（全局上下文联动）/
 *   算法 / 算法版本 / 决策人 / 时间区间；
 * - 行：点位 + 动作 old→new + 状态徽标；辅行 = 算法@版本 · 预期节能 · 置信度 ·
 *   失效倒计时（pending 专属）；行内操作（stopPropagation）：确认/驳回（能力键
 *   渲染，viewer 只查看）/ 执行详情（failed/executed）；
 * - 游标分页无跳页：加载更多 + 已加载计数。
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
  Tabs,
  Typography,
} from 'antd';
import type { TabsProps } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ProposalCountsSchema,
  ProposalListResponseSchema,
  type ProposalCard,
  type ProposalCounts,
} from '@thermio/shared-types';
import { apiFetch } from '../../app/api-client.js';
import { errorText } from '../asset/asset-shared.js';
import {
  ExpiresCountdown,
  ProposalStatusTag,
  algoText,
  confidenceText,
  expectedSavingText,
  formatTime,
  useHasCapability,
  valueChainText,
} from './proposal-shared.js';
import { useBuildingOptions } from './proposal-hooks.js';

const STATUS_TABS: readonly { key: string; label: string; statuses: string | null }[] = [
  { key: 'pending', label: '待确认', statuses: 'pending' },
  { key: 'decided', label: '已决策', statuses: 'approved,rejected,expired' },
  { key: 'executed', label: '已执行', statuses: 'executed,failed' },
  { key: 'all', label: '全部', statuses: null },
];

interface ProposalRow extends ProposalCard {
  readonly key: string;
}

export function ProposalsPage(): React.ReactNode {
  const canDecide = useHasCapability('proposals.decide.write');
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') ?? 'pending';
  const [rows, setRows] = useState<readonly ProposalRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [counts, setCounts] = useState<ProposalCounts | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 筛选（白名单内，全部可清空）
  const [buildingId, setBuildingId] = useState<string | undefined>(undefined);
  const [algo, setAlgo] = useState('');
  const [algoVersion, setAlgoVersion] = useState('');
  const [range, setRange] = useState<[Date | null, Date | null] | null>(null);
  const buildingOptions = useBuildingOptions();

  const loadCounts = useCallback(async (): Promise<void> => {
    try {
      const params = new URLSearchParams();
      if (buildingId !== undefined) params.set('building_id', buildingId);
      setCounts(await apiFetch(`/proposals/counts?${params.toString()}`, ProposalCountsSchema));
    } catch {
      // 角标失败不阻塞列表（下次写操作会重取）
    }
  }, [buildingId]);

  const load = useCallback(
    async (nextCursor?: string): Promise<void> => {
      const tabSpec: (typeof STATUS_TABS)[number] = STATUS_TABS.find(
        (item) => item.key === tab,
      ) ?? { key: 'pending', label: '待确认', statuses: 'pending' };
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ limit: '50' });
        if (tabSpec.statuses !== null) params.set('status', tabSpec.statuses);
        if (buildingId !== undefined) params.set('building_id', buildingId);
        if (algo.trim().length > 0) params.set('algo', algo.trim());
        if (algoVersion.trim().length > 0) params.set('algo_version', algoVersion.trim());
        if (range !== null && range[0] !== null) params.set('from', range[0].toISOString());
        if (range !== null && range[1] !== null) params.set('to', range[1].toISOString());
        if (nextCursor !== undefined && nextCursor.length > 0) params.set('cursor', nextCursor);
        const result = await apiFetch(
          `/proposals?${params.toString()}`,
          ProposalListResponseSchema,
        );
        const mapped = result.items.map((item) => ({ ...item, key: item.id }));
        setRows((prev) => (nextCursor === undefined ? mapped : [...prev, ...mapped]));
        setCursor(result.next_cursor);
      } catch (cause) {
        setError(errorText(cause, '建议列表加载失败'));
      } finally {
        setLoading(false);
      }
    },
    [tab, buildingId, algo, algoVersion, range],
  );

  useEffect(() => {
    void load();
    void loadCounts();
  }, [load, loadCounts]);

  const columns = useMemo(
    () => [
      {
        title: '状态',
        dataIndex: 'status',
        width: 96,
        render: (_: unknown, row: ProposalRow): React.ReactNode => (
          <ProposalStatusTag status={row.status} />
        ),
      },
      {
        title: '点位 / 动作',
        dataIndex: 'point',
        render: (_: unknown, row: ProposalRow): React.ReactNode => (
          <Space direction="vertical" size={2}>
            <Link to={`/proposals/${row.id}`}>{row.point.display_name ?? row.point.raw_name}</Link>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {row.point.raw_name} ·{' '}
              {valueChainText(row.previous_value, row.action.value, row.action.unit)}
            </Typography.Text>
          </Space>
        ),
      },
      {
        title: '算法@版本',
        dataIndex: 'algo',
        width: 210,
        render: (_: unknown, row: ProposalRow): React.ReactNode => (
          <Typography.Text code style={{ fontSize: 12 }}>
            {algoText(row)}
          </Typography.Text>
        ),
      },
      {
        title: '预期节能',
        dataIndex: 'expected_saving_kw',
        width: 110,
        render: (_: unknown, row: ProposalRow): React.ReactNode => (
          <Typography.Text type="success">
            {expectedSavingText(row.expected_saving_kw)}
          </Typography.Text>
        ),
      },
      {
        title: '置信度',
        dataIndex: 'confidence',
        width: 90,
        render: (_: unknown, row: ProposalRow): React.ReactNode => confidenceText(row.confidence),
      },
      {
        title: '失效',
        dataIndex: 'expires_at',
        width: 140,
        render: (_: unknown, row: ProposalRow): React.ReactNode =>
          row.status === 'pending' ? <ExpiresCountdown expiresAt={row.expires_at} /> : '—',
      },
      {
        title: '创建时间',
        dataIndex: 'created_at',
        width: 170,
        render: (value: string): React.ReactNode => formatTime(value),
      },
      {
        title: '操作',
        key: 'actions',
        width: 210,
        render: (_: unknown, row: ProposalRow): React.ReactNode => (
          <Space
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            {canDecide && row.status === 'pending' && (
              <>
                <Button
                  size="small"
                  type="primary"
                  onClick={() => {
                    void navigate(`/proposals/${row.id}?confirm=1`);
                  }}
                >
                  确认
                </Button>
                <Button
                  size="small"
                  danger
                  onClick={() => {
                    void navigate(`/proposals/${row.id}?reject=1`);
                  }}
                >
                  驳回
                </Button>
              </>
            )}
            {(row.status === 'executed' || row.status === 'failed') && (
              <Button size="small" onClick={() => void navigate(`/proposals/${row.id}/execution`)}>
                执行详情
              </Button>
            )}
          </Space>
        ),
      },
    ],
    [canDecide, navigate],
  );

  const tabItems: TabsProps['items'] = STATUS_TABS.map((item) => {
    const badge =
      counts === null
        ? ''
        : item.statuses === null
          ? ` (${String(Object.values(counts).reduce((sum, n) => sum + n, 0))})`
          : ` (${String(
              item.statuses
                .split(',')
                .reduce((sum, status) => sum + counts[status as keyof ProposalCounts], 0),
            )})`;
    return { key: item.key, label: `${item.label}${badge}` };
  });

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Card size="small">
        <Space wrap size={12}>
          <Select
            allowClear
            placeholder="楼宇"
            style={{ minWidth: 180 }}
            options={[...buildingOptions]}
            value={buildingId}
            onChange={(value) => {
              setBuildingId(value);
            }}
          />
          <Input
            allowClear
            placeholder="算法（如 optimizer/chiller-sequencer）"
            style={{ width: 260 }}
            value={algo}
            onChange={(event) => {
              setAlgo(event.target.value);
            }}
          />
          <Input
            allowClear
            placeholder="算法版本"
            style={{ width: 140 }}
            value={algoVersion}
            onChange={(event) => {
              setAlgoVersion(event.target.value);
            }}
          />
          <DatePicker.RangePicker
            showTime
            onChange={(values) => {
              setRange(
                values === null ? null : [values[0]?.toDate() ?? null, values[1]?.toDate() ?? null],
              );
            }}
          />
        </Space>
      </Card>
      <Card size="small" title="建议工作台">
        <Tabs
          activeKey={tab}
          items={tabItems}
          onChange={(key) => {
            const next = new URLSearchParams(searchParams);
            next.set('tab', key);
            setSearchParams(next);
          }}
        />
        {error !== null && (
          <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />
        )}
        <Table
          size="small"
          loading={loading}
          columns={columns}
          dataSource={[...rows]}
          pagination={false}
          rowClassName={() => 'proposal-row'}
          onRow={(row) => ({
            onClick: () => void navigate(`/proposals/${row.id}`),
            style: { cursor: 'pointer' },
          })}
        />
        <Space style={{ marginTop: 12 }} align="center">
          <Button
            loading={loading}
            disabled={cursor === null}
            onClick={() => void load(cursor ?? undefined)}
          >
            加载更多
          </Button>
          <Typography.Text type="secondary">已加载 {String(rows.length)} 条</Typography.Text>
        </Space>
      </Card>
    </Space>
  );
}
