/**
 * 抑制记录页 /alarms/suppressions（M4-alarm.md §7 行 4）：生效中/已结束两态列表；
 * 行内「提前恢复」动作（unsuppress，admin）。数据 GET /alarms/suppressions。
 */
import { Alert, Button, Card, Popconfirm, Space, Table, Tabs, Typography, message } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlarmSuppressionListResponseSchema,
  type AlarmSuppressionListItem,
} from '@thermio/shared-types';
import { apiFetch } from '../../app/api-client.js';
import { errorText } from '../asset/asset-shared.js';
import { SeverityTag, StatusTag, formatTime, useHasCapability } from './alarm-shared.js';
import { unsuppressAlarm } from './alarm-actions.js';

const ENDED_REASON_LABEL: Record<string, string> = {
  expired: '到期',
  unsuppressed: '提前恢复',
  alarm_closed: '告警已关闭',
  superseded: '续期接替',
};

export function AlarmSuppressionsPage(): React.ReactNode {
  const canSuppress = useHasCapability('alarms.suppress');
  const [state, setState] = useState<'active' | 'ended'>('active');
  const [items, setItems] = useState<readonly AlarmSuppressionListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (target: 'active' | 'ended'): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiFetch(
        `/alarms/suppressions?state=${target}&limit=100`,
        AlarmSuppressionListResponseSchema,
      );
      setItems(result.items);
    } catch (cause) {
      setError(errorText(cause, '抑制记录加载失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(state);
  }, [load, state]);

  return (
    <Card title="抑制记录">
      {error !== null && (
        <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />
      )}
      <Tabs
        activeKey={state}
        onChange={(key) => {
          setState(key as 'active' | 'ended');
        }}
        items={[
          { key: 'active', label: '生效中' },
          { key: 'ended', label: '已结束' },
        ]}
      />
      <Table<AlarmSuppressionListItem>
        size="small"
        rowKey={(row) => row.suppression.id}
        loading={loading}
        dataSource={[...items]}
        pagination={{ pageSize: 50, showSizeChanger: false }}
        columns={[
          {
            title: '告警',
            render: (_: unknown, row: AlarmSuppressionListItem): React.ReactNode => (
              <Space direction="vertical" size={2}>
                <Link to={`/alarms/${String(row.alarm.id)}`}>{row.alarm.message}</Link>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  <SeverityTag severity={row.alarm.severity} />{' '}
                  <StatusTag status={row.alarm.status} /> {row.alarm.source_type} ·{' '}
                  {row.alarm.source_name ?? row.alarm.source_id}
                </Typography.Text>
              </Space>
            ),
          },
          { title: '原因', dataIndex: ['suppression', 'reason'], width: 180 },
          {
            title: state === 'active' ? '抑制至' : '生效区间',
            width: 220,
            render: (_: unknown, row: AlarmSuppressionListItem): React.ReactNode =>
              state === 'active'
                ? formatTime(row.suppression.until_at)
                : `${formatTime(row.suppression.started_at)} → ${row.suppression.ended_at === null ? '—' : formatTime(row.suppression.ended_at)}`,
          },
          {
            title: '结束原因',
            width: 110,
            render: (_: unknown, row: AlarmSuppressionListItem): React.ReactNode =>
              row.suppression.ended_reason === null
                ? '—'
                : (ENDED_REASON_LABEL[row.suppression.ended_reason] ??
                  row.suppression.ended_reason),
          },
          {
            title: '操作',
            key: 'actions',
            width: 120,
            render: (_: unknown, row: AlarmSuppressionListItem): React.ReactNode =>
              canSuppress &&
              state === 'active' && (
                <Popconfirm
                  title="提前恢复该抑制？"
                  onConfirm={() =>
                    void unsuppressAlarm(row.suppression.alarm_event_id, false)
                      .then(() => load(state))
                      .catch((cause: unknown) => message.error(errorText(cause, '恢复失败')))
                  }
                >
                  <Button size="small">提前恢复</Button>
                </Popconfirm>
              ),
          },
        ]}
      />
    </Card>
  );
}
