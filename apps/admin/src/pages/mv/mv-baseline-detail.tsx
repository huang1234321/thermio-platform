/**
 * 基线详情 /mv/baselines/:id（modules/M9-mv-report.md §8 页二；IMPL-21 / DAT-242）。
 *
 * - draft：口径四项可编辑（期/模型参数/计量边界/天气站点）+ :validate 重跑校核 +
 *   :activate（二次确认「影响结算口径」；409 details.conflicts 驱动 supersede 勾选）；
 * - active：只读 + :retire；retired：只读；
 * - 校核结果卡：window.gaps 缺口清单（日期段 × 点位 × 原因）+ fit 指标与合格线对照
 *   （§3.5 形状直读）。
 */
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Form,
  InputNumber,
  Modal,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { MvBaselineDetail, MvValidationResult, MvWeatherStation } from '@thermio/shared-types';
import { useAuth } from '../../app/auth-context.js';
import { ApiError } from '../../app/api-client.js';
import { errorText } from '../asset/asset-shared.js';
import { formatAbsolute } from '../relative-time.js';
import {
  activateMvBaseline,
  deleteMvBaseline,
  fetchMvBaselineDetail,
  fetchMvWeatherStations,
  patchMvBaseline,
  retireMvBaseline,
  validateMvBaseline,
} from './mv-data.js';

const CAUSE_LABEL: Record<string, string> = {
  reset: '表计复位（累计量倒退）',
  hours: '小时覆盖不足（<24 桶）',
  bad_ratio: '坏样占比超限（>5%）',
};

export function MvBaselineDetailPage(): ReactNode {
  const { baselineId } = useParams<{ baselineId: string }>();
  const navigate = useNavigate();
  const { state } = useAuth();
  const [detail, setDetail] = useState<MvBaselineDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [activateOpen, setActivateOpen] = useState(false);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [supersede, setSupersede] = useState<string | null>(null);
  const [stations, setStations] = useState<readonly MvWeatherStation[]>([]);
  const [form] = Form.useForm<EditableValues>();

  const capabilities =
    state.phase === 'authenticated' || state.phase === 'must-change-password'
      ? state.me.capabilities
      : [];
  const canWrite = capabilities.includes('mv_baselines.write');
  const buildings =
    state.phase === 'authenticated' || state.phase === 'must-change-password'
      ? state.me.building_scopes
      : [];

  const load = useCallback(async (): Promise<void> => {
    if (baselineId === undefined) return;
    try {
      const loaded = await fetchMvBaselineDetail(baselineId);
      setDetail(loaded);
      form.setFieldsValue({
        t_cool_c: loaded.model_params?.spec.t_cool_c ?? 26,
        t_heat_c: loaded.model_params?.spec.t_heat_c ?? 18,
        weekend_dummy: loaded.model_params?.spec.weekend_dummy ?? true,
        weather_source: loaded.weather_source,
      });
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) setMissing(true);
      else setError(errorText(cause, '基线详情加载失败'));
    }
  }, [baselineId, form]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void fetchMvWeatherStations()
      .then((response) => {
        setStations(response.items);
      })
      .catch(() => {
        setStations([]);
      });
  }, []);

  if (missing) {
    return <Alert type="error" showIcon message="基线不存在或无权访问（mv.baseline_not_found）" />;
  }
  if (detail === null) {
    if (error !== null) return <Alert type="error" showIcon message={error} />;
    return (
      <div style={{ textAlign: 'center', padding: 48 }}>
        <Spin />
      </div>
    );
  }

  const editable = detail.status === 'draft' && canWrite;
  const period = detail.baseline_period;

  const act = async (action: () => Promise<unknown>, successText: string): Promise<void> => {
    setActing(true);
    try {
      await action();
      void message.success(successText);
      await load();
    } catch (cause) {
      if (cause instanceof ApiError && cause.parsed.reason_code === 'mv.baseline_overlap') {
        const conflictList =
          (cause.parsed.details as { conflicts?: string[] } | null)?.conflicts ?? [];
        setConflicts(conflictList);
        setSupersede(null);
        setActivateOpen(true);
        return;
      }
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
            <Button size="small" onClick={() => void navigate('/mv')}>
              返回
            </Button>
            基线 {period.start} ~ {period.end}（闭开）
            <Tag
              color={
                detail.status === 'active'
                  ? 'green'
                  : detail.status === 'retired'
                    ? 'orange'
                    : 'default'
              }
              style={{ marginInlineEnd: 0 }}
            >
              {detail.status === 'active'
                ? '现行'
                : detail.status === 'retired'
                  ? '已停用'
                  : '草稿'}
            </Tag>
          </Space>
        }
        extra={
          canWrite && (
            <Space>
              {detail.status === 'draft' && (
                <>
                  <Button
                    loading={acting}
                    onClick={() => void act(() => validateMvBaseline(detail.id), '校核完成')}
                  >
                    重跑校核
                  </Button>
                  <Button
                    type="primary"
                    loading={acting}
                    onClick={() => {
                      setConflicts([]);
                      setSupersede(null);
                      setActivateOpen(true);
                    }}
                  >
                    激活
                  </Button>
                  <Button
                    danger
                    loading={acting}
                    onClick={() =>
                      void act(async () => {
                        await deleteMvBaseline(detail.id);
                        void navigate('/mv');
                      }, '草稿已删除')
                    }
                  >
                    删除草稿
                  </Button>
                </>
              )}
              {detail.status === 'active' && (
                <Button
                  loading={acting}
                  onClick={() => void act(() => retireMvBaseline(detail.id), '基线已停用')}
                >
                  停用
                </Button>
              )}
            </Space>
          )
        }
      >
        <Descriptions size="small" column={2}>
          <Descriptions.Item label="楼宇">
            {buildings.find((b) => b.id === detail.building_id)?.name ?? detail.building_id}
          </Descriptions.Item>
          <Descriptions.Item label="方法">IPMVP 选项 C（整楼度量 + 天气归一化）</Descriptions.Item>
          <Descriptions.Item label="天气站点">{detail.weather_source}</Descriptions.Item>
          <Descriptions.Item label="报告计数">{String(detail.report_count)}</Descriptions.Item>
          <Descriptions.Item label="激活">
            {detail.activated_at === null ? '—' : formatAbsolute(detail.activated_at)}
          </Descriptions.Item>
          <Descriptions.Item label="停用">
            {detail.retired_at === null ? '—' : formatAbsolute(detail.retired_at)}
          </Descriptions.Item>
        </Descriptions>
        {detail.status !== 'draft' && (
          <Alert
            type="info"
            showIcon
            message="口径已冻结：基线期/模型参数/计量边界/天气站点自激活起只读（核证口径可审计复现）"
            style={{ marginTop: 8 }}
          />
        )}
      </Card>

      <Card title="模型参数与计量边界">
        <Form
          form={form}
          layout="vertical"
          disabled={!editable}
          onFinish={(values) =>
            void act(
              () =>
                patchMvBaseline(detail.id, {
                  model_spec: {
                    t_cool_c: values.t_cool_c ?? 26,
                    t_heat_c: values.t_heat_c ?? 18,
                    weekend_dummy: values.weekend_dummy ?? true,
                  },
                  weather_source: values.weather_source ?? detail.weather_source,
                }),
              '口径已更新（校核结果已失效，请重跑校核）',
            )
          }
        >
          <Space size={16} wrap>
            <Form.Item name="t_cool_c" label="制冷平衡点（℃）">
              <InputNumber min={-40} max={60} />
            </Form.Item>
            <Form.Item name="t_heat_c" label="制热平衡点（℃）">
              <InputNumber min={-40} max={60} />
            </Form.Item>
            <Form.Item name="weekend_dummy" label="周末哑变量" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="weather_source" label="天气站点">
              <Select
                style={{ width: 260 }}
                options={stations.map((station) => ({
                  value: station.station_id,
                  label: `${station.station_id}（${String(Math.round(station.coverage_90d * 100))}%）`,
                }))}
              />
            </Form.Item>
            {editable && (
              <Button htmlType="submit" loading={acting}>
                保存口径
              </Button>
            )}
          </Space>
        </Form>
        <Typography.Title level={5} style={{ marginTop: 8 }}>
          计量边界（激活后冻结）
        </Typography.Title>
        <Table
          size="small"
          rowKey="point_id"
          dataSource={detail.metering_points.map((p) => ({ ...p, key: p.point_id }))}
          pagination={false}
          columns={[
            { title: 'point_id', dataIndex: 'point_id', width: 110 },
            { title: '名称', dataIndex: 'name' },
            {
              title: '单位',
              dataIndex: 'unit',
              width: 90,
              render: (value: string | null): ReactNode => value ?? 'kWh',
            },
          ]}
        />
      </Card>

      <ValidationCard validation={detail.validation_result} />

      {activateOpen && (
        <Modal
          title="激活基线（影响结算口径）"
          open
          okText="确认激活"
          okButtonProps={{ loading: acting }}
          onCancel={() => {
            setActivateOpen(false);
          }}
          onOk={() =>
            void act(
              () =>
                activateMvBaseline(detail.id, {
                  ...(supersede !== null ? { supersede } : {}),
                }),
              '基线已激活',
            ).then(() => {
              setActivateOpen(false);
            })
          }
        >
          <Typography.Paragraph>
            激活后基线期、模型参数、计量边界与天气站点全部冻结，成为 M&V 核证报告的计算口径。
            激活门槛：完整日 ≥90 且覆盖率 ≥90%；CVRMSE ≤30%、|NMBE| ≤10%。
          </Typography.Paragraph>
          {conflicts.length > 0 && (
            <Alert
              type="warning"
              showIcon
              message="与现行基线基线期重叠，需先停用或调整基线期"
              description={
                <Space direction="vertical">
                  {conflicts.map((conflictId) => (
                    <Checkbox
                      key={conflictId}
                      checked={supersede === conflictId}
                      onChange={(event) => {
                        setSupersede(event.target.checked ? conflictId : null);
                      }}
                    >
                      替代现行基线 {conflictId.slice(0, 8)}（单事务原子换代：旧基线 → retired）
                    </Checkbox>
                  ))}
                </Space>
              }
              style={{ marginTop: 8 }}
            />
          )}
        </Modal>
      )}
    </Space>
  );
}

interface EditableValues {
  t_cool_c: number | undefined;
  t_heat_c: number | undefined;
  weekend_dummy: boolean | undefined;
  weather_source: string | undefined;
}

/** §3.5 校核结果卡：窗口缺口清单 + 拟合指标与合格线对照。 */
function ValidationCard({ validation }: { validation: MvValidationResult | null }): ReactNode {
  if (validation === null) {
    return (
      <Card title="校核结果">
        <Typography.Text type="secondary">从未校核（PATCH 后请重跑校核）</Typography.Text>
      </Card>
    );
  }
  const { window: win, fit, weather } = validation;
  const coveragePct = Math.round(win.coverage * 1000) / 10;
  const windowOk =
    win.period_days >= win.required.min_days && win.coverage >= win.required.min_coverage;
  const fitOk = fit?.qualified ?? false;
  return (
    <Card
      title={`校核结果（${formatAbsolute(validation.validated_at)}）`}
      extra={
        <Space>
          <Tag color={windowOk ? 'green' : 'red'} style={{ marginInlineEnd: 0 }}>
            数据窗 {windowOk ? '达标' : '不足'}
          </Tag>
          <Tag color={fitOk ? 'green' : 'red'} style={{ marginInlineEnd: 0 }}>
            拟合 {fitOk ? '合格' : '未达标'}
          </Tag>
          <Tag style={{ marginInlineEnd: 0 }}>
            天气覆盖 {String(Math.round(weather.coverage * 100))}%
          </Tag>
        </Space>
      }
    >
      <Descriptions size="small" column={3}>
        <Descriptions.Item label="基线期天数">{String(win.period_days)}</Descriptions.Item>
        <Descriptions.Item label="完整日">{String(win.complete_days)}</Descriptions.Item>
        <Descriptions.Item label="覆盖率">
          {String(coveragePct)}%（门槛 {String(Math.round(win.required.min_coverage * 100))}%）
        </Descriptions.Item>
        {fit !== null && fit.metrics !== null && (
          <>
            <Descriptions.Item label="n_obs">{String(fit.n_obs)}</Descriptions.Item>
            <Descriptions.Item label="R²">{fit.metrics.r2.toFixed(3)}</Descriptions.Item>
            <Descriptions.Item label="CVRMSE">
              {fit.metrics.cvrmse_pct.toFixed(1)}%（≤{String(fit.thresholds.cvrmse_max_pct)}%）
            </Descriptions.Item>
            <Descriptions.Item label="NMBE">
              {fit.metrics.nmbe_pct.toFixed(2)}%（|·| ≤{String(fit.thresholds.nmbe_max_pct)}%）
            </Descriptions.Item>
            <Descriptions.Item label="β0 / β1">
              {fit.coefficients === null
                ? '—'
                : `${fit.coefficients.b0.toFixed(0)} / ${fit.coefficients.b1.toFixed(1)}`}
            </Descriptions.Item>
            <Descriptions.Item label="β2 / β3">
              {fit.coefficients === null
                ? '—'
                : `${fit.coefficients.b2.toFixed(1)} / ${fit.coefficients.b3?.toFixed(1) ?? '—'}`}
            </Descriptions.Item>
          </>
        )}
      </Descriptions>
      <Typography.Title level={5} style={{ marginTop: 8 }}>
        数据缺口（{String(win.gaps.length)} 段）
      </Typography.Title>
      {win.gaps.length === 0 ? (
        <Typography.Text type="secondary">无缺口</Typography.Text>
      ) : (
        <Table
          size="small"
          rowKey="from"
          dataSource={win.gaps.map((gap) => ({ ...gap, key: `${gap.from}-${gap.cause}` }))}
          pagination={false}
          columns={[
            {
              title: '日期段（含端）',
              render: (_v: unknown, row: { from: string; to: string }): string =>
                `${row.from} ~ ${row.to}`,
            },
            { title: '天数', dataIndex: 'days', width: 70 },
            {
              title: '点位',
              dataIndex: 'points_affected',
              render: (value: string[]) => value.join('、'),
            },
            {
              title: '原因',
              dataIndex: 'cause',
              width: 220,
              render: (value: string): ReactNode => CAUSE_LABEL[value] ?? value,
            },
          ]}
        />
      )}
      <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
        <Link to="/mv">返回 M&V 总览</Link> ·
        插补只发生在报告期（缺口日按基线模型预测或样本日均插补并显式计数）
      </Typography.Text>
    </Card>
  );
}
