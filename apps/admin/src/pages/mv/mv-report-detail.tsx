/**
 * 报告详情 /mv/reports/:id（modules/M9-mv-report.md §8 页三；IMPL-21 / DAT-242）。
 *
 * - 双曲线图（series：基线预测/实际，内联 SVG，无图表依赖）+ 节能量卡（口径 A/B
 *   并列）+ 置信区间条 + 口径说明区（模型参数/拟合指标/插补日/season_coverage）；
 * - 降级横幅「本期天气数据缺失，节能量为未归一化口径」+ late_buffer 横幅（§3.6）；
 * - 审批按钮 mv_reports.approve 能力驱动；待审批「删除重出」；导出 → 任务态轮询
 *   → 下载（导出任务卡复用任务态页型，§6.13 数据面）。
 */
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Modal,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from 'antd';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { MvExportCreateResponse, MvExportJob, MvReportDetail } from '@thermio/shared-types';
import { useAuth } from '../../app/auth-context.js';
import { ApiError } from '../../app/api-client.js';
import { errorText } from '../asset/asset-shared.js';
import { formatAbsolute } from '../relative-time.js';
import {
  approveMvReport,
  deleteMvReport,
  exportDownloadHref,
  exportMvReport,
  fetchMvExportJob,
  fetchMvReportDetail,
} from './mv-data.js';

const fmtKwh = (value: number | null | undefined): string =>
  value === null || value === undefined
    ? '—'
    : `${String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} kWh`;

export function MvReportDetailPage(): ReactNode {
  const { reportId } = useParams<{ reportId: string }>();
  const navigate = useNavigate();
  const { state } = useAuth();
  const [report, setReport] = useState<MvReportDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [exportJob, setExportJob] = useState<MvExportCreateResponse | null>(null);
  const [exportState, setExportState] = useState<MvExportJob | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const capabilities =
    state.phase === 'authenticated' || state.phase === 'must-change-password'
      ? state.me.capabilities
      : [];
  const canApprove = capabilities.includes('mv_reports.approve');
  const canExport = capabilities.includes('mv_reports.export');
  const canGenerate = capabilities.includes('mv_reports.generate');

  const load = useCallback(async (): Promise<void> => {
    if (reportId === undefined) return;
    try {
      setReport(await fetchMvReportDetail(reportId));
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) setMissing(true);
      else setError(errorText(cause, '报告详情加载失败'));
    }
  }, [reportId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 导出任务轮询（§8：可离开页面，此处为本页内的任务态卡）
  useEffect(() => {
    if (exportJob === null) return;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const job = await fetchMvExportJob(exportJob.export_job_id);
        if (cancelled) return;
        setExportState(job);
        if (job.status === 'queued' || job.status === 'running') {
          setTimeout(() => void poll(), 800);
        }
      } catch {
        if (!cancelled) setExportState(null);
      }
    };
    void poll();
    return () => {
      cancelled = true;
    };
  }, [exportJob]);

  const series = useMemo(() => report?.series ?? [], [report]);

  if (missing) {
    return <Alert type="error" showIcon message="报告不存在或无权访问（mv.report_not_found）" />;
  }
  if (report === null) {
    if (error !== null) return <Alert type="error" showIcon message={error} />;
    return (
      <div style={{ textAlign: 'center', padding: 48 }}>
        <Spin />
      </div>
    );
  }

  const ci = report.confidence_interval;

  const act = async (action: () => Promise<unknown>, successText: string): Promise<void> => {
    setActing(true);
    try {
      await action();
      void message.success(successText);
      await load();
    } catch (cause) {
      setError(errorText(cause, '操作失败'));
    } finally {
      setActing(false);
    }
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title={
          <Space size={8}>
            <Button size="small" onClick={() => void navigate('/mv?tab=reports')}>
              返回
            </Button>
            {report.report_no}
            <Tag
              color={report.status === 'approved' ? 'green' : 'blue'}
              style={{ marginInlineEnd: 0 }}
            >
              {report.status === 'approved' ? '已审批（结算锁定）' : '待审批'}
            </Tag>
          </Space>
        }
        extra={
          <Space>
            {canApprove && report.status === 'pending_approval' && (
              <Button
                type="primary"
                loading={acting}
                onClick={() => void act(() => approveMvReport(report.id), '已审批锁定')}
              >
                审批锁定
              </Button>
            )}
            {canGenerate && report.status === 'pending_approval' && (
              <Button
                danger
                loading={acting}
                onClick={() => {
                  setDeleteOpen(true);
                }}
              >
                删除重出
              </Button>
            )}
            {canExport && (
              <Button
                loading={acting}
                onClick={() =>
                  void act(async () => {
                    const created = await exportMvReport(report.id);
                    setExportJob(created);
                    setExportState(null);
                  }, '导出任务已创建')
                }
              >
                导出 PDF
              </Button>
            )}
          </Space>
        }
      >
        <Descriptions size="small" column={3}>
          <Descriptions.Item label="报告期（闭开）">
            {report.report_period.start} ~ {report.report_period.end}
          </Descriptions.Item>
          <Descriptions.Item label="生成时间">
            {formatAbsolute(report.generated_at)}
          </Descriptions.Item>
          <Descriptions.Item label="审批时间">
            {report.approved_at === null ? '—' : formatAbsolute(report.approved_at)}
          </Descriptions.Item>
        </Descriptions>
        {report.degraded && (
          <Alert
            type="warning"
            showIcon
            message="本期天气数据缺失，节能量为未归一化口径"
            description="天气覆盖率低于 95% 门槛：口径 B（天气归一化节能量）与置信区间为空，仅口径 A 并列呈现。"
            style={{ marginTop: 8 }}
          />
        )}
        {report.late_buffer && (
          <Alert
            type="info"
            showIcon
            message="补传缓冲期内：报告期止距生成不足 5 天，建议期满后删除重出"
            style={{ marginTop: 8 }}
          />
        )}
      </Card>

      <Card title="节能量（双口径并列）">
        <Space size={40} wrap>
          <SavingCard
            label="口径 A · 未归一化（kWh）"
            value={fmtKwh(report.raw_saving_kwh)}
            hint={`基线参照 ${fmtKwh(report.baseline_energy_kwh)} − 实际 ${fmtKwh(report.actual_energy_kwh)}`}
          />
          <SavingCard
            label="口径 B · 天气归一化（kWh）"
            value={report.degraded ? '—（降级）' : fmtKwh(report.weather_adjusted_saving_kwh)}
            hint={
              report.degraded
                ? '天气覆盖率不足 95%'
                : ci === null
                  ? '—'
                  : `68% CI：${fmtKwh(ci.lower_kwh)} ~ ${fmtKwh(ci.upper_kwh)}（半宽 ${fmtKwh(ci.half_width_kwh)}）`
            }
            warn={report.degraded || (ci?.uncertainty_high ?? false)}
          />
          <SavingCard
            label="插补日"
            value={String(report.imputed_days)}
            hint="缺口日按基线模型预测或样本日均插补（显式计数）"
          />
        </Space>
        {ci !== null && ci.uncertainty_high && (
          <Alert
            type="warning"
            showIcon
            message="不确定性警示：置信区间半宽超过节能量一半（IPMVP 警示线，呈现不阻断）"
            style={{ marginTop: 12 }}
          />
        )}
      </Card>

      <Card title="日粒度双曲线（基线预测 Ŝ / 实际 E）">
        <DualCurveChart series={series} />
      </Card>

      <Card title="口径说明（基线模型与校核快照）">
        {report.calib.model_params === null ? (
          <Typography.Text type="secondary">无模型参数快照</Typography.Text>
        ) : (
          <Descriptions size="small" column={3}>
            <Descriptions.Item label="模型">日粒度 OLS（CDD/HDD + 周末哑变量）</Descriptions.Item>
            <Descriptions.Item label="平衡点">
              T_cool {String(report.calib.model_params.spec.t_cool_c)}℃ / T_heat{' '}
              {String(report.calib.model_params.spec.t_heat_c)}℃
            </Descriptions.Item>
            <Descriptions.Item label="周末哑变量">
              {report.calib.model_params.spec.weekend_dummy ? '开' : '关'}
            </Descriptions.Item>
            {report.calib.model_params.metrics !== null && (
              <>
                <Descriptions.Item label="n_obs">
                  {String(report.calib.model_params.n_obs)}
                </Descriptions.Item>
                <Descriptions.Item label="CVRMSE">
                  {report.calib.model_params.metrics.cvrmse_pct.toFixed(1)}%
                </Descriptions.Item>
                <Descriptions.Item label="season_coverage">
                  {report.calib.model_params.season_coverage === 'full'
                    ? '全年'
                    : '部分季（真楼飞轮冷却季首报的诚实呈现）'}
                </Descriptions.Item>
              </>
            )}
          </Descriptions>
        )}
      </Card>

      {exportState !== null && (
        <Card title="导出任务" size="small">
          <Space>
            <Tag
              color={
                exportState.status === 'succeeded'
                  ? 'green'
                  : exportState.status === 'failed'
                    ? 'red'
                    : 'blue'
              }
              style={{ marginInlineEnd: 0 }}
            >
              {exportState.status}
            </Tag>
            {exportState.status === 'succeeded' ? (
              <a href={exportDownloadHref(exportState.id)} target="_blank" rel="noreferrer">
                下载 PDF（{String(Math.round((exportState.file_bytes ?? 0) / 1024))} KB， 保留至{' '}
                {exportState.expires_at === null ? '—' : formatAbsolute(exportState.expires_at)}）
              </a>
            ) : (
              <Typography.Text type="secondary">
                {exportState.status === 'failed'
                  ? `渲染失败：${exportState.failure?.message ?? '—'}（可重新导出；报告本体不受影响）`
                  : '渲染中……可离开本页，完成后从导出任务列表下载'}
              </Typography.Text>
            )}
          </Space>
        </Card>
      )}

      <Modal
        title="删除重出"
        open={deleteOpen}
        okText="删除"
        okButtonProps={{ danger: true, loading: acting }}
        onCancel={() => {
          setDeleteOpen(false);
        }}
        onOk={() =>
          void act(async () => {
            await deleteMvReport(report.id);
            void navigate('/mv?tab=reports');
          }, '已删除，同周期可重出')
        }
      >
        <Typography.Paragraph>
          删除后同（基线 × 报告期）可重新发起生成；已审批报告不可删除（结算锁定）。
        </Typography.Paragraph>
      </Modal>

      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        <Link to="/mv">返回 M&V 总览</Link> · 报告编号与导出 PDF 同源（MV-楼宇-期起-期止-短号）
      </Typography.Text>
    </Space>
  );
}

function SavingCard({
  label,
  value,
  hint,
  warn = false,
}: {
  label: string;
  value: string;
  hint: string;
  warn?: boolean;
}): ReactNode {
  return (
    <div style={{ minWidth: 220 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {label}
      </Typography.Text>
      <div
        style={{
          fontSize: 30,
          fontWeight: 600,
          lineHeight: 1.25,
          color: warn ? 'var(--ti-sev-warning, #d46b08)' : undefined,
        }}
      >
        {value}
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {hint}
      </Typography.Text>
    </div>
  );
}

/** 内联 SVG 双曲线（无图表依赖；基线预测蓝 / 实际绿，缺值断点）。 */
function DualCurveChart({
  series,
}: {
  series: readonly { date: string; baseline_pred_kwh: number | null; actual_kwh: number | null }[];
}): ReactNode {
  const width = 860;
  const height = 260;
  const padding = { top: 16, right: 16, bottom: 26, left: 64 };
  if (series.length === 0) {
    return (
      <Typography.Text type="secondary">
        序列数据暂不可用（TSDB 读失败时结算列不受影响）
      </Typography.Text>
    );
  }
  const values = series.flatMap((point) =>
    point.baseline_pred_kwh !== null && point.actual_kwh !== null
      ? [point.baseline_pred_kwh, point.actual_kwh]
      : [],
  );
  const maxValue = Math.max(...(values.length > 0 ? values : [1]));
  const minValue = Math.min(0, ...values);
  const x = (index: number): number =>
    padding.left +
    (index / Math.max(series.length - 1, 1)) * (width - padding.left - padding.right);
  const y = (value: number): number =>
    height -
    padding.bottom -
    ((value - minValue) / Math.max(maxValue - minValue, 1e-9)) *
      (height - padding.top - padding.bottom);

  const path = (
    pick: (point: { baseline_pred_kwh: number | null; actual_kwh: number | null }) => number | null,
  ): string => {
    let pathValue = '';
    let penDown = false;
    series.forEach((point, index) => {
      const value = pick(point);
      if (value === null) {
        penDown = false;
        return;
      }
      pathValue += `${penDown ? 'L' : 'M'}${x(index).toFixed(1)},${y(value).toFixed(1)} `;
      penDown = true;
    });
    return pathValue.trim();
  };

  const gridValues = [0, 0.25, 0.5, 0.75, 1].map(
    (ratio) => minValue + ratio * (maxValue - minValue),
  );

  return (
    <svg
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      style={{ width: '100%', height: 'auto' }}
    >
      {gridValues.map((value) => (
        <g key={String(value)}>
          <line
            x1={padding.left}
            x2={width - padding.right}
            y1={y(value)}
            y2={y(value)}
            stroke="var(--ant-color-border-secondary, #e5e7eb)"
            strokeWidth={0.7}
          />
          <text
            x={padding.left - 6}
            y={y(value) + 3}
            textAnchor="end"
            fontSize={10}
            fill="currentColor"
            opacity={0.55}
          >
            {String(Math.round(value))}
          </text>
        </g>
      ))}
      <path
        d={path((point) => point.baseline_pred_kwh)}
        fill="none"
        stroke="#1677ff"
        strokeWidth={1.6}
      />
      <path d={path((point) => point.actual_kwh)} fill="none" stroke="#389e0d" strokeWidth={1.6} />
      <text x={padding.left} y={height - 8} fontSize={10} fill="currentColor" opacity={0.55}>
        {series[0]?.date}
      </text>
      <text
        x={width - padding.right}
        y={height - 8}
        textAnchor="end"
        fontSize={10}
        fill="currentColor"
        opacity={0.55}
      >
        {series[series.length - 1]?.date}
      </text>
      <g fontSize={11}>
        <line
          x1={padding.left}
          x2={padding.left + 26}
          y1={12}
          y2={12}
          stroke="#1677ff"
          strokeWidth={1.6}
        />
        <text x={padding.left + 32} y={16} fill="currentColor">
          基线预测 Ŝ
        </text>
        <line
          x1={padding.left + 110}
          x2={padding.left + 136}
          y1={12}
          y2={12}
          stroke="#389e0d"
          strokeWidth={1.6}
        />
        <text x={padding.left + 142} y={16} fill="currentColor">
          实际 E
        </text>
      </g>
    </svg>
  );
}
