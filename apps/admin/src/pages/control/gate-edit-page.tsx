/**
 * 闸门参数编辑页 /control/points/:id/gate（M8-safety-ui.md §4，UC-M8-2）。
 *
 * - 编辑基线 = 服务端实体读回（§4.1：不做本地乐观初值）；仅变更字段进请求体
 *   （PATCH 语义：未改动字段不产生 config_audit 行，C1 逐字段留痕）；
 * - 二次确认对话框（§4.4）：old→new diff 表 + reason 必填 + 显式动作名 +
 *   不回车提交；取消/Esc 零请求落库；
 * - 专项提示（§4.3）：收紧值域黄条（在途提案派发前将被新上限夹紧）/ 关闭白名单
 *   黄条（T2 复评拦截）；
 * - 服务端复核码呈现（§1.3）：gate.clamp_range_invalid / gate.controllable_requires_
 *   clamp / gate.rate_invalid 字段级红字；成功 toast 含热生效提示 + 变更历史入口。
 */
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Space,
  Switch,
  Typography,
  message,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ControlPointsListResponseSchema, type ControlPointItem } from '@thermio/shared-types';
import { apiFetch } from '../../app/api-client.js';
import { errorText } from '../asset/asset-shared.js';
import { ApiError } from '../../app/api-client.js';
import { clampText, patchGate } from './control-shared.js';

interface GateForm {
  is_controllable: boolean;
  clamp_min: number | null;
  clamp_max: number | null;
  write_rate_limit_per_hour: number | null;
}

export function GateEditPage(): React.ReactNode {
  const { pointId } = useParams<{ pointId?: string }>();
  const navigate = useNavigate();
  const [point, setPoint] = useState<ControlPointItem | null>(null);
  const [form] = Form.useForm<GateForm>();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reason, setReason] = useState('');

  useEffect(() => {
    const state = { cancelled: false };
    if (pointId === undefined) return;
    // 单点读：清单端点无单点参数，全量首页 + 本地筛（MVP 量级 ≤200 点）
    void (async () => {
      setLoading(true);
      try {
        const response = await apiFetch(
          '/control/points?limit=200&is_controllable=all',
          ControlPointsListResponseSchema,
        );
        const hit = response.items.find((item) => String(item.point_id) === pointId);
        if (state.cancelled) return;
        if (hit === undefined) {
          setError('点位不存在或不可见');
          return;
        }
        setPoint(hit);
        form.setFieldsValue({
          is_controllable: hit.gate.is_controllable,
          clamp_min: hit.gate.clamp_min,
          clamp_max: hit.gate.clamp_max,
          write_rate_limit_per_hour: hit.gate.write_rate_limit_per_hour,
        });
      } catch (cause) {
        if (!state.cancelled) setError(errorText(cause, '点位加载失败'));
      } finally {
        if (!state.cancelled) setLoading(false);
      }
    })();
    return () => {
      state.cancelled = true;
    };
  }, [pointId, form]);

  /** 表单值快照（对话框打开时刷新——diff 依赖表单当前值）。 */
  const [formSnapshot, setFormSnapshot] = useState<GateForm | null>(null);
  useEffect(() => {
    if (confirmOpen) setFormSnapshot(form.getFieldsValue());
  }, [confirmOpen, form]);

  /** diff（仅变更字段，§4.4）。 */
  const diff = useMemo(() => {
    if (point === null || formSnapshot === null) return [];
    const values = formSnapshot;
    const rows: Array<{ label: string; oldText: string; newText: string }> = [];
    const fmt = (v: boolean | number | null): string =>
      v === null ? '空' : typeof v === 'boolean' ? (v ? '开' : '关') : String(v);
    if (values.is_controllable !== point.gate.is_controllable) {
      rows.push({
        label: '受控白名单',
        oldText: fmt(point.gate.is_controllable),
        newText: fmt(values.is_controllable),
      });
    }
    if (values.clamp_min !== point.gate.clamp_min) {
      rows.push({
        label: 'clamp_min',
        oldText: fmt(point.gate.clamp_min),
        newText: fmt(values.clamp_min),
      });
    }
    if (values.clamp_max !== point.gate.clamp_max) {
      rows.push({
        label: 'clamp_max',
        oldText: fmt(point.gate.clamp_max),
        newText: fmt(values.clamp_max),
      });
    }
    if (values.write_rate_limit_per_hour !== point.gate.write_rate_limit_per_hour) {
      rows.push({
        label: '频率上限（次/h）',
        oldText: fmt(point.gate.write_rate_limit_per_hour),
        newText: fmt(values.write_rate_limit_per_hour),
      });
    }
    return rows;
  }, [point, formSnapshot]);

  const snapshotClampMax = formSnapshot?.clamp_max;
  const tighteningClamp =
    point !== null &&
    typeof snapshotClampMax === 'number' &&
    point.gate.clamp_max !== null &&
    snapshotClampMax < point.gate.clamp_max;
  const closingWhitelist =
    point !== null && formSnapshot?.is_controllable === false && point.gate.is_controllable;

  const submit = async (): Promise<void> => {
    if (pointId === undefined || point === null) return;
    setSubmitting(true);
    try {
      const values = form.getFieldsValue();
      setFormSnapshot(values);
      const body: Record<string, unknown> = { reason };
      if (values.is_controllable !== point.gate.is_controllable)
        body.is_controllable = values.is_controllable;
      if (values.clamp_min !== point.gate.clamp_min) body.clamp_min = values.clamp_min;
      if (values.clamp_max !== point.gate.clamp_max) body.clamp_max = values.clamp_max;
      if (values.write_rate_limit_per_hour !== point.gate.write_rate_limit_per_hour) {
        body.write_rate_limit_per_hour = values.write_rate_limit_per_hour;
      }
      await patchGate(Number(pointId), body as { reason: string });
      message.success('已变更 · 新参数即刻生效；队列中提案派发前按新参数复评');
      void navigate('/control/config-audit');
    } catch (cause) {
      const code = cause instanceof ApiError ? cause.parsed.reason_code : null;
      const apiMessage = cause instanceof ApiError ? cause.parsed.message : null;
      if (code === 'point.gate_clamp_range_invalid') {
        form.setFields([
          { name: 'clamp_min', errors: [apiMessage === null ? '值域矛盾' : apiMessage] },
        ]);
      } else if (code === 'point.gate_controllable_requires_clamp') {
        form.setFields([{ name: 'clamp_min', errors: ['开启白名单必须先配置值域'] }]);
      } else if (code === 'point.gate_rate_invalid') {
        form.setFields([
          {
            name: 'write_rate_limit_per_hour',
            errors: [apiMessage === null ? '频率上限非法' : apiMessage],
          },
        ]);
      } else {
        message.error(errorText(cause, '变更失败'));
      }
      setConfirmOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  if (error !== null) {
    return <Alert type="error" showIcon message={error} />;
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title={`闸门参数编辑${point === null ? '' : ` · ${point.display_name ?? point.raw_name}（${point.raw_name}）`}`}
        loading={loading}
        extra={<Link to="/control/points">返回清单</Link>}
      >
        <Form form={form} layout="vertical" style={{ maxWidth: 480 }}>
          <Form.Item
            name="is_controllable"
            label="受控白名单"
            valuePropName="checked"
            extra="开启 = 允许算法提案触达该点位（闸门 1 白名单）"
          >
            <Switch />
          </Form.Item>
          <Space size={12}>
            <Form.Item
              name="clamp_min"
              label={`clamp_min${point?.unit_std ? `（${point.unit_std}）` : ''}`}
            >
              <InputNumber style={{ width: 160 }} placeholder="不设下限" />
            </Form.Item>
            <Form.Item
              name="clamp_max"
              label={`clamp_max${point?.unit_std ? `（${point.unit_std}）` : ''}`}
            >
              <InputNumber style={{ width: 160 }} placeholder="不设上限" />
            </Form.Item>
          </Space>
          <Form.Item
            name="write_rate_limit_per_hour"
            label="频率上限（次/h）"
            extra="可控点必填（正整数）；运行时兜底 6 次/h 仅对存量空列生效（control-safety §3.3）"
          >
            <InputNumber style={{ width: 160 }} min={1} precision={0} />
          </Form.Item>
          {point !== null && (
            <Typography.Text type="secondary">当前值域：{clampText(point)}</Typography.Text>
          )}
          <Form.Item style={{ marginTop: 16 }}>
            <Button
              type="primary"
              onClick={() => {
                setFormSnapshot(form.getFieldsValue());
                setConfirmOpen(true);
              }}
              disabled={loading}
            >
              校验并确认变更
            </Button>
          </Form.Item>
        </Form>
      </Card>

      <Modal
        title="确认变更闸门参数"
        open={confirmOpen}
        onCancel={() => {
          setConfirmOpen(false);
        }}
        onOk={() => {
          void submit();
        }}
        okText="确认变更"
        okButtonProps={{ disabled: reason.trim().length === 0, loading: submitting }}
        destroyOnHidden
      >
        {diff.length === 0 ? (
          <Alert type="info" message="未修改任何字段——仅变更字段会写入变更审计" />
        ) : (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Typography.Text strong>
              变更点位 {point?.raw_name}（{point?.equipment?.name ?? '—'}）的闸门参数
            </Typography.Text>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {diff.map((row) => (
                  <tr key={row.label}>
                    <td style={{ padding: '4px 12px 4px 0', color: '#888' }}>{row.label}</td>
                    <td style={{ padding: '4px 6px', textDecoration: 'line-through' }}>
                      {row.oldText}
                    </td>
                    <td style={{ padding: '4px 6px', fontWeight: 600 }}>{row.newText}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {tighteningClamp && (
              <Alert
                type="warning"
                showIcon
                message="收紧值域后，在途提案的目标值可能在派发前被新上限夹紧（clamp 调整不拒绝）"
              />
            )}
            {closingWhitelist && (
              <Alert
                type="warning"
                showIcon
                message="关闭后新提案一律被闸门 1 拒绝；已入队列提案在派发前复评拦截"
              />
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
        )}
      </Modal>
    </Space>
  );
}
