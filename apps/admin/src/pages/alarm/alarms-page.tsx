/**
 * 告警列表页 /alarms（M4-alarm.md §7 行 1 / ui/baseline §3.4 根因折叠特例）。
 *
 * - 折叠视图：根行「+N 子告警」角标，展开走 root_group_id 参数（§3.1）；
 * - 批量 ack 仅作用勾选可见行（含展开子行），207 逐项结果汇总 toast + 失败行内联标红；
 * - 游标分页「加载更多 + 已加载计数」（§3.1，照齐可控点清单示范）；
 * - 列表时间相对显示（§2.2，hover 完整时间戳）；能力显隐 ack/close=alarms.ack，
 *   suppress=alarms.suppress。
 */
import { Alert, Button, Card, Popconfirm, Select, Space, Table, Typography, message } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ALARM_CATEGORIES,
  ALARM_EVENT_STATUSES,
  ALARM_SEVERITIES,
  AlarmBatchAckResponseSchema,
  AlarmListResponseSchema,
  type AlarmEventView,
} from '@thermio/shared-types';
import { apiFetch } from '../../app/api-client.js';
import { errorText } from '../asset/asset-shared.js';
import { RelativeTime } from '../relative-time.js';
import { SeverityTag, StatusTag, useHasCapability } from './alarm-shared.js';
import { CloseAlarmModal, SuppressModal, ackAlarm, unsuppressAlarm } from './alarm-actions.js';

const STATUS_OPTIONS = ALARM_EVENT_STATUSES.map((value) => ({ value, label: value }));
const SEVERITY_OPTIONS = ALARM_SEVERITIES.map((value) => ({ value, label: value }));
const CATEGORY_OPTIONS = ALARM_CATEGORIES.map((value) => ({ value, label: value }));

interface AlarmRow extends AlarmEventView {
  readonly key: string;
}

export function AlarmsPage(): React.ReactNode {
  const canAck = useHasCapability('alarms.ack');
  const canSuppress = useHasCapability('alarms.suppress');
  const [searchParams, setSearchParams] = useSearchParams();
  const [rows, setRows] = useState<readonly AlarmRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [failedIds, setFailedIds] = useState<readonly number[]>([]);
  const [closeTarget, setCloseTarget] = useState<AlarmEventView | null>(null);
  const [suppressTarget, setSuppressTarget] = useState<AlarmEventView | null>(null);
  const expandedGroup = searchParams.get('root_group_id');

  const load = useCallback(
    async (nextCursor?: string): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ limit: '50' });
        const status = searchParams.get('status');
        const severity = searchParams.get('severity');
        const category = searchParams.get('category');
        if (status !== null) params.set('status', status);
        if (severity !== null) params.set('severity', severity);
        if (category !== null) params.set('category', category);
        if (expandedGroup !== null) params.set('root_group_id', expandedGroup);
        if (nextCursor !== undefined && nextCursor.length > 0) params.set('cursor', nextCursor);
        const result = await apiFetch(`/alarms?${params.toString()}`, AlarmListResponseSchema);
        const page = result.items.map((item) => ({ ...item, key: String(item.id) }));
        setRows((prev) => (nextCursor === undefined ? page : [...prev, ...page]));
        setTotal((prev) => (nextCursor === undefined ? page.length : (prev ?? 0) + page.length));
        setCursor(result.next_cursor);
      } catch (cause) {
        setError(errorText(cause, '告警列表加载失败'));
      } finally {
        setLoading(false);
      }
    },
    [searchParams, expandedGroup],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const batchAck = useCallback(
    async (ids: readonly number[]): Promise<void> => {
      try {
        // 207 逐项结果（API-DSN-05）
        const result = await apiFetch('/alarms/batch-ack', AlarmBatchAckResponseSchema, {
          method: 'POST',
          body: { ids },
        });
        const failed = result.items.filter((item) => !item.ok);
        const ok = result.items.length - failed.length;
        setFailedIds(failed.map((item) => item.alarm_id));
        void message.open({
          type: failed.length > 0 ? 'warning' : 'success',
          content: `批量确认完成：成功 ${String(ok)}，失败 ${String(failed.length)}（行内标红）`,
        });
        await load();
      } catch (cause) {
        void message.error(errorText(cause, '批量确认失败'));
      }
    },
    [load],
  );

  const columns = useMemo(
    () => [
      {
        title: '严重度',
        dataIndex: 'severity',
        width: 96,
        render: (_: unknown, row: AlarmRow): React.ReactNode => (
          <SeverityTag severity={row.severity} />
        ),
      },
      {
        title: '状态',
        dataIndex: 'status',
        width: 96,
        render: (_: unknown, row: AlarmRow): React.ReactNode => <StatusTag status={row.status} />,
      },
      {
        title: '告警内容',
        dataIndex: 'message',
        render: (_: unknown, row: AlarmRow): React.ReactNode => (
          <Space direction="vertical" size={2}>
            <Link to={`/alarms/${String(row.id)}`}>{row.message}</Link>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {row.source_type} · {row.source_name ?? row.source_id}
              {row.is_root && row.child_count_active !== null && row.child_count_active > 0
                ? ` · +${String(row.child_count_active)} 子告警`
                : ''}
              {row.is_root && !expandedGroup && row.root_group_id !== null ? '（根因组代表）' : ''}
            </Typography.Text>
          </Space>
        ),
      },
      {
        title: '开启时间',
        dataIndex: 'opened_at',
        width: 170,
        render: (value: string): React.ReactNode => <RelativeTime iso={value} />,
      },
      {
        title: '操作',
        key: 'actions',
        width: 240,
        render: (_: unknown, row: AlarmRow): React.ReactNode => (
          <Space>
            {canAck && row.status === 'open' && (
              <Button
                size="small"
                onClick={() =>
                  void ackAlarm(row.id)
                    .then(() => load())
                    .catch((cause: unknown) => message.error(errorText(cause, '确认失败')))
                }
              >
                确认
              </Button>
            )}
            {canAck && (row.status === 'open' || row.status === 'acked') && (
              <Button
                size="small"
                danger
                onClick={() => {
                  setCloseTarget(row);
                }}
              >
                关闭
              </Button>
            )}
            {canSuppress &&
              (row.status === 'open' || row.status === 'acked' || row.status === 'suppressed') && (
                <Button
                  size="small"
                  onClick={() => {
                    setSuppressTarget(row);
                  }}
                >
                  抑制
                </Button>
              )}
            {canSuppress && row.status === 'suppressed' && (
              <Popconfirm
                title="提前恢复该抑制？"
                onConfirm={() =>
                  void unsuppressAlarm(row.id, row.is_root)
                    .then(() => load())
                    .catch((cause: unknown) => message.error(errorText(cause, '恢复失败')))
                }
              >
                <Button size="small">恢复</Button>
              </Popconfirm>
            )}
          </Space>
        ),
      },
    ],
    [canAck, canSuppress, expandedGroup, load],
  );

  return (
    <Card
      title={expandedGroup !== null ? '告警中心 · 根因组展开' : '告警中心'}
      extra={
        <Space>
          <Link to="/alarm-rules">规则管理</Link>
          <Link to="/alarms/suppressions">抑制记录</Link>
          {expandedGroup !== null && (
            <Button
              onClick={() => {
                setSearchParams({});
              }}
            >
              返回折叠视图
            </Button>
          )}
          {canAck && (
            <Button
              disabled={selected.length === 0}
              onClick={() => void batchAck(selected.map((key) => Number(key)))}
            >
              批量确认（{String(selected.length)}）
            </Button>
          )}
        </Space>
      }
    >
      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          allowClear
          placeholder="状态"
          style={{ width: 120 }}
          options={STATUS_OPTIONS}
          value={searchParams.get('status') ?? undefined}
          onChange={(value) => {
            setSearchParams((prev) => setParam(prev, 'status', value));
          }}
        />
        <Select
          allowClear
          placeholder="严重度"
          style={{ width: 120 }}
          options={SEVERITY_OPTIONS}
          value={searchParams.get('severity') ?? undefined}
          onChange={(value) => {
            setSearchParams((prev) => setParam(prev, 'severity', value));
          }}
        />
        <Select
          allowClear
          placeholder="类别"
          style={{ width: 160 }}
          options={CATEGORY_OPTIONS}
          value={searchParams.get('category') ?? undefined}
          onChange={(value) => {
            setSearchParams((prev) => setParam(prev, 'category', value));
          }}
        />
        {total !== null && (
          <Typography.Text type="secondary">已加载 {String(rows.length)} 条</Typography.Text>
        )}
      </Space>
      {error !== null && (
        <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />
      )}
      <Table<AlarmRow>
        size="small"
        loading={loading}
        columns={columns}
        dataSource={[...rows]}
        pagination={false}
        {...(canAck
          ? {
              rowSelection: {
                selectedRowKeys: [...selected],
                onChange: (keys) => {
                  setSelected(keys.map(String));
                },
                getCheckboxProps: (row: AlarmRow) => ({ disabled: row.status !== 'open' }),
              },
            }
          : {})}
        rowClassName={(row) =>
          failedIds.includes(row.id)
            ? 'alarm-row-failed'
            : row.is_root && row.root_group_id !== null && !expandedGroup
              ? 'alarm-row-root'
              : ''
        }
        onRow={(row) => ({
          onDoubleClick: () => {
            const groupId = row.root_group_id;
            if (groupId !== null) {
              setSearchParams((prev) => setParam(prev, 'root_group_id', groupId));
            }
          },
        })}
      />
      {cursor !== null && (
        <Button
          block
          style={{ marginTop: 12 }}
          onClick={() => {
            void load(cursor);
          }}
          loading={loading}
        >
          加载更多
        </Button>
      )}
      <CloseAlarmModal
        alarm={closeTarget}
        onClose={() => {
          setCloseTarget(null);
        }}
        onDone={() => {
          setCloseTarget(null);
          void load();
        }}
      />
      <SuppressModal
        alarm={suppressTarget}
        onClose={() => {
          setSuppressTarget(null);
        }}
        onDone={() => {
          setSuppressTarget(null);
          void load();
        }}
      />
    </Card>
  );
}

function setParam(prev: URLSearchParams, key: string, value: string | undefined): URLSearchParams {
  const next = new URLSearchParams(prev);
  if (value === undefined || value.length === 0) {
    next.delete(key);
  } else {
    next.set(key, value);
  }
  return next;
}
