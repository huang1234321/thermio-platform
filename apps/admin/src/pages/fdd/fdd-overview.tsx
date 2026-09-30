/**
 * /fdd FDD 概览（modules/M6-fdd.md §7.1 看板页型，IMPL-16 切片 / DAT-212）。
 *
 * - 未决计数卡组：open.total 大数 + 五级 severity 分布条（--ti-sev-* token）；
 * - 设备健康度排名：最新周报 health.ranking 表；无报告 → Empty（首个周报生成后可见）；
 * - 抽检命中率卡（S3）：hit_rate%（reviewed=0 显示「—」）+ 覆盖进度 +
 *   confirmed/false_positive 计数；「去抽检」跳列表预设筛选（§5.2 本周新增+未抽检）。
 */
import { Alert, Button, Card, Empty, Progress, Space, Spin, Table, Typography } from 'antd';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ALARM_SEVERITIES, type FddOverview } from '@thermio/shared-types';
import { useAuth } from '../../app/auth-context.js';
import { errorText } from '../asset/asset-shared.js';
import { SEVERITY_LABEL } from '../alarm/alarm-shared.js';
import { formatAbsolute } from '../relative-time.js';
import { fetchFddOverview } from './fdd-data.js';
import { hitRateText, overviewTitle, weeklySamplePreset } from './fdd-shared.js';

/** 分布条 sev 色（token 直引；条宽按占比）。 */
const SEVERITY_BAR_COLOR: Record<(typeof ALARM_SEVERITIES)[number], string> = {
  critical: 'var(--ti-sev-critical)',
  major: 'var(--ti-sev-major)',
  minor: 'var(--ti-sev-minor)',
  warning: 'var(--ti-sev-warning)',
  info: 'var(--ti-sev-info)',
};

export function FddOverviewPage(): ReactNode {
  const { state } = useAuth();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const buildingId = searchParams.get('building_id') ?? undefined;
  const buildingName =
    buildingId === undefined
      ? undefined
      : state.phase === 'authenticated' || state.phase === 'must-change-password'
        ? (state.me.building_scopes.find((b) => b.id === buildingId)?.name ?? undefined)
        : undefined;
  const [overview, setOverview] = useState<FddOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setOverview(await fetchFddOverview(buildingId));
    } catch (cause) {
      setError(errorText(cause, 'FDD 概览加载失败'));
    } finally {
      setLoading(false);
    }
  }, [buildingId]);

  useEffect(() => {
    void load();
  }, [load]);

  const goSample = (): void => {
    const preset = weeklySamplePreset();
    const params = new URLSearchParams({
      from: preset.from,
      to: preset.to,
      review: 'unreviewed',
    });
    if (buildingId !== undefined) params.set('building_id', buildingId);
    void navigate(`/fdd/findings?${params.toString()}`);
  };

  if (loading && overview === null) {
    return (
      <div style={{ textAlign: 'center', padding: 48 }}>
        <Spin />
      </div>
    );
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title={overviewTitle(buildingName)}
        extra={
          <Space>
            <Link to="/fdd/findings">发现列表</Link>
            <Link to="/fdd/reports">周期报告</Link>
            <Button size="small" onClick={() => void load()}>
              刷新
            </Button>
          </Space>
        }
      >
        {error !== null && (
          <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />
        )}
        {overview !== null && (
          <Space size={32} wrap align="start">
            <div>
              <Typography.Text type="secondary">未决发现</Typography.Text>
              <div style={{ fontSize: 40, fontWeight: 600, lineHeight: 1.2 }}>
                {String(overview.open.total)}
              </div>
            </div>
            <div style={{ minWidth: 320 }}>
              <SeverityDistribution
                bySeverity={overview.open.by_severity}
                total={overview.open.total}
              />
            </div>
          </Space>
        )}
      </Card>

      {overview !== null && (
        <Card title="抽检命中率（S3 · 近 7 天滚动窗）">
          <Space size={32} wrap align="center">
            <div>
              <Typography.Text type="secondary">命中率</Typography.Text>
              <div style={{ fontSize: 40, fontWeight: 600, lineHeight: 1.2 }}>
                {hitRateText(overview)}
              </div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                confirmed ÷ 已抽检（{String(overview.review_stats.reviewed)}）
              </Typography.Text>
            </div>
            <div style={{ minWidth: 280 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                抽检覆盖（已抽检 {String(overview.review_stats.reviewed)} / 窗口内新增{' '}
                {String(overview.review_stats.new_findings)}）
              </Typography.Text>
              <Progress
                percent={
                  overview.review_stats.new_findings === 0
                    ? 0
                    : Math.round(
                        (overview.review_stats.reviewed / overview.review_stats.new_findings) * 100,
                      )
                }
                size="small"
              />
              <Space size={16} style={{ fontSize: 12 }}>
                <span>✓ 真实故障 {String(overview.review_stats.confirmed)}</span>
                <span>✗ 误报 {String(overview.review_stats.false_positive)}</span>
              </Space>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                窗口起点 {formatAbsolute(overview.review_stats.window_from)}
              </Typography.Text>
            </div>
            <Button type="primary" onClick={goSample}>
              去抽检（本周新增 · 未抽检）
            </Button>
          </Space>
        </Card>
      )}

      <Card title="设备健康度排名（最新周报）">
        {overview === null || overview.health === null ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="首个周报生成后可见——可先去发现列表查看实时发现"
          />
        ) : (
          <HealthRankingTable
            ranking={overview.health.ranking}
            footerNote={`报告期 ${overview.health.period.start} ~ ${overview.health.period.end}（终日不含）· 生成于 ${formatAbsolute(overview.health.generated_at)}`}
          />
        )}
      </Card>
    </Space>
  );
}

/** 五级分布条 + 计数行（total=0 时平铺空条也保持五级可见）。 */
function SeverityDistribution({
  bySeverity,
  total,
}: {
  bySeverity: Record<(typeof ALARM_SEVERITIES)[number], number>;
  total: number;
}): ReactNode {
  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      <div style={{ display: 'flex', height: 12, borderRadius: 6, overflow: 'hidden' }}>
        {ALARM_SEVERITIES.slice()
          .reverse() // critical 在左（视觉权重从重到轻）
          .map((severity) => (
            <div
              key={severity}
              title={`${SEVERITY_LABEL[severity]} ${String(bySeverity[severity])}`}
              style={{
                width: total === 0 ? '20%' : `${String((bySeverity[severity] / total) * 100)}%`,
                background: SEVERITY_BAR_COLOR[severity],
              }}
            />
          ))}
      </div>
      <Space size={16} wrap style={{ fontSize: 12 }}>
        {ALARM_SEVERITIES.slice()
          .reverse()
          .map((severity) => (
            <span key={severity}>
              <span
                style={{
                  display: 'inline-block',
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  background: SEVERITY_BAR_COLOR[severity],
                  marginRight: 4,
                }}
              />
              {SEVERITY_LABEL[severity]} {String(bySeverity[severity])}
            </span>
          ))}
      </Space>
    </Space>
  );
}

/** 健康度排名表（§7.1 与报告详情 §7.4 同构，快照口径）。 */
export function HealthRankingTable({
  ranking,
  footerNote,
}: {
  ranking: NonNullable<FddOverview['health']>['ranking'];
  footerNote?: string;
}): ReactNode {
  if (ranking.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="报告期内无未决发现" />;
  }
  return (
    <Table
      size="small"
      rowKey={(row) => row.equipment_id}
      pagination={false}
      dataSource={[...ranking]}
      columns={[
        { title: '#', width: 48, render: (_v, _r, index) => String(index + 1) },
        { title: '设备', dataIndex: 'equipment_name' },
        { title: '类型', dataIndex: 'equipment_type', width: 140 },
        { title: '未决发现数', dataIndex: 'open_count', width: 110 },
        { title: '加权分', dataIndex: 'weighted_score', width: 100 },
      ]}
      footer={() =>
        footerNote === undefined ? null : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {footerNote}
          </Typography.Text>
        )
      }
    />
  );
}
