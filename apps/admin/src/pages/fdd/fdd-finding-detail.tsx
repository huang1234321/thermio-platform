/**
 * /fdd/findings/:id 发现详情（modules/M6-fdd.md §7.3 详情页型，IMPL-16 切片 / DAT-212）。
 *
 * - 头卡：严重度徽标 + title + meta（设备/规则/algo_version/状态/首次·最后发现/
 *   resolved·ignored 时间）+ 页级操作（抽检/忽略，按 fdd.write 渲染）；
 * - 证据卡：evidence.points 多点同轴曲线——逐点调 M1 GET /points/{id}/telemetry
 *   ?from&to&interval=5min（§4.3 前端行为契约；ADR-005 read replica）+ detail
 *   键值指标卡 + 「在实时监控中查看」逐点链接；
 * - 建议动作卡（suggested_action 可空不渲染）+ 抽检卡（当前判定/入口）+ 关联区
 *   （联动告警 /alarms/{id} · 设备监控 · 设备档案，§7.3 表）。
 */
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Empty,
  Space,
  Spin,
  Tag,
  Typography,
  theme,
} from 'antd';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { TelemetryPageSchema, type FddFindingDetail } from '@thermio/shared-types';
import { apiFetch, ApiError } from '../../app/api-client.js';
import { errorText } from '../asset/asset-shared.js';
import { formatAbsolute } from '../relative-time.js';
import { SeverityTag } from '../alarm/alarm-shared.js';
import { fetchFddFindingDetail } from './fdd-data.js';
import {
  FDD_STATUS_LABEL,
  REVIEW_RESULT_LABEL,
  ReviewBadge,
  useHasFddCapability,
} from './fdd-shared.js';
import { IgnoreModal, ReviewModal } from './fdd-findings.js';

/** 图表序列 token（baseline §2.1 --ti-chart-1..5；SVG 经 style 消费）。 */
const SERIES_COLORS = [
  'var(--ti-chart-1)',
  'var(--ti-chart-2)',
  'var(--ti-chart-3)',
  'var(--ti-chart-4)',
  'var(--ti-chart-5)',
];

/** 证据曲线取数窗（§4.3：窗口 = evidence.window；跨度超限由 M1 端点兜底）。 */
const EVIDENCE_INTERVAL = '5min';
const EVIDENCE_PAGE_LIMIT = 200;
const EVIDENCE_MAX_PAGES = 10;

interface EvidenceSeries {
  readonly pointId: number;
  readonly quantityType: string;
  readonly samples: ReadonlyArray<{
    ts?: string;
    bucket?: string;
    value?: number | null;
    avg?: number | null;
  }>;
}

export function FddFindingDetailPage(): ReactNode {
  const { findingId } = useParams<{ findingId: string }>();
  const navigate = useNavigate();
  const canWrite = useHasFddCapability('fdd.write');
  const [detail, setDetail] = useState<FddFindingDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [series, setSeries] = useState<readonly EvidenceSeries[]>([]);
  const [curveError, setCurveError] = useState<string | null>(null);
  const [curveLoading, setCurveLoading] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [ignoreOpen, setIgnoreOpen] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    if (findingId === undefined) return;
    try {
      setDetail(await fetchFddFindingDetail(findingId));
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) setMissing(true);
      else setError(errorText(cause, '发现详情加载失败'));
    }
  }, [findingId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 证据曲线：对 evidence.points[] 逐点拉窗（§4.3 前端行为契约）
  useEffect(() => {
    if (detail === null) return;
    let cancelled = false;
    const loadCurves = async (): Promise<void> => {
      setCurveLoading(true);
      setCurveError(null);
      try {
        const loaded = await Promise.all(
          detail.evidence.points.map(async (point) => {
            const samples: Array<{
              ts?: string;
              bucket?: string;
              value?: number | null;
              avg?: number | null;
            }> = [];
            let cursor: string | undefined;
            for (let pageIndex = 0; pageIndex < EVIDENCE_MAX_PAGES; pageIndex += 1) {
              const params = new URLSearchParams({
                interval: EVIDENCE_INTERVAL,
                from: detail.evidence.window.from,
                to: detail.evidence.window.to,
                limit: String(EVIDENCE_PAGE_LIMIT),
              });
              if (cursor !== undefined) params.set('cursor', cursor);
              const page = await apiFetch(
                `/points/${String(point.point_id)}/telemetry?${params.toString()}`,
                TelemetryPageSchema,
              );
              samples.push(...page.items);
              if (page.next_cursor === null) break;
              cursor = page.next_cursor;
            }
            return { pointId: point.point_id, quantityType: point.quantity_type, samples };
          }),
        );
        if (!cancelled) setSeries(loaded);
      } catch (cause) {
        if (!cancelled) {
          setSeries([]);
          setCurveError(errorText(cause, '证据曲线拉取失败（遥测端点不可用或时间范围受限）'));
        }
      } finally {
        if (!cancelled) setCurveLoading(false);
      }
    };
    void loadCurves();
    return () => {
      cancelled = true;
    };
  }, [detail]);

  if (missing) {
    return <Alert type="error" showIcon message="发现不存在或无权访问（fdd.finding_not_found）" />;
  }
  if (detail === null) {
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
          <Space size={8} wrap>
            <Button size="small" onClick={() => void navigate('/fdd/findings')}>
              返回列表
            </Button>
            <SeverityTag severity={detail.severity} />
            {detail.title}
            <Tag style={{ marginInlineEnd: 0 }}>{FDD_STATUS_LABEL[detail.status]}</Tag>
          </Space>
        }
        extra={
          canWrite ? (
            <Space>
              <Button
                onClick={() => {
                  setReviewOpen(true);
                }}
              >
                {detail.review === null ? '记录抽检' : '更新抽检'}
              </Button>
              {detail.status === 'open' && (
                <Button
                  danger
                  onClick={() => {
                    setIgnoreOpen(true);
                  }}
                >
                  忽略
                </Button>
              )}
            </Space>
          ) : undefined
        }
      >
        <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 3 }}>
          <Descriptions.Item label="设备">
            <Link to={`/assets/equipments/${detail.equipment.id}`}>{detail.equipment.name}</Link>
            {detail.equipment.local_id !== null ? `（${detail.equipment.local_id}）` : ''}
          </Descriptions.Item>
          <Descriptions.Item label="规则">
            <Typography.Text code>{detail.rule_key}</Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label="算法版本">{detail.algo_version}</Descriptions.Item>
          <Descriptions.Item label="首次发现">
            {formatAbsolute(detail.first_detected_at)}
          </Descriptions.Item>
          <Descriptions.Item label="最后发现">
            {formatAbsolute(detail.last_detected_at)}
          </Descriptions.Item>
          {detail.resolved_at !== null && (
            <Descriptions.Item label="消除时间">
              {formatAbsolute(detail.resolved_at)}
            </Descriptions.Item>
          )}
          {detail.ignored_at !== null && (
            <Descriptions.Item label="忽略时间">
              {formatAbsolute(detail.ignored_at)}
              {detail.ignored_by_name !== null ? `（${detail.ignored_by_name}）` : ''}
            </Descriptions.Item>
          )}
        </Descriptions>
      </Card>

      <Card
        title={`证据曲线（${formatAbsolute(detail.evidence.window.from)} ~ ${formatAbsolute(detail.evidence.window.to)}，5min 粒度）`}
        extra={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            证据窗口 = 规则评估窗（algo 5min 桶对齐）
          </Typography.Text>
        }
      >
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {curveError !== null && <Alert type="warning" showIcon message={curveError} />}
          {curveLoading ? (
            <div style={{ textAlign: 'center', padding: 24 }}>
              <Spin />
            </div>
          ) : (
            <EvidenceTrend series={series} />
          )}
          <Space size={16} wrap>
            {/* M3 无 /monitor/points/:id 独立路由——点位趋势在设备工况详情（勾选点位） */}
            {detail.evidence.points.map((point) => (
              <Link key={point.point_id} to={`/monitor/equipments/${detail.equipment.id}`}>
                点位 {String(point.point_id)}（{point.quantity_type}）在实时监控中查看 →
              </Link>
            ))}
          </Space>
          {Object.keys(detail.evidence.detail).length > 0 && (
            <Card
              size="small"
              title="量化依据（evidence.detail）"
              styles={{ body: { padding: '8px 12px' } }}
            >
              <Space size={20} wrap>
                {Object.entries(detail.evidence.detail).map(([key, value]) => (
                  <span key={key}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {key}
                    </Typography.Text>{' '}
                    <Typography.Text style={{ fontWeight: 600 }}>
                      {typeof value === 'object' && value !== null
                        ? JSON.stringify(value)
                        : String(value)}
                    </Typography.Text>
                  </span>
                ))}
              </Space>
            </Card>
          )}
        </Space>
      </Card>

      {detail.suggested_action !== null && (
        <Card title="建议动作" size="small">
          <Typography.Paragraph style={{ marginBottom: 0 }}>
            {detail.suggested_action}
          </Typography.Paragraph>
        </Card>
      )}

      <Card
        title="抽检判定"
        size="small"
        extra={
          canWrite ? (
            <Button
              size="small"
              onClick={() => {
                setReviewOpen(true);
              }}
            >
              {detail.review === null ? '记录抽检' : '更新抽检'}
            </Button>
          ) : undefined
        }
      >
        {detail.review === null ? (
          <Typography.Text type="secondary">
            未抽检{canWrite ? '——记录结论后进入 S3 命中率统计' : ''}
          </Typography.Text>
        ) : (
          <Descriptions size="small" column={{ xs: 1, sm: 3 }}>
            <Descriptions.Item label="结论">
              <ReviewBadge review={detail.review} />
            </Descriptions.Item>
            <Descriptions.Item label="评审人">
              {detail.review.reviewed_by_name} · {formatAbsolute(detail.review.reviewed_at)}
            </Descriptions.Item>
            <Descriptions.Item label="备注">
              {detail.review.note === null ? '—' : detail.review.note}
            </Descriptions.Item>
          </Descriptions>
        )}
        {detail.review !== null && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            当前结论：{REVIEW_RESULT_LABEL[detail.review.result]}（可覆写，最新结论生效）
          </Typography.Text>
        )}
      </Card>

      <Card title="关联" size="small">
        <Space size={20} wrap>
          {detail.alarm_event_id !== null && (
            <Link to={`/alarms/${String(detail.alarm_event_id)}`}>
              联动告警 #{String(detail.alarm_event_id)} →
            </Link>
          )}
          <Link to={`/monitor/equipments/${detail.equipment.id}`}>设备监控 →</Link>
          <Link to={`/assets/equipments/${detail.equipment.id}`}>设备档案 →</Link>
        </Space>
      </Card>

      <ReviewModal
        finding={reviewOpen ? detail : null}
        onClose={() => {
          setReviewOpen(false);
        }}
        onDone={() => {
          setReviewOpen(false);
          void load();
        }}
      />
      <IgnoreModal
        finding={ignoreOpen ? detail : null}
        onClose={() => {
          setIgnoreOpen(false);
        }}
        onDone={() => {
          setIgnoreOpen(false);
          void load();
        }}
      />
    </Space>
  );
}

/**
 * 证据多序列内联 SVG 折线（同轴叠加，§7.3；零图表依赖沿 monitor 同款纪律）。
 * 时间刻度取证据窗；值刻度自适应；序列 ≤5（evidence.points 上限由规则窗约束）。
 */
function EvidenceTrend({ series }: { series: readonly EvidenceSeries[] }): ReactNode {
  const { token } = theme.useToken();
  const mapped = series.map((line) => ({
    ...line,
    coords: line.samples
      .map((sample) => ({
        xMs: Date.parse(sample.ts ?? sample.bucket ?? ''),
        y: sample.value ?? sample.avg ?? null,
      }))
      .filter(
        (point): point is { xMs: number; y: number } =>
          point.y !== null && Number.isFinite(point.xMs),
      ),
  }));
  const drawable = mapped.filter((line) => line.coords.length >= 2);
  if (drawable.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="证据窗口内暂无遥测数据" />;
  }

  const W = 960;
  const H = 240;
  const PAD_L = 56;
  const PAD_R = 16;
  const PAD_T = 12;
  const PAD_B = 24;
  const xs = drawable.flatMap((line) => line.coords.map((point) => point.xMs));
  const ys = drawable.flatMap((line) => line.coords.map((point) => point.y));
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const ySpan = yMax - yMin || Math.abs(yMax) * 0.1 || 1;
  const yPad = ySpan * 0.08;
  const yLo = yMin - yPad;
  const yHi = yMax + yPad;
  const px = (xMs: number): number =>
    PAD_L + ((xMs - xMin) / (xMax - xMin || 1)) * (W - PAD_L - PAD_R);
  const py = (y: number): number => H - PAD_B - ((y - yLo) / (yHi - yLo)) * (H - PAD_T - PAD_B);
  const yTicks = Array.from({ length: 5 }, (_, index) => yLo + ((yHi - yLo) / 4) * index);
  const xTicks = Array.from({ length: 5 }, (_, index) => xMin + ((xMax - xMin) / 4) * index);

  return (
    <div>
      <svg
        viewBox={`0 0 ${String(W)} ${String(H)}`}
        role="img"
        aria-label="证据曲线"
        style={{ width: '100%', height: 240 }}
      >
        {yTicks.map((tick, index) => {
          const y = py(tick);
          return (
            <g key={`y-${String(index)}`}>
              <line
                x1={PAD_L}
                x2={W - PAD_R}
                y1={y}
                y2={y}
                stroke={token.colorBorderSecondary}
                strokeWidth="1"
              />
              <text
                x={PAD_L - 6}
                y={y + 3}
                textAnchor="end"
                fontSize="10"
                fill={token.colorTextTertiary}
              >
                {Math.abs(tick) < 100 && !Number.isInteger(tick)
                  ? tick.toFixed(1)
                  : String(Math.round(tick))}
              </text>
            </g>
          );
        })}
        {xTicks.map((tick, index) => (
          <text
            key={`x-${String(index)}`}
            x={px(tick)}
            y={H - 6}
            textAnchor={index === 0 ? 'start' : index === 4 ? 'end' : 'middle'}
            fontSize="10"
            fill={token.colorTextTertiary}
          >
            {formatAbsolute(new Date(tick).toISOString()).slice(11)}
          </text>
        ))}
        {drawable.map((line, index) => (
          <polyline
            key={line.pointId}
            points={line.coords
              .map((point) => `${px(point.xMs).toFixed(1)},${py(point.y).toFixed(1)}`)
              .join(' ')}
            fill="none"
            style={{ stroke: SERIES_COLORS[index % SERIES_COLORS.length], fill: 'none' }}
            strokeWidth="1.5"
          />
        ))}
      </svg>
      <Space size={16} wrap style={{ fontSize: 12 }}>
        {drawable.map((line, index) => (
          <span key={line.pointId}>
            <span style={{ color: SERIES_COLORS[index % SERIES_COLORS.length] }}>━</span> 点位{' '}
            {String(line.pointId)}（{line.quantityType}）
          </span>
        ))}
      </Space>
    </div>
  );
}
