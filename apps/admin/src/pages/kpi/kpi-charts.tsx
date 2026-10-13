/**
 * M11 能耗看板图表件（M11-kpi-dashboard §7.1；IMPL-22 / DAT-246）。
 *
 * 自包含 SVG（无图表库依赖，mv-report-detail 手绘 SVG 同款纪律；视觉对齐 prototype
 * v3 StackBarTrend/Donut——--ti-chart-* 序列 ≤5，baseline §2 图表纪律）：
 * - 堆叠柱：gap/reset 桶断柱 + 轴上标记（×/↺，§2.2 不插值/不计入）；uncertain 桶
 *   点标注；进行中桶半透明 + partial 角标；基准虚线（序列型源或 fixed 日恒值）；
 * - 环形图 + 明细行（结构卡，§7.1 结构图卡）。
 */
import type { ReactNode } from 'react';
import type { KpiEnergyStructure, KpiEnergyTrend, KpiTrendBucket } from '@thermio/shared-types';

const CHART = [
  'var(--ti-chart-1)',
  'var(--ti-chart-2)',
  'var(--ti-chart-3)',
  'var(--ti-chart-4)',
  'var(--ti-chart-5)',
];

const chartColor = (index: number): string => CHART[index] ?? CHART[4] ?? '#8a9099';

const GROUP_LABELS: Record<string, string> = {
  chilled_water: '冷冻水',
  cooling_water: '冷却水',
  ahu: 'AHU',
  vav: 'VAV',
  unclassified: '未分类',
  chiller: '冷机',
  chwp_pump: '冷冻水泵',
  cwp_pump: '冷却水泵',
  cooling_tower: '冷却塔',
  valve: '阀门',
  sensor: '传感器',
  energy_meter: '计量表',
};

export function groupLabel(key: string): string {
  return GROUP_LABELS[key] ?? key;
}

function bucketLabel(bucket: string, interval: 'hour' | 'day'): string {
  const d = new Date(bucket);
  if (interval === 'hour') {
    return `${String(d.getHours()).padStart(2, '0')}:00`;
  }
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 趋势堆叠柱（§7.1 趋势卡）。 */
export function StackBarTrend({
  trend,
  groupKeys,
}: {
  trend: KpiEnergyTrend;
  groupKeys: readonly string[];
}): ReactNode {
  const width = 860;
  const height = 280;
  const padL = 56;
  const padR = 14;
  const padB = 30;
  const padT = 16;
  const buckets = trend.buckets;
  if (buckets.length === 0) {
    return (
      <div style={{ padding: '24px 0', color: 'var(--ant-color-text-tertiary)' }}>
        窗口内无能耗数据
      </div>
    );
  }
  const valuesOf = (b: KpiTrendBucket): number[] =>
    trend.group_by === 'none'
      ? [b.total_kwh ?? 0]
      : groupKeys.map((key) => b.groups.find((g) => g.key === key)?.kwh ?? 0);
  const benchmarkValues =
    trend.benchmark_series?.map((p) => p.value_kwh).filter((v): v is number => v !== null) ?? [];
  const max =
    Math.max(
      ...buckets.map((b) => valuesOf(b).reduce((s, v) => s + v, 0)),
      ...(benchmarkValues.length > 0 ? benchmarkValues : [0]),
      1,
    ) * 1.12;
  const bw = (width - padL - padR) / buckets.length;
  const x = (i: number): number => padL + i * bw;
  const y = (v: number): number => padT + (1 - v / max) * (height - padT - padB);
  const labelEvery = Math.max(1, Math.ceil(buckets.length / 9));
  const showLabel = (i: number): boolean => i % labelEvery === 0 || i === buckets.length - 1;
  const grid = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const series: readonly { readonly bucket: string; readonly value_kwh: number | null }[] | null =
    trend.benchmark_series ??
    (trend.benchmark.status === 'ok' &&
    trend.benchmark.baseline_kwh !== null &&
    trend.interval === 'day'
      ? // fixed 源：日恒值由前端派生（§5.2——响应不给序列，避免伪造数据点）
        buckets.map((b) => ({ bucket: b.bucket, value_kwh: trend.benchmark.baseline_kwh }))
      : null);
  return (
    <div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 4, fontSize: 12 }}>
        {(trend.group_by === 'none'
          ? [{ key: 'total', label: '合计能耗' }]
          : groupKeys.map((key) => ({ key, label: groupLabel(key) }))
        ).map((s, i) => (
          <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 2,
                background: chartColor(i),
                opacity: s.key === 'unclassified' ? 0.55 : 0.9,
              }}
            />
            {s.label}
          </span>
        ))}
        {series !== null && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 16, height: 0, borderTop: '2px dashed var(--ti-chart-5)' }} />
            基准线
          </span>
        )}
      </div>
      <svg
        viewBox={`0 0 ${String(width)} ${String(height)}`}
        style={{ width: '100%', height: 'auto' }}
      >
        {grid.map((g) => (
          <g key={String(g)}>
            <line
              x1={padL}
              x2={width - padR}
              y1={y(g)}
              y2={y(g)}
              stroke="var(--ant-color-border-secondary)"
              strokeWidth={0.8}
            />
            <text
              x={padL - 6}
              y={y(g) + 3}
              textAnchor="end"
              fontSize={10}
              fill="currentColor"
              opacity={0.55}
            >
              {g >= 1000 ? `${(g / 1000).toFixed(1)}k` : String(Math.round(g))}
            </text>
          </g>
        ))}
        {series !== null &&
          (() => {
            let pathValue = '';
            let penDown = false;
            series.forEach((point, index) => {
              const value = point.value_kwh;
              if (value === null) {
                penDown = false;
                return;
              }
              const px = padL + ((index + 0.5) * (width - padL - padR)) / series.length;
              pathValue += `${penDown ? 'L' : 'M'}${px.toFixed(1)},${y(value).toFixed(1)} `;
              penDown = true;
            });
            return (
              <path
                d={pathValue.trim()}
                fill="none"
                stroke="var(--ti-chart-5)"
                strokeWidth={1.6}
                strokeDasharray="6 4"
              />
            );
          })()}
        {buckets.map((b, i) => {
          if (b.total_kwh === null) {
            // gap/reset 桶：断柱 + 轴上标记（§2.2：不插值 / 不计入）
            const isReset = b.status === 'reset';
            return (
              <g key={b.bucket}>
                <line
                  x1={x(i) + bw * 0.5}
                  x2={x(i) + bw * 0.5}
                  y1={padT + 4}
                  y2={height - padB}
                  stroke={isReset ? 'var(--ant-color-warning)' : 'var(--ant-color-border)'}
                  strokeWidth={1}
                  strokeDasharray={isReset ? '3 3' : '1 4'}
                  opacity={0.7}
                />
                <text
                  x={x(i) + bw * 0.5}
                  y={padT + 2}
                  textAnchor="middle"
                  fontSize={10}
                  fill={isReset ? 'var(--ant-color-warning)' : 'currentColor'}
                  opacity={0.7}
                >
                  {isReset ? '↺' : '×'}
                </text>
                {showLabel(i) && (
                  <text
                    x={x(i) + bw * 0.5}
                    y={height - padB + 13}
                    textAnchor="middle"
                    fontSize={10}
                    fill="currentColor"
                    opacity={0.55}
                  >
                    {bucketLabel(b.bucket, trend.interval)}
                  </text>
                )}
              </g>
            );
          }
          let acc = 0;
          return (
            <g key={b.bucket}>
              {valuesOf(b).map((v, j) => {
                const y0 = y(acc);
                const y1 = y(acc + v);
                acc += v;
                return (
                  <rect
                    key={String(j)}
                    x={x(i) + bw * 0.18}
                    width={bw * 0.64}
                    y={y1}
                    height={Math.max(y0 - y1, 0)}
                    fill={chartColor(j)}
                    opacity={b.partial ? 0.45 : b.status === 'uncertain' ? 0.62 : 0.88}
                  />
                );
              })}
              {b.status === 'uncertain' && (
                <circle
                  cx={x(i) + bw * 0.82}
                  cy={padT + 6}
                  r={3}
                  fill="var(--ant-color-warning)"
                  opacity={0.8}
                />
              )}
              {showLabel(i) && (
                <text
                  x={x(i) + bw * 0.5}
                  y={height - padB + 13}
                  textAnchor="middle"
                  fontSize={10}
                  fill="currentColor"
                  opacity={b.partial ? 0.65 : 1}
                >
                  {bucketLabel(b.bucket, trend.interval)}
                  {b.partial ? '…' : ''}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** 结构图卡（§7.1：环形 + 明细行；未分类灰档）。 */
export function StructureDonut({ structure }: { structure: KpiEnergyStructure }): ReactNode {
  const size = 172;
  const R = size / 2 - 10;
  const C = 2 * Math.PI * R;
  const items = structure.items;
  const total = items.reduce((s, it) => s + (it.kwh ?? 0), 0) || 1;
  let acc = 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap' }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${String(size)} ${String(size)}`}
        style={{ flex: 'none' }}
      >
        {items.map((it, i) => {
          const frac = (it.kwh ?? 0) / total;
          const element = (
            <circle
              key={it.key}
              cx={size / 2}
              cy={size / 2}
              r={R}
              fill="none"
              stroke={chartColor(i)}
              strokeWidth={16}
              strokeDasharray={`${String(frac * C)} ${String(C - frac * C)}`}
              strokeDashoffset={String(-acc * C)}
              transform={`rotate(-90 ${String(size / 2)} ${String(size / 2)})`}
              opacity={it.key === 'unclassified' ? 0.5 : 0.88}
            />
          );
          acc += frac;
          return element;
        })}
        <text
          x={size / 2}
          y={size / 2 - 6}
          textAnchor="middle"
          fontSize={17}
          fontWeight={600}
          fill="currentColor"
        >
          {total >= 1000 ? `${(total / 1000).toFixed(1)}k` : String(Math.round(total))}
        </text>
        <text
          x={size / 2}
          y={size / 2 + 12}
          textAnchor="middle"
          fontSize={11}
          fill="currentColor"
          opacity={0.55}
        >
          kWh
        </text>
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 220 }}>
        {items.map((it, i) => (
          <div key={it.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 2,
                background: chartColor(i),
                opacity: it.key === 'unclassified' ? 0.55 : 0.9,
                flex: 'none',
              }}
            />
            <span style={{ color: 'var(--ant-color-text-secondary)', flex: 1 }}>
              {groupLabel(it.key)}
            </span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>
              {(it.kwh ?? 0).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}
            </span>
            <span
              style={{
                fontVariantNumeric: 'tabular-nums',
                opacity: 0.55,
                width: 48,
                textAlign: 'right',
              }}
            >
              {it.share_pct === null ? '—' : `${it.share_pct.toFixed(1)}%`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
