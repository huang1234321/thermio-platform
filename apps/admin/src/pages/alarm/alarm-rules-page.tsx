/**
 * 告警规则页 /alarm-rules（M4-alarm.md §7 行 3）：规则表格 + 编辑表单
 * （rule_type 定 scope（组合矩阵 §4.1）/severity/sustained_s/params 动态表单/启停开关）；
 * 删除确认按钮不用危险色（§4.2 白名单：危险色仅 apply/凭证轮换；DAT-157 修单）；
 * 游标分页「加载更多 + 已加载计数」（§3.1）；创建时间相对显示（§2.2）。
 * 能力 alarm_rules.write（admin）。
 */
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Typography,
  message,
} from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ALARM_RULE_TYPES,
  ALARM_SEVERITIES,
  ALARM_SUSTAINED_S_DEFAULT,
  AlarmRuleListResponseSchema,
  type AlarmRule,
  type AlarmRuleType,
  type AlarmSeverity,
} from '@thermio/shared-types';
import { AlarmRuleSchema } from '@thermio/shared-types';
import { apiFetch } from '../../app/api-client.js';
import { errorText } from '../asset/asset-shared.js';
import { RelativeTime } from '../relative-time.js';
import { SeverityTag, useHasCapability } from './alarm-shared.js';
import { noContent } from './alarm-actions.js';

/** rule_type × scope 组合矩阵（§4.1 表；scope 由 rule_type 推导，不可选错）。 */
const RULE_SCOPE: Record<AlarmRuleType, 'point' | 'equipment' | 'system' | 'gateway'> = {
  point_stale: 'point',
  gateway_offline: 'gateway',
  fdd_finding: 'equipment',
};

const RULE_TYPE_LABEL: Record<AlarmRuleType, string> = {
  point_stale: '点位数据失效（stale）',
  gateway_offline: '网关离线',
  fdd_finding: 'FDD 发现（IMPL-16 接入）',
};

interface RuleFormValues {
  rule_type: AlarmRuleType;
  scope_id: string;
  severity: AlarmSeverity;
  sustained_s: number;
  enabled: boolean;
  recovery_s?: number;
  min_severity?: AlarmSeverity;
}

export function AlarmRulesPage(): React.ReactNode {
  const canWrite = useHasCapability('alarm_rules.write');
  const [items, setItems] = useState<readonly AlarmRule[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<AlarmRule | null>(null);
  const [form] = Form.useForm<RuleFormValues>();

  const load = useCallback(async (nextCursor?: string): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (nextCursor !== undefined && nextCursor.length > 0) params.set('cursor', nextCursor);
      const result = await apiFetch(
        `/alarm-rules?${params.toString()}`,
        AlarmRuleListResponseSchema,
      );
      setItems((prev) => (nextCursor === undefined ? result.items : [...prev, ...result.items]));
      setTotal((prev) =>
        nextCursor === undefined ? result.items.length : (prev ?? 0) + result.items.length,
      );
      setCursor(result.next_cursor);
    } catch (cause) {
      setError(errorText(cause, '规则列表加载失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openEditor = useCallback(
    (rule: AlarmRule | null): void => {
      setEditing(rule);
      const ruleType = rule?.rule_type ?? 'gateway_offline';
      const initial: Partial<Record<keyof RuleFormValues, unknown>> = {
        rule_type: ruleType,
        scope_id: rule?.scope_id ?? '',
        severity: rule?.severity ?? 'major',
        sustained_s: rule?.sustained_s ?? ALARM_SUSTAINED_S_DEFAULT.major,
        enabled: rule?.enabled ?? true,
      };
      if (rule !== null && typeof rule.params['recovery_s'] === 'number') {
        initial['recovery_s'] = rule.params['recovery_s'];
      }
      if (rule?.rule_type === 'fdd_finding' && rule.params['min_severity'] !== undefined) {
        initial['min_severity'] = rule.params['min_severity'];
      }
      form.setFieldsValue(initial as Parameters<typeof form.setFieldsValue>[0]);
      setEditorOpen(true);
    },
    [form],
  );

  const ruleType = Form.useWatch('rule_type', form);

  const submit = useCallback(async (): Promise<void> => {
    const values = await form.validateFields();
    const isFdd = values.rule_type === 'fdd_finding';
    const params: Record<string, unknown> = isFdd
      ? values.min_severity !== undefined
        ? { min_severity: values.min_severity }
        : {}
      : values.recovery_s !== undefined
        ? { recovery_s: values.recovery_s }
        : {};
    const isPointScope = RULE_SCOPE[values.rule_type] === 'point';
    const body =
      editing === null
        ? {
            scope: RULE_SCOPE[values.rule_type],
            scope_id: isPointScope ? Number(values.scope_id) : values.scope_id,
            rule_type: values.rule_type,
            params,
            severity: values.severity,
            sustained_s: values.sustained_s,
            enabled: values.enabled,
          }
        : {
            params,
            severity: values.severity,
            sustained_s: values.sustained_s,
            enabled: values.enabled,
          };
    try {
      if (editing === null) {
        await apiFetch('/alarm-rules', noContent, { method: 'POST', body });
      } else {
        await apiFetch(`/alarm-rules/${editing.id}`, AlarmRuleSchema, { method: 'PATCH', body });
      }
      void message.success(editing === null ? '规则已创建' : '规则已更新');
      setEditorOpen(false);
      await load();
    } catch (cause) {
      void message.error(errorText(cause, editing === null ? '创建失败' : '更新失败'));
    }
  }, [editing, form, load]);

  const columns = useMemo(
    () => [
      {
        title: '规则类型',
        dataIndex: 'rule_type',
        render: (value: AlarmRuleType) => RULE_TYPE_LABEL[value],
      },
      { title: '作用域', render: (_: unknown, row: AlarmRule) => `${row.scope} · ${row.scope_id}` },
      {
        title: '严重度',
        dataIndex: 'severity',
        width: 96,
        render: (value: AlarmSeverity) => <SeverityTag severity={value} />,
      },
      { title: '防抖(s)', dataIndex: 'sustained_s', width: 90 },
      {
        title: '参数',
        width: 160,
        render: (_: unknown, row: AlarmRule) => JSON.stringify(row.params),
      },
      {
        title: '启用',
        dataIndex: 'enabled',
        width: 80,
        render: (value: boolean, row: AlarmRule) =>
          canWrite ? (
            <Switch
              size="small"
              checked={value}
              onChange={(checked) =>
                void apiFetch(`/alarm-rules/${row.id}`, AlarmRuleSchema, {
                  method: 'PATCH',
                  body: { enabled: checked },
                })
                  .then(() => load())
                  .catch((cause: unknown) => message.error(errorText(cause, '启停失败')))
              }
            />
          ) : (
            <Typography.Text>{value ? '是' : '否'}</Typography.Text>
          ),
      },
      {
        title: '创建时间',
        dataIndex: 'created_at',
        width: 170,
        render: (value: string) => <RelativeTime iso={value} />,
      },
      {
        title: '操作',
        key: 'actions',
        width: 150,
        render: (_: unknown, row: AlarmRule): React.ReactNode =>
          canWrite && (
            <Space>
              <Button
                size="small"
                onClick={() => {
                  openEditor(row);
                }}
              >
                编辑
              </Button>
              <Popconfirm
                title="删除该规则？"
                description="仍被告警引用的规则无法删除（将提示改用停用）"
                okText="确认删除"
                cancelText="取消"
                onConfirm={() =>
                  void apiFetch(`/alarm-rules/${row.id}`, noContent, { method: 'DELETE' })
                    .then(() => {
                      void message.success('规则已删除');
                      return load();
                    })
                    .catch((cause: unknown) =>
                      message.error(errorText(cause, '删除失败（仍被引用时请改用停用）')),
                    )
                }
              >
                <Button size="small">删除</Button>
              </Popconfirm>
            </Space>
          ),
      },
    ],
    [canWrite, load, openEditor],
  );

  return (
    <Card
      title="告警规则"
      extra={
        <Space>
          {total !== null && (
            <Typography.Text type="secondary">已加载 {String(items.length)} 条</Typography.Text>
          )}
          {canWrite && (
            <Button
              type="primary"
              onClick={() => {
                openEditor(null);
              }}
            >
              新建规则
            </Button>
          )}
        </Space>
      }
    >
      {error !== null && (
        <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />
      )}
      <Table<AlarmRule>
        size="small"
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={[...items]}
        pagination={false}
      />
      {cursor !== null && (
        <Button
          block
          style={{ marginTop: 12 }}
          onClick={() => {
            void load(cursor);
          }}
          loading={loading}
        >
          加载更多
        </Button>
      )}
      <Modal
        title={editing === null ? '新建规则' : '编辑规则（scope/type 不可变，重定向 = 新建）'}
        open={editorOpen}
        onCancel={() => {
          setEditorOpen(false);
        }}
        onOk={() => void submit()}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="rule_type" label="规则类型" rules={[{ required: true }]}>
            <Select
              disabled={editing !== null}
              options={ALARM_RULE_TYPES.map((value) => ({ value, label: RULE_TYPE_LABEL[value] }))}
            />
          </Form.Item>
          <Form.Item
            name="scope_id"
            label={
              ruleType === 'point_stale'
                ? '点位 ID（整数）'
                : ruleType === 'gateway_offline'
                  ? '网关 ID（uuid）'
                  : '设备 ID（uuid）'
            }
            rules={[{ required: true, message: '请填写目标 ID' }]}
          >
            <Input
              disabled={editing !== null}
              placeholder={ruleType === 'point_stale' ? '如 42' : 'uuid'}
            />
          </Form.Item>
          <Space size="large">
            <Form.Item name="severity" label="严重度" rules={[{ required: true }]}>
              <Select
                style={{ width: 140 }}
                options={ALARM_SEVERITIES.map((value) => ({ value, label: value }))}
              />
            </Form.Item>
            <Form.Item
              name="sustained_s"
              label="防抖持续秒数"
              rules={[{ required: true }]}
              extra="0..86400；缺省按严重度分级"
            >
              <InputNumber min={0} max={86400} style={{ width: 140 }} />
            </Form.Item>
          </Space>
          {ruleType !== 'fdd_finding' && (
            <Form.Item name="recovery_s" label="回稳持续秒数（recovery_s，可选 0..86400）">
              <InputNumber min={0} max={86400} style={{ width: 200 }} />
            </Form.Item>
          )}
          {ruleType === 'fdd_finding' && (
            <Form.Item name="min_severity" label="触发门槛 min_severity（可选）">
              <Select
                allowClear
                style={{ width: 200 }}
                options={ALARM_SEVERITIES.map((value) => ({ value, label: value }))}
              />
            </Form.Item>
          )}
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
