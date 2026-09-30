/**
 * /fdd/reports + /fdd/reports/:id 周期报告（modules/M6-fdd.md §7.4，IMPL-16 切片 / DAT-212）。
 *
 * - 列表：楼宇/期型（日/周）筛选；行 = 楼宇 · period（闭开，终日不含）· 类型徽标 ·
 *   新增/消除/持续三计数摘要 · 生成时间（hover 显 algo_version）；
 * - 详情：报告头（楼宇/期型/期间/生成时间/algo_version）→ 三计数卡 → 新增与期末
 *   未决 severity 分布双条 → 健康度排名表；标注「数据截至报告期」（生成时快照）。
 */
import { Alert, Button, Card, Empty, Select, Space, Spin, Table, Tag, Typography } from 'antd';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ALARM_SEVERITIES,
  FDD_REPORT_PERIOD_TYPES,
  type FddReportItem,
} from '@thermio/shared-types';
import { useAuth } from '../../app/auth-context.js';
import { ApiError } from '../../app/api-client.js';
import { errorText } from '../asset/asset-shared.js';
import { formatAbsolute } from '../relative-time.js';
import { SEVERITY_LABEL } from '../alarm/alarm-shared.js';
import { fetchFddReportDetail, fetchFddReports } from './fdd-data.js';
import { HealthRankingTable } from './fdd-overview.js';

const PERIOD_TYPE_LABEL: Record<(typeof FDD_REPORT_PERIOD_TYPES)[number], string> = {
  day: '日报',
  week: '周报',
};

const PERIOD_TYPE_OPTIONS = FDD_REPORT_PERIOD_TYPES.map((value) => ({
  value,
  label: PERIOD_TYPE_LABEL[value],
}));

/** 分布条 sev 色（--ti-sev-* token；列表/详情同款）。 */
const SEVERITY_BAR_COLOR: Record<(typeof ALARM_SEVERITIES)[number], string> = {
  critical: 'var(--ti-sev-critical)',
  major: 'var(--ti-sev-major)',
  minor: 'var(--ti-sev-minor)',
  warning: 'var(--ti-sev-warning)',
  info: 'var(--ti-sev-info)',
};

export function FddReportsPage(): ReactNode {
  const { state } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState<readonly FddReportItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buildings =
    state.phase === 'authenticated' || state.phase === 'must-change-password'
      ? state.me.building_scopes
      : [];

  const load = useCallback(
    async (nextCursor?: string): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const buildingId = searchParams.get('building_id');
        const periodType = searchParams.get('period_type');
        const page = await fetchFddReports({
          ...(buildingId !== null ? { building_id: buildingId } : {}),
          ...(periodType !== null ? { period_type: periodType } : {}),
          ...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
        });
        setItems((prev) => (nextCursor === undefined ? page.items : [...prev, ...page.items]));
        setCursor(page.next_cursor);
      } catch (cause) {
        setError(errorText(cause, '报告列表加载失败'));
      } finally {
        setLoading(false);
      }
    },
    [searchParams],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const setParam = (key: string, value: string | undefined): void => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value === undefined || value.length === 0) next.delete(key);
      else next.set(key, value);
      return next;
    });
  };

  return (
    <Card
      title="FDD 周期报告"
      extra={
        <Space>
          <Link to="/fdd">概览</Link>
          <Link to="/fdd/findings">发现列表</Link>
        </Space>
      }
    >
      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          allowClear
          placeholder="楼宇"
          style={{ width: 160 }}
          value={searchParams.get('building_id') ?? undefined}
          options={buildings.map((b) => ({ value: b.id, label: b.name }))}
          onChange={(value) => {
            setParam('building_id', value);
          }}
        />
        <Select
          allowClear
          placeholder="期型"
          style={{ width: 110 }}
          value={searchParams.get('period_type') ?? undefined}
          options={PERIOD_TYPE_OPTIONS}
          onChange={(value) => {
            setParam('period_type', value);
          }}
        />
      </Space>
      {error !== null && (
        <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />
      )}
      <Table
        size="small"
        loading={loading}
        rowKey="id"
        dataSource={items.map((item) => ({ ...item, key: item.id }))}
        pagination={false}
        columns={[
          {
            title: '楼宇',
            dataIndex: ['building', 'name'],
            width: 160,
            render: (_v, row: FddReportItem): ReactNode => (
              <Link to={`/fdd/reports/${row.id}`}>{row.building.name}</Link>
            ),
          },
          {
            title: '期间（闭开，终日不含）',
            dataIndex: 'period',
            render: (_v, row: FddReportItem): ReactNode =>
              `${row.period.start} ~ ${row.period.end}`,
          },
          {
            title: '期型',
            dataIndex: 'period_type',
            width: 80,
            render: (value: FddReportItem['period_type']): ReactNode => (
              <Tag style={{ marginInlineEnd: 0 }}>{PERIOD_TYPE_LABEL[value]}</Tag>
            ),
          },
          {
            title: '新增 / 消除 / 持续',
            key: 'counts',
            width: 150,
            render: (_v, row: FddReportItem): ReactNode =>
              `${String(row.summary.counts.new)} / ${String(row.summary.counts.resolved)} / ${String(row.summary.counts.persisting)}`,
          },
          {
            title: '生成时间',
            dataIndex: 'generated_at',
            width: 170,
            render: (value: string, row: FddReportItem): ReactNode => (
              <span title={row.algo_version ?? '—'}>{formatAbsolute(value)}</span>
            ),
          },
          {
            title: '操作',
            key: 'actions',
            width: 90,
            render: (_v, row: FddReportItem): ReactNode => (
              <Link to={`/fdd/reports/${row.id}`}>详情</Link>
            ),
          },
        ]}
      />
      {cursor !== null && (
        <Button block style={{ marginTop: 12 }} loading={loading} onClick={() => void load(cursor)}>
          加载更多
        </Button>
      )}
    </Card>
  );
}

export function FddReportDetailPage(): ReactNode {
  const { reportId } = useParams<{ reportId: string }>();
  const navigate = useNavigate();
  const [report, setReport] = useState<FddReportItem | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      if (reportId === undefined) return;
      try {
        const loaded = await fetchFddReportDetail(reportId);
        if (!cancelled) setReport(loaded);
      } catch (cause) {
        if (cancelled) return;
        if (cause instanceof ApiError && cause.status === 404) {
          setMissing(true);
        } else {
          setError(errorText(cause, '报告详情加载失败'));
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [reportId]);

  if (missing) {
    return <Alert type="error" showIcon message="报告不存在或无权访问（fdd.report_not_found）" />;
  }
  if (report === null) {
    if (error !== null) return <Alert type="error" showIcon message={error} />;
    return (
      <div style={{ textAlign: 'center', padding: 48 }}>
        <Spin />
      </div>
    );
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title={
          <Space size={8}>
            <Button size="small" onClick={() => void navigate('/fdd/reports')}>
              返回列表
            </Button>
            {report.building.name} · {PERIOD_TYPE_LABEL[report.period_type]}（{report.period.start}{' '}
            ~ {report.period.end}，终日不含）
          </Space>
        }
        extra={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            生成于 {formatAbsolute(report.generated_at)} · algo {report.algo_version ?? '—'}
          </Typography.Text>
        }
      >
        <Space size={32} wrap>
          <CountCard label="新增" value={report.summary.counts.new} />
          <CountCard label="消除" value={report.summary.counts.resolved} />
          <CountCard label="期末持续" value={report.summary.counts.persisting} />
        </Space>
      </Card>

      <Card title="severity 分布（左：期初新增 new_by_severity；右：期末未决 open_by_severity）">
        <Space size={40} wrap>
          <SeverityBar title="新增" bySeverity={report.summary.new_by_severity} />
          <SeverityBar title="期末未决" bySeverity={report.summary.open_by_severity} />
        </Space>
      </Card>

      <Card
        title="设备健康度排名（按加权分降序，top 10）"
        extra={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            数据截至报告期（生成时快照，设备名不随改名漂移）
          </Typography.Text>
        }
      >
        <HealthRankingTable
          ranking={report.summary.health_ranking}
          footerNote="加权分 = Σ FDD_SEVERITY_WEIGHTS[severity] × 未决数（info 1 / warning 2 / minor 4 / major 8 / critical 16）"
        />
      </Card>
    </Space>
  );
}

function CountCard({ label, value }: { label: string; value: number }): ReactNode {
  return (
    <div>
      <Typography.Text type="secondary">{label}</Typography.Text>
      <div style={{ fontSize: 32, fontWeight: 600, lineHeight: 1.2 }}>{String(value)}</div>
    </div>
  );
}

/** 五级水平分布条（比例 + 图例计数）。 */
function SeverityBar({
  title,
  bySeverity,
}: {
  title: string;
  bySeverity: Record<(typeof ALARM_SEVERITIES)[number], number>;
}): ReactNode {
  const total = ALARM_SEVERITIES.reduce((sum, severity) => sum + bySeverity[severity], 0);
  if (total === 0) {
    return (
      <div style={{ minWidth: 260 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {title}
        </Typography.Text>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无" style={{ margin: '8px 0' }} />
      </div>
    );
  }
  return (
    <div style={{ minWidth: 260 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {title}（共 {String(total)}）
      </Typography.Text>
      <div
        style={{ display: 'flex', height: 12, borderRadius: 6, overflow: 'hidden', marginTop: 6 }}
      >
        {ALARM_SEVERITIES.slice()
          .reverse()
          .map((severity) => (
            <div
              key={severity}
              title={`${SEVERITY_LABEL[severity]} ${String(bySeverity[severity])}`}
              style={{
                width: `${String((bySeverity[severity] / total) * 100)}%`,
                background: SEVERITY_BAR_COLOR[severity],
              }}
            />
          ))}
      </div>
      <Space size={12} wrap style={{ fontSize: 12, marginTop: 6 }}>
        {ALARM_SEVERITIES.slice()
          .reverse()
          .map((severity) => (
            <span key={severity}>
              {SEVERITY_LABEL[severity]} {String(bySeverity[severity])}
            </span>
          ))}
      </Space>
    </div>
  );
}
