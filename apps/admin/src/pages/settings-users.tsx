/**
 * 用户管理页（modules M7 页面地图 /settings/users/:id?，admin 专属 users.manage）。
 * - 列表：游标分页（API-DSN-03）+ 角色/状态/关键词筛选；
 * - 编辑抽屉：显示名/状态、角色（单角色）、楼宇授权（UUID 标签输入——楼宇选择器随
 *   IMPL-11 资产 API 落地后替换）、一次性重置令牌（仅本次展示，SEC-PW-05）。
 */
import {
  Alert,
  Button,
  Drawer,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { useCallback, useEffect, useState } from 'react';
import {
  CreateUserRequestSchema,
  ResetPasswordResponseSchema,
  UserListItemSchema,
  UserListResponseSchema,
  type ResetPasswordResponse,
  type UserListItem,
  type UserListResponse,
} from '@thermio/shared-types';
import { ApiError, apiFetch } from '../app/api-client.js';

const FALLBACK_LIST: UserListResponse = { items: [], next_cursor: null };

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? cause.parsed.message : fallback;
}

export function SettingsUsersPage(): React.ReactNode {
  const [data, setData] = useState<UserListResponse>(FALLBACK_LIST);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [roleFilter, setRoleFilter] = useState<string | undefined>(undefined);

  const [editing, setEditing] = useState<UserListItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [resetToken, setResetToken] = useState<ResetPasswordResponse | null>(null);
  const [createForm] = Form.useForm();
  const [editForm] = Form.useForm();

  const load = useCallback(
    async (nextCursor: string | null, replace: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ limit: '50' });
        if (nextCursor !== null) params.set('cursor', nextCursor);
        if (roleFilter !== undefined) params.set('role', roleFilter);
        if (keyword.trim().length > 0) params.set('keyword', keyword.trim());
        const result = await apiFetch<UserListResponse>(
          `/users?${params.toString()}`,
          UserListResponseSchema,
        );
        setData((previous) => ({
          items: replace ? result.items : [...previous.items, ...result.items],
          next_cursor: result.next_cursor,
        }));
      } catch (cause) {
        setError(errorText(cause, '用户列表加载失败'));
      } finally {
        setLoading(false);
      }
    },
    [keyword, roleFilter],
  );

  useEffect(() => {
    void load(null, true);
  }, [load]);

  async function submitCreate(values: {
    email: string;
    display_name: string;
    password: string;
    role: 'admin' | 'operator' | 'viewer';
    building_ids_raw: string;
  }): Promise<void> {
    const parsed = CreateUserRequestSchema.safeParse({
      email: values.email,
      display_name: values.display_name,
      password: values.password,
      role: values.role,
      building_ids: values.building_ids_raw.split(/[\s,]+/).filter((id: string) => id.length > 0),
    });
    if (!parsed.success) {
      void message.error('表单不符合契约（密码策略/邮箱格式）');
      return;
    }
    try {
      await apiFetch('/users', UserListItemSchema, {
        method: 'POST',
        body: parsed.data,
      });
      void message.success('用户已创建（初始密码首登强制轮换）');
      setCreating(false);
      createForm.resetFields();
      void load(null, true);
    } catch (cause) {
      void message.error(errorText(cause, '创建失败'));
    }
  }

  async function submitEdit(
    user: UserListItem,
    values: {
      display_name: string;
      status: 'active' | 'disabled';
      role: string;
      building_ids_raw: string;
    },
  ): Promise<void> {
    try {
      const ack = { safeParse: (input: unknown) => ({ success: true as const, data: input }) };
      await apiFetch(`/users/${user.id}`, ack, {
        method: 'PATCH',
        body: { display_name: values.display_name, status: values.status },
      });
      if (values.role !== user.role) {
        await apiFetch(`/users/${user.id}/roles`, ack, {
          method: 'PUT',
          body: { role: values.role },
        });
      }
      await apiFetch(`/users/${user.id}/building-scopes`, ack, {
        method: 'PUT',
        body: {
          building_ids: values.building_ids_raw
            .split(/[\s,]+/)
            .filter((id: string) => id.length > 0),
        },
      });
      void message.success('已保存');
      setEditing(null);
      void load(null, true);
    } catch (cause) {
      void message.error(errorText(cause, '保存失败'));
    }
  }

  async function issueReset(user: UserListItem): Promise<void> {
    try {
      const issued = await apiFetch<ResetPasswordResponse>(
        `/users/${user.id}/reset-password`,
        ResetPasswordResponseSchema,
        { method: 'POST' },
      );
      setResetToken(issued);
    } catch (cause) {
      void message.error(errorText(cause, '重置令牌签发失败'));
    }
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space wrap>
        <Input.Search
          placeholder="按邮箱/显示名搜索"
          allowClear
          onSearch={(value) => {
            setKeyword(value);
          }}
          style={{ width: 260 }}
        />
        <Select<string | undefined>
          allowClear
          placeholder="角色筛选"
          style={{ width: 140 }}
          options={[
            { value: 'admin', label: 'admin' },
            { value: 'operator', label: 'operator' },
            { value: 'viewer', label: 'viewer' },
          ]}
          onChange={(value: string | undefined) => {
            setRoleFilter(value);
          }}
        />
        <Button
          type="primary"
          onClick={() => {
            setCreating(true);
          }}
        >
          新建用户
        </Button>
      </Space>
      {error !== null && <Alert type="error" message={error} showIcon />}
      <Table<UserListItem>
        rowKey="id"
        loading={loading}
        dataSource={data.items}
        pagination={false}
        columns={[
          { title: '邮箱', dataIndex: 'email', key: 'email' },
          { title: '显示名', dataIndex: 'display_name', key: 'display_name' },
          { title: '角色', dataIndex: 'role', key: 'role', width: 100 },
          {
            title: '状态',
            dataIndex: 'status',
            key: 'status',
            width: 100,
            render: (status: string) =>
              status === 'active' ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>,
          },
          {
            title: '首登轮换',
            dataIndex: 'must_change_password',
            key: 'must_change_password',
            width: 100,
            render: (pending: boolean) => (pending ? <Tag color="orange">待轮换</Tag> : '—'),
          },
          {
            title: '操作',
            key: 'actions',
            width: 180,
            render: (_unknown, user) => (
              <Space>
                <Button
                  size="small"
                  onClick={() => {
                    setEditing(user);
                    editForm.setFieldsValue({
                      display_name: user.display_name,
                      status: user.status,
                      role: user.role,
                    });
                  }}
                >
                  编辑
                </Button>
                <Button size="small" onClick={() => void issueReset(user)}>
                  重置密码
                </Button>
              </Space>
            ),
          },
        ]}
      />
      {data.next_cursor !== null && (
        <Button
          onClick={() => {
            void load(data.next_cursor, false);
          }}
          loading={loading}
        >
          加载更多
        </Button>
      )}

      <Modal
        title="新建用户"
        open={creating}
        onCancel={() => {
          setCreating(false);
        }}
        footer={null}
      >
        <Form
          form={createForm}
          layout="vertical"
          onFinish={(values: Parameters<typeof submitCreate>[0]) => void submitCreate(values)}
        >
          <Form.Item name="email" label="邮箱" rules={[{ required: true }, { type: 'email' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="display_name" label="显示名" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item
            name="password"
            label="初始密码（首登强制轮换，SEC-PW-03）"
            rules={[{ required: true }]}
            extra="长度至少 8 位且含字母与数字"
          >
            <Input.Password />
          </Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true }]} initialValue="viewer">
            <Select
              options={[
                { value: 'admin', label: 'admin' },
                { value: 'operator', label: 'operator' },
                { value: 'viewer', label: 'viewer' },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="building_ids_raw"
            label="楼宇授权（UUID，逗号/空格分隔；operator/viewer 必填非空）"
            initialValue=""
          >
            <Input.TextArea rows={2} placeholder="0b7285a0-…, 1c8395b1-…" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            创建
          </Button>
        </Form>
      </Modal>

      <Drawer
        title={`编辑用户 · ${editing?.email ?? ''}`}
        open={editing !== null}
        onClose={() => {
          setEditing(null);
        }}
        width={480}
        footer={null}
      >
        {editing !== null && (
          <Form
            form={editForm}
            layout="vertical"
            onFinish={(values: Parameters<typeof submitEdit>[1]) =>
              void submitEdit(editing, values)
            }
          >
            <Form.Item name="display_name" label="显示名" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item name="status" label="状态" rules={[{ required: true }]}>
              <Select
                options={[
                  { value: 'active', label: '启用' },
                  { value: 'disabled', label: '停用' },
                ]}
              />
            </Form.Item>
            <Form.Item name="role" label="角色（单角色 MVP）" rules={[{ required: true }]}>
              <Select
                options={[
                  { value: 'admin', label: 'admin' },
                  { value: 'operator', label: 'operator' },
                  { value: 'viewer', label: 'viewer' },
                ]}
              />
            </Form.Item>
            <Form.Item
              name="building_ids_raw"
              label="楼宇授权（UUID，逗号/空格分隔；admin 可空 = 隐式全楼宇）"
              initialValue=""
            >
              <Input.TextArea rows={2} placeholder="0b7285a0-…, 1c8395b1-…" />
            </Form.Item>
            <Button type="primary" htmlType="submit" block>
              保存
            </Button>
          </Form>
        )}
      </Drawer>

      <Modal
        title="一次性重置令牌（SEC-PW-05：仅本次展示，15 分钟内有效）"
        open={resetToken !== null}
        onCancel={() => {
          setResetToken(null);
        }}
        footer={[
          <Button
            key="close"
            type="primary"
            onClick={() => {
              setResetToken(null);
            }}
          >
            我已转交
          </Button>,
        ]}
      >
        {resetToken !== null && (
          <Typography.Paragraph copyable={{ text: resetToken.reset_token }}>
            {resetToken.reset_token}
          </Typography.Paragraph>
        )}
        <Typography.Text type="secondary">
          令牌不落日志不回显列表；请经安全渠道转交本人，由其在登录页完成密码重置。
        </Typography.Text>
      </Modal>
    </Space>
  );
}
