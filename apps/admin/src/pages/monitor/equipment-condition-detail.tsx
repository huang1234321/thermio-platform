/**
 * 设备工况详情（M3-monitor §8.3 页面 2 · 详情）：
 * 头卡（运行态 + 在用告警最严重级）→ 关键点位实时值卡 → 历史曲线
 * （点位多选 ≤5 序列 + 粒度 raw/5min/1h，直连 M1 GET /points/{id}/telemetry
 * ——不建双入口 §3.3）→ 异常记录双 tab（告警 M4 stub / FDD M6 占位空态）。
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
} from 'antd';
import type { ReactNode } from 'react';
import { apiFetch, ApiError } from '../../app/api-client.js';
import { TelemetryPageSchema, type TelemetryInterval } from '@thermio/shared-types';
import type { EquipmentConditionDetail } from './api-contracts.js';
import { MONITOR_MOCK, displayPointValue, fetchEquipmentConditionDetail } from './monitor-data.js';

const SERIES_COLORS = ['#0B7285', '#AD6800', '#CF1322', '#2B8A3E', '#6741D9'];

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

const TREND_WINDOW_MS = 6 * 3600_000;
/** api 单页上限（shared-types TELEMETRY_PAGE_LIMIT_MAX）；6h raw 按游标翻页取全。 */
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

export function EquipmentConditionDetailPage(): ReactNode {
  const { equipmentId } = useParams<{ equipmentId: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<EquipmentConditionDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [series, setSeries] = useState<readonly TrendSeries[]>([]);
  const [trendLoading, setTrendLoading] = useState(false);
  const [interval, setIntervalValue] = useState<TelemetryInterval>('raw');
  const [trendError, setTrendError] = useState<string | null>(null);

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
      const from = new Date(Date.now() - TREND_WINDOW_MS).toISOString();
      const loaded = await Promise.all(
        selectedPointIds.map(async (pointId) => {
          const label =
            pointOptions.find((item) => item.point.id === pointId)?.point.display_name ??
            String(pointId);
          const unit =
            pointOptions.find((item) => item.point.id === pointId)?.point.unit_std ?? null;
          // 游标分页（API-DSN-03 { items, next_cursor }），拼齐 6h 窗口
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
    } catch {
      setTrendError('历史曲线拉取失败（TSDB 端点不可用或权限不足）');
    } finally {
      setTrendLoading(false);
    }
  }, [selectedPointIds, interval, pointOptions]);

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

  const severity = detail.alarms.items.reduce<string | null>((worst, item) => {
    const rank = ['info', 'warning', 'minor', 'major', 'critical'];
    if (worst === null || rank.indexOf(item.severity) > rank.indexOf(worst)) return item.severity;
    return worst;
  }, null);

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
          <Typography.Text type="secondary">
            {detail.equipment.local_id} · {detail.equipment.equipment_type}
            {severity !== null ? ` · 在用告警最严 ${severity}` : ''}
          </Typography.Text>
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
              <div style={{ fontSize: 12, color: '#8c8c8c' }}>
                {item.point.display_name ?? item.point.raw_name}
              </div>
              <div style={{ fontSize: 20, fontWeight: 600 }}>
                {displayPointValue(item.point.quantity_type, item.latest)}
                {item.point.unit_std !== null ? (
                  <span style={{ fontSize: 12, fontWeight: 400 }}> {item.point.unit_std}</span>
                ) : null}
              </div>
              <div style={{ fontSize: 12, color: '#8c8c8c' }}>
                {item.latest === null
                  ? '暂无数据'
                  : `更新 ${new Date(item.latest.ts).toLocaleTimeString()} · q${String(item.latest.quality)}`}
              </div>
            </Card>
          ))}
        </Space>
      </Card>

      <Card
        title="历史曲线（近 6 小时）"
        extra={
          <Space wrap>
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
          {trendError !== null && <Alert type="warning" showIcon message={trendError} />}
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
                        borderBottom: '1px solid #f0f0f0',
                      }}
                    >
                      <Tag color={SEVERITY_TAG[item.severity].color} style={{ marginInlineEnd: 0 }}>
                        {SEVERITY_TAG[item.severity].label}
                      </Tag>
                      <span style={{ flex: 1 }}>{item.rule_summary}</span>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {new Date(item.opened_at).toLocaleString()}
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

/** 多序列内联 SVG 折线（≤5 条；零图表依赖——baseline §2 纪律，PointTrend 多序版）。 */
function MultiTrend({ series }: { series: readonly TrendSeries[] }): ReactNode {
  if (series.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="勾选点位后绘制（≤5 序列）" />;
  }
  const W = 960;
  const H = 240;
  const PAD = 12;
  const points = series.map((line) => ({
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
  const drawable = points.filter((line) => line.coords.length >= 2);
  if (drawable.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="趋势窗口内暂无数据" />;
  }
  const xs = drawable.flatMap((line) => line.coords.map((point) => point.xMs));
  const ys = drawable.flatMap((line) => line.coords.map((point) => point.y));
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const ySpan = yMax - yMin || Math.abs(yMax) * 0.1 || 1;
  return (
    <div>
      <svg
        viewBox={`0 0 ${String(W)} ${String(H)}`}
        role="img"
        style={{ width: '100%', height: 240 }}
      >
        {drawable.map((line, index) => {
          const path = line.coords
            .map((point) => {
              const px = PAD + ((point.xMs - xMin) / (xMax - xMin || 1)) * (W - 2 * PAD);
              const py = H - PAD - ((point.y - yMin) / ySpan) * (H - 2 * PAD);
              return `${px.toFixed(1)},${py.toFixed(1)}`;
            })
            .join(' ');
          return (
            <polyline
              key={line.pointId}
              points={path}
              fill="none"
              stroke={SERIES_COLORS[index % SERIES_COLORS.length]}
              strokeWidth="1.5"
            />
          );
        })}
      </svg>
      <Space size={16} wrap style={{ fontSize: 12 }}>
        {drawable.map((line, index) => (
          <span key={line.pointId}>
            <span style={{ color: SERIES_COLORS[index % SERIES_COLORS.length] }}>━</span>{' '}
            {line.label}
            {line.unit !== null ? ` (${line.unit})` : ''}
          </span>
        ))}
      </Space>
    </div>
  );
}
