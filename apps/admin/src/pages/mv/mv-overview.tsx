/**
 * M&V 总览 /mv（modules/M9-mv-report.md §8 页一；IMPL-21 / DAT-242）。
 *
 * Tab 两区：基线列表（楼宇/基线期/方法/状态/季覆盖）+ 报告列表（期/状态/节能量/
 * 降级标）。空态文案与能力显隐按 §8：建基线 mv_baselines.write、生成
 * mv_reports.generate；激活冲突 details.conflicts 驱动「替代/取消」选择（Modal）。
 */
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Empty,
  Form,
  InputNumber,
  Modal,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { Dayjs } from 'dayjs';
import {
  type MvBaselineList,
  type MvBaselineSummary,
  type MvReportList,
  type MvReportSummary,
  type MvWeatherStation,
} from '@thermio/shared-types';
import { useAuth } from '../../app/auth-context.js';
import { errorText } from '../asset/asset-shared.js';
import { formatAbsolute } from '../relative-time.js';
import {
  createMvBaseline,
  fetchMvBaselines,
  fetchMvReports,
  fetchMvWeatherStations,
} from './mv-data.js';

const STATUS_LABEL: Record<MvBaselineSummary['status'], { text: string; color: string }> = {
  draft: { text: '草稿', color: 'default' },
  active: { text: '现行', color: 'green' },
  retired: { text: '已停用', color: 'orange' },
};

interface EnergyPointOption {
  readonly value: number;
  readonly label: string;
}

export function MvOverviewPage(): ReactNode {
  const { state } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState(searchParams.get('tab') ?? 'baselines');
  const [baselines, setBaselines] = useState<MvBaselineList | null>(null);
  const [reports, setReports] = useState<MvReportList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const capabilities =
    state.phase === 'authenticated' || state.phase === 'must-change-password'
      ? state.me.capabilities
      : [];
  const buildings =
    state.phase === 'authenticated' || state.phase === 'must-change-password'
      ? state.me.building_scopes
      : [];
  const canWrite = capabilities.includes('mv_baselines.write');
  const canGenerate = capabilities.includes('mv_reports.generate');

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [baselinePage, reportPage] = await Promise.all([fetchMvBaselines(), fetchMvReports()]);
      setBaselines(baselinePage);
      setReports(reportPage);
    } catch (cause) {
      setError(errorText(cause, 'M&V 数据加载失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card
      title="M&V 节能量核证"
      extra={
        <Space>
          {canWrite && (
            <Button
              type="primary"
              onClick={() => {
                setCreateOpen(true);
              }}
            >
              新建基线
            </Button>
          )}
          {canGenerate && (
            <Button onClick={() => void navigate('/mv', { replace: true })}>
              在基线详情发起生成
            </Button>
          )}
        </Space>
      }
    >
      {error !== null && (
        <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />
      )}
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'baselines',
            label: '基线',
            children: (
              <BaselinesTable
                page={baselines}
                loading={loading}
                empty={canWrite ? '尚无基线——建立基线后才能生成核证报告' : '尚无基线'}
                onLoadMore={
                  baselines !== null && baselines.next_cursor !== null
                    ? () => void load()
                    : undefined
                }
              />
            ),
          },
          {
            key: 'reports',
            label: '报告',
            children: (
              <ReportsTable
                page={reports}
                loading={loading}
                empty="尚无报告——基线激活后可发起生成"
              />
            ),
          },
        ]}
      />
      {createOpen && (
        <CreateBaselineModal
          buildings={buildings.map((b) => ({ value: b.id, label: b.name }))}
          onClose={() => {
            setCreateOpen(false);
          }}
          onCreated={(id) => {
            setCreateOpen(false);
            void navigate(`/mv/baselines/${id}`);
          }}
        />
      )}
    </Card>
  );
}

function BaselinesTable({
  page,
  loading,
  empty,
  onLoadMore,
}: {
  page: MvBaselineList | null;
  loading: boolean;
  empty: string;
  onLoadMore: (() => void) | undefined;
}): ReactNode {
  if (page === null) {
    return (
      <div style={{ textAlign: 'center', padding: 32 }}>
        <Spin />
      </div>
    );
  }
  if (page.items.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={empty} />;
  }
  return (
    <>
      <Table
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={page.items.map((item) => ({ ...item, key: item.id }))}
        pagination={false}
        columns={[
          {
            title: '基线期（闭开）',
            dataIndex: 'baseline_period',
            render: (_v, row: MvBaselineSummary): ReactNode => (
              <Link to={`/mv/baselines/${row.id}`}>
                {row.baseline_period.start} ~ {row.baseline_period.end}
              </Link>
            ),
          },
          {
            title: '方法',
            dataIndex: 'method',
            width: 150,
            render: (): ReactNode => <Tag style={{ marginInlineEnd: 0 }}>IPMVP 选项 C</Tag>,
          },
          {
            title: '状态',
            dataIndex: 'status',
            width: 90,
            render: (value: MvBaselineSummary['status']): ReactNode => (
              <Tag color={STATUS_LABEL[value].color} style={{ marginInlineEnd: 0 }}>
                {STATUS_LABEL[value].text}
              </Tag>
            ),
          },
          {
            title: '季覆盖',
            dataIndex: 'season_coverage',
            width: 90,
            render: (value: MvBaselineSummary['season_coverage']): ReactNode =>
              value === 'full' ? '全年' : <Tag color="gold">部分季</Tag>,
          },
          {
            title: '激活时间',
            dataIndex: 'activated_at',
            width: 170,
            render: (value: string | null): ReactNode =>
              value === null ? '—' : formatAbsolute(value),
          },
          {
            title: '操作',
            key: 'actions',
            width: 80,
            render: (_v, row: MvBaselineSummary): ReactNode => (
              <Link to={`/mv/baselines/${row.id}`}>详情</Link>
            ),
          },
        ]}
      />
      {onLoadMore !== undefined && (
        <Button block style={{ marginTop: 12 }} loading={loading} onClick={onLoadMore}>
          加载更多
        </Button>
      )}
    </>
  );
}

function ReportsTable({
  page,
  loading,
  empty,
}: {
  page: MvReportList | null;
  loading: boolean;
  empty: string;
}): ReactNode {
  if (page === null) {
    return (
      <div style={{ textAlign: 'center', padding: 32 }}>
        <Spin />
      </div>
    );
  }
  if (page.items.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={empty} />;
  }
  const fmt = (value: number | null): string =>
    value === null ? '—' : `${String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} kWh`;
  return (
    <Table
      size="small"
      rowKey="id"
      loading={loading}
      dataSource={page.items.map((item) => ({ ...item, key: item.id }))}
      pagination={false}
      columns={[
        {
          title: '报告期（闭开）',
          dataIndex: 'report_period',
          render: (_v, row: MvReportSummary): ReactNode => (
            <Link to={`/mv/reports/${row.id}`}>
              {row.report_period.start} ~ {row.report_period.end}
            </Link>
          ),
        },
        {
          title: '状态',
          dataIndex: 'status',
          width: 100,
          render: (value: MvReportSummary['status']): ReactNode => (
            <Tag color={value === 'approved' ? 'green' : 'blue'} style={{ marginInlineEnd: 0 }}>
              {value === 'approved' ? '已审批' : '待审批'}
            </Tag>
          ),
        },
        {
          title: '节能量（口径 B）',
          dataIndex: 'weather_adjusted_saving_kwh',
          width: 150,
          render: (value: number | null, row: MvReportSummary): ReactNode =>
            row.degraded ? <Tag color="orange">降级</Tag> : fmt(value),
        },
        {
          title: '节能量（口径 A）',
          dataIndex: 'raw_saving_kwh',
          width: 150,
          render: (value: number): ReactNode => fmt(value),
        },
        {
          title: '生成时间',
          dataIndex: 'generated_at',
          width: 170,
          render: (value: string): ReactNode => formatAbsolute(value),
        },
        {
          title: '操作',
          key: 'actions',
          width: 80,
          render: (_v, row: MvReportSummary): ReactNode => (
            <Link to={`/mv/reports/${row.id}`}>详情</Link>
          ),
        },
      ]}
    />
  );
}

interface CreateFormValues {
  building_id: string;
  period: [Dayjs | null, Dayjs | null] | undefined;
  t_cool_c: number | undefined;
  t_heat_c: number | undefined;
  weekend_dummy: boolean | undefined;
  metering_point_ids: number[] | undefined;
  weather_source: string | undefined;
}

/** 新建基线弹窗（§8：方法默认选项 C、点位选择器 quantity_type=energy、站点选择器 §6.14）。 */
function CreateBaselineModal({
  buildings,
  onClose,
  onCreated,
}: {
  buildings: readonly { value: string; label: string }[];
  onClose: () => void;
  onCreated: (baselineId: string) => void;
}): ReactNode {
  const [form] = Form.useForm<CreateFormValues>();
  const [stations, setStations] = useState<readonly MvWeatherStation[]>([]);
  const [pointOptions, setPointOptions] = useState<readonly EnergyPointOption[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    void fetchMvWeatherStations()
      .then((response) => {
        setStations(response.items);
      })
      .catch(() => {
        setStations([]);
      });
  }, []);

  const loadPoints = useCallback(async (buildingId: string): Promise<void> => {
    try {
      const params = new URLSearchParams({
        building_id: buildingId,
        quantity_type: 'energy',
        limit: '200',
      });
      const { apiFetch } = await import('../../app/api-client.js');
      const { PointListResponseSchema } = await import('@thermio/shared-types');
      const page = await apiFetch(`/points?${params.toString()}`, PointListResponseSchema);
      setPointOptions(
        page.items.map((item) => ({
          value: item.point.id,
          label: `${item.point.display_name ?? item.point.raw_name}（point:${String(item.point.id)}）`,
        })),
      );
    } catch {
      setPointOptions([]);
    }
  }, []);

  const submit = async (): Promise<void> => {
    try {
      const values = await form.validateFields();
      const period = values.period ?? [];
      const start = period[0] ?? null;
      const end = period[1] ?? null;
      if (start === null || end === null || !start.isBefore(end)) {
        throw new Error('基线期起止颠倒或缺选');
      }
      setSubmitting(true);
      setSubmitError(null);
      const created = await createMvBaseline({
        building_id: values.building_id,
        method: 'ipmvp_option_c',
        baseline_period: { start: start.format('YYYY-MM-DD'), end: end.format('YYYY-MM-DD') },
        model_type: 'ols_daily_cdd_hdd',
        model_spec: {
          t_cool_c: values.t_cool_c ?? 26,
          t_heat_c: values.t_heat_c ?? 18,
          weekend_dummy: values.weekend_dummy ?? true,
        },
        metering_point_ids: values.metering_point_ids ?? [],
        weather_source: values.weather_source ?? '',
      });
      void message.success('基线已创建（首次校核完成）');
      onCreated(created.id);
    } catch (cause) {
      setSubmitError(errorText(cause, '创建失败'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="新建基线（IPMVP 选项 C · 整楼度量）"
      open
      onCancel={onClose}
      confirmLoading={submitting}
      onOk={() => void submit()}
      okText="创建"
      width={640}
    >
      {submitError !== null && (
        <Alert type="error" showIcon message={submitError} style={{ marginBottom: 12 }} />
      )}
      <Form
        form={form}
        layout="vertical"
        initialValues={{ weekend_dummy: true, t_cool_c: 26, t_heat_c: 18 }}
      >
        <Form.Item
          name="building_id"
          label="楼宇"
          rules={[{ required: true, message: '选择楼宇' }]}
        >
          <Select
            options={buildings.map((option) => ({ ...option }))}
            placeholder="选择楼宇"
            onChange={(value: string) => {
              void loadPoints(value);
            }}
          />
        </Form.Item>
        <Form.Item
          name="period"
          label="基线期（90–731 天，闭开区间）"
          rules={[{ required: true, message: '选择基线期' }]}
        >
          <DatePicker.RangePicker style={{ width: '100%' }} />
        </Form.Item>
        <Space size={16} wrap>
          <Form.Item name="t_cool_c" label="制冷平衡点（℃）" style={{ marginBottom: 0 }}>
            <InputNumber min={-40} max={60} />
          </Form.Item>
          <Form.Item name="t_heat_c" label="制热平衡点（℃）" style={{ marginBottom: 0 }}>
            <InputNumber min={-40} max={60} />
          </Form.Item>
          <Form.Item
            name="weekend_dummy"
            label="周末哑变量"
            valuePropName="checked"
            style={{ marginBottom: 0 }}
          >
            <Switch />
          </Form.Item>
        </Space>
        <Form.Item
          name="metering_point_ids"
          label="计量边界（energy 量型点位，激活后冻结）"
          rules={[{ required: true, message: '选择计量点位' }]}
          style={{ marginTop: 16 }}
        >
          <Select
            mode="multiple"
            options={pointOptions.map((option) => ({ ...option }))}
            placeholder="选择楼宇后加载 energy 点位"
          />
        </Form.Item>
        <Form.Item
          name="weather_source"
          label="天气站点（近 90 天有观测）"
          rules={[{ required: true, message: '选择天气站点' }]}
        >
          <Select
            options={stations.map((station) => ({
              value: station.station_id,
              label: `${station.station_id}（覆盖率 ${String(Math.round(station.coverage_90d * 100))}%）`,
            }))}
            placeholder="站点选择器"
          />
        </Form.Item>
      </Form>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        基线期长度 90–731 天；创建即跑首次数据窗校核（完整日 ≥90 且覆盖率 ≥90%、CVRMSE ≤30%、 |NMBE|
        ≤10% 方可激活）。
      </Typography.Text>
    </Modal>
  );
}
