/**
 * 状态页：403（已认证无能力，baseline §1.2）/ 404（含越权资源统一口径，SEC-AZ-03）/
 * 模块占位页（对应模块随 IMPL-11+ 落地）。
 */
import { Button, Result } from 'antd';
import { useNavigate } from 'react-router-dom';

function BackHomeButton(): React.ReactNode {
  const navigate = useNavigate();
  return (
    <Button
      type="primary"
      onClick={() => {
        void navigate('/');
      }}
    >
      返回首页
    </Button>
  );
}

export function ForbiddenPage(): React.ReactNode {
  return (
    <Result
      status="403"
      title="403"
      subTitle="当前账号无此操作权限，请联系管理员开通。"
      extra={<BackHomeButton />}
    />
  );
}

export function NotFoundPage(): React.ReactNode {
  return (
    <Result status="404" title="404" subTitle="资源不存在或不可访问。" extra={<BackHomeButton />} />
  );
}

export function ModulePlaceholderPage({ title }: { title: string }): React.ReactNode {
  return <Result status="info" title={title} subTitle="模块建设中（随后续迭代卡交付）。" />;
}
