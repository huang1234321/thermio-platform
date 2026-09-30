/**
 * /fdd/findings 发现列表（modules/M6-fdd.md §7.2 列表页型，IMPL-16 切片 / DAT-212）。
 *
 * - Tabs 状态机分组（未决/已消除/已忽略/全部，§2.1）+ 筛选区（白名单对齐 §5.2）；
 * - 列：严重度徽标 · 标题（行点击进详情）· 设备 · 规则（等宽）· 抽检徽标 · 首次/最后发现
 *   （相对时间 hover 绝对）；
 * - 行内动作 fdd.write 才渲染：抽检（结论单选 + 备注 ≤500）/ 忽略（reason 必填）——
 *   均 stopPropagation 不触发跳转；
 * - 游标分页「加载更多」，无跳页。
 */
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Table,
  Tabs,
  Typography,
  message,
} from 'antd';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ALARM_SEVERITIES,
  FDD_FINDING_STATUSES,
  type FddFindingListItem,
} from '@thermio/shared-types';
import { apiFetch } from '../../app/api-client.js';
import { errorText } from '../asset/asset-shared.js';
import { RelativeTime } from '../relative-time.js';
import { SeverityTag } from '../alarm/alarm-shared.js';
import { useAuth } from '../../app/auth-context.js';
import { fetchFddFindings, ignoreFinding, reviewFinding, type FindingsFilter } from './fdd-data.js';
import { FDD_STATUS_LABEL, ReviewBadge, useHasFddCapability } from './fdd-shared.js';

const SEVERITY_OPTIONS = ALARM_SEVERITIES.map((value) => ({ value, label: value }));
const REVIEW_OPTIONS = [
  { value: 'unreviewed', label: '未抽检' },
  { value: 'confirmed', label: '✓ 真实故障' },
  { value: 'false_positive', label: '✗ 误报' },
];

/** 时间范围快捷项（§7.2：今天/本周/近 30 天——to=now 开区间）。 */
const QUICK_RANGES = [
  { key: 'today', label: '今天', days: 0 },
  { key: 'week', label: '本周', days: 7 },
  { key: 'month', label: '近 30 天', days: 30 },
] as const;

interface EquipmentOption {
  readonly value: string;
  readonly label: string;
}

interface Row extends FddFindingListItem {
  readonly key: string;
}

/** 设备搜索最小形状（safeParse 宽松面——仅取 items[].equipment 三字段）。 */
const EQUIPMENT_SEARCH_SCHEMA = {
  safeParse: (
    input: unknown,
  ): {
    success: true;
    data: { items: Array<{ equipment: { id: string; name: string; local_id: string | null } }> };
  } => {
    const items =
      (
        input as {
          items?: Array<{ equipment?: { id: string; name: string; local_id: string | null } }>;
        }
      ).items ?? [];
    return {
      success: true,
      data: {
        items: items.filter(
          (item): item is { equipment: { id: string; name: string; local_id: string | null } } =>
            item.equipment !== undefined,
        ),
      },
    };
  },
};

export function FddFindingsPage(): ReactNode {
  const navigate = useNavigate();
  const canWrite = useHasFddCapability('fdd.write');
  const { state } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [rows, setRows] = useState<readonly Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewTarget, setReviewTarget] = useState<FddFindingListItem | null>(null);
  const [ignoreTarget, setIgnoreTarget] = useState<FddFindingListItem | null>(null);
  const [equipmentOptions, setEquipmentOptions] = useState<readonly EquipmentOption[]>([]);

  const statusTab = searchParams.get('status') ?? 'open';
  const buildingId = searchParams.get('building_id') ?? undefined;
  const reviewFilter = searchParams.get('review') ?? undefined;
  const hasTimeFilter = searchParams.get('from') !== null || searchParams.get('to') !== null;

  const buildings =
    state.phase === 'authenticated' || state.phase === 'must-change-password'
      ? state.me.building_scopes
      : [];

  const filterOf = useCallback(
    (nextCursor?: string): FindingsFilter => {
      const param = (key: string): { readonly [k: string]: string } => {
        const value = searchParams.get(key);
        return value === null || value.length === 0 ? {} : { [key]: value };
      };
      return {
        limit: 50,
        ...(statusTab !== 'all' ? { status: statusTab } : {}),
        ...(buildingId !== undefined ? { building_id: buildingId } : {}),
        ...param('equipment_id'),
        ...param('severity'),
        ...param('rule_key'),
        ...(reviewFilter !== undefined ? { review: reviewFilter } : {}),
        ...param('from'),
        ...param('to'),
        ...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
      };
    },
    [searchParams, statusTab, buildingId, reviewFilter],
  );

  const load = useCallback(
    async (nextCursor?: string): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const result = await fetchFddFindings(filterOf(nextCursor));
        const page = result.items.map((item) => ({ ...item, key: item.id }));
        setRows((prev) => (nextCursor === undefined ? page : [...prev, ...page]));
        setCursor(result.next_cursor);
      } catch (cause) {
        setError(errorText(cause, '发现列表加载失败'));
      } finally {
        setLoading(false);
      }
    },
    [filterOf],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // 设备搜索选择（§7.2；数据源 = M3 设备工况检索，需先选楼宇——端点 building_id 必填）
  const searchEquipment = useCallback(
    async (keyword: string): Promise<void> => {
      if (keyword.trim().length === 0) return;
      try {
        const page = await apiFetch(
          `/monitor/equipments?building_id=${String(buildingId)}&keyword=${encodeURIComponent(keyword.trim())}&limit=20`,
          EQUIPMENT_SEARCH_SCHEMA,
        );
        setEquipmentOptions(
          page.items.map((item) => ({
            value: item.equipment.id,
            label:
              item.equipment.local_id !== null
                ? `${item.equipment.name}（${item.equipment.local_id}）`
                : item.equipment.name,
          })),
        );
      } catch {
        setEquipmentOptions([]);
      }
    },
    [buildingId],
  );

  const setParam = (key: string, value: string | undefined): void => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === undefined || value.length === 0) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: false },
    );
  };

  const applyQuickRange = (days: 0 | 7 | 30): void => {
    const now = new Date();
    const from = new Date(now);
    if (days === 0) from.setHours(0, 0, 0, 0);
    else from.setDate(from.getDate() - days);
    setParam('from', from.toISOString());
    setParam('to', now.toISOString());
  };

  const columns = useMemo(
    () => [
      {
        title: '严重度',
        dataIndex: 'severity',
        width: 96,
        render: (_: unknown, row: Row): ReactNode => <SeverityTag severity={row.severity} />,
      },
      {
        title: '发现',
        dataIndex: 'title',
        render: (_: unknown, row: Row): ReactNode => (
          <Space direction="vertical" size={2}>
            <Link to={`/fdd/findings/${row.id}`}>{row.title}</Link>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {row.equipment.name}
              {row.equipment.local_id !== null ? `（${row.equipment.local_id}）` : ''} ·{' '}
              {row.equipment.equipment_type}
            </Typography.Text>
          </Space>
        ),
      },
      {
        title: '规则',
        dataIndex: 'rule_key',
        width: 220,
        render: (value: string): ReactNode => (
          <Typography.Text code style={{ fontSize: 12 }}>
            {value}
          </Typography.Text>
        ),
      },
      {
        title: '状态',
        dataIndex: 'status',
        width: 88,
        render: (_: unknown, row: Row): ReactNode => (
          <Typography.Text type={row.status === 'open' ? 'danger' : 'secondary'}>
            {FDD_STATUS_LABEL[row.status]}
          </Typography.Text>
        ),
      },
      {
        title: '抽检',
        dataIndex: 'review',
        width: 110,
        render: (_: unknown, row: Row): ReactNode => <ReviewBadge review={row.review} />,
      },
      {
        title: '首次发现',
        dataIndex: 'first_detected_at',
        width: 120,
        render: (value: string): ReactNode => <RelativeTime iso={value} />,
      },
      {
        title: '最后发现',
        dataIndex: 'last_detected_at',
        width: 120,
        render: (value: string): ReactNode => <RelativeTime iso={value} />,
      },
      {
        title: '操作',
        key: 'actions',
        width: 150,
        render: (_: unknown, row: Row): ReactNode =>
          canWrite ? (
            <Space>
              <Button
                size="small"
                onClick={(event) => {
                  event.stopPropagation();
                  setReviewTarget(row);
                }}
              >
                抽检
              </Button>
              {row.status === 'open' && (
                <Button
                  size="small"
                  danger
                  onClick={(event) => {
                    event.stopPropagation();
                    setIgnoreTarget(row);
                  }}
                >
                  忽略
                </Button>
              )}
            </Space>
          ) : null,
      },
    ],
    [canWrite],
  );

  return (
    <Card
      title="FDD 发现"
      extra={
        <Space>
          <Link to="/fdd">概览</Link>
          <Link to="/fdd/reports">周期报告</Link>
        </Space>
      }
    >
      <Tabs
        activeKey={statusTab}
        onChange={(key) => {
          setParam('status', key === 'open' ? undefined : key);
        }}
        items={[
          ...FDD_FINDING_STATUSES.map((status) => ({
            key: status,
            label: FDD_STATUS_LABEL[status],
          })),
          { key: 'all', label: '全部' },
        ]}
      />
      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          allowClear
          placeholder="楼宇"
          style={{ width: 160 }}
          value={buildingId}
          options={buildings.map((b) => ({ value: b.id, label: b.name }))}
          onChange={(value) => {
            setParam('building_id', value);
            setParam('equipment_id', undefined);
            setEquipmentOptions([]);
          }}
        />
        <Select
          allowClear
          showSearch
          disabled={buildingId === undefined}
          placeholder={buildingId === undefined ? '设备（先选楼宇）' : '设备（输入搜索）'}
          style={{ width: 200 }}
          value={searchParams.get('equipment_id') ?? undefined}
          options={[...equipmentOptions]}
          filterOption={false}
          onSearch={(value) => void searchEquipment(value)}
          onChange={(value) => {
            setParam('equipment_id', value);
          }}
        />
        <Select
          allowClear
          placeholder="严重度"
          style={{ width: 110 }}
          value={searchParams.get('severity') ?? undefined}
          options={SEVERITY_OPTIONS}
          onChange={(value) => {
            setParam('severity', value);
          }}
        />
        <Select
          allowClear
          placeholder="抽检状态"
          style={{ width: 130 }}
          value={reviewFilter}
          options={REVIEW_OPTIONS}
          onChange={(value) => {
            setParam('review', value);
          }}
        />
        <Input.Search
          allowClear
          placeholder="规则 key"
          style={{ width: 200 }}
          defaultValue={searchParams.get('rule_key') ?? undefined}
          onSearch={(value) => {
            setParam('rule_key', value.trim().length === 0 ? undefined : value.trim());
          }}
        />
        <Select
          placeholder="时间范围"
          style={{ width: 110 }}
          value={null}
          options={QUICK_RANGES.map((range) => ({ value: range.key, label: range.label }))}
          onSelect={(key: unknown) => {
            const range = QUICK_RANGES.find((item) => item.key === key);
            if (range !== undefined) applyQuickRange(range.days);
          }}
        />
        {hasTimeFilter && (
          <Button
            size="small"
            onClick={() => {
              setParam('from', undefined);
              setParam('to', undefined);
            }}
          >
            清除时间
          </Button>
        )}
        <Typography.Text type="secondary">已加载 {String(rows.length)} 条</Typography.Text>
      </Space>
      {error !== null && (
        <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />
      )}
      <Table<Row>
        size="small"
        loading={loading}
        columns={columns}
        dataSource={[...rows]}
        pagination={false}
        onRow={(row) => ({
          onClick: () => {
            // 行点击整行跳详情（标题链接同效；动作按钮 stopPropagation）
            void navigate(`/fdd/findings/${row.id}`);
          },
        })}
      />
      {cursor !== null && (
        <Button block style={{ marginTop: 12 }} loading={loading} onClick={() => void load(cursor)}>
          加载更多
        </Button>
      )}
      <ReviewModal
        finding={reviewTarget}
        onClose={() => {
          setReviewTarget(null);
        }}
        onDone={() => {
          setReviewTarget(null);
          void load();
        }}
      />
      <IgnoreModal
        finding={ignoreTarget}
        onClose={() => {
          setIgnoreTarget(null);
        }}
        onDone={() => {
          setIgnoreTarget(null);
          void load();
        }}
      />
    </Card>
  );
}

/** 抽检弹窗（§7.2：结论单选 真实故障/误报 + 备注 ≤500；普通确认弹窗——非后果性写）。 */
export function ReviewModal({
  finding,
  onClose,
  onDone,
}: {
  finding: FddFindingListItem | null;
  onClose: () => void;
  onDone: () => void;
}): ReactNode {
  const [form] = Form.useForm<{ result: 'confirmed' | 'false_positive'; note?: string }>();
  const [submitting, setSubmitting] = useState(false);

  return (
    <Modal
      title={finding === null ? '抽检' : `抽检：${finding.title}`}
      open={finding !== null}
      confirmLoading={submitting}
      okText="记录结论"
      cancelText="取消"
      onCancel={onClose}
      destroyOnHidden
      onOk={() => {
        if (finding === null) return;
        void (async () => {
          const values = await form.validateFields();
          setSubmitting(true);
          try {
            await reviewFinding(finding.id, {
              result: values.result,
              ...(values.note !== undefined && values.note.length > 0 ? { note: values.note } : {}),
            });
            void message.success('抽检结论已记录');
            onDone();
          } catch (cause) {
            void message.error(errorText(cause, '抽检记录失败'));
          } finally {
            setSubmitting(false);
          }
        })();
      }}
    >
      <Form form={form} layout="vertical" initialValues={{ result: 'confirmed' }}>
        <Form.Item
          name="result"
          label="抽检结论（可覆写——最新结论生效）"
          rules={[{ required: true, message: '请选择结论' }]}
        >
          <Radio.Group
            options={[
              { value: 'confirmed', label: '✓ 真实故障（现场确认）' },
              { value: 'false_positive', label: '✗ 误报' },
            ]}
          />
        </Form.Item>
        <Form.Item name="note" label="备注（≤500，可空）">
          <Input.TextArea rows={2} maxLength={500} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** 忽略弹窗（§5.5：reason 必填 1..500，入结构化日志；忽略不抑制后续检测）。 */
export function IgnoreModal({
  finding,
  onClose,
  onDone,
}: {
  finding: FddFindingListItem | null;
  onClose: () => void;
  onDone: () => void;
}): ReactNode {
  const [form] = Form.useForm<{ reason: string }>();
  const [submitting, setSubmitting] = useState(false);

  return (
    <Modal
      title={finding === null ? '忽略' : `忽略：${finding.title}`}
      open={finding !== null}
      confirmLoading={submitting}
      okText="确认忽略"
      okButtonProps={{ danger: true }}
      cancelText="取消"
      onCancel={onClose}
      destroyOnHidden
      onOk={() => {
        if (finding === null) return;
        void (async () => {
          const values = await form.validateFields();
          setSubmitting(true);
          try {
            await ignoreFinding(finding.id, values.reason);
            void message.success('已忽略（后续同规则再命中将产生新发现）');
            onDone();
          } catch (cause) {
            void message.error(errorText(cause, '忽略失败'));
          } finally {
            setSubmitting(false);
          }
        })();
      }}
    >
      <Form form={form} layout="vertical">
        <Form.Item
          name="reason"
          label="忽略原因（必填，闭环留痕）"
          rules={[{ required: true, min: 1, max: 500, message: '请填写忽略原因（≤500 字）' }]}
        >
          <Input.TextArea rows={2} maxLength={500} />
        </Form.Item>
      </Form>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        忽略是「本轮发现的处置」，不是「规则的抑制」——真实持续故障再次命中会以新发现呈现。
      </Typography.Text>
    </Modal>
  );
}
