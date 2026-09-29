/**
 * 登录页（modules M7 页面地图 /login：邮箱 + 密码；MFA P2）。
 * 失败文案只按 auth.invalid_credentials / common.rate_limited 分支（API-ERR-01）。
 */
import { Alert, Button, Card, Form, Input } from 'antd';
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../app/api-client.js';
import { useAuth } from '../app/auth-context.js';

interface LoginForm {
  readonly email: string;
  readonly password: string;
}

export function LoginPage(): React.ReactNode {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const rawReturnTo =
    typeof location.state === 'object' && location.state !== null && 'returnTo' in location.state
      ? (location.state as { returnTo: unknown }).returnTo
      : '/';
  const returnTo = typeof rawReturnTo === 'string' ? rawReturnTo : '/';

  async function onFinish(values: LoginForm): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      await login(values.email, values.password);
      void navigate(returnTo, { replace: true });
    } catch (cause) {
      if (cause instanceof ApiError) {
        setError(
          cause.parsed.reason_code === 'common.rate_limited'
            ? '尝试过于频繁，请稍后再试'
            : '邮箱或密码错误',
        );
      } else {
        setError('服务暂不可用，请稍后重试');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--ti-bg-page)',
      }}
    >
      <Card title="thermio 节能管理" style={{ width: 360 }}>
        <Form<LoginForm> layout="vertical" onFinish={(values) => void onFinish(values)}>
          <Form.Item
            name="email"
            label="邮箱"
            rules={[
              { required: true, message: '请输入邮箱' },
              { type: 'email', message: '邮箱格式不正确' },
            ]}
          >
            <Input autoComplete="username" />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          {error !== null && (
            <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />
          )}
          <Button type="primary" htmlType="submit" block loading={submitting}>
            登录
          </Button>
        </Form>
      </Card>
    </div>
  );
}
