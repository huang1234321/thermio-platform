/**
 * 修改密码表单（SEC-PW-02 策略前置提示 + user.password_policy_failed 后端码兜底）。
 */
import { Alert, Button, Form, Input } from 'antd';
import { useState } from 'react';
import {
  ChangePasswordRequestSchema,
  LoginResponseSchema,
  type LoginResponse,
} from '@thermio/shared-types';
import { ApiError, apiFetch } from '../app/api-client.js';
import { useAuth } from '../app/auth-context.js';

interface FormValues {
  readonly old_password: string;
  readonly new_password: string;
  readonly confirm: string;
}

export function ChangePasswordForm({ onDone }: { onDone: () => void }): React.ReactNode {
  const { applyNewTokens } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<FormValues>();

  async function onFinish(values: FormValues): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      const tokens = await apiFetch<LoginResponse>('/auth/change-password', LoginResponseSchema, {
        method: 'POST',
        body: { old_password: values.old_password, new_password: values.new_password },
      });
      await applyNewTokens(tokens);
      form.resetFields();
      onDone();
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.parsed.reason_code === 'user.password_policy_failed'
          ? '新密码不符合策略：长度至少 8 位且含字母与数字'
          : '旧密码不正确或服务暂不可用，请重试',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Form<FormValues> form={form} layout="vertical" onFinish={(values) => void onFinish(values)}>
      <Form.Item name="old_password" label="当前密码" rules={[{ required: true }]}>
        <Input.Password autoComplete="current-password" />
      </Form.Item>
      <Form.Item
        name="new_password"
        label="新密码"
        rules={[
          { required: true },
          {
            validator: (_rule, value: string | undefined) =>
              value !== undefined &&
              ChangePasswordRequestSchema.shape.new_password.safeParse(value).success
                ? Promise.resolve()
                : Promise.reject(new Error('长度至少 8 位且含字母与数字')),
          },
        ]}
      >
        <Input.Password autoComplete="new-password" />
      </Form.Item>
      <Form.Item
        name="confirm"
        label="确认新密码"
        dependencies={['new_password']}
        rules={[
          { required: true },
          ({ getFieldValue }) => ({
            validator: (_rule, value: string | undefined) =>
              value === getFieldValue('new_password')
                ? Promise.resolve()
                : Promise.reject(new Error('两次输入不一致')),
          }),
        ]}
      >
        <Input.Password autoComplete="new-password" />
      </Form.Item>
      {error !== null && (
        <Alert type="error" message={error} style={{ marginBottom: 16 }} showIcon />
      )}
      <Button type="primary" htmlType="submit" loading={submitting}>
        更新密码
      </Button>
    </Form>
  );
}
