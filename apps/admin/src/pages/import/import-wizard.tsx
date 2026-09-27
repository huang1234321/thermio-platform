/**
 * 导入向导（M2-import §10.1/§10.2；ui/baseline §3.4 五步规范，原型向导屏）。
 *
 * - /imports/new 与 /imports/:id 共用本组件：作业 id 驱动恢复（§10.2 状态→步骤映射，
 *   刷新/续入可恢复）；离开未完成的作业停在服务端状态，可从历史续入；
 * - 客户端 1.5s 轮询作业详情驱动异步段推进（§3.3 口径：状态跳变 + 摘要字段，
 *   不依赖进行中子态 §4.3）；
 * - 步骤 5 执行步纪律（flows §1）：dry-run 阻塞项清零前 apply disabled + 阻塞计数；
 *   apply 二次确认（登记 N 点 + 推送说明 + 幂等说明行，baseline §4.2）；
 * - apply 后行不可改（ddl §9.1）：未命中点修正入口按 §9.4 分流（语义类跳 M1
 *   点位语义编辑、物理类跳点位详情物理层卡，R8/补强 B）。
 */
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Progress,
  Select,
  Space,
  Steps,
  Table,
  Typography,
  Upload,
  message,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { UploadFile } from 'antd';
import {
  DryRunReportSchema,
  ImportJobSchema,
  ImportRowListResponseSchema,
  ImportRowSchema,
  QUANTITY_TYPES,
  SelfCheckReportSchema,
  type DryRunReport,
  type Equipment,
  type Gateway,
  type ImportJob,
  type ImportRow,
  type SelfCheckReport,
} from '@thermio/shared-types';
import {
  BuildingListResponseSchema,
  EquipmentListResponseSchema,
  GatewayListResponseSchema,
  SystemListResponseSchema,
  type Building,
} from '@thermio/shared-types';
import { apiFetch, apiUpload } from '../../app/api-client.js';
import { errorText, useHasCapability } from '../asset/asset-shared.js';
import { JobStatusTag, conversionLabel, excelRow, usePolling } from './import-shared.js';

const WIZARD_STEPS = ['上传', '解析预览', '语义映射', '单位换算确认', '执行与自检'] as const;

/** /imports/:jobId 续入入口（§10.2：作业 id 驱动恢复，刷新/续入可恢复）。 */
export function ImportWizardResumePage(): React.ReactNode {
  const { jobId } = useParams<{ jobId: string }>();
  return <ImportWizardPage jobId={jobId} />;
}

/** §10.2 状态 → 恢复步骤。 */
function stepForStatus(job: ImportJob | null): number {
  if (job === null) return 0;
  switch (job.status) {
    case 'parsed':
      return 1;
    case 'mapping':
      return 2;
    case 'validated':
      return 4;
    case 'applied':
    case 'checked':
      return 4;
    case 'failed':
      return job.failure?.stage === 'parse' ? 0 : 4;
  }
}

export function ImportWizardPage({ jobId }: { jobId?: string | undefined }): React.ReactNode {
  const canWrite = useHasCapability('imports.write');
  const navigate = useNavigate();
  const [job, setJob] = useState<ImportJob | null>(null);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // 步骤 1 状态
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [gateways, setGateways] = useState<Gateway[]>([]);
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [form] = Form.useForm<{ building_id: string; gateway_id: string }>();

  // 步骤 2–4 状态
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [autoRunning, setAutoRunning] = useState(false);
  const [mappingTarget, setMappingTarget] = useState<ImportRow | null>(null);
  const [equipments, setEquipments] = useState<Equipment[]>([]);

  // 步骤 5 状态
  const [dryReport, setDryReport] = useState<DryRunReport | null>(null);
  const [selfReport, setSelfReport] = useState<SelfCheckReport | null>(null);
  /** 自检真实 in-flight 标志（QA 阻塞 #2：loading 绑作业状态会把 applied 休息态锁死按钮）。 */
  const [selfCheckPending, setSelfCheckPending] = useState(false);
  /**
   * pending 的 ref 镜像：轮询回调内**同步** check-and-clear——状态更新在 rerender
   * 前不反映到旧闭包，相邻两轮轮询会以 pending=true 二次触发守卫（连弹两条相同
   * warning，QA 第 3 轮探针发现）；ref 写入即时生效，天然免重入。
   */
  const selfCheckPendingRef = useRef(false);
  /** 自检派发时点的 checked_at 锚（首轮 null；完成信号 = checked_at 前进，checked→checked 重跑同判）。 */
  const selfCheckDispatchedAt = useRef<string | null>(null);
  /** 派发时刻（ms）：卡死守卫——服务端内部失败不产生状态跳变时解除按钮锁（重试安全：单飞幂等）。 */
  const selfCheckDispatchedMs = useRef(0);
  /** 报告已取的 checked_at（防轮询重复拉取）。 */
  const reportLoadedFor = useRef<string | null>(null);

  const loadJob = useCallback(async (id: string): Promise<ImportJob | null> => {
    try {
      const result = await apiFetch(`/imports/${id}`, ImportJobSchema);
      setJob(result);
      return result;
    } catch (cause) {
      setError(errorText(cause, '作业详情加载失败'));
      return null;
    }
  }, []);

  const loadRows = useCallback(async (id: string): Promise<void> => {
    setRowsLoading(true);
    try {
      const result = await apiFetch(`/imports/${id}/rows?limit=200`, ImportRowListResponseSchema);
      setRows(result.items);
    } catch (cause) {
      setError(errorText(cause, '行列表加载失败'));
    } finally {
      setRowsLoading(false);
    }
  }, []);

  /** 装备候选（job.building 内：building → systems → equipments 扁平化）。 */
  const loadEquipments = useCallback(async (buildingId: string): Promise<void> => {
    try {
      const systems = await apiFetch(
        `/buildings/${buildingId}/systems?limit=100`,
        SystemListResponseSchema,
      );
      const all: Equipment[] = [];
      for (const system of systems.items) {
        const list = await apiFetch(
          `/systems/${system.id}/equipments?limit=200`,
          EquipmentListResponseSchema,
        );
        all.push(...list.items);
      }
      setEquipments(all);
    } catch {
      setEquipments([]); // 装备清单非关键路径：加载失败仅意味着 Select 选项少
    }
  }, []);

  // 初始装载：种子下拉 + 续入作业
  useEffect(() => {
    void (async () => {
      try {
        const [buildingList, gatewayList] = await Promise.all([
          apiFetch('/buildings?limit=100', BuildingListResponseSchema),
          apiFetch('/gateways?limit=100', GatewayListResponseSchema),
        ]);
        setBuildings(buildingList.items);
        setGateways(gatewayList.items);
      } catch (cause) {
        setError(errorText(cause, '楼宇/网关清单加载失败'));
      }
    })();
  }, []);

  useEffect(() => {
    if (jobId === undefined) return;
    void (async () => {
      const loaded = await loadJob(jobId);
      if (loaded === null) return;
      setStep(stepForStatus(loaded));
      if (loaded.row_count > 0) await loadRows(jobId);
      await loadEquipments(loaded.building_id);
      if (loaded.status === 'checked' && loaded.checked_at !== null) {
        await loadSelfReport(jobId, loaded.checked_at);
      }
    })();
  }, [jobId, loadJob, loadRows, loadEquipments]);

  // 异步段轮询（§4.3 完成信号：row_count>0 / mapped_count 稳定 / status 跳变）
  const inAsyncPhase =
    job !== null &&
    ((step === 0 && job.status === 'parsed' && job.row_count === 0) ||
      (autoRunning && job.status === 'mapping') ||
      (step === 4 && job.status === 'validated') ||
      (step === 4 && (job.status === 'applied' || job.status === 'checked')));
  usePolling(
    () => {
      if (job === null) return;
      void loadJob(job.id).then((fresh) => {
        if (fresh === null) return;
        if (autoRunning && fresh.mapped_count >= fresh.row_count - countUnmappedSkippable()) {
          setAutoRunning(false);
        }
        if (fresh.row_count > 0 && rows.length === 0 && fresh.status !== 'failed') {
          void loadRows(fresh.id);
        }
        // 自检完成信号（§4.3 状态跳变 + 摘要字段）：checked_at 前进 → 清 pending、拉报告
        // （pending 判定/清零走 ref 镜像：同步 check-and-clear，防相邻轮询在 rerender
        // 前以旧闭包 pending=true 重入——守卫连弹两条相同 warning，QA 第 3 轮探针发现）
        if (fresh.status === 'failed') {
          selfCheckPendingRef.current = false;
          setSelfCheckPending(false);
          return;
        }
        if (fresh.status === 'checked' && fresh.checked_at !== null) {
          if (selfCheckPendingRef.current && fresh.checked_at !== selfCheckDispatchedAt.current) {
            selfCheckPendingRef.current = false;
            setSelfCheckPending(false);
          }
          void loadSelfReport(fresh.id, fresh.checked_at);
          return;
        }
        // 卡死守卫：pending 超 5 min 无状态跳变（服务端统计失败不迁移作业态）→ 解锁可重试
        if (
          selfCheckPendingRef.current &&
          fresh.status === 'applied' &&
          Date.now() - selfCheckDispatchedMs.current > 5 * 60 * 1000
        ) {
          selfCheckPendingRef.current = false; // 先占位防相邻轮次重入，再弹提示
          setSelfCheckPending(false);
          void message.warning(
            '自检长时间未返回，已解除按钮锁——可重试（服务端单飞幂等，不会并发两轮）',
          );
        }
      });
    },
    1500,
    inAsyncPhase,
  );

  function countUnmappedSkippable(): number {
    return rows.filter((r) => r.quantity_type === null).length;
  }

  // ── 步骤 1：上传 ──
  async function submitUpload(): Promise<void> {
    const values = await form.validateFields();
    const file = fileList[0]?.originFileObj;
    if (file === undefined) {
      void message.warning('请选择 .xlsx 点表文件');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const formdata = new FormData();
      formdata.append('file', file);
      formdata.append('building_id', values.building_id);
      formdata.append('gateway_id', values.gateway_id);
      const created = await apiUpload('/imports', formdata, ImportJobSchema);
      void message.success('已受理（202）：解析中…');
      void navigate(`/imports/${created.id}`);
      setJob(created);
      setStep(0); // 等待解析完成信号后进步骤 2
    } catch (cause) {
      setError(errorText(cause, '上传失败'));
    } finally {
      setUploading(false);
    }
  }

  // ── 步骤 3：自动映射 ──
  async function runAutoMapping(): Promise<void> {
    if (job === null) return;
    setAutoRunning(true);
    try {
      await apiFetch(`/imports/${job.id}/mapping/auto`, ImportJobSchema, {
        method: 'POST',
        body: {},
      });
      await loadJob(job.id);
    } catch (cause) {
      setAutoRunning(false);
      setError(errorText(cause, '自动映射受理失败'));
    }
  }

  // ── 步骤 3/4：人工映射/换算修正（PATCH rows）──
  async function patchRow(row: ImportRow, body: Record<string, string | null>): Promise<void> {
    if (job === null) return;
    try {
      const updated = await apiFetch(`/imports/${job.id}/rows/${String(row.id)}`, ImportRowSchema, {
        method: 'PATCH',
        body,
      });
      setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      setMappingTarget(null);
      void loadJob(job.id);
      void message.success(`第 ${String(excelRow(row.row_no))} 行已保存`);
    } catch (cause) {
      void message.error(errorText(cause, '映射保存失败'));
    }
  }

  // ── 步骤 5：dry-run / apply / self-check ──
  async function runDryRun(): Promise<void> {
    if (job === null) return;
    try {
      const report = await apiFetch(`/imports/${job.id}/dry-run`, DryRunReportSchema, {
        method: 'POST',
        body: {},
      });
      setDryReport(report);
      await loadJob(job.id);
      if (report.passed) {
        void message.success('dry-run 通过：阻塞 0，可执行 apply');
      } else {
        void message.warning(`dry-run 存在 ${String(report.blocking_count)} 项阻塞：apply 被拒绝`);
      }
    } catch (cause) {
      void message.error(errorText(cause, 'dry-run 失败'));
    }
  }

  function confirmApply(): void {
    if (job === null || dryReport === null || !dryReport.passed) return;
    const n = job.row_count;
    Modal.confirm({
      title: 'apply 二次确认',
      content: (
        <Space direction="vertical">
          <span>
            将执行：登记 {n} 点（两层字段）→ 生成网关采集配置 → 推送配置（EMQX 下行 retained）
          </span>
          <Typography.Text type="secondary">
            前置：dry-run 通过（阻塞 0）✓ · 幂等：Idempotency-Key 自动携带，重试不重复登记
            （API-DSN-01）· 异步：202 受理，完成后可发起采集自检
          </Typography.Text>
        </Space>
      ),
      okText: '确认 apply',
      okButtonProps: { danger: true },
      onOk: () => {
        void doApply();
      },
    });
  }

  async function doApply(): Promise<void> {
    if (job === null) return;
    try {
      await apiFetch(`/imports/${job.id}/apply`, ImportJobSchema, {
        method: 'POST',
        body: {},
        headers: { 'Idempotency-Key': `admin-${job.id}` },
      });
      void message.success('apply 已受理（202）：登记与推送执行中，轮询作业状态…');
      await loadJob(job.id);
    } catch (cause) {
      void message.error(errorText(cause, 'apply 受理失败'));
    }
  }

  /** 报告拉取（§3.10 GET 实时计算口径；按 checked_at 去重防轮询重复拉取）。 */
  async function loadSelfReport(jobId: string, checkedAt: string): Promise<void> {
    if (reportLoadedFor.current === checkedAt) return;
    try {
      const report = await apiFetch(`/imports/${jobId}/self-check`, SelfCheckReportSchema);
      reportLoadedFor.current = checkedAt;
      setSelfReport(report);
    } catch {
      /* checked 态下报告必在；瞬时失败由下轮 checked_at 变化或重跑再拉 */
    }
  }

  async function runSelfCheck(): Promise<void> {
    if (job === null || selfCheckPending) return;
    selfCheckDispatchedAt.current = job.checked_at; // 完成信号锚（首轮 null → 非空；重跑 → 前进）
    selfCheckDispatchedMs.current = Date.now();
    selfCheckPendingRef.current = true;
    setSelfCheckPending(true);
    try {
      await apiFetch(`/imports/${job.id}/self-check`, ImportJobSchema, {
        method: 'POST',
        body: {},
      });
      void message.success('自检已发起（202）：读指令下发 → 采集窗等待 → 统计中…');
      await loadJob(job.id);
    } catch (cause) {
      selfCheckPendingRef.current = false;
      setSelfCheckPending(false); // 受理失败即可重试（服务端单飞幂等 202，不冲突）
      void message.error(errorText(cause, '自检发起失败'));
    }
  }

  const unmappedRows = useMemo(() => rows.filter((r) => r.quantity_type === null), [rows]);
  const conversionRows = useMemo(() => rows.filter((r) => r.unit_raw !== null), [rows]);

  // ── 失败视图（failed：按 failure.stage 定位，§10.2）──
  if (job !== null && job.status === 'failed') {
    return (
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          导入向导 · {job.id.slice(0, 8)}
        </Typography.Title>
        <Card>
          <Space direction="vertical">
            <Space>
              <JobStatusTag status={job.status} />
              <Typography.Text type="secondary">{job.file_name}</Typography.Text>
            </Space>
            <Alert
              type="error"
              showIcon
              message={`作业失败（${job.failure?.stage ?? 'unknown'} · ${job.failure?.code ?? 'unknown'}）`}
              description={
                <Space direction="vertical">
                  <span>{job.failure?.message}</span>
                  {job.failure?.stage === 'parse' && (
                    <Button
                      type="primary"
                      onClick={() => {
                        void navigate('/imports/new');
                      }}
                    >
                      修正文件后重新上传（新作业）
                    </Button>
                  )}
                  {job.failure?.stage === 'apply_push' && (
                    <Typography.Text type="secondary">
                      点位已登记保留（数据底座优先）：失败清单见 failure.rows；处置路径 =
                      物理修正（点位详情物理层卡）→ 网关重连取 retained 配置 → 重跑自检 （M2-import
                      §8.6）
                    </Typography.Text>
                  )}
                </Space>
              }
            />
            <Button
              onClick={() => {
                void navigate('/imports');
              }}
            >
              回导入历史
            </Button>
          </Space>
        </Card>
      </Space>
    );
  }

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Typography.Title level={3} style={{ margin: 0 }}>
        导入向导{job !== null ? ` · ${job.id.slice(0, 8)}` : ''}
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
        离开未完成的作业可从历史续入（作业状态服务端持久）
      </Typography.Paragraph>
      <Card>
        <Steps size="small" current={step} items={WIZARD_STEPS.map((title) => ({ title }))} />
        <div style={{ marginTop: 24 }}>
          {step === 0 && (
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              {job !== null && job.status === 'parsed' && job.row_count === 0 && (
                <Alert type="info" showIcon message="解析中（异步 worker）…完成后自动进入预览" />
              )}
              <Form form={form} layout="vertical" style={{ maxWidth: 480 }}>
                <Form.Item
                  name="building_id"
                  label="楼宇"
                  rules={[{ required: true, message: '选择目标楼宇' }]}
                >
                  <Select
                    placeholder="选择楼宇"
                    disabled={job !== null}
                    options={buildings.map((b) => ({ value: b.id, label: b.name }))}
                    onChange={(buildingId: unknown) => {
                      if (typeof buildingId === 'string') void loadEquipments(buildingId);
                    }}
                  />
                </Form.Item>
                <Form.Item
                  name="gateway_id"
                  label="网关"
                  rules={[{ required: true, message: '选择接入网关' }]}
                  extra="apply 前置同步预检要求网关在线；离线网关将被拦截"
                >
                  <Select
                    placeholder="选择网关"
                    disabled={job !== null}
                    options={gateways.map((g) => ({
                      value: g.id,
                      label: `${g.name} · ${g.mqtt_client_id}（${g.status}）`,
                      disabled: g.status === 'offline',
                    }))}
                  />
                </Form.Item>
                <Form.Item label="Excel 点表文件" required>
                  <Upload.Dragger
                    multiple={false}
                    maxCount={1}
                    accept=".xlsx"
                    fileList={fileList}
                    beforeUpload={() => false}
                    onChange={({ fileList: fl }) => {
                      setFileList(fl);
                    }}
                  >
                    <Typography.Text>
                      拖拽 .xlsx 到此处，或点击选择（≤5 MB / ≤5,000 行）
                    </Typography.Text>
                  </Upload.Dragger>
                </Form.Item>
              </Form>
              <Space>
                <Typography.Link href="/templates/point-import-template.xlsx" download>
                  下载模板（含示例行）
                </Typography.Link>
                {canWrite && job === null && (
                  <Button
                    type="primary"
                    loading={uploading}
                    onClick={() => {
                      void submitUpload();
                    }}
                  >
                    上传并解析
                  </Button>
                )}
              </Space>
            </Space>
          )}

          {step === 1 && (
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <Alert
                type="success"
                showIcon
                message={`解析完成：${String(job?.row_count ?? 0)} 行 · 识别列：点号 / 描述 / 单位 / 方向`}
              />
              <Table<ImportRow>
                rowKey="id"
                size="small"
                loading={rowsLoading}
                dataSource={rows.slice(0, 8)}
                pagination={false}
                columns={[
                  { title: '#', dataIndex: 'row_no', width: 60, render: excelRow },
                  { title: '原始点号', dataIndex: 'raw_name' },
                  { title: '描述', dataIndex: 'raw_description' },
                  { title: '单位', dataIndex: 'unit_raw', width: 90 },
                  {
                    title: '方向',
                    dataIndex: 'is_write',
                    width: 80,
                    render: (w: boolean) => (w ? '写' : '读'),
                  },
                ]}
              />
              {job !== null && job.row_count > 8 && (
                <Typography.Text type="secondary">
                  … 其余 {job.row_count - 8} 行（后续步骤分页加载）
                </Typography.Text>
              )}
              <Button
                type="primary"
                onClick={() => {
                  setStep(2);
                }}
              >
                下一步：语义映射
              </Button>
            </Space>
          )}

          {step === 2 && (
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <Space wrap>
                <Button
                  type="primary"
                  loading={autoRunning}
                  disabled={!canWrite}
                  onClick={() => {
                    void runAutoMapping();
                  }}
                >
                  ▶ 执行自动映射（规则 + 历史模板库）
                </Button>
                <Typography.Text type="secondary">
                  自动映射 {job?.mapped_count ?? 0}/{job?.row_count ?? 0} · 待人工 $
                  {String(unmappedRows.length)} 行（先自动后人工，UC-M2-2；枚举只从清单选择）
                </Typography.Text>
              </Space>
              <Table<ImportRow>
                rowKey="id"
                size="small"
                loading={rowsLoading}
                dataSource={unmappedRows}
                pagination={{ pageSize: 20 }}
                columns={[
                  { title: '#', dataIndex: 'row_no', width: 60, render: excelRow },
                  {
                    title: '原始点号/描述',
                    render: (_, row) => (
                      <Space direction="vertical" size={0}>
                        <Typography.Text strong>{row.raw_name}</Typography.Text>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {row.raw_description ?? ''}
                        </Typography.Text>
                      </Space>
                    ),
                  },
                  {
                    title: '建议',
                    render: (_, row) =>
                      row.suggestions.length === 0 ? (
                        <Typography.Text type="secondary">—</Typography.Text>
                      ) : (
                        <Space wrap>
                          {row.suggestions.map((s, i) => (
                            <Button
                              key={i}
                              size="small"
                              onClick={() => {
                                void patchRow(row, {
                                  equipment_id: s.equipment_id,
                                  quantity_type: s.quantity_type,
                                  unit_std: s.unit_std,
                                });
                              }}
                            >
                              {s.source === 'history_exact' ? '历史精确' : '历史相似'}
                              {s.quantity_type ?? ''}（{s.score}）
                            </Button>
                          ))}
                        </Space>
                      ),
                  },
                  {
                    title: '操作',
                    width: 120,
                    render: (_, row) =>
                      canWrite ? (
                        <Button
                          size="small"
                          onClick={() => {
                            setMappingTarget(row);
                          }}
                        >
                          人工映射…
                        </Button>
                      ) : null,
                  },
                ]}
              />
              {unmappedRows.length > 0 && (
                <Alert
                  type="warning"
                  showIcon
                  message={`待人工 ${String(unmappedRows.length)} 行未清零前，dry-run 将报阻塞 row_unmapped`}
                />
              )}
              <Button
                type="primary"
                disabled={job === null || job.mapped_count < job.row_count}
                onClick={() => {
                  setStep(3);
                }}
              >
                下一步：单位换算确认
              </Button>
            </Space>
          )}

          {step === 3 && (
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <Typography.Text type="secondary">
                raw → std 换算在 ingest 入库前完成（ADR-005）——本步确认换算式；未列出的行为
                无原始单位（直通，不换算）
              </Typography.Text>
              <Table<ImportRow>
                rowKey="id"
                size="small"
                dataSource={conversionRows}
                pagination={{ pageSize: 20 }}
                columns={[
                  { title: '#', dataIndex: 'row_no', width: 60, render: excelRow },
                  { title: '原始点号', dataIndex: 'raw_name' },
                  { title: '原始单位', dataIndex: 'unit_raw', width: 100 },
                  {
                    title: '标准单位',
                    dataIndex: 'unit_std',
                    width: 120,
                    render: (unitStd: string | null, row) =>
                      canWrite ? (
                        <Button
                          size="small"
                          type="link"
                          onClick={() => {
                            const next = window.prompt(
                              `unit_std（≤32；留空 = 确认直通）`,
                              unitStd ?? '',
                            );
                            if (next === null) return;
                            void patchRow(row, { unit_std: next.length === 0 ? null : next });
                          }}
                        >
                          {unitStd ?? '（直通）'}
                        </Button>
                      ) : (
                        (unitStd ?? '（直通）')
                      ),
                  },
                  {
                    title: '换算',
                    render: (_, row) =>
                      row.unit_std === null
                        ? conversionLabel(row.unit_raw ?? '', row.unit_raw ?? '')
                        : conversionLabel(row.unit_raw ?? '', row.unit_std),
                  },
                ]}
              />
              <Button
                type="primary"
                onClick={() => {
                  setStep(4);
                }}
              >
                下一步：dry-run 与执行
              </Button>
            </Space>
          )}

          {step === 4 && (
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <Typography.Title level={5} style={{ margin: 0 }}>
                dry-run 校验（apply 的强制前置 · flows.md §1）
              </Typography.Title>
              {dryReport === null && job?.status === 'mapping' && (
                <Space>
                  <Button
                    type="primary"
                    disabled={!canWrite}
                    onClick={() => {
                      void runDryRun();
                    }}
                  >
                    ▶ 执行 dry-run（查重/枚举/write 点数值量 P2-3）
                  </Button>
                  <Typography.Text type="secondary">阻塞项清零前 apply 不可用</Typography.Text>
                </Space>
              )}
              {dryReport !== null && !dryReport.passed && (
                <Alert
                  type="error"
                  showIcon
                  message={`⛔ 阻塞项 ${String(dryReport.blocking_count)}：apply 被拒绝`}
                  description={
                    <Space direction="vertical">
                      <Typography.Text type="secondary">
                        行级明细见「重新校验」后刷新的映射工作台（GET rows?issue=*）
                      </Typography.Text>
                      <Button
                        onClick={() => {
                          void runDryRun();
                        }}
                      >
                        重新校验
                      </Button>
                    </Space>
                  }
                />
              )}
              {dryReport !== null && dryReport.passed && (
                <Alert
                  type="success"
                  showIcon
                  message={`dry-run 通过：阻塞 0 · 警告 ${String(dryReport.warning_count)}（不阻断）· 待登记 ${String(job?.row_count ?? 0)} 点`}
                />
              )}
              {job?.status === 'validated' && (
                <Space>
                  <Button
                    disabled={!canWrite}
                    onClick={() => {
                      void runDryRun();
                    }}
                  >
                    重新校验
                  </Button>
                  <Button danger type="primary" disabled={!canWrite} onClick={confirmApply}>
                    执行 apply（二次确认）
                  </Button>
                </Space>
              )}
              {job?.status === 'applied' && (
                <Alert
                  type="success"
                  showIcon
                  message="apply 完成：点位已登记，等待配置推送应答收敛"
                />
              )}
              {(job?.status === 'applied' || job?.status === 'checked') && (
                <Space direction="vertical" size="small">
                  <Typography.Title level={5} style={{ margin: 0 }}>
                    采集自检（全点位读一遍 → 命中率报告）
                  </Typography.Title>
                  <Button
                    type="primary"
                    disabled={!canWrite}
                    loading={selfCheckPending}
                    onClick={() => {
                      void runSelfCheck();
                    }}
                  >
                    ▶ {job.status === 'checked' ? '重跑自检（刷新命中率）' : '发起采集自检'}
                  </Button>
                  {job.hit_rate !== null && (
                    <Progress
                      percent={Math.round(job.hit_rate * 1000) / 10}
                      status={job.hit_rate >= 0.9 ? 'success' : 'active'}
                    />
                  )}
                </Space>
              )}
              {selfReport !== null && (
                <Card size="small" title={`自检报告（${selfReport.checked_at} 实时计算口径）`}>
                  <Space direction="vertical" size="small">
                    <Typography.Text>
                      命中率{' '}
                      <Typography.Text strong>
                        {selfReport.hit_count}/{selfReport.total_count}
                      </Typography.Text>
                      （{(selfReport.hit_rate * 100).toFixed(1)}%）—— 回看窗{' '}
                      {selfReport.window.lookback_s / 60} min
                    </Typography.Text>
                    {selfReport.missed.map((m) => (
                      <Alert
                        key={m.point_id}
                        type="warning"
                        showIcon
                        message={`未命中：第 ${String(excelRow(m.row_no))} 行 ${m.raw_name}（统计窗口内未收到新值）`}
                        description="修正入口分流（apply 后导入行不可改，ddl §9.1）：语义类 → 点位语义编辑（M1）；物理类 → 点位详情物理层卡 / 现场整改后重跑自检"
                      />
                    ))}
                  </Space>
                </Card>
              )}
              <Button
                onClick={() => {
                  void navigate('/imports');
                }}
              >
                完成（回导入历史）
              </Button>
            </Space>
          )}
        </div>
        {error !== null && (
          <Alert style={{ marginTop: 16 }} type="error" showIcon message={error} />
        )}
      </Card>

      {/* 人工映射弹窗（§3.5：quantity_type 只允许从枚举清单选择，DM §6） */}
      <Modal
        open={mappingTarget !== null}
        title={`人工映射 · 第 ${mappingTarget ? String(excelRow(mappingTarget.row_no)) : ''} 行 ${mappingTarget?.raw_name ?? ''}`}
        onCancel={() => {
          setMappingTarget(null);
        }}
        footer={null}
        destroyOnHidden
      >
        {mappingTarget !== null && (
          <MappingForm
            row={mappingTarget}
            equipments={equipments}
            onSubmit={(values) => {
              void patchRow(mappingTarget, values);
            }}
          />
        )}
      </Modal>
    </Space>
  );
}

function MappingForm({
  row,
  equipments,
  onSubmit,
}: {
  row: ImportRow;
  equipments: Equipment[];
  onSubmit: (values: Record<string, string | null>) => void;
}): React.ReactNode {
  const [form] = Form.useForm<{
    equipment_id: string | null;
    quantity_type: string | null;
    unit_std: string | null;
  }>();
  return (
    <Form
      form={form}
      layout="vertical"
      initialValues={{
        equipment_id: row.equipment_id ?? undefined,
        quantity_type: row.quantity_type ?? undefined,
        unit_std: row.unit_std ?? '',
      }}
      onFinish={(values) => {
        onSubmit({
          equipment_id: values.equipment_id ?? null,
          quantity_type: values.quantity_type ?? null,
          unit_std: (values.unit_std ?? '').length === 0 ? null : values.unit_std,
        });
      }}
    >
      <Form.Item name="equipment_id" label="设备（留空 = 系统级独立测点）">
        <Select
          allowClear
          placeholder="（系统级独立测点）"
          options={equipments.map((e) => ({
            value: e.id,
            label: `${e.name} · ${e.equipment_type}`,
          }))}
        />
      </Form.Item>
      <Form.Item
        name="quantity_type"
        label="量类型 quantity_type"
        rules={[{ required: true, message: '从枚举清单选择' }]}
        extra="只允许从清单选择（DM §6 · QUANTITY_TYPE_UNKNOWN 拒绝自由输入）"
      >
        <Select
          allowClear
          placeholder="选择量类型"
          options={QUANTITY_TYPES.map((q) => ({ value: q, label: q }))}
        />
      </Form.Item>
      <Form.Item name="unit_std" label="标准单位（≤32；留空 = 直通）">
        <Input maxLength={32} placeholder={row.unit_raw ?? '无原始单位'} />
      </Form.Item>
      <Space>
        <Button
          onClick={() => {
            onSubmit({ equipment_id: null, quantity_type: null, unit_std: null });
          }}
        >
          清除映射
        </Button>
        <Button type="primary" htmlType="submit">
          保存映射
        </Button>
      </Space>
    </Form>
  );
}
