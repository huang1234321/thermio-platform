/**
 * M11 FDD 周报导出扩展（M11-kpi-dashboard §7.2；IMPL-22 / DAT-246；
 * prototype v3 FddReport 导出态对齐实现）。
 *
 * - 「导出 PDF」按钮仅 fdd.export 渲染（viewer 无按钮——PRD §4.2 出域口径，
 *   SEC-AZ-05）→ 202 后按钮转任务态徽标（执行中 → 完成 toast + 下载 / 失败块带
 *   原因 + 重新导出）；
 * - 「导出记录」抽屉：本人任务列表（§5.6 端点族）——任务不依赖会话存活，回来
 *   经抽屉查看；
 * - 取数时机（DAT-250 O4）：挂载期零请求——挂载即取 latest 属不必要请求；任务态
 *   仅会话内自建任务可见（202 后刷新），跨会话回看走抽屉（打开时取数）；
 * - 完成通知 = 会话内 toast（不引入消息中心，§7.2 收窄交付）；
 * - 过期判定 = expires_at（载体无独立 expired 态，M9 §1.7）。
 */
import {
  Alert,
  Button,
  Drawer,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  App as AntdApp,
} from 'antd';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { MvExportJob } from '@thermio/shared-types';
import { useCapabilities } from '../../app/auth-context.js';
import { errorText } from '../asset/asset-shared.js';
import { formatAbsolute } from '../relative-time.js';
import { fddExportDownloadHref, exportFddReport, fetchFddExportJobs } from '../kpi/kpi-data.js';

const STATUS_META: Record<MvExportJob['status'], { color: string; label: string }> = {
  queued: { color: 'default', label: '排队中' },
  running: { color: 'processing', label: '渲染中' },
  succeeded: { color: 'success', label: '已完成' },
  failed: { color: 'error', label: '失败' },
};

/** 报告详情页头导出动作区（导出按钮 + 任务态横幅 + 记录抽屉）。 */
export function FddExportPanel({ reportId }: { reportId: string }): ReactNode {
  const capabilities = useCapabilities();
  const { message } = AntdApp.useApp();
  const canExport = capabilities.includes('fdd.export');
  const [latest, setLatest] = useState<MvExportJob | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 挂载期零取数（DAT-250 O4）：latest 只随会话内自建任务刷新（202 后拉一次）；
  // 跨会话在飞任务回看走「导出记录」抽屉（打开时取数），不在此预取。

  // 在飞任务轮询（queued/running → 完成态可见；完成即停，§7.2 任务态徽标）
  useEffect(() => {
    if (latest === null || (latest.status !== 'queued' && latest.status !== 'running')) return;
    pollTimer.current = setTimeout(() => {
      void fetchFddExportJobs({ resource_id: reportId, limit: 1 })
        .then((page) => {
          const next = page.items[0] ?? null;
          setLatest(next);
          if (next?.status === 'succeeded') {
            message.success('导出完成：302 签名 URL 可下载（保留 30 天）');
          }
        })
        .catch(() => undefined);
    }, 2_000);
    pollTimer.current.unref();
    return () => {
      if (pollTimer.current !== null) clearTimeout(pollTimer.current);
    };
  }, [latest, reportId, message]);

  const requestExport = useCallback(async (): Promise<void> => {
    setRequesting(true);
    try {
      const created = await exportFddReport(reportId);
      message.success(`导出任务已创建（${created.export_job_id.slice(0, 8)}），渲染完成后可下载`);
      const page = await fetchFddExportJobs({ resource_id: reportId, limit: 1 });
      setLatest(page.items[0] ?? null);
    } catch (cause) {
      message.error(errorText(cause, '导出发起失败'));
    } finally {
      setRequesting(false);
    }
  }, [reportId, message]);

  if (!canExport) return null; // viewer 无导出面（按钮不渲染，SEC-AZ-05）

  const expired =
    latest?.status === 'succeeded' &&
    latest.expires_at !== null &&
    Date.parse(latest.expires_at) < Date.now();

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Space wrap>
        <Button
          type="primary"
          loading={requesting || latest?.status === 'queued' || latest?.status === 'running'}
          onClick={() => void requestExport()}
        >
          {latest?.status === 'queued' || latest?.status === 'running' ? '导出中…' : '导出 PDF'}
        </Button>
        {latest?.status === 'succeeded' && !expired && (
          <Button href={fddExportDownloadHref(latest.id)} target="_blank">
            下载（302 签名 URL，60 min 窗）
          </Button>
        )}
        <Button
          onClick={() => {
            setDrawerOpen(true);
          }}
        >
          导出记录
        </Button>
      </Space>
      {latest?.status === 'failed' && (
        <Alert
          type="error"
          showIcon
          message={
            <Space size={8} wrap>
              <span>
                导出失败 · {latest.failure?.stage ?? 'render'} ·{' '}
                {latest.failure?.message ?? '渲染异常'}
              </span>
              <Button size="small" onClick={() => void requestExport()}>
                重新导出（新任务行）
              </Button>
            </Space>
          }
        />
      )}
      {expired && (
        <Alert
          type="warning"
          showIcon
          message={
            <Space size={8} wrap>
              <span>
                最近一次导出件已过保留期（expires_at 判定，下载 409 mv.export_file_expired）
              </span>
              <Button size="small" onClick={() => void requestExport()}>
                重新导出
              </Button>
            </Space>
          }
        />
      )}
      <ExportJobsDrawer
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
        }}
      />
    </Space>
  );
}

/** 导出记录抽屉（本人任务，GET /kpi/export-jobs；可离开页面，回来再查）。 */
function ExportJobsDrawer({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  const [items, setItems] = useState<readonly MvExportJob[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (nextCursor?: string): Promise<void> => {
    setLoading(true);
    try {
      const page = await fetchFddExportJobs({
        ...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
      });
      setItems((prev) => (nextCursor === undefined ? page.items : [...prev, ...page.items]));
      setCursor(page.next_cursor);
    } catch {
      // 抽屉加载失败静默（下次打开重试）
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && items.length === 0) {
      void load();
    }
  }, [open, items.length, load]);

  return (
    <Drawer
      title="导出记录（本人任务 · GET /kpi/export-jobs，resource_type=fdd_report）"
      width={560}
      open={open}
      onClose={onClose}
    >
      <Table<MvExportJob>
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={items.map((j) => ({ ...j }))}
        pagination={false}
        columns={[
          {
            title: '状态',
            dataIndex: 'status',
            width: 90,
            render: (status: MvExportJob['status']): ReactNode => (
              <Tag color={STATUS_META[status].color} style={{ marginInlineEnd: 0 }}>
                {STATUS_META[status].label}
              </Tag>
            ),
          },
          {
            title: '发起时间',
            dataIndex: 'created_at',
            width: 150,
            render: (v: string): ReactNode => (
              <span style={{ fontSize: 12 }}>{formatAbsolute(v)}</span>
            ),
          },
          {
            title: '大小',
            dataIndex: 'file_bytes',
            width: 80,
            render: (v: number | null): ReactNode =>
              v === null ? '—' : `${String(Math.round(v / 1024))} KB`,
          },
          {
            title: '操作',
            key: 'actions',
            render: (_v, row: MvExportJob): ReactNode => {
              const expired =
                row.status === 'succeeded' &&
                row.expires_at !== null &&
                Date.parse(row.expires_at) < Date.now();
              if (row.status === 'succeeded' && !expired) {
                return (
                  <Space size={8}>
                    <Button size="small" href={fddExportDownloadHref(row.id)} target="_blank">
                      下载
                    </Button>
                    <Tooltip
                      title={`保留至 ${row.expires_at !== null ? formatAbsolute(row.expires_at) : '—'}（30 天）`}
                    >
                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                        时效
                      </Typography.Text>
                    </Tooltip>
                  </Space>
                );
              }
              if (row.status === 'failed') {
                return (
                  <Tooltip title="重新导出 = 新任务行（POST 再发起，不复活旧行）">
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      {row.failure?.stage ?? 'render'} 失败
                    </Typography.Text>
                  </Tooltip>
                );
              }
              return (
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {row.status === 'succeeded' ? '已过保留期' : '处理中…'}
                </Typography.Text>
              );
            },
          },
        ]}
      />
      {cursor !== null && (
        <Button block style={{ marginTop: 12 }} loading={loading} onClick={() => void load(cursor)}>
          加载更多
        </Button>
      )}
      <div
        style={{
          fontSize: 11,
          color: 'var(--ant-color-text-tertiary)',
          marginTop: 12,
          lineHeight: 1.8,
        }}
      >
        载体 = M9 export_job（resource_type=fdd_report，PRD §6.3 共用承载）· 任务只看本人（admin
        亦然，§5.6）
        <br />
        导出件保留 30 天（下载 → 409 mv.export_file_expired）· PDF 三要素与页面一致（AC-9）
      </div>
    </Drawer>
  );
}
