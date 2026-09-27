/**
 * 点位趋势图（M1-asset §7 行 5）：内联 SVG 折线（不引入图表依赖——本项目零新依赖纪律）。
 * raw 形取 value、聚合形取 avg；空窗/单点给空态文案。视觉规格（颜色/网格克制）随
 * baseline §2 亮暗主题继承 antd token（currentColor + 6% 网格线）。
 */
import { Empty } from 'antd';
import { useMemo } from 'react';

export interface TrendSample {
  readonly ts?: string;
  readonly bucket?: string;
  readonly value?: number | null;
  readonly avg?: number | null;
}

const W = 640;
const H = 180;
const PAD = 8;

export function PointTrend({
  samples,
  unit,
}: {
  samples: readonly TrendSample[];
  unit: string | null;
}): React.ReactNode {
  const points = useMemo(
    () =>
      samples
        .map((sample) => ({
          xMs: Date.parse(sample.ts ?? sample.bucket ?? ''),
          y: sample.value ?? sample.avg ?? null,
        }))
        .filter((p): p is { xMs: number; y: number } => p.y !== null),
    [samples],
  );

  if (points.length < 2) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="趋势窗口内暂无数据" />;
  }

  const xs = points.map((p) => p.xMs);
  const ys = points.map((p) => p.y);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const ySpan = yMax - yMin || 1;
  const coords = points.map((p) => {
    const px = PAD + ((p.xMs - xMin) / (xMax - xMin || 1)) * (W - 2 * PAD);
    const py = H - PAD - ((p.y - yMin) / ySpan) * (H - 2 * PAD);
    return `${px.toFixed(1)},${py.toFixed(1)}`;
  });

  return (
    <svg
      viewBox={`0 0 ${String(W)} ${String(H)}`}
      role="img"
      style={{ width: '100%', height: 180 }}
    >
      {Array.from({ length: 4 }, (_, i) => {
        const y = PAD + ((H - 2 * PAD) / 3) * i;
        return (
          <line
            key={i}
            x1={PAD}
            x2={W - PAD}
            y1={y}
            y2={y}
            stroke="currentColor"
            strokeOpacity={0.08}
          />
        );
      })}
      <polyline
        points={coords.join(' ')}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinejoin="round"
      />
      <text x={PAD} y={14} fontSize={10} fill="currentColor" fillOpacity={0.55}>
        {`${String(yMax)}${unit ?? ''}`}
      </text>
      <text x={PAD} y={H - 3} fontSize={10} fill="currentColor" fillOpacity={0.55}>
        {`${String(yMin)}${unit ?? ''}`}
      </text>
      <text
        x={W - PAD}
        y={14}
        fontSize={10}
        textAnchor="end"
        fill="currentColor"
        fillOpacity={0.55}
      >
        {`${String(points.length)} 样本`}
      </text>
    </svg>
  );
}
