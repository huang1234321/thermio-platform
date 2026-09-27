/**
 * 执行详情页 /proposals/:id/execution（M5-proposal.md §6.3，UC-M5-4；PRD D2）。
 *
 * - 头卡：执行详情 · 点位 + 终态徽标（outcome 四值中文映射；进行中 = phase + spinner）；
 * - 五闸门时间线（§2.3 gates 渲染）：纵向五节点，逐节点 outcome 图标 + 解码文案；
 *   未知 outcome 兜底徽标（API-CT-02）；
 * - 阶段时间线（§4.3）：pending 引导态「建议尚未确认」；
 * - 三值链卡：指令值 → 生效值（被钳制 ⚠）→ 回读值 ✓；
 * - 回读验证卡（verify.readings）+ 审计链卡（at ASC 全链路，actor/result 徽标）；
 * - 轮询（§7）：approved 非终态 3s 节奏，终态即停；连续 30 次（≈90s）未终态 →
 *   停止并提示手动刷新；页面隐藏暂停（document.visibilitychange）。
 */
import { Alert, Card, Skeleton, Space, Spin, Table, Tag, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ControlAuditRow } from '@thermio/shared-types';
import { apiFetch } from '../../app/api-client.js';
import { errorText } from '../asset/asset-shared.js';
import {
  ActorTag,
  AuditResultTag,
  GATE_OUTCOME_META,
  ProposalStatusTag,
  formatTime,
  gateTitle,
} from './proposal-shared.js';
import { parseExecutionView, type ExecutionView } from './execution-view.js';
import { PROPOSAL_POLL_MAX_ROUNDS, useProposalPolling } from './proposal-hooks.js';

const OUTCOME_LABEL: Record<string, string> = {
  executed: '已执行',
  verify_failed: '验证失败',
  reverted: '已回滚',
  rejected_by_gate: '闸门拒绝',
};

const PHASE_LABEL: Record<string, string> = {
  queued: '排队中',
  arbitrating: '仲裁中',
  dispatching: '下发中',
  awaiting_ack: '等待网关应答',
  awaiting_readback: '回读验证中',
  retrying: '重试中',
  reverting: '回写原值中',
  executed: '已执行',
  failed: '失败',
};

export function ProposalExecutionPage(): React.ReactNode {
  const { proposalId } = useParams();
  const [view, setView] = useState<ExecutionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<ExecutionView> => {
    if (proposalId === undefined) throw new Error('缺 proposalId');
    return apiFetch(`/proposals/${proposalId}/execution`, {
      safeParse: (input: unknown) => {
        const parsed = parseExecutionView(input);
        return parsed === null
          ? { success: false as const }
          : { success: true as const, data: parsed };
      },
    });
  }, [proposalId]);

  // M5 §7（B2 复用）：3s 轮询、终态停、30 次上限、隐藏暂停（hook 内）
  const { rounds: pollRounds } = useProposalPolling(
    load,
    (data) => data.status === 'approved',
    (data) => {
      setView(data);
      setError(null);
      setLoading(false);
    },
    true,
    (cause) => {
      // R-1：恢复错误路径具体原因展示（读失败保留上一帧，手动刷新兜底）
      setError(errorText(cause, '执行详情加载失败'));
      setLoading(false);
    },
  );
  useEffect(() => {
    setLoading(false);
  }, []);

  if (loading) return <Skeleton active />;
  if (error !== null || view === null) {
    return <Alert type="error" showIcon message={error ?? '执行详情不可用'} />;
  }

  const isRunning = view.status === 'approved';

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Card size="small">
        <Space wrap align="center">
          <Typography.Title level={4} style={{ margin: 0 }}>
            执行详情 · {view.audit_ref.proposal_id.slice(0, 8)}
          </Typography.Title>
          <ProposalStatusTag status={view.status} />
          {isRunning && (
            <Space size={6}>
              <Spin size="small" />
              <Typography.Text type="warning">
                {PHASE_LABEL[view.phase ?? 'queued'] ?? view.phase ?? '执行中'}
              </Typography.Text>
            </Space>
          )}
          {view.outcome !== null && (
            <Tag color={view.outcome === 'executed' ? 'green' : 'red'}>
              {OUTCOME_LABEL[view.outcome] ?? view.outcome}
            </Tag>
          )}
          <Link to={`/proposals/${view.proposal_id}`}>返回建议详情</Link>
        </Space>
      </Card>

      {view.status === 'pending' && (
        <Alert type="info" showIcon message="建议尚未确认（approve 后进入仲裁执行）" />
      )}
      {pollRounds.current >= PROPOSAL_POLL_MAX_ROUNDS && isRunning && (
        <Alert type="warning" showIcon message="执行仍在进行，请稍后手动刷新" />
      )}

      <Card size="small" title="五闸门时间线">
        {view.gates.length === 0 ? (
          <Typography.Text type="secondary">暂无闸门求值记录（未进入仲裁）</Typography.Text>
        ) : (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {view.gates.map((gate) => {
              const meta = GATE_OUTCOME_META[gate.outcome] ?? {
                label: gate.outcome,
                color: 'default' as const,
              };
              return (
                <Space key={String(gate.gate)} align="start" size={8}>
                  <Typography.Text type="secondary">{String(gate.gate)}</Typography.Text>
                  <Typography.Text strong style={{ width: 92, display: 'inline-block' }}>
                    {gateTitle(gate.gate)}
                  </Typography.Text>
                  <Tag color={meta.color}>{meta.label}</Tag>
                  {gate.outcome === 'clamped' && gate.detail !== null && (
                    <Typography.Text type="warning" style={{ fontSize: 12 }}>
                      {formatDetailNumber(gate.detail['from'])} →{' '}
                      {formatDetailNumber(gate.detail['to'])}
                    </Typography.Text>
                  )}
                  {gate.outcome === 'unevaluated' && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      前序闸门已拒绝，未求值
                    </Typography.Text>
                  )}
                </Space>
              );
            })}
          </Space>
        )}
      </Card>

      <Card size="small" title="三值链">
        <Space size={16} wrap>
          <span>指令值 {valueText(view.value_chain.value_commanded)}</span>
          <Typography.Text type="secondary">→</Typography.Text>
          <span>
            生效值 {valueText(view.value_chain.value_effective)}
            {view.value_chain.clamped && (
              <Typography.Text type="warning">（被钳制 ⚠）</Typography.Text>
            )}
          </span>
          <span>
            回读值{' '}
            {view.verify.readings.length > 0
              ? valueText(view.verify.readings[view.verify.readings.length - 1]?.value ?? null)
              : '—'}
            {view.verify.readings.length > 0 &&
              (view.verify.readings[view.verify.readings.length - 1]?.match === true ? (
                <Typography.Text style={{ color: '#52c41a' }}> ✓</Typography.Text>
              ) : (
                <Typography.Text type="danger"> ✗</Typography.Text>
              ))}
          </span>
        </Space>
      </Card>

      <Card size="small" title={`回读验证（重写 ${String(view.verify.retries_write)} 次）`}>
        {view.verify.readings.length === 0 ? (
          <Typography.Text type="secondary">暂无回读记录</Typography.Text>
        ) : (
          <Table
            size="small"
            pagination={false}
            rowKey={(row, index) => `${row.at ?? ''}-${String(index)}`}
            dataSource={view.verify.readings.map((reading, index) => ({
              ...reading,
              key: String(index),
            }))}
            columns={[
              {
                title: '时间',
                dataIndex: 'at',
                render: (value: string | null) => (value === null ? '—' : formatTime(value)),
              },
              {
                title: '读数',
                dataIndex: 'value',
                render: (value: number | null) => valueText(value),
              },
              {
                title: '质量',
                dataIndex: 'quality',
                render: (value: string | null) => value ?? '—',
              },
              {
                title: '一致',
                dataIndex: 'match',
                render: (value: boolean | null) =>
                  value === null ? (
                    '—'
                  ) : value ? (
                    <Typography.Text style={{ color: '#52c41a' }}>✓</Typography.Text>
                  ) : (
                    <Typography.Text type="danger">✗</Typography.Text>
                  ),
              },
            ]}
          />
        )}
      </Card>

      <Card
        size="small"
        title={`审计链（${String(view.audit.length)} 条）`}
        extra={<Link to={`/control-audit?proposal_id=${view.proposal_id}`}>在执行审计中查看</Link>}
      >
        <AuditChainTable rows={view.audit} />
      </Card>
    </Space>
  );
}

function valueText(value: number | null): string {
  return value === null ? '—' : String(value);
}

/** clamp detail 数值兜底格式化（宽松投影值可能是任意 JSON——仅数值可读化）。 */
function formatDetailNumber(value: unknown): string {
  return typeof value === 'number' ? String(value) : '—';
}

/** 审计链表（§6.3：时间 + actor 徽标 + result 徽标 + old→new + reason）。 */
export function AuditChainTable({ rows }: { rows: readonly ControlAuditRow[] }): React.ReactNode {
  return (
    <Table
      size="small"
      pagination={false}
      rowKey="id"
      dataSource={[...rows]}
      columns={[
        {
          title: '时间',
          dataIndex: 'at',
          width: 170,
          render: (value: string) => formatTime(value),
        },
        {
          title: '行为者',
          dataIndex: 'actor_type',
          width: 90,
          render: (value: ControlAuditRow['actor_type']) => <ActorTag actor={value} />,
        },
        {
          title: '结果',
          dataIndex: 'result',
          width: 100,
          render: (value: ControlAuditRow['result']) => <AuditResultTag result={value} />,
        },
        {
          title: '点位',
          dataIndex: 'point',
          render: (_: unknown, row: ControlAuditRow) =>
            row.point.display_name ?? row.point.raw_name,
        },
        {
          title: 'old → new',
          width: 150,
          render: (_: unknown, row: ControlAuditRow) =>
            `${valueText(row.old_value)} → ${valueText(row.new_value)}`,
        },
        { title: '原因', dataIndex: 'reason', render: (value: string | null) => value ?? '—' },
        {
          title: '建议',
          dataIndex: 'proposal_id',
          width: 110,
          render: (value: string | null) =>
            value === null ? (
              <Typography.Text type="secondary">系统接管（无关联提案）</Typography.Text>
            ) : (
              <Link to={`/proposals/${value}`}>查看</Link>
            ),
        },
      ]}
    />
  );
}
