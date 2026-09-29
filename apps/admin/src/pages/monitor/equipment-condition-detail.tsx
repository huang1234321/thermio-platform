/**
 * 设备工况详情（M3-monitor §8.3 页面 2 · 详情）：
 * 头卡（运行态 + 在用告警最严重级）→ 关键点位实时值卡 → 历史曲线
 * （时间范围切换 + 点位多选 ≤5 序列 + 粒度 raw/5min/1h，直连 M1
 * GET /points/{id}/telemetry——不建双入口 §3.3）→ 异常记录双 tab
 * （告警 M4 stub / FDD M6 占位空态）。
 * 曲线按单位分面板绘制（每面板单 y 轴 + 时间/值刻度）——双单位共轴会把
 * 小量程序列压平（视觉门 r1 页4-1/2）；时间格式吃 baseline §2.2 中文单语。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Empty,
  Segmented,
  Space,
  Spin,
  Tabs,
  Tag,
  Typography,
  theme,
} from 'antd';
import type { ReactNode } from 'react';
import { apiFetch, ApiError } from '../../app/api-client.js';
import { TelemetryPageSchema, type TelemetryInterval } from '@thermio/shared-types';
import type { EquipmentConditionDetail } from './api-contracts.js';
import {
  MONITOR_MOCK,
  fetchEquipmentConditionDetail,
  formatStamp,
  formatTick,
  qualityLabel,
  statusDisplayText,
} from './monitor-data.js';

// 图表序列 token（baseline §2.1 --ti-chart-1..5；深色档由 tokens.css 换算）——
// SVG 需经 style 消费（stroke 属性不支持 var()），故存 CSS 变量引用。
const SERIES_COLORS = [
  'var(--ti-chart-1)',
  'var(--ti-chart-2)',
  'var(--ti-chart-3)',
  'var(--ti-chart-4)',
  'var(--ti-chart-5)',
];

const RUN_STATE_META = {
  running: { label: '运行', color: 'green' },
  standby: { label: '备用', color: 'default' },
  fault: { label: '故障', color: 'red' },
  unknown: { label: '未知', color: 'default' },
} as const;

const SEVERITY_TAG = {
  info: { color: 'blue', label: 'info' },
  warning: { color: 'orange', label: 'warning' },
  minor: { color: 'gold', label: 'minor' },
  major: { color: 'volcano', label: 'major' },
  critical: { color: 'red', label: 'critical' },
} as const;

/** 时间范围切换（§8.2 历史曲线区块；默认近 6 小时）。 */
const TREND_WINDOWS: ReadonlyArray<{ label: string; ms: number }> = [
  { label: '近 1 小时', ms: 3600_000 },
  { label: '近 6 小时', ms: 6 * 3600_000 },
  { label: '近 24 小时', ms: 24 * 3600_000 },
];
/** api 单页上限（shared-types TELEMETRY_PAGE_LIMIT_MAX）；raw 按游标翻页取全。 */
const TREND_PAGE_LIMIT = 200;
const TREND_MAX_PAGES = 10;

interface TrendSeries {
  readonly pointId: number;
  readonly label: string;
  readonly unit: string | null;
  readonly samples: ReadonlyArray<{
    ts?: string;
    bucket?: string;
    value?: number | null;
    avg?: number | null;
  }>;
}

interface TrendFailure {
  readonly message: string;
  readonly requestId: string | null;
}

export function EquipmentConditionDetailPage(): ReactNode {
  const { equipmentId } = useParams<{ equipmentId: string }>();
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const [detail, setDetail] = useState<EquipmentConditionDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [series, setSeries] = useState<readonly TrendSeries[]>([]);
  const [trendLoading, setTrendLoading] = useState(false);
  const [interval, setIntervalValue] = useState<TelemetryInterval>('raw');
  const [windowMs, setWindowMs] = useState(6 * 3600_000);
  const [trendError, setTrendError] = useState<TrendFailure | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      if (equipmentId === undefined) return;
      try {
        const loaded = await fetchEquipmentConditionDetail(equipmentId);
        if (!cancelled) setDetail(loaded);
      } catch (cause) {
        if (!cancelled && cause instanceof ApiError && cause.status === 404) setMissing(true);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [equipmentId]);

  const pointOptions = useMemo(() => detail?.points ?? [], [detail]);
  const [selectedPointIds, setSelectedPointIds] = useState<readonly number[]>([]);

  // 默认勾选前两个可绘点位（数值量；run_status 文本量不进曲线）
  useEffect(() => {
    if (detail === null) return;
    setSelectedPointIds((current) => {
      if (current.length > 0) return current;
      return detail.points
        .filter((item) => item.point.quantity_type !== 'run_status')
        .slice(0, 2)
        .map((item) => item.point.id);
    });
  }, [detail]);

  const loadTrend = useCallback(async (): Promise<void> => {
    if (selectedPointIds.length === 0) {
      setSeries([]);
      return;
    }
    setTrendLoading(true);
    setTrendError(null);
    try {
      const from = new Date(Date.now() - windowMs).toISOString();
      const loaded = await Promise.all(
        selectedPointIds.map(async (pointId) => {
          const label =
            pointOptions.find((item) => item.point.id === pointId)?.point.display_name ??
            String(pointId);
          const unit =
            pointOptions.find((item) => item.point.id === pointId)?.point.unit_std ?? null;
          // 游标分页（API-DSN-03 { items, next_cursor }），拼齐窗口
          const samples: Array<{
            ts?: string;
            bucket?: string;
            value?: number | null;
            avg?: number | null;
          }> = [];
          let cursor: string | undefined;
          for (let pageIndex = 0; pageIndex < TREND_MAX_PAGES; pageIndex += 1) {
            const params = new URLSearchParams({
              interval,
              from,
              limit: String(TREND_PAGE_LIMIT),
            });
            if (cursor !== undefined) params.set('cursor', cursor);
            const page = await apiFetch(
              `/points/${String(pointId)}/telemetry?${params.toString()}`,
              TelemetryPageSchema,
            );
            samples.push(...page.items);
            if (page.next_cursor === null) break;
            cursor = page.next_cursor;
          }
          return { pointId, label, unit, samples } satisfies TrendSeries;
        }),
      );
      setSeries(loaded);
    } catch (cause) {
      setTrendError({
        message: '历史曲线拉取失败（TSDB 端点不可用或权限不足）',
        requestId: cause instanceof ApiError ? cause.parsed.request_id : null,
      });
    } finally {
      setTrendLoading(false);
    }
  }, [selectedPointIds, interval, windowMs, pointOptions]);

  useEffect(() => {
    void loadTrend();
  }, [loadTrend]);

  if (missing) {
    return <Alert type="error" showIcon message="设备不存在或无权访问（asset.not_found）" />;
  }
  if (detail === null) {
    return (
      <div style={{ textAlign: 'center', padding: 48 }}>
        <Spin />
      </div>
    );
  }

  const severity = detail.alarms.items.reduce<keyof typeof SEVERITY_TAG | null>((worst, item) => {
    const rank = ['info', 'warning', 'minor', 'major', 'critical'];
    if (worst === null || rank.indexOf(item.severity) > rank.indexOf(worst)) return item.severity;
    return worst;
  }, null);
  const windowLabel = TREND_WINDOWS.find((item) => item.ms === windowMs)?.label ?? '';

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title={
          <Space size={8}>
            <Button
              size="small"
              onClick={() => {
                void navigate('/monitor/equipments');
              }}
            >
              返回列表
            </Button>
            {detail.equipment.name}
            <Tag color={RUN_STATE_META[detail.run_state].color} style={{ marginInlineEnd: 0 }}>
              {RUN_STATE_META[detail.run_state].label}
            </Tag>
            {MONITOR_MOCK && <Tag color="orange">演示数据</Tag>}
          </Space>
        }
        extra={
          <Space size={8}>
            <Typography.Text type="secondary">
              {detail.equipment.local_id} · {detail.equipment.equipment_type}
            </Typography.Text>
            {severity !== null && (
              <Tag color={SEVERITY_TAG[severity].color} style={{ marginInlineEnd: 0 }}>
                在用告警最严 {SEVERITY_TAG[severity].label}
              </Tag>
            )}
          </Space>
        }
      >
        <Space size={16} wrap>
          {detail.points.map((item) => (
            <Card
              key={item.point.id}
              size="small"
              style={{ minWidth: 168 }}
              styles={{ body: { padding: '8px 12px' } }}
            >
              <div style={{ fontSize: 12, color: token.colorTextTertiary }}>
                {item.point.display_name ?? item.point.raw_name}
              </div>
              <div style={{ fontSize: 20, fontWeight: 600 }}>
                {statusDisplayText(item.point.quantity_type, item.latest, detail.run_state)}
                {item.point.unit_std !== null ? (
                  <span style={{ fontSize: 12, fontWeight: 400 }}> {item.point.unit_std}</span>
                ) : null}
              </div>
              <div style={{ fontSize: 12, color: token.colorTextTertiary }}>
                {item.latest === null
                  ? '暂无数据'
                  : `更新 ${formatStamp(item.latest.ts)} · ${qualityLabel(item.latest.quality)}`}
              </div>
            </Card>
          ))}
        </Space>
      </Card>

      <Card
        title={`历史曲线（${windowLabel}）`}
        extra={
          <Space wrap>
            <Segmented
              value={windowMs}
              onChange={(value) => {
                setWindowMs(value);
              }}
              options={TREND_WINDOWS.map((item) => ({ label: item.label, value: item.ms }))}
            />
            <Segmented
              value={interval}
              onChange={(value) => {
                setIntervalValue(value as TelemetryInterval);
              }}
              options={[
                { label: 'raw', value: 'raw' },
                { label: '5min', value: '5min' },
                { label: '1h', value: '1h' },
              ]}
            />
            <Button size="small" onClick={() => void loadTrend()}>
              刷新
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" style={{ width: '100%' }} size={8}>
          <div>
            {pointOptions.map((item) => (
              <Checkbox
                key={item.point.id}
                checked={selectedPointIds.includes(item.point.id)}
                onChange={(event) => {
                  const pointId = item.point.id;
                  setSelectedPointIds((current) =>
                    event.target.checked
                      ? current.length >= 5
                        ? current // baseline §2：≤5 序列
                        : [...current, pointId]
                      : current.filter((id) => id !== pointId),
                  );
                }}
                style={{ marginRight: 16 }}
              >
                {item.point.display_name ?? item.point.raw_name}
                {selectedPointIds.length >= 5 && !selectedPointIds.includes(item.point.id)
                  ? '（序列上限 5）'
                  : ''}
              </Checkbox>
            ))}
          </div>
          {trendError !== null && (
            <Alert
              type="warning"
              showIcon
              message={trendError.message}
              description={
                trendError.requestId !== null ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }} copyable>
                    request_id: {trendError.requestId}
                  </Typography.Text>
                ) : undefined
              }
              action={
                <Button size="small" danger onClick={() => void loadTrend()}>
                  重试
                </Button>
              }
            />
          )}
          {interval === 'raw' && windowMs > 6 * 3600_000 && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              raw 大窗口按游标上限截断（≤{String(TREND_MAX_PAGES * TREND_PAGE_LIMIT)} 点）——长窗口
              建议切 5min/1h 聚合粒度
            </Typography.Text>
          )}
          {trendLoading ? (
            <div style={{ textAlign: 'center', padding: 24 }}>
              <Spin />
            </div>
          ) : (
            <MultiTrend series={series} />
          )}
        </Space>
      </Card>

      <Card title="异常记录">
        <Tabs
          items={[
            {
              key: 'alarms',
              label: `告警（在用 ${String(detail.alarms.items.length)}）`,
              children:
                detail.alarms.items.length === 0 ? (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无在用告警" />
                ) : (
                  detail.alarms.items.map((item) => (
                    <div
                      key={item.id}
                      style={{
                        display: 'flex',
                        gap: 12,
                        padding: '6px 0',
                        borderBottom: `1px solid ${token.colorBorderSecondary}`,
                      }}
                    >
                      <Tag color={SEVERITY_TAG[item.severity].color} style={{ marginInlineEnd: 0 }}>
                        {SEVERITY_TAG[item.severity].label}
                      </Tag>
                      <span style={{ flex: 1 }}>{item.rule_summary}</span>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {formatStamp(item.opened_at)}
                      </Typography.Text>
                    </div>
                  ))
                ),
            },
            {
              key: 'fdd',
              label: `FDD 发现（${String(detail.fdd.open_total)}）`,
              children:
                detail.fdd.items.length === 0 ? (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="FDD 发现属 M6 域（GET /fdd/findings?equipment_id= 联动）——接入后此处展示"
                  />
                ) : (
                  detail.fdd.items.map((item) => (
                    <div key={item.id} style={{ display: 'flex', gap: 12, padding: '6px 0' }}>
                      <Tag color={SEVERITY_TAG[item.severity].color} style={{ marginInlineEnd: 0 }}>
                        {SEVERITY_TAG[item.severity].label}
                      </Tag>
                      <span style={{ flex: 1 }}>{item.rule}</span>
                      <Tag style={{ marginInlineEnd: 0 }}>{item.status}</Tag>
                    </div>
                  ))
                ),
            },
          ]}
        />
      </Card>
    </Space>
  );
}

/**
 * 多序列内联 SVG 折线（≤5 条；零图表依赖——baseline §2 纪律，PointTrend 多序版）。
 * 按单位分面板：每面板单 y 轴（好值域）+ 值刻度，x 轴统一时间刻度——不同量纲
 * 共轴会互相压平（视觉门 r1 页4-2）。单位缺失的序列归入「其他」面板。
 */
function MultiTrend({ series }: { series: readonly TrendSeries[] }): ReactNode {
  const { token } = theme.useToken();
  if (series.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="勾选点位后绘制（≤5 序列）" />;
  }
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
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="趋势窗口内暂无数据" />;
  }

  // 单位 → 序列分组（保持首现顺序；缺单位归「—」组）
  const groups = new Map<string, typeof drawable>();
  for (const line of drawable) {
    const key = line.unit ?? '—';
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [line]);
    else bucket.push(line);
  }
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {[...groups.entries()].map(([unit, lines]) => (
        <TrendPanel key={unit} unit={unit} lines={lines} token={token} />
      ))}
    </Space>
  );
}

/** 单面板：单单位序列 + y 值刻度 + x 时间刻度（HH:mm）。 */
function TrendPanel(props: {
  unit: string;
  lines: ReadonlyArray<{
    pointId: number;
    label: string;
    coords: ReadonlyArray<{ xMs: number; y: number }>;
  }>;
  token: ReturnType<typeof theme.useToken>['token'];
}): ReactNode {
  const W = 960;
  const H = 220;
  const PAD_L = 56;
  const PAD_R = 16;
  const PAD_T = 12;
  const PAD_B = 24;
  const xs = props.lines.flatMap((line) => line.coords.map((point) => point.xMs));
  const ys = props.lines.flatMap((line) => line.coords.map((point) => point.y));
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
        aria-label={`${props.unit} 面板趋势`}
        style={{ width: '100%', height: 220 }}
      >
        {/* 网格 + y 值刻度 */}
        {yTicks.map((tick, index) => {
          const y = py(tick);
          return (
            <g key={`y-${String(index)}`}>
              <line
                x1={PAD_L}
                x2={W - PAD_R}
                y1={y}
                y2={y}
                stroke={props.token.colorBorderSecondary}
                strokeWidth="1"
              />
              <text
                x={PAD_L - 6}
                y={y + 3}
                textAnchor="end"
                fontSize="10"
                fill={props.token.colorTextTertiary}
              >
                {formatTickValue(tick)}
              </text>
            </g>
          );
        })}
        {/* x 时间刻度 */}
        {xTicks.map((tick, index) => (
          <text
            key={`x-${String(index)}`}
            x={px(tick)}
            y={H - 6}
            textAnchor={index === 0 ? 'start' : index === 4 ? 'end' : 'middle'}
            fontSize="10"
            fill={props.token.colorTextTertiary}
          >
            {formatTick(new Date(tick).toISOString())}
          </text>
        ))}
        {props.lines.map((line, index) => (
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
        {props.lines.map((line, index) => (
          <span key={line.pointId}>
            <span style={{ color: SERIES_COLORS[index % SERIES_COLORS.length] }}>━</span>{' '}
            {line.label}
            {props.unit !== '—' ? ` (${props.unit})` : ''}
          </span>
        ))}
      </Space>
    </div>
  );
}

/** y 刻度值：小数自适应（跨度 <4 保留 1 位，否则整数）。 */
function formatTickValue(value: number): string {
  return Math.abs(value) < 100 && !Number.isInteger(value)
    ? value.toFixed(1)
    : String(Math.round(value));
}
