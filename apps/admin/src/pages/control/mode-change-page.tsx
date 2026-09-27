/**
 * 控制模式切换页 /control/points/:id/mode（M8-safety-ui.md §5，UC-M8-3）。
 *
 * - 状态机可视化（§5.1）：三档 Stepper，当前档高亮；跳档禁用（一次只能前进一档）
 *   / 熔断期间前进禁用（cause=fuse_open）/ supervised·auto 前提白名单；
 * - 二次确认（§5.4）：方向标注（前进一档 / 回退可跨档）+ diff + 专项提示 +
 *   reason 必填；取消零副作用；
 * - 服务端 409 双形态消费（§5.3）：mode_transition_invalid details.cause=skip|fuse_open
 *   分支呈现；mode_same → 刷新；
 * - 模式变更时间线（§5.5）：config-audit?point_id=&field=control_mode 嵌入。
 */
import { Alert, Button, Card, Input, Modal, Space, Steps, Typography, message } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ConfigAuditListResponseSchema,
  type ConfigAuditItem,
  type ControlMode,
  type ControlPointItem,
  ControlPointsListResponseSchema,
} from '@thermio/shared-types';
import { apiFetch } from '../../app/api-client.js';
import { errorText } from '../asset/asset-shared.js';
import { ApiError } from '../../app/api-client.js';
import { ControlModeTag, changeControlMode } from './control-shared.js';

const MODES: readonly ControlMode[] = ['advisory', 'supervised', 'auto'];
const MODE_LABEL: Record<ControlMode, string> = {
  advisory: '建议',
  supervised: '监督',
  auto: '自动',
};

export function ModeChangePage(): React.ReactNode {
  const { pointId } = useParams<{ pointId?: string }>();
  const navigate = useNavigate();
  const [point, setPoint] = useState<ControlPointItem | null>(null);
  const [history, setHistory] = useState<readonly ConfigAuditItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<ControlMode | null>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancelledRef = useRef<boolean>(false);
  const isCancelled = (): boolean => cancelledRef.current;
  useEffect(() => {
    if (pointId === undefined) return;
    void (async () => {
      setLoading(true);
      try {
        const response = await apiFetch(
          '/control/points?limit=200&is_controllable=all',
          ControlPointsListResponseSchema,
        );
        const hit = response.items.find((item) => String(item.point_id) === pointId);
        if (isCancelled()) return;
        if (hit === undefined) {
          setError('点位不存在或不可见');
          return;
        }
        setPoint(hit);
        const audit = await apiFetch(
          `/config-audit?point_id=${pointId}&field=control_mode&limit=20`,
          ConfigAuditListResponseSchema,
        );
        if (!isCancelled()) setHistory(audit.items);
      } catch (cause) {
        if (!isCancelled()) setError(errorText(cause, '点位加载失败'));
      } finally {
        if (!isCancelled()) setLoading(false);
      }
    })();
    return () => {
      cancelledRef.current = true;
    };
  }, [pointId]);

  const currentIdx = point === null ? 0 : MODES.indexOf(point.control_mode);
  const rank = (mode: ControlMode): number => MODES.indexOf(mode);

  /** 前进可用性（§5.2 矩阵：跳档/熔断/白名单前提禁用；auto 已顶格）。 */
  const forwardTarget: ControlMode | null =
    point === null || point.control_mode === 'auto' ? null : (MODES[currentIdx + 1] ?? null);

  const submit = async (): Promise<void> => {
    if (pointId === undefined || target === null) return;
    setSubmitting(true);
    try {
      await changeControlMode(Number(pointId), target, reason);
      message.success('模式已切换（config_audit 已留档）');
      void navigate('/control/config-audit');
    } catch (cause) {
      const api = cause instanceof ApiError ? cause.parsed : null;
      const code = api?.reason_code;
      if (code === 'point.control_mode_transition_invalid') {
        const details = api?.details;
        const causeFlag =
          typeof details === 'object' && details !== null
            ? (details as { cause?: string }).cause
            : undefined;
        message.error(
          causeFlag === 'fuse_open'
            ? '系统熔断中，前进已被封锁——熔断解除后点位仍停在 advisory，需逐档前进'
            : '一次只能前进一档',
        );
      } else if (code === 'point.control_mode_same') {
        message.info('点位已在目标模式（可能已被他人变更），已刷新');
      } else if (code === 'point.control_mode_point_not_controllable') {
        message.error('supervised/auto 前提：点位已入受控白名单——请先在闸门编辑中开启');
      } else {
        message.error(errorText(cause, '切换失败'));
      }
      setTarget(null);
      setReason('');
    } finally {
      setSubmitting(false);
    }
  };

  const direction = useMemo(() => {
    if (point === null || target === null) return '';
    return rank(target) > rank(point.control_mode) ? '前进一档' : '回退（可跨档）';
  }, [point, target]);

  if (error !== null) return <Alert type="error" showIcon message={error} />;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title={`控制模式切换${point === null ? '' : ` · ${point.display_name ?? point.raw_name}（${point.raw_name}）`}`}
        loading={loading}
        extra={<Link to="/control/points">返回清单</Link>}
      >
        <Steps
          direction="vertical"
          current={currentIdx}
          items={MODES.map((mode) => ({
            title: (
              <Space size={6}>
                {MODE_LABEL[mode]}
                {point?.control_mode === mode && <ControlModeTag mode={mode} />}
              </Space>
            ),
            description:
              point === null
                ? ''
                : mode === 'advisory'
                  ? '建议模式（MVP 唯一在用）'
                  : mode === 'supervised'
                    ? '监督模式（每次写经人工确认担责）'
                    : '自动模式（算法连续执掌，租约保护，失联回滚原值）',
          }))}
        />
        <Space size={12} style={{ marginTop: 16 }} wrap>
          {point !== null && forwardTarget !== null && (
            <Button
              type="primary"
              disabled={
                point.system_fuse === 'open' ||
                (forwardTarget !== 'advisory' && !point.gate.is_controllable)
              }
              title={
                point.system_fuse === 'open'
                  ? '系统熔断中：禁止前进爬档（解除后仍需逐档前进）'
                  : forwardTarget !== 'advisory' && !point.gate.is_controllable
                    ? '前提：点位已入受控白名单'
                    : undefined
              }
              onClick={() => {
                setTarget(forwardTarget);
              }}
            >
              前进一档（{MODE_LABEL[point.control_mode]} → {MODE_LABEL[forwardTarget]}）
            </Button>
          )}
          {point !== null && point.control_mode !== 'advisory' && (
            <Button
              onClick={() => {
                setTarget('advisory');
              }}
            >
              回退（可跨档）
            </Button>
          )}
        </Space>
      </Card>

      <Card title="模式变更时间线（config_audit · control_mode）" size="small">
        {history.length === 0 ? (
          <Typography.Text type="secondary">暂无变更记录</Typography.Text>
        ) : (
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            {history.map((row) => (
              <div key={row.id} style={row.actor_type === 'system' ? { opacity: 0.7 } : undefined}>
                {row.actor_type === 'system' ? (
                  <Typography.Text type="secondary">
                    {row.at} · {String(row.old_value)} → {String(row.new_value)} · system
                    {row.reason === null ? '' : ` · ${row.reason}`}
                  </Typography.Text>
                ) : (
                  <Typography.Text>
                    {row.at} · {String(row.old_value)} → {String(row.new_value)} ·{' '}
                    {row.actor_name ?? row.actor_ref ?? '—'}
                    {row.reason === null ? '' : ` · ${row.reason}`}
                  </Typography.Text>
                )}
              </div>
            ))}
          </Space>
        )}
      </Card>

      <Modal
        title="确认切换控制模式"
        open={target !== null}
        onCancel={() => {
          setTarget(null);
          setReason('');
        }}
        onOk={() => void submit()}
        okText="确认切换"
        okButtonProps={{ disabled: reason.trim().length === 0, loading: submitting }}
        destroyOnHidden
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Text strong>
            切换点位 {point?.raw_name} 控制模式 · {direction}
          </Typography.Text>
          <Typography.Text>
            control_mode：{point ? MODE_LABEL[point.control_mode] : ''} →{' '}
            {target === null ? '' : MODE_LABEL[target]}
          </Typography.Text>
          {target === 'auto' && (
            <Alert
              type="warning"
              showIcon
              message="auto 模式下算法连续执掌该点位写操作（租约保护，失联回滚原值）"
            />
          )}
          {target === 'advisory' && (
            <Alert type="info" showIcon message="advisory 为 MVP 唯一在用模式" />
          )}
          <Input.TextArea
            placeholder="将写入变更审计（config_audit），可按谁/何时/为什么检索"
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
            rows={3}
            maxLength={2000}
          />
        </Space>
      </Modal>
    </Space>
  );
}
