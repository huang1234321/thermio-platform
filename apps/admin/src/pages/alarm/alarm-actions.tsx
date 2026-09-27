/**
 * 告警处置动作弹窗（M4-alarm.md §7 行 2：close 二次确认 reason 必填；
 * suppress 对话框期限 presets 1h/4h/24h + 自定义，duration+reason 均必填）。
 */
import { Form, Input, Modal, Radio, message } from 'antd';
import { useEffect, useState } from 'react';
import {
  AlarmCloseResponseSchema,
  AlarmEventViewSchema,
  AlarmSuppressResponseSchema,
  AlarmUnsuppressResponseSchema,
  type AlarmEventView,
} from '@thermio/shared-types';
import { apiFetch } from '../../app/api-client.js';
import { errorText } from '../asset/asset-shared.js';

/** 204 无内容响应的 safeParse 占位（204 在 apiFetch 内短路，不经 parse）。 */
export const noContent = {
  safeParse: (input: unknown): { success: true; data: unknown } => ({ success: true, data: input }),
};

/** 关闭弹窗：reason 必填（闭环留痕，「告警摘要」预设文案可改）。 */
export function CloseAlarmModal({
  alarm,
  onClose,
  onDone,
}: {
  alarm: AlarmEventView | null;
  onClose: () => void;
  onDone: () => void;
}): React.ReactNode {
  const [form] = Form.useForm<{ reason: string }>();
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    if (alarm !== null) {
      form.setFieldValue('reason', `处置完成：${alarm.message}`);
    }
  }, [alarm, form]);

  return (
    <Modal
      title={`关闭告警 #${alarm === null ? '' : String(alarm.id)}`}
      open={alarm !== null}
      confirmLoading={submitting}
      onCancel={onClose}
      onOk={() => {
        if (alarm === null) return;
        void (async () => {
          const values = await form.validateFields();
          setSubmitting(true);
          try {
            const result = await apiFetch(
              `/alarms/${String(alarm.id)}/close`,
              AlarmCloseResponseSchema,
              { method: 'POST', body: { reason: values.reason } },
            );
            void message.success(`已关闭（级联关闭 ${String(result.cascade_closed)} 条子告警）`);
            onDone();
          } catch (cause) {
            void message.error(errorText(cause, '关闭失败'));
          } finally {
            setSubmitting(false);
          }
        })();
      }}
    >
      <Form form={form} layout="vertical">
        <Form.Item
          name="reason"
          label="关闭原因（必填，闭环留痕）"
          rules={[{ required: true, min: 1, max: 1024, message: '请填写关闭原因' }]}
        >
          <Input.TextArea rows={2} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

const DURATION_PRESETS = [
  { value: 3600, label: '1 小时' },
  { value: 4 * 3600, label: '4 小时' },
  { value: 24 * 3600, label: '24 小时' },
];

/** 抑制弹窗：期限 presets + 自定义分钟数；duration+reason 均必填（值域 300..86400）。 */
export function SuppressModal({
  alarm,
  onClose,
  onDone,
}: {
  alarm: AlarmEventView | null;
  onClose: () => void;
  onDone: () => void;
}): React.ReactNode {
  const [form] = Form.useForm<{ duration_s: number; reason: string; custom_minutes?: number }>();
  const [submitting, setSubmitting] = useState(false);
  const [customMode, setCustomMode] = useState(false);

  return (
    <Modal
      title={`抑制告警 #${alarm === null ? '' : String(alarm.id)}`}
      open={alarm !== null}
      confirmLoading={submitting}
      onCancel={onClose}
      onOk={() => {
        if (alarm === null) return;
        void (async () => {
          const values = await form.validateFields();
          const durationS = customMode ? (values.custom_minutes ?? 0) * 60 : values.duration_s;
          setSubmitting(true);
          try {
            const result = await apiFetch(
              `/alarms/${String(alarm.id)}/suppress`,
              AlarmSuppressResponseSchema,
              {
                method: 'POST',
                body: {
                  duration_s: durationS,
                  reason: values.reason,
                  ...(alarm.is_root ? { cascade: true } : {}),
                },
              },
            );
            void message.success(
              `已抑制至 ${new Date(result.suppression.until_at).toLocaleString('zh-CN', { hour12: false })}（级联 ${String(result.cascade_suppressed)} 条）`,
            );
            onDone();
          } catch (cause) {
            void message.error(errorText(cause, '抑制失败'));
          } finally {
            setSubmitting(false);
          }
        })();
      }}
    >
      <Form form={form} layout="vertical" initialValues={{ duration_s: 3600 }}>
        <Form.Item label="抑制期限" required>
          <Radio.Group
            value={customMode ? 'custom' : 'preset'}
            onChange={(event) => {
              setCustomMode(event.target.value === 'custom');
            }}
          >
            {DURATION_PRESETS.map((preset) => (
              <Radio.Button
                key={preset.label}
                value="preset"
                onClick={() => {
                  form.setFieldValue('duration_s', preset.value);
                }}
              >
                {preset.label}
              </Radio.Button>
            ))}
            <Radio.Button value="custom">自定义</Radio.Button>
          </Radio.Group>
        </Form.Item>
        {customMode && (
          <Form.Item
            name="custom_minutes"
            label="自定义分钟数（5..1440）"
            rules={[
              { required: true, message: '请填写分钟数' },
              {
                validator: (_rule, value: number) =>
                  value >= 5 && value <= 1440
                    ? Promise.resolve()
                    : Promise.reject(new Error('须在 5..1440 分钟内')),
              },
            ]}
          >
            <Input type="number" min={5} max={1440} />
          </Form.Item>
        )}
        <Form.Item
          name="reason"
          label="抑制原因（必填）"
          rules={[{ required: true, min: 1, max: 1024, message: '请填写抑制原因' }]}
        >
          <Input.TextArea rows={2} placeholder="如：维护窗口 / 已知误报" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** 提前恢复（unsuppress，含级联）。 */
export async function unsuppressAlarm(alarmId: number, cascade: boolean): Promise<void> {
  await apiFetch(`/alarms/${String(alarmId)}/unsuppress`, AlarmUnsuppressResponseSchema, {
    method: 'POST',
    body: { ...(cascade ? { cascade: true } : {}) },
  });
}

/** 单条确认（非批量路径）。 */
export async function ackAlarm(alarmId: number): Promise<AlarmEventView> {
  return apiFetch(`/alarms/${String(alarmId)}/ack`, AlarmEventViewSchema, {
    method: 'POST',
    body: {},
  });
}
