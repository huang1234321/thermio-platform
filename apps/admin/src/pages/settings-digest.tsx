/**
 * /settings/digest FDD 周报订阅（M11-kpi-dashboard §7.3；IMPL-22 / DAT-246；
 * prototype v3 SettingsDigest 对齐实现；admin 守卫 403 = 路由层 digest.manage）。
 *
 * 订阅配置卡（楼宇选择 + 启用开关 + 周期说明 + 收件人列表行内编辑 ≤20 + 保存 PUT
 * 全量替换）+ 投递记录卡（期次/楼宇/报告链接/收件数/状态徽标/失败原因/投递时间；
 * skipped 显「该期报告未生成」）。
 */
import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  App as AntdApp,
} from 'antd';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { FDD_DIGEST_RECIPIENTS_MAX, type FddDigestDeliveryItem } from '@thermio/shared-types';
import { useAuth } from '../app/auth-context.js';
import { errorText } from './asset/asset-shared.js';
import { formatAbsolute } from './relative-time.js';
import { fetchFddDigest, fetchFddDigestDeliveries, putFddDigest } from './kpi/kpi-data.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const DELIVERY_STATUS: Record<FddDigestDeliveryItem['status'], { color: string; label: string }> = {
  sent: { color: 'green', label: 'sent · 已投递' },
  failed: { color: 'red', label: 'failed · 失败' },
  skipped: { color: 'default', label: 'skipped · 跳过' },
  queued: { color: 'blue', label: 'queued · 排队中' },
};

interface RecipientDraft {
  email: string;
  note: string | undefined;
}

export function SettingsDigestPage(): ReactNode {
  const { state } = useAuth();
  const { message } = AntdApp.useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const [recipients, setRecipients] = useState<readonly RecipientDraft[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<readonly FddDigestDeliveryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);

  const buildings =
    state.phase === 'authenticated' || state.phase === 'must-change-password'
      ? state.me.building_scopes
      : [];
  const buildingId = searchParams.get('building_id') ?? buildings[0]?.id;

  const load = useCallback(async (targetBuilding: string | undefined): Promise<void> => {
    if (targetBuilding === undefined) return;
    setLoading(true);
    setError(null);
    try {
      const [config, deliveryPage] = await Promise.all([
        fetchFddDigest(targetBuilding),
        fetchFddDigestDeliveries({ building_id: targetBuilding }),
      ]);
      setEnabled(config.enabled);
      setRecipients(config.recipients.map((r) => ({ email: r.email, note: r.note })));
      setConfigured(config.updated_at !== null);
      setUpdatedAt(config.updated_at);
      setDeliveries(deliveryPage.items);
      setCursor(deliveryPage.next_cursor);
    } catch (cause) {
      setError(errorText(cause, '订阅配置加载失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(buildingId);
  }, [buildingId, load]);

  const save = async (): Promise<void> => {
    if (buildingId === undefined) return;
    const badIndex = recipients.findIndex((r) => !EMAIL_RE.test(r.email));
    if (recipients.length === 0 || badIndex >= 0) {
      message.error(
        badIndex >= 0
          ? `第 ${String(badIndex + 1)} 项收件人邮箱格式非法（422 digest.recipient_invalid · details 序号）`
          : '收件人列表为空',
      );
      return;
    }
    setSaving(true);
    try {
      const config = await putFddDigest(buildingId, {
        enabled,
        recipients: recipients.map((r) => ({ email: r.email.trim(), note: r.note })),
      });
      setEnabled(config.enabled);
      setRecipients(config.recipients.map((r) => ({ email: r.email, note: r.note })));
      setConfigured(config.updated_at !== null);
      setUpdatedAt(config.updated_at);
      message.success('订阅已保存（PUT /fdd/digest 全量替换幂等）');
    } catch (cause) {
      message.error(errorText(cause, '保存失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title="FDD 周报订阅"
        extra={
          <Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              启用
            </Typography.Text>
            <Switch checked={enabled} onChange={setEnabled} />
          </Space>
        }
      >
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          设置区 · admin 专属（digest.manage）· 每周一 08:00 投递上一自然周 FDD
          周报（Asia/Shanghai）
        </Typography.Text>
        <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', marginTop: 14 }}>
          <div style={{ minWidth: 280, flex: 1 }}>
            <div style={{ fontSize: 12, color: 'var(--ant-color-text-tertiary)', marginBottom: 6 }}>
              楼宇（一楼一份订阅，UNIQUE tenant+building）
            </div>
            <Select
              style={{ width: '100%' }}
              value={buildingId}
              options={buildings.map((b) => ({ value: b.id, label: b.name }))}
              onChange={(value) => {
                setSearchParams((prev) => {
                  const next = new URLSearchParams(prev);
                  if (value !== undefined) next.set('building_id', value);
                  return next;
                });
              }}
            />
            <div
              style={{
                fontSize: 12,
                color: 'var(--ant-color-text-tertiary)',
                margin: '14px 0 6px',
              }}
            >
              投递周期（v1 仅周投递）
            </div>
            <Select
              style={{ width: '100%' }}
              disabled
              value="monday_08:00"
              options={[
                { value: 'monday_08:00', label: '每周一 08:00（Asia/Shanghai）· 上一自然周报告' },
              ]}
            />
            <div style={{ fontSize: 11, color: 'var(--ant-color-text-tertiary)', marginTop: 10 }}>
              {updatedAt !== null ? `上次更新：${formatAbsolute(updatedAt)}` : '尚未配置'}
              （updated_by 留痕 + 结构化日志）
            </div>
          </div>
          <div style={{ minWidth: 320, flex: 1.4 }}>
            <div style={{ fontSize: 12, color: 'var(--ant-color-text-tertiary)', marginBottom: 6 }}>
              收件人列表（邮箱 + 备注，≤{String(FDD_DIGEST_RECIPIENTS_MAX)}——超限 422
              digest.recipient_invalid）
            </div>
            {loading ? null : !configured && recipients.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="尚未配置订阅——配置后每周一自动投递 FDD 周报"
                style={{ padding: '12px 0' }}
              >
                <Button
                  type="primary"
                  onClick={() => {
                    setRecipients([{ email: '', note: undefined }]);
                  }}
                >
                  添加收件人
                </Button>
              </Empty>
            ) : (
              recipients.map((r, i) => {
                const bad = r.email.length > 0 && !EMAIL_RE.test(r.email);
                return (
                  <div
                    key={String(i)}
                    style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'flex-start' }}
                  >
                    <Input
                      style={{ flex: 1.6 }}
                      status={bad ? 'error' : ''}
                      placeholder="name@company.cn"
                      value={r.email}
                      onChange={(e) => {
                        setRecipients((rs) =>
                          rs.map((x, j) => (j === i ? { email: e.target.value, note: x.note } : x)),
                        );
                      }}
                    />
                    <Input
                      style={{ flex: 1 }}
                      placeholder="备注（≤50）"
                      value={r.note ?? ''}
                      onChange={(e) => {
                        setRecipients((rs) =>
                          rs.map((x, j) =>
                            j === i ? { email: x.email, note: e.target.value } : x,
                          ),
                        );
                      }}
                    />
                    <Popconfirm
                      title="删除该收件人？"
                      onConfirm={() => {
                        setRecipients((rs) => rs.filter((_, j) => j !== i));
                      }}
                    >
                      <Button danger type="text" />
                    </Popconfirm>
                    {bad && (
                      <Typography.Text type="danger" style={{ fontSize: 11 }}>
                        邮箱格式非法
                      </Typography.Text>
                    )}
                  </div>
                );
              })
            )}
            {recipients.length > 0 && (
              <Button
                block
                type="dashed"
                disabled={recipients.length >= FDD_DIGEST_RECIPIENTS_MAX}
                onClick={() => {
                  setRecipients((rs) => [...rs, { email: '', note: undefined }]);
                }}
              >
                添加收件人
                {recipients.length >= FDD_DIGEST_RECIPIENTS_MAX
                  ? `（已达上限 ${String(FDD_DIGEST_RECIPIENTS_MAX)}）`
                  : `（${String(recipients.length)}/${String(FDD_DIGEST_RECIPIENTS_MAX)}）`}
              </Button>
            )}
          </div>
        </div>
        {error !== null && (
          <Alert type="error" showIcon message={error} style={{ marginTop: 12 }} />
        )}
        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
          <Button type="primary" loading={saving} disabled={!enabled} onClick={() => void save()}>
            保存订阅
          </Button>
        </div>
      </Card>

      <Card title="投递记录" styles={{ body: { padding: 0 } }}>
        <Table<FddDigestDeliveryItem>
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={deliveries.map((d) => ({ ...d }))}
          pagination={false}
          columns={[
            {
              title: '期次（闭开区间）',
              dataIndex: 'period',
              width: 210,
              render: (_v, row): ReactNode => (
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {row.period.start} ~ {row.period.end}
                </span>
              ),
            },
            {
              title: '楼宇',
              width: 140,
              render: (_v, row): ReactNode => row.building.name,
            },
            {
              title: '报告',
              dataIndex: 'report_id',
              width: 110,
              render: (reportId: string | null): ReactNode =>
                reportId === null ? (
                  <Tooltip title="该期报告未生成（no_report）——不伪造空报告">
                    <span style={{ color: 'var(--ant-color-text-quaternary)' }}>—</span>
                  </Tooltip>
                ) : (
                  <Link to={`/fdd/reports/${reportId}`}>{reportId.slice(0, 8)}</Link>
                ),
            },
            {
              title: '收件数',
              dataIndex: 'recipients_count',
              width: 80,
              render: (v: number): ReactNode => (
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{String(v)}</span>
              ),
            },
            {
              title: '状态',
              dataIndex: 'status',
              width: 140,
              render: (status: FddDigestDeliveryItem['status']): ReactNode => (
                <Tag
                  color={DELIVERY_STATUS[status].color}
                  style={{ marginInlineEnd: 0, fontSize: 11 }}
                >
                  {DELIVERY_STATUS[status].label}
                </Tag>
              ),
            },
            {
              title: '失败/跳过原因',
              key: 'reason',
              render: (_v, row): ReactNode =>
                row.failure_msg !== null ? (
                  row.failure_msg
                ) : row.skip_reason !== null ? (
                  '该期报告未生成'
                ) : (
                  <span style={{ color: 'var(--ant-color-text-quaternary)' }}>—</span>
                ),
            },
            {
              title: '投递时间',
              dataIndex: 'delivered_at',
              width: 160,
              render: (v: string | null): ReactNode => (v === null ? '—' : formatAbsolute(v)),
            },
          ]}
        />
        {cursor !== null && (
          <Button
            block
            style={{ margin: '8px 0' }}
            loading={loading}
            onClick={() => {
              if (buildingId === undefined) return;
              void fetchFddDigestDeliveries({ building_id: buildingId, cursor }).then((page) => {
                setDeliveries((prev) => [...prev, ...page.items]);
                setCursor(page.next_cursor);
              });
            }}
          >
            加载更多
          </Button>
        )}
        <div
          style={{
            fontSize: 11,
            color: 'var(--ant-color-text-tertiary)',
            padding: '10px 16px 14px',
          }}
        >
          同订阅同期 UNIQUE（重投走状态机不插新行）· 埋点 fdd_digest_delivered ·
          失败不影响报告本体（PRD 卡 R6）
        </div>
      </Card>
    </Space>
  );
}
