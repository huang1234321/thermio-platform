/**
 * 告警详情页 /alarms/:id（M4-alarm.md §7 行 2）：
 * 来源上下文卡 → 规则参数卡 → 根因组卡（members 列表）→ 时间线 → 抑制历史。
 */
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Row,
  Space,
  Spin,
  Table,
  Timeline,
  Typography,
  message,
} from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlarmDetailSchema, type AlarmDetail } from '@thermio/shared-types';
import { apiFetch } from '../../app/api-client.js';
import { errorText } from '../asset/asset-shared.js';
import { SeverityTag, StatusTag, formatTime, useHasCapability } from './alarm-shared.js';
import { CloseAlarmModal, SuppressModal, ackAlarm, unsuppressAlarm } from './alarm-actions.js';

const TIMELINE_LABEL: Record<string, string> = {
  opened: '开启',
  acked: '确认',
  suppressed: '抑制',
  closed: '关闭',
};

export function AlarmDetailPage(): React.ReactNode {
  const { alarmId } = useParams();
  const navigate = useNavigate();
  const canAck = useHasCapability('alarms.ack');
  const canSuppress = useHasCapability('alarms.suppress');
  const [detail, setDetail] = useState<AlarmDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [closeOpen, setCloseOpen] = useState(false);
  const [suppressOpen, setSuppressOpen] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    if (alarmId === undefined) return;
    setLoading(true);
    setError(null);
    try {
      setDetail(await apiFetch(`/alarms/${alarmId}`, AlarmDetailSchema));
    } catch (cause) {
      setError(errorText(cause, '告警详情加载失败'));
    } finally {
      setLoading(false);
    }
  }, [alarmId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && detail === null) return <Spin />;
  if (error !== null && detail === null) return <Alert type="error" showIcon message={error} />;
  if (detail === null) return null;
  const { alarm, rule, source, group } = detail;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title={`告警 #${String(alarm.id)}`}
        extra={
          <Space>
            <Button onClick={() => void navigate('/alarms')}>返回列表</Button>
            {canAck && alarm.status === 'open' && (
              <Button
                onClick={() =>
                  void ackAlarm(alarm.id)
                    .then(load)
                    .catch((cause: unknown) => message.error(errorText(cause, '确认失败')))
                }
              >
                确认
              </Button>
            )}
            {canAck && (alarm.status === 'open' || alarm.status === 'acked') && (
              <Button
                danger
                onClick={() => {
                  setCloseOpen(true);
                }}
              >
                关闭
              </Button>
            )}
            {canSuppress && alarm.status !== 'closed' && (
              <Button
                onClick={() => {
                  setSuppressOpen(true);
                }}
              >
                抑制
              </Button>
            )}
            {canSuppress && alarm.status === 'suppressed' && (
              <Button
                onClick={() =>
                  void unsuppressAlarm(alarm.id, alarm.is_root)
                    .then(load)
                    .catch((cause: unknown) => message.error(errorText(cause, '恢复失败')))
                }
              >
                提前恢复
              </Button>
            )}
          </Space>
        }
      >
        <Descriptions column={3} size="small">
          <Descriptions.Item label="严重度">
            <SeverityTag severity={alarm.severity} />
          </Descriptions.Item>
          <Descriptions.Item label="状态">
            <StatusTag status={alarm.status} />
          </Descriptions.Item>
          <Descriptions.Item label="类别">{alarm.category}</Descriptions.Item>
          <Descriptions.Item label="内容" span={3}>
            {alarm.message}
          </Descriptions.Item>
          <Descriptions.Item label="开启">{formatTime(alarm.opened_at)}</Descriptions.Item>
          {alarm.acked_at !== null && (
            <Descriptions.Item label="确认">{formatTime(alarm.acked_at)}</Descriptions.Item>
          )}
          {alarm.closed_at !== null && (
            <Descriptions.Item label="关闭">
              {formatTime(alarm.closed_at)}
              {alarm.closed_by === null ? '（系统）' : ''}
              {alarm.close_reason !== null ? ` · ${alarm.close_reason}` : ''}
            </Descriptions.Item>
          )}
        </Descriptions>
      </Card>

      <Row gutter={16}>
        <Col span={12}>
          <Card title="来源上下文" size="small">
            <Descriptions column={1} size="small">
              <Descriptions.Item label="来源类型">{source.type}</Descriptions.Item>
              <Descriptions.Item label="来源">
                {source.name}（{source.id}）
              </Descriptions.Item>
              <Descriptions.Item label="楼宇">{source.building.name}</Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
        <Col span={12}>
          <Card title="触发规则（当前态）" size="small">
            {rule === null ? (
              <Typography.Text type="secondary">直写告警（无规则关联）</Typography.Text>
            ) : (
              <Descriptions column={1} size="small">
                <Descriptions.Item label="rule_type">{rule.rule_type}</Descriptions.Item>
                <Descriptions.Item label="作用域">
                  {rule.scope} · {rule.scope_id}
                </Descriptions.Item>
                <Descriptions.Item label="severity">{rule.severity}</Descriptions.Item>
                <Descriptions.Item label="sustained_s">
                  {String(rule.sustained_s)}s
                </Descriptions.Item>
                <Descriptions.Item label="params">{JSON.stringify(rule.params)}</Descriptions.Item>
                <Descriptions.Item label="启用">{rule.enabled ? '是' : '否'}</Descriptions.Item>
              </Descriptions>
            )}
          </Card>
        </Col>
      </Row>

      {group !== null && (
        <Card title={`根因组 ${group.is_root ? '（本条为根告警）' : ''}`} size="small">
          {group.root !== null && (
            <Alert
              style={{ marginBottom: 8 }}
              type="info"
              showIcon
              message={
                <span>
                  根告警 #{String(group.root.id)}：<SeverityTag severity={group.root.severity} />{' '}
                  <Link to={`/alarms/${String(group.root.id)}`}>{group.root.message}</Link>
                </span>
              }
            />
          )}
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={group.members.map((member) => ({ ...member }))}
            columns={[
              { title: '#', dataIndex: 'id', width: 80 },
              {
                title: '严重度',
                dataIndex: 'severity',
                width: 96,
                render: (value: AlarmDetail['alarm']['severity']) => (
                  <SeverityTag severity={value} />
                ),
              },
              {
                title: '状态',
                dataIndex: 'status',
                width: 96,
                render: (value: AlarmDetail['alarm']['status']) => <StatusTag status={value} />,
              },
              {
                title: '内容',
                dataIndex: 'message',
                render: (value: string, row: { id: number }) => (
                  <Link to={`/alarms/${String(row.id)}`}>{value}</Link>
                ),
              },
              {
                title: '开启时间',
                dataIndex: 'opened_at',
                width: 170,
                render: (value: string) => formatTime(value),
              },
            ]}
          />
        </Card>
      )}

      <Row gutter={16}>
        <Col span={14}>
          <Card title="时间线" size="small">
            <Timeline
              items={detail.timeline.map((entry, index) => ({
                key: `${entry.type}-${String(index)}`,
                children: (
                  <span>
                    <b>{TIMELINE_LABEL[entry.type] ?? entry.type}</b> · {formatTime(entry.at)}
                    {entry.type === 'suppressed' &&
                      ` · 至 ${formatTime(entry.until_at)}（${entry.reason}）`}
                    {entry.type === 'closed' &&
                      ` · ${entry.reason}${entry.by === null ? '（系统）' : ''}`}
                    {entry.type === 'acked' && ` · ${entry.by}`}
                  </span>
                ),
              }))}
            />
          </Card>
        </Col>
        <Col span={10}>
          <Card title="抑制历史" size="small">
            {detail.suppressions.length === 0 ? (
              <Typography.Text type="secondary">无抑制记录</Typography.Text>
            ) : (
              <Table
                size="small"
                rowKey="id"
                pagination={false}
                dataSource={detail.suppressions.map((item) => ({ ...item }))}
                columns={[
                  { title: '原因', dataIndex: 'reason' },
                  {
                    title: '生效区间',
                    render: (_: unknown, row: AlarmDetail['suppressions'][number]) =>
                      `${formatTime(row.started_at)} → ${row.ended_at === null ? '生效中' : formatTime(row.ended_at)}`,
                  },
                  {
                    title: '结束原因',
                    dataIndex: 'ended_reason',
                    render: (value: string | null) => value ?? '—',
                  },
                ]}
              />
            )}
          </Card>
        </Col>
      </Row>

      <CloseAlarmModal
        alarm={closeOpen ? alarm : null}
        onClose={() => {
          setCloseOpen(false);
        }}
        onDone={() => {
          setCloseOpen(false);
          void load();
        }}
      />
      <SuppressModal
        alarm={suppressOpen ? alarm : null}
        onClose={() => {
          setSuppressOpen(false);
        }}
        onDone={() => {
          setSuppressOpen(false);
          void load();
        }}
      />
    </Space>
  );
}
