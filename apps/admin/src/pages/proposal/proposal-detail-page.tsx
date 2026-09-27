/**
 * 建议详情页 /proposals/:id（M5-proposal.md §6.2，UC-M5-1/2/3；baseline §3.2）。
 *
 * - 头卡：点位 + 状态徽标 + meta（算法@版本 · 创建/失效时间）+ 页级操作
 *   （确认/驳回/执行详情——按状态与能力键渲染，§4.4）；
 * - 主信息卡：信封全字段 Z1–Z8（动作 old→new diff / rationale 全文 / 预期节能 /
 *   置信度进度条 / evidence 折叠树 / 倒计时 / 决策信息）+ Z9 precheck 面板
 *   （四项 ✓/✗ + 「预检为快照，最终以执行仲裁为准」固定文案）；
 * - 确认弹窗（baseline §4.2 二次确认）：diff 表 + 预检四项 + comment 可选 +
 *   「确认执行建议」显式动作名；卡片停留后重取刷新 precheck（§5 checked_at 纪律）；
 * - 驳回弹窗：reason 必填多行（空值字段级错误文案 baseline §4.1）；
 * - 空态/错误态/加载态按 baseline §4.3；404 → 全局 404。
 */
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Form,
  Input,
  Modal,
  Progress,
  Row,
  Skeleton,
  Space,
  Typography,
  message,
} from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ProposalDetailSchema,
  type ProposalDetail,
  type ProposalPrecheck,
} from '@thermio/shared-types';
import { apiFetch } from '../../app/api-client.js';
import { errorText } from '../asset/asset-shared.js';
import {
  ExpiresCountdown,
  ProposalStatusTag,
  algoText,
  confidenceText,
  expectedSavingText,
  formatTime,
  useHasCapability,
  valueChainText,
} from './proposal-shared.js';
import { approveProposal, newIdempotencyKey, rejectProposal } from './proposal-actions.js';

export function ProposalDetailPage(): React.ReactNode {
  const { proposalId } = useParams();
  const canDecide = useHasCapability('proposals.decide.write');
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [detail, setDetail] = useState<ProposalDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(searchParams.get('confirm') === '1');
  const [rejectOpen, setRejectOpen] = useState(searchParams.get('reject') === '1');
  const [rejectForm] = Form.useForm<{ reason: string }>();
  const [comment, setComment] = useState('');
  const [idemKey, setIdemKey] = useState(newIdempotencyKey());

  const load = useCallback(async (): Promise<void> => {
    if (proposalId === undefined) return;
    setLoading(true);
    setError(null);
    try {
      setDetail(await apiFetch(`/proposals/${proposalId}`, ProposalDetailSchema));
    } catch (cause) {
      setError(errorText(cause, '建议详情加载失败'));
    } finally {
      setLoading(false);
    }
  }, [proposalId]);

  useEffect(() => {
    void load();
  }, [load]);

  const pending = detail?.status === 'pending';

  const doApprove = useCallback(async (): Promise<void> => {
    if (detail === null) return;
    try {
      await approveProposal(detail.id, idemKey, comment.length > 0 ? comment : undefined);
      void message.success('已确认，执行进行中（仲裁链异步）');
      setConfirmOpen(false);
      await load();
    } catch (cause) {
      void message.error(errorText(cause, '确认失败'));
      setConfirmOpen(false);
    }
  }, [detail, idemKey, comment, load]);

  const doReject = useCallback(async (): Promise<void> => {
    if (detail === null) return;
    try {
      const reason = await rejectForm.validateFields();
      await rejectProposal(detail.id, reason.reason, idemKey);
      void message.success('已驳回');
      setRejectOpen(false);
      await load();
    } catch (cause) {
      if (cause !== null && typeof cause === 'object' && 'errorFields' in cause) return; // 表单校验内联
      void message.error(errorText(cause, '驳回失败'));
      setRejectOpen(false);
    }
  }, [detail, idemKey, rejectForm, load]);

  if (loading) return <Skeleton active />;
  if (error !== null || detail === null) {
    return <Alert type="error" showIcon message={error ?? '建议不存在'} />;
  }

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Card size="small">
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Space wrap align="center">
            <Typography.Title level={4} style={{ margin: 0 }}>
              {detail.point.display_name ?? detail.point.raw_name}
            </Typography.Title>
            <ProposalStatusTag status={detail.status} />
            <Typography.Text type="secondary" code>
              {detail.point.raw_name}
            </Typography.Text>
          </Space>
          <Space wrap size={16}>
            <Typography.Text type="secondary">{algoText(detail)}</Typography.Text>
            <Typography.Text type="secondary">
              创建于 {formatTime(detail.created_at)}
            </Typography.Text>
            {pending && (
              <Typography.Text type="secondary">
                失效 <ExpiresCountdown expiresAt={detail.expires_at} />
              </Typography.Text>
            )}
          </Space>
          <Space style={{ marginTop: 4 }} align="center">
            {canDecide && pending && (
              <>
                <Button
                  type="primary"
                  onClick={() => {
                    setIdemKey(newIdempotencyKey());
                    void load(); // §5：弹窗打开时重取刷新 precheck（快照会过期）
                    setConfirmOpen(true);
                  }}
                >
                  确认
                </Button>
                <Button
                  danger
                  onClick={() => {
                    setIdemKey(newIdempotencyKey());
                    setRejectOpen(true);
                  }}
                >
                  驳回
                </Button>
              </>
            )}
            {detail.status !== 'pending' && (
              <Button onClick={() => void navigate(`/proposals/${detail.id}/execution`)}>
                查看执行详情
              </Button>
            )}
          </Space>
        </Space>
      </Card>

      <Row gutter={12}>
        <Col xs={24} lg={16}>
          <Card size="small" title="建议信封">
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="动作 old → new">
                <Typography.Text strong>
                  {valueChainText(detail.previous_value, detail.action.value, detail.action.unit)}
                </Typography.Text>
                {detail.action.op !== 'set' && (
                  <Typography.Text type="warning">（op={detail.action.op}）</Typography.Text>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="理由（rationale）">
                <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>
                  {detail.rationale}
                </Typography.Paragraph>
              </Descriptions.Item>
              <Descriptions.Item label="预期节能">
                <Typography.Text type="success">
                  {expectedSavingText(detail.expected_saving_kw)}
                </Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="置信度">
                {detail.confidence === null ? (
                  '—'
                ) : (
                  <Space>
                    <Progress
                      percent={Math.round(detail.confidence * 100)}
                      size="small"
                      style={{ width: 140, marginBottom: 0 }}
                      showInfo={false}
                    />
                    {confidenceText(detail.confidence)}
                  </Space>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="附加上下文（evidence）">
                <pre style={{ margin: 0, fontSize: 12, maxHeight: 260, overflow: 'auto' }}>
                  {JSON.stringify(detail.evidence ?? {}, null, 2)}
                </pre>
              </Descriptions.Item>
              <Descriptions.Item label="算法 / 版本">
                <Typography.Text code>{algoText(detail)}</Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="决策信息">
                {detail.status === 'pending' ? (
                  '—（未决策）'
                ) : (
                  <Space direction="vertical" size={0}>
                    <span>
                      {detail.decided_by_name ?? '—'} ·{' '}
                      {detail.decided_at === null ? '—' : formatTime(detail.decided_at)}
                      {detail.status === 'expired' && '（系统过期沉降，无人工决策）'}
                    </span>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      驳回原因留存于日志（DDL 修订 decided_reason 落列后转持久化）
                    </Typography.Text>
                  </Space>
                )}
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card size="small" title="闸门预检（快照）">
            {detail.precheck === null ? (
              <Typography.Text type="secondary">已决策 / 终态建议无预检</Typography.Text>
            ) : (
              <PrecheckPanel precheck={detail.precheck} />
            )}
          </Card>
          <Card size="small" title="关联" style={{ marginTop: 12 }}>
            <Space direction="vertical" size={4}>
              <Link to={`/assets/points/${String(detail.point_id)}`}>
                目标点位详情（闸门参数只读）
              </Link>
              <Link to={`/assets/equipments/${detail.equipment_id}`}>目标设备详情</Link>
              <Link to={`/control-audit?point_id=${String(detail.point_id)}`}>该点位执行审计</Link>
            </Space>
          </Card>
        </Col>
      </Row>

      {/* 确认弹窗（baseline §4.2 M5 确认行） */}
      <Modal
        title="确认执行建议"
        open={confirmOpen}
        onOk={() => void doApprove()}
        onCancel={() => {
          setConfirmOpen(false);
        }}
        okText="确认执行建议"
      >
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="点位">
              {detail.point.display_name ?? detail.point.raw_name}（{detail.point.raw_name}）
            </Descriptions.Item>
            <Descriptions.Item label="设定值变更">
              <Typography.Text strong>
                {valueChainText(detail.previous_value, detail.action.value, detail.action.unit)}
              </Typography.Text>
            </Descriptions.Item>
          </Descriptions>
          {detail.precheck !== null && <PrecheckPanel precheck={detail.precheck} />}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            预检为快照，最终以执行仲裁为准；确认后不可撤回。
          </Typography.Text>
          <Input.TextArea
            placeholder="备注（可选；当前留存于日志，DDL 修订后转持久化）"
            value={comment}
            maxLength={2000}
            onChange={(event) => {
              setComment(event.target.value);
            }}
          />
        </Space>
      </Modal>

      {/* 驳回弹窗（baseline §4.1 校验文案） */}
      <Modal
        title="驳回建议"
        open={rejectOpen}
        onOk={() => void doReject()}
        onCancel={() => {
          setRejectOpen(false);
        }}
        okText="驳回建议"
        okButtonProps={{ danger: true }}
      >
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="点位">
              {detail.point.display_name ?? detail.point.raw_name}
            </Descriptions.Item>
            <Descriptions.Item label="动作">
              {valueChainText(detail.previous_value, detail.action.value, detail.action.unit)}
            </Descriptions.Item>
          </Descriptions>
          <Form form={rejectForm} layout="vertical">
            <Form.Item
              name="reason"
              label="驳回原因"
              rules={[
                { required: true, message: '请填写驳回原因（必填，进入审计记录）' },
                { max: 2000, message: '≤2000 字' },
              ]}
            >
              <Input.TextArea rows={3} placeholder="驳回原因将回流算法归因（当前留存于日志）" />
            </Form.Item>
          </Form>
        </Space>
      </Modal>
    </Space>
  );
}

/** Z9 预检面板：四项 ✓/✗ + 说明 + 固定文案（§6.2-Z9）。 */
function PrecheckPanel({ precheck }: { precheck: ProposalPrecheck }): React.ReactNode {
  const rows: { key: string; pass: boolean; text: string }[] = [
    {
      key: 'whitelist',
      pass: precheck.whitelist.pass,
      text: precheck.whitelist.pass
        ? '点位在受控白名单（可写、启用中）'
        : '该点位不在受控白名单（不可控/停用/只读）',
    },
    {
      key: 'clamp',
      pass: !precheck.clamp.would_clamp,
      text: precheck.clamp.would_clamp
        ? `值将被钳制 ${String(precheck.clamp.value)} → ${String(precheck.clamp.effective_value)}（非拒绝）`
        : `值在钳制域内（[${String(precheck.clamp.clamp_min ?? '−∞')}, ${String(precheck.clamp.clamp_max ?? '+∞')}]）`,
    },
    {
      key: 'rate',
      pass: precheck.rate.pass,
      text: `本小时已写 ${String(precheck.rate.used)}/${String(precheck.rate.limit)} 次`,
    },
    {
      key: 'fuse',
      pass: precheck.fuse.status === 'closed',
      text:
        precheck.fuse.status === 'open'
          ? '目标系统熔断中（确认后必被熔断闸门拦下）'
          : '目标系统熔断器闭合（正常）',
    },
  ];
  return (
    <Space direction="vertical" size={6} style={{ width: '100%' }}>
      {rows.map((row) =>
        row.pass ? (
          <Space key={row.key} align="start">
            <Typography.Text style={{ color: '#52c41a' }}>✓</Typography.Text>
            <Typography.Text style={{ fontSize: 12 }}>{row.text}</Typography.Text>
          </Space>
        ) : row.key === 'clamp' || row.key === 'rate' ? (
          <Space key={row.key} align="start">
            <Typography.Text style={{ color: '#faad14' }}>⚠</Typography.Text>
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              {row.text}
            </Typography.Text>
          </Space>
        ) : (
          <Space key={row.key} align="start">
            <Typography.Text style={{ color: '#ff4d4f' }}>✗</Typography.Text>
            <Typography.Text type="danger" style={{ fontSize: 12 }}>
              {row.text}
            </Typography.Text>
          </Space>
        ),
      )}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        预检为快照（{formatTime(precheck.checked_at)}），最终以执行仲裁为准。
      </Typography.Text>
    </Space>
  );
}
