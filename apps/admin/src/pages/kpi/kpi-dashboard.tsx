/**
 * /kpi 能耗与 KPI 看板（M11-kpi-dashboard §7.1；IMPL-22 / DAT-246；prototype v3
 * KpiDashboard 对齐实现）。
 *
 * 区块：页头控件（楼宇随全局上下文 + 时间窗快捷项 + 手动刷新 + 近 1h 角标）→
 * KPI 卡组（§2.6 六卡：期能耗/单位面积能耗/基准偏差/S1 采纳率/S3 命中率/节能量）
 * → 趋势卡（堆叠柱 + 基准虚线 + reset/gap 断柱标注）→ 结构图卡（环形 + 明细行）
 * → 对标卡（基准缺失显式空态 + admin 配置入口）。
 *
 * 口径纪律：无自动轮询（慢变量）——进页/切窗拉取 + 手动刷新；数据截至 data_as_of；
 * viewer/operator 同视图，仅对标配置入口按 kpi.config 渲染（SEC-AZ-05）；
 * 无能耗点位空态引导（量型/计量表接入指引，§2.1）；单卡错误态不阻塞他卡（R5）。
 */
import {
  Alert,
  Button,
  Card,
  Empty,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Skeleton,
  Space,
  Tag,
  Tooltip,
  Typography,
  App as AntdApp,
} from 'antd';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  KPI_BENCHMARK_SOURCES,
  type KpiBenchmarkConfigPut,
  type KpiEnergyStructure,
  type KpiEnergyTrend,
  type KpiOverview,
} from '@thermio/shared-types';
import { useAuth, useCapabilities } from '../../app/auth-context.js';
import { errorText } from '../asset/asset-shared.js';
import { formatAbsolute } from '../relative-time.js';
import {
  WINDOW_OPTIONS,
  fetchKpiBenchmarkConfig,
  fetchKpiOverview,
  fetchKpiStructure,
  fetchKpiTrend,
  putKpiBenchmarkConfig,
  windowRange,
  type WindowKey,
} from './kpi-data.js';
import { StackBarTrend, StructureDonut } from './kpi-charts.js';

type GroupBy = 'none' | 'system_type' | 'equipment_type';

const GROUP_OPTIONS = [
  { label: '按系统', value: 'system_type' },
  { label: '按设备类型', value: 'equipment_type' },
  { label: '合计', value: 'none' },
] as const;

const BENCHMARK_SOURCE_OPTIONS = KPI_BENCHMARK_SOURCES.map((source) => ({
  value: source,
  label:
    source === 'none'
      ? 'none · 未配置（默认，显式基准缺失）'
      : source === 'fixed'
        ? 'fixed · 定额基准（日均 kWh）'
        : source === 'previous_period'
          ? 'previous_period · 环比（上一等长窗口）'
          : source === 'same_period_last_year'
            ? 'same_period_last_year · 同期同比'
            : 'mv_baseline · M9 基线推算（交付后接线）',
}));

function KpiCard({
  title,
  tip,
  foot,
  children,
}: {
  title: string;
  tip?: string;
  foot?: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <div
      style={{
        border: '1px solid var(--ant-color-border-secondary)',
        borderRadius: 8,
        padding: '12px 16px',
        background: 'var(--ant-color-bg-container)',
      }}
    >
      <div
        style={{
          fontSize: 12,
          color: 'var(--ant-color-text-tertiary)',
          display: 'flex',
          alignItems: 'center',
          gap: 5,
        }}
      >
        {title}
        {tip !== undefined && (
          <Tooltip title={tip}>
            <span style={{ fontSize: 11, opacity: 0.7 }}>?</span>
          </Tooltip>
        )}
      </div>
      <div style={{ marginTop: 5 }}>{children}</div>
      {foot !== undefined && (
        <div style={{ fontSize: 11, color: 'var(--ant-color-text-tertiary)', marginTop: 4 }}>
          {foot}
        </div>
      )}
    </div>
  );
}

function BigValue({
  value,
  unit,
  tone,
}: {
  value: string;
  unit: string;
  tone?: 'ok' | 'warn';
}): ReactNode {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 2, fontSize: 26, fontWeight: 600 }}>
      <span
        style={
          tone === 'ok'
            ? { color: 'var(--ant-color-success)' }
            : tone === 'warn'
              ? { color: 'var(--ant-color-warning)' }
              : undefined
        }
      >
        {value}
      </span>
      <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--ant-color-text-tertiary)' }}>
        {unit}
      </span>
    </div>
  );
}

export function KpiDashboardPage(): ReactNode {
  const { state } = useAuth();
  const capabilities = useCapabilities();
  const [searchParams, setSearchParams] = useSearchParams();
  const [win, setWin] = useState<WindowKey>('7d');
  const [groupBy, setGroupBy] = useState<GroupBy>('system_type');
  const [overview, setOverview] = useState<KpiOverview | null>(null);
  const [trend, setTrend] = useState<KpiEnergyTrend | null>(null);
  const [structure, setStructure] = useState<KpiEnergyStructure | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [benchOpen, setBenchOpen] = useState(false);

  const buildings =
    state.phase === 'authenticated' || state.phase === 'must-change-password'
      ? state.me.building_scopes
      : [];
  const buildingId = searchParams.get('building') ?? undefined;
  const canConfig = capabilities.includes('kpi.config');

  const range = useMemo(() => windowRange(win), [win]);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [o, t, s] = await Promise.all([
        fetchKpiOverview(buildingId, range),
        fetchKpiTrend(buildingId, range, groupBy),
        fetchKpiStructure(buildingId, range, groupBy === 'none' ? 'system_type' : groupBy),
      ]);
      setOverview(o);
      setTrend(t);
      setStructure(s);
    } catch (cause) {
      setError(errorText(cause, '看板数据加载失败'));
    } finally {
      setLoading(false);
    }
  }, [buildingId, range, groupBy]);

  useEffect(() => {
    void load();
  }, [load]);

  const groupKeys =
    trend === null || trend.group_by === 'none'
      ? []
      : [...new Set(trend.buckets.flatMap((b) => b.groups.map((g) => g.key)))];

  const benchmark = overview?.benchmark;
  const energy = overview?.energy;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title="能耗与 KPI 看板"
        extra={
          <Space wrap>
            <Select
              allowClear
              placeholder="全部授权楼宇"
              style={{ width: 170 }}
              value={buildingId}
              options={buildings.map((b) => ({ value: b.id, label: b.name }))}
              onChange={(value) => {
                setSearchParams((prev) => {
                  const next = new URLSearchParams(prev);
                  if (value === undefined) next.delete('building');
                  else next.set('building', value);
                  return next;
                });
              }}
            />
            <Segmented
              value={win}
              onChange={(v) => {
                setWin(v);
              }}
              options={WINDOW_OPTIONS.map((w) => ({ label: w.label, value: w.key }))}
            />
            <Segmented
              size="small"
              value={groupBy}
              onChange={(v) => {
                setGroupBy(v);
              }}
              options={[...GROUP_OPTIONS]}
            />
            <Button size="small" loading={loading} onClick={() => void load()}>
              刷新
            </Button>
            {overview?.freshness.includes_realtime === true && (
              <Tooltip title="时间窗覆盖最近 1 小时：cagg real-time 语义（ddl §11.2），近窗值由原始表现场合并，非最终物化口径">
                <Tag color="blue" style={{ marginInlineEnd: 0, fontSize: 11 }}>
                  含实时未聚合数据
                </Tag>
              </Tooltip>
            )}
          </Space>
        }
      >
        {error !== null && (
          <Alert
            type="error"
            showIcon
            message={error}
            style={{ marginBottom: 12 }}
            action={
              <Button size="small" onClick={() => void load()}>
                重试
              </Button>
            }
          />
        )}
        {overview !== null && !overview.energy.linked ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="暂无能耗数据（量型待登记 / 计量表待接入）"
            style={{ padding: '32px 0' }}
          >
            <div style={{ fontSize: 12, color: 'var(--ant-color-text-tertiary)', lineHeight: 1.9 }}>
              能耗点位集 = quantity_type=&apos;energy&apos; 的在用点位（§2.1）——当前为空：
              <br />① 确认 M3 §10.2 R12 量型登记已合入；② 在资产档案接入计量表并导入点位。
            </div>
          </Empty>
        ) : loading && overview === null ? (
          <Skeleton active paragraph={{ rows: 8 }} />
        ) : (
          <>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              窗口 {formatAbsolute(range.from)} ~ {formatAbsolute(range.to)} · 数据截至{' '}
              {overview !== null ? formatAbsolute(overview.freshness.data_as_of) : '—'} · 能耗口径 =
              能量累计点位 1h 聚合读数差分（缺失段不插值、表计重置不计入）
            </Typography.Text>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
                gap: 16,
                marginTop: 14,
              }}
            >
              <KpiCard
                title="期能耗"
                tip="窗口能耗 = 能量累计点位窗末/窗初读数差（§2.2）；桶覆盖见脚注"
                foot={`覆盖率 ${energy !== undefined ? (energy.coverage * 100).toFixed(1) : '—'}%（ok+uncertain ÷ 应有桶）`}
              >
                <BigValue
                  value={
                    energy?.total_kwh !== null && energy?.total_kwh !== undefined
                      ? energy.total_kwh.toLocaleString('zh-CN', { maximumFractionDigits: 1 })
                      : '—'
                  }
                  unit="kWh"
                />
              </KpiCard>
              {energy?.eui_kwh_m2 !== null && energy?.eui_kwh_m2 !== undefined && (
                <KpiCard
                  title="单位面积能耗"
                  tip="期能耗 ÷ building.gross_area_m2——面积缺失时本卡不渲染（真实可溯纪律，§2.6）"
                >
                  <BigValue value={energy.eui_kwh_m2.toFixed(2)} unit="kWh/m²" />
                </KpiCard>
              )}
              <KpiCard
                title="基准偏差"
                tip="(实际 − 基准) ÷ 基准；正 = 超基准（§2.5）"
                foot={
                  benchmark?.status === 'ok' ? (benchmark.source_label ?? undefined) : undefined
                }
              >
                {benchmark === undefined || benchmark.status === 'missing' ? (
                  <div style={{ fontSize: 13, color: 'var(--ant-color-text-tertiary)' }}>
                    基准缺失
                    <div style={{ fontSize: 11, marginTop: 2 }}>待配置基准源（H6 假设未收口）</div>
                  </div>
                ) : benchmark.status === 'unlinked' ? (
                  <div style={{ fontSize: 13, color: 'var(--ant-color-text-tertiary)' }}>
                    基准来源待接入
                    <div style={{ fontSize: 11, marginTop: 2 }}>
                      M9 基线推算接线前不伪算（§2.5）
                    </div>
                  </div>
                ) : (
                  <BigValue
                    value={`${benchmark.deviation_pct !== null && benchmark.deviation_pct > 0 ? '+' : ''}${benchmark.deviation_pct?.toFixed(1) ?? '—'}`}
                    unit="%"
                    tone={
                      benchmark.deviation_pct !== null && benchmark.deviation_pct < 0
                        ? 'ok'
                        : 'warn'
                    }
                  />
                )}
              </KpiCard>
              <KpiCard
                title="建议采纳率（S1）"
                tip="approved(含 executed/failed) ÷ (approved+rejected)，窗口内决策；expired 单独观测不入分母（PRD §7）"
                foot={
                  overview?.proposal_acceptance.unavailable === true
                    ? '统计源异常（暂不可用）'
                    : `已决策 ${String(overview?.proposal_acceptance.decided ?? 0)} · 确认 ${String(
                        overview?.proposal_acceptance.approved ?? 0,
                      )} · 过期 ${String(overview?.proposal_acceptance.expired ?? 0)}（不计分母）`
                }
              >
                {overview?.proposal_acceptance.unavailable === true ? (
                  <div style={{ fontSize: 13, color: 'var(--ant-color-text-tertiary)' }}>
                    暂不可用
                  </div>
                ) : (
                  <BigValue
                    value={
                      overview?.proposal_acceptance.rate !== null &&
                      overview?.proposal_acceptance.rate !== undefined
                        ? (overview.proposal_acceptance.rate * 100).toFixed(0)
                        : '—'
                    }
                    unit="%"
                  />
                )}
              </KpiCard>
              <KpiCard
                title="FDD 命中率（S3 抽检）"
                tip="confirmed ÷ reviewed，滚动 7×24h——与 M6 概览 review_stats 同式（§2.6 同源声明）"
                foot={`已抽检 ${String(overview?.fdd_hit_rate.reviewed ?? 0)} · 确认真实 ${String(
                  overview?.fdd_hit_rate.confirmed ?? 0,
                )}`}
              >
                <BigValue
                  value={
                    overview?.fdd_hit_rate.hit_rate !== null &&
                    overview?.fdd_hit_rate.hit_rate !== undefined
                      ? (overview.fdd_hit_rate.hit_rate * 100).toFixed(0)
                      : '—'
                  }
                  unit="%"
                />
              </KpiCard>
              <KpiCard
                title="节能量（当期）"
                tip="当期 mv_report 天气归一化节能量（M9 域，§2.6）"
                foot={
                  overview?.saving.linked === true ? 'M9 M&V 报告（天气归一化口径）' : undefined
                }
              >
                {overview?.saving.linked !== true ? (
                  <div style={{ fontSize: 13, color: 'var(--ant-color-text-tertiary)' }}>
                    未接入
                    <div style={{ fontSize: 11, marginTop: 2 }}>M9 M&amp;V 报告交付后接线</div>
                  </div>
                ) : (
                  <BigValue
                    value={
                      overview.saving.kwh !== null
                        ? overview.saving.kwh.toLocaleString('zh-CN', { maximumFractionDigits: 1 })
                        : '—'
                    }
                    unit="kWh"
                  />
                )}
              </KpiCard>
            </div>
          </>
        )}
      </Card>

      {overview?.energy.linked !== false && (
        <>
          <Card
            title="能耗趋势"
            extra={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {trend?.interval === 'day' ? '日桶（>7 天自动规则）' : '小时桶（≤7 天自动规则）'} ·
                数据截至 {overview !== null ? formatAbsolute(overview.freshness.data_as_of) : '—'}
              </Typography.Text>
            }
          >
            {loading && trend === null ? (
              <Skeleton active paragraph={{ rows: 7 }} />
            ) : trend !== null ? (
              <StackBarTrend trend={trend} groupKeys={groupKeys} />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无趋势数据" />
            )}
          </Card>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))',
              gap: 16,
            }}
          >
            <Card
              title={`能耗结构（${groupBy === 'none' ? '按系统' : groupBy === 'system_type' ? '按系统' : '按设备类型'}）`}
            >
              {loading && structure === null ? (
                <Skeleton active paragraph={{ rows: 5 }} />
              ) : structure !== null && structure.items.length > 0 ? (
                <>
                  <StructureDonut structure={structure} />
                  <div
                    style={{ fontSize: 11, color: 'var(--ant-color-text-tertiary)', marginTop: 10 }}
                  >
                    未分类 = 能耗点位未挂系统/设备缺失（§2.4，灰档末位）·
                    防双计属建档纪律（总表/分表挂载层级单一）
                  </div>
                </>
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="窗口内无能耗数据" />
              )}
            </Card>
            <Card
              title="对标"
              extra={
                canConfig && buildingId !== undefined ? (
                  <Button
                    size="small"
                    onClick={() => {
                      setBenchOpen(true);
                    }}
                  >
                    配置基准
                  </Button>
                ) : undefined
              }
            >
              {benchmark === undefined || benchmark.status === 'missing' ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="暂无对标基准（基准口径待配置）"
                  style={{ padding: '18px 0' }}
                >
                  {canConfig && buildingId !== undefined && (
                    <Button
                      type="primary"
                      onClick={() => {
                        setBenchOpen(true);
                      }}
                    >
                      配置基准源
                    </Button>
                  )}
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--ant-color-text-tertiary)',
                      marginTop: 10,
                      lineHeight: 1.8,
                    }}
                  >
                    基准口径是待验证假设（PRD §2.3 H6）：同类楼宇 / 国标 / 历史基线均无数据支撑——
                    <br />
                    按可配置基准源设计，不预设来源为事实（§8）
                  </div>
                </Empty>
              ) : (
                <Space direction="vertical" size={12}>
                  <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontSize: 12, color: 'var(--ant-color-text-tertiary)' }}>
                        实际 / 基准（窗口）
                      </div>
                      <div style={{ fontSize: 22, fontWeight: 600, marginTop: 4 }}>
                        {(energy?.total_kwh ?? 0).toLocaleString('zh-CN', {
                          maximumFractionDigits: 0,
                        })}
                        <span
                          style={{
                            fontSize: 12,
                            fontWeight: 400,
                            color: 'var(--ant-color-text-tertiary)',
                          }}
                        >
                          {' '}
                          /{' '}
                          {(benchmark.baseline_kwh ?? 0).toLocaleString('zh-CN', {
                            maximumFractionDigits: 0,
                          })}{' '}
                          kWh
                        </span>
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 12, color: 'var(--ant-color-text-tertiary)' }}>
                        偏差
                      </div>
                      <div
                        style={{
                          fontSize: 22,
                          fontWeight: 600,
                          marginTop: 4,
                          color:
                            benchmark.deviation_pct !== null && benchmark.deviation_pct < 0
                              ? 'var(--ant-color-success)'
                              : 'var(--ant-color-warning)',
                        }}
                      >
                        {benchmark.deviation_pct !== null && benchmark.deviation_pct < 0
                          ? '▼'
                          : '▲'}
                        {benchmark.deviation_pct !== null
                          ? `${benchmark.deviation_pct.toFixed(1)}%`
                          : '—'}
                      </div>
                    </div>
                  </div>
                  {benchmark.source_label !== null && (
                    <Tag color="geekblue">{benchmark.source_label}</Tag>
                  )}
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--ant-color-text-tertiary)',
                      lineHeight: 1.8,
                    }}
                  >
                    有基准时标注口径来源（AC-8）· fixed 定额 / 环比 / 同期同比 / M9
                    基线推算（待接入不伪算，§2.5）
                  </div>
                </Space>
              )}
            </Card>
          </div>
        </>
      )}

      {benchOpen && buildingId !== undefined && (
        <BenchmarkConfigModal
          buildingId={buildingId}
          onClose={() => {
            setBenchOpen(false);
          }}
          onSaved={() => {
            setBenchOpen(false);
            void load();
          }}
        />
      )}
    </Space>
  );
}

/** 对标基准配置（admin，kpi.config；§5.5 PUT /kpi/benchmark-config）。 */
function BenchmarkConfigModal({
  buildingId,
  onClose,
  onSaved,
}: {
  buildingId: string;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const { message } = AntdApp.useApp();
  const [source, setSource] = useState<KpiBenchmarkConfigPut['source']>('none');
  const [kwhPerDay, setKwhPerDay] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const config = await fetchKpiBenchmarkConfig(buildingId);
        if (cancelled) return;
        setSource(config.source);
        setKwhPerDay(config.params.kwh_per_day ?? null);
        setUpdatedAt(config.updated_at);
      } catch {
        // 无配置 = none 缺省形状；加载失败保持缺省
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [buildingId]);

  const save = async (): Promise<void> => {
    if (source === 'fixed' && (kwhPerDay === null || kwhPerDay <= 0)) {
      message.error('fixed 源必填 params.kwh_per_day（422 kpi.benchmark_config_invalid）');
      return;
    }
    setSaving(true);
    try {
      await putKpiBenchmarkConfig(buildingId, {
        source,
        params: source === 'fixed' && kwhPerDay !== null ? { kwh_per_day: kwhPerDay } : {},
      });
      message.success('基准配置已保存');
      onSaved();
    } catch (cause) {
      message.error(errorText(cause, '保存失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="对标基准配置（kpi.config · admin）"
      open
      onCancel={onClose}
      onOk={() => void save()}
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      okButtonProps={{ disabled: loading }}
    >
      <div
        style={{
          fontSize: 12,
          color: 'var(--ant-color-text-tertiary)',
          marginBottom: 12,
          lineHeight: 1.8,
        }}
      >
        一楼一套现行配置（UNIQUE tenant+building）· 变更留结构化日志 · source 与 params 匹配校验 422
        kpi.benchmark_config_invalid
      </div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, marginBottom: 6 }}>基准源（KPI_BENCHMARK_SOURCES）</div>
        <Select
          style={{ width: '100%' }}
          value={source}
          options={BENCHMARK_SOURCE_OPTIONS}
          onChange={(v) => {
            setSource(v);
          }}
        />
      </div>
      {source === 'fixed' && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, marginBottom: 6 }}>
            日均定额（kWh/日，params.kwh_per_day）
          </div>
          <InputNumber
            style={{ width: '100%' }}
            min={0.001}
            value={kwhPerDay}
            onChange={(v) => {
              setKwhPerDay(v);
            }}
            placeholder="fixed 源必填"
          />
        </div>
      )}
      <div style={{ fontSize: 11, color: 'var(--ant-color-text-tertiary)' }}>
        {updatedAt !== null ? `上次更新：${formatAbsolute(updatedAt)}` : '尚未配置'}
      </div>
    </Modal>
  );
}
