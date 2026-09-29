/**
 * 监控总览（M3-monitor §8.1 页面 1：3D 全屏主视图 + KPI 悬浮层）。
 *
 * 结构对齐 §8.1：左上 KPI 四卡（可收起，localStorage 记忆）→ 顶部筛选
 * （ALL/CHW/CW + 图例四回路细分）→ 场景切换器（?scene= 入 URL 可分享回链）/
 * 设备目录抽屉 / 属性面板抽屉 / 工具栏（流向·标签·俯视·复位·全屏）→
 * SSE 状态徽标与断线横幅（§4.3）。
 * 键盘：Space 流向 / R 复位 / F 定位所选 / Esc 关闭（§5.2 全集）。
 *
 * 数据：overview + 告警快照 60s 轮询（REST）；遥测走 SSE（§4.2，open 时批量
 * 快照校准）；求值在 bind-core（§6.1），本页只搬运结果。mock 接缝见
 * monitor-data.ts（演示模式显式挂「演示数据」角标）。
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Badge,
  Button,
  Card,
  Drawer,
  Empty,
  Input,
  Progress,
  Segmented,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  theme,
} from 'antd';
import type { ReactNode } from 'react';
import { Scene3D, type CircuitFilter, type PlantScene, type SceneHoverInfo } from '@thermio/viz-3d';
import type { SceneManifest } from '@thermio/viz-3d';
import { evaluateScene, type LatestValue } from '@thermio/bind-core';
import { CIRCUITS, type SceneDetail } from '@thermio/scene-schema';
import type { StreamStatus } from '../../app/telemetry-stream.js';
import type { EquipmentConditionCard, MonitorOverview, OpenAlarm } from './api-contracts.js';
import {
  MONITOR_MOCK,
  createTelemetryStream,
  fetchEquipmentConditions,
  fetchMonitorOverview,
  fetchOpenAlarms,
  fetchPointsLatestBatch,
  fetchSceneDetail,
} from './monitor-data.js';

const KPI_COLLAPSED_KEY = 'thermio.monitor.kpi_collapsed';
const POLL_MS = 60_000;
const STALE_TIMEOUT_S = 30;

const RUN_STATE_META = {
  running: { label: '运行', color: 'var(--ti-ok)' },
  standby: { label: '备用', color: 'var(--ti-text-3)' },
  fault: { label: '故障', color: 'var(--ti-sev-critical)' },
  unknown: { label: '未知', color: 'var(--ti-text-3)' },
} as const;

const STREAM_LABEL = {
  connecting: '连接中',
  open: '实时',
  paused: '已暂停',
  reconnecting: '重连中',
  failed: '连接失败',
  closed: '已断开',
} as const;

export function MonitorOverviewPage(): ReactNode {
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const [searchParams, setSearchParams] = useSearchParams();
  const [overview, setOverview] = useState<MonitorOverview | null>(null);
  const [sceneDetail, setSceneDetail] = useState<SceneDetail | null>(null);
  const [manifest, setManifest] = useState<SceneManifest | null>(null);
  const [equipments, setEquipments] = useState<readonly EquipmentConditionCard[]>([]);
  const [alarms, setAlarms] = useState<readonly OpenAlarm[]>([]);
  const [progress, setProgress] = useState(0);
  const [sceneError, setSceneError] = useState<{ kind: string; message: string } | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hover, setHover] = useState<SceneHoverInfo | null>(null);
  const [filter, setFilter] = useState<CircuitFilter>('ALL');
  const [flowOn, setFlowOn] = useState(true);
  const [labelsOn, setLabelsOn] = useState(true);
  const [sceneKind, setSceneKind] = useState<'3d' | '2d'>(() =>
    searchParams.get('scene') === '2d' ? '2d' : '3d',
  );
  const [kpiCollapsed, setKpiCollapsed] = useState(
    () => globalThis.localStorage.getItem(KPI_COLLAPSED_KEY) === '1',
  );
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [directoryKeyword, setDirectoryKeyword] = useState('');
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('connecting');
  const [streamDetail, setStreamDetail] = useState<string | undefined>(undefined);
  const sceneRef = useRef<PlantScene | null>(null);
  const latestRef = useRef<Map<number, LatestValue>>(new Map());
  const [tick, bump] = useReducer((count: number) => count + 1, 0);

  // 初始装载：overview + 设备卡（下钻映射）+ 告警快照 + 场景配置
  useEffect(() => {
    let cancelled = false;
    const boot = async (): Promise<void> => {
      const [nextOverview, equipmentPage, openAlarms] = await Promise.all([
        fetchMonitorOverview(),
        fetchEquipmentConditions(),
        fetchOpenAlarms().catch(() => [] as OpenAlarm[]),
      ]);
      if (cancelled) return;
      setOverview(nextOverview);
      setEquipments(equipmentPage.items);
      setAlarms(openAlarms);
      const scene3d = nextOverview.scenes.find((scene) => scene.kind === '3d');
      if (scene3d !== undefined) setSceneDetail(await fetchSceneDetail(scene3d.id));
    };
    void boot().catch(() => {
      if (!cancelled) setSceneError({ kind: 'overview_failed', message: '监控总览数据加载失败' });
    });
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  // KPI 60s 轮询（§3.1：REST 慢变量，不占 SSE 订阅）
  useEffect(() => {
    const timer = setInterval(() => {
      void fetchMonitorOverview()
        .then(setOverview)
        .catch(() => undefined);
      void fetchOpenAlarms()
        .then(setAlarms)
        .catch(() => undefined);
    }, POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  // SSE 订阅（§4.2：绑定点位全集；open → 批量快照校准）
  const boundPointIds = useMemo(
    () =>
      sceneDetail === null ? [] : [...new Set(sceneDetail.config.bindings.map((b) => b.point_id))],
    [sceneDetail],
  );
  useEffect(() => {
    if (boundPointIds.length === 0) return;
    const calibrate = async (): Promise<void> => {
      const batch = await fetchPointsLatestBatch(boundPointIds);
      for (const item of batch.items) {
        if (item.latest === null) continue;
        latestRef.current.set(item.point_id, item.latest);
      }
      bump();
    };
    void calibrate();
    const handle = createTelemetryStream(boundPointIds, {
      onStatus: (status, detail) => {
        setStreamStatus(status);
        setStreamDetail(detail);
        if (status === 'open') void calibrate();
      },
      onPoints: (points) => {
        for (const point of points) {
          latestRef.current.set(point.point_id, {
            value: point.value,
            value_text: point.value_text,
            ts: point.ts,
            quality: point.quality,
          });
        }
        bump();
      },
    });
    return () => {
      handle.close();
    };
  }, [boundPointIds]);

  // bind-core 求值（§6.1：本页只搬运结果；parents 来自 manifest.parent 数据驱动）
  const evaluation = useMemo(() => {
    if (sceneDetail === null) return null;
    const parents: Record<string, string> = {};
    if (manifest !== null) {
      for (const asset of manifest.assets) {
        if (asset.parent != null) parents[asset.id] = asset.parent;
      }
    }
    return evaluateScene(
      sceneDetail.config,
      latestRef.current,
      alarms.map((alarm) => ({
        id: alarm.id,
        severity: alarm.severity,
        object_ids: alarm.object_ids,
      })),
      { nowMs: Date.now(), staleTimeoutS: STALE_TIMEOUT_S, parents },
    );
    // tick：SSE/校准写入 latestRef 后手动触发重算（ref 写入对依赖静态分析不可见）
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tick 是刻意的重算信号
  }, [sceneDetail, manifest, alarms, tick]);

  const selectedAsset = useMemo(
    () => manifest?.assets.find((asset) => asset.id === selectedId) ?? null,
    [manifest, selectedId],
  );
  const selectedEquipment = useMemo(
    () => equipments.find((card) => card.equipment.local_id === selectedId) ?? null,
    [equipments, selectedId],
  );
  const slotToPoint = useMemo(() => {
    const map = new Map<string, number>();
    for (const binding of sceneDetail?.config.bindings ?? [])
      map.set(binding.slot, binding.point_id);
    return map;
  }, [sceneDetail]);

  const select = useCallback((objectId: string | null) => {
    setSelectedId(objectId);
    setInspectorOpen(objectId !== null);
  }, []);

  // 键盘（§5.2 全集；输入控件聚焦时跳过）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target !== null && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (event.key === ' ') {
        event.preventDefault();
        setFlowOn((value) => !value);
      } else if (event.key === 'r' || event.key === 'R') {
        sceneRef.current?.preset('overview');
      } else if (event.key === 'f' || event.key === 'F') {
        if (selectedId !== null) sceneRef.current?.focus(selectedId);
      } else if (event.key === 'Escape') {
        if (inspectorOpen || directoryOpen) {
          setInspectorOpen(false);
          setDirectoryOpen(false);
        } else {
          select(null);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [inspectorOpen, directoryOpen, selectedId, select]);

  const toggleKpi = (): void => {
    setKpiCollapsed((value) => {
      globalThis.localStorage.setItem(KPI_COLLAPSED_KEY, value ? '0' : '1');
      return !value;
    });
  };

  // 场景选中态入 URL（§8.1③ 可分享/回链）：?scene=3d|2d，replace 不堆历史栈
  const changeSceneKind = useCallback(
    (kind: '3d' | '2d'): void => {
      setSceneKind(kind);
      setSearchParams({ scene: kind }, { replace: true });
    },
    [setSearchParams],
  );
  // 挂载即补默认值——URL 恒携带当前场景（分享 /monitor 也得到可回链状态）
  useEffect(() => {
    if (searchParams.get('scene') === null) {
      setSearchParams({ scene: sceneKind }, { replace: true });
    }
    // 仅首挂载补一次；后续由 changeSceneKind 驱动
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sceneKind 初始值即默认场景
  }, []);

  // 全屏（§8.1③ 视图工具栏）：作用于 3D 主视图容器
  const viewRef = useRef<HTMLDivElement | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const onChange = (): void => {
      setFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
    };
  }, []);
  const toggleFullscreen = (): void => {
    const container = viewRef.current;
    if (container === null) return;
    if (document.fullscreenElement !== null) {
      void document.exitFullscreen();
    } else {
      void container.requestFullscreen().catch(() => undefined);
    }
  };

  const directoryAssets = useMemo(() => {
    if (manifest === null) return [];
    const directoryKinds = new Set(['chiller', 'pump', 'tower', 'load']);
    const keyword = directoryKeyword.trim().toLowerCase();
    return manifest.assets.filter(
      (asset) =>
        directoryKinds.has(asset.kind) &&
        (keyword === '' ||
          asset.name.toLowerCase().includes(keyword) ||
          asset.id.toLowerCase().includes(keyword)),
    );
  }, [manifest, directoryKeyword]);

  const kpi = overview?.kpi;
  const sceneState = sceneError !== null ? 'error' : manifest === null ? 'loading' : 'ready';

  return (
    <div ref={viewRef} style={{ position: 'relative' }}>
      <Card
        styles={{
          body: { padding: 0, position: 'relative', height: 'calc(100vh - 168px)', minHeight: 520 },
        }}
        title="实时监控 · 能源站组态"
        extra={
          <Space size="small">
            {MONITOR_MOCK && <Tag color="orange">演示数据</Tag>}
            <Badge
              status={
                streamStatus === 'open'
                  ? 'processing'
                  : streamStatus === 'failed'
                    ? 'error'
                    : 'warning'
              }
              text={streamLabel(streamStatus, boundPointIds.length)}
            />
            <Select<'3d' | '2d'>
              size="small"
              value={sceneKind}
              style={{ minWidth: 168 }}
              onChange={changeSceneKind}
              options={(overview?.scenes ?? []).map((scene) => ({
                value: scene.kind,
                label: scene.name,
              }))}
            />
          </Space>
        }
      >
        {/* 3D 主视图（viz-3d 引擎；WebGL 降级链 §5.1） */}
        {sceneKind === '3d' && sceneDetail !== null && (
          <Scene3D
            key={`scene-${sceneDetail.id}-${String(reloadTick)}`}
            style={{ height: '100%' }}
            manifestUrl={sceneDetail.assets?.manifest.url ?? ''}
            modelUrl={sceneDetail.assets?.model.url ?? ''}
            expectedSha256={sceneDetail.assets?.model.sha256}
            decoderPath="/draco/"
            states={evaluation?.states}
            highlights={evaluation?.highlights}
            fanSpeeds={evaluation?.fanSpeeds}
            selectedId={selectedId}
            filter={filter}
            flowEnabled={flowOn}
            labelsEnabled={labelsOn}
            labelIds={
              manifest === null
                ? undefined
                : manifest.assets
                    .filter((asset) => ['chiller', 'pump', 'tower', 'load'].includes(asset.kind))
                    .map((asset) => asset.id)
            }
            renderLabel={(asset) => {
              const state = evaluation?.states[asset.id];
              const color =
                state === 'running' ? RUN_STATE_META.running.color : RUN_STATE_META.standby.color;
              return (
                <div
                  style={{
                    background: 'var(--ti-scene-overlay)',
                    color: '#fff',
                    borderRadius: 4,
                    padding: '2px 8px',
                    fontSize: 12,
                    whiteSpace: 'nowrap',
                    pointerEvents: 'auto',
                    cursor: 'pointer',
                  }}
                  onClick={() => {
                    select(asset.id);
                  }}
                >
                  <span style={{ color, marginRight: 6 }}>●</span>
                  {asset.name}
                </div>
              );
            }}
            onProgress={setProgress}
            onReady={(handle, loadedManifest) => {
              sceneRef.current = handle;
              setManifest(loadedManifest);
              setSceneError(null);
            }}
            onSelect={select}
            onHover={setHover}
            onError={(kind, message) => {
              setSceneError({ kind, message });
            }}
          />
        )}

        {/* 加载 / 错误 / 2D 占位（§5.1 画面就绪状态机） */}
        {sceneKind === '3d' && sceneState === 'loading' && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'grid',
              placeItems: 'center',
              background: 'var(--ti-scene-backdrop)',
            }}
          >
            <div style={{ textAlign: 'center', color: '#fff' }}>
              <Spin />
              <div style={{ margin: '12px 0' }}>三维场景装载中</div>
              <Progress type="line" percent={progress} style={{ width: 240 }} status="active" />
            </div>
          </div>
        )}
        {sceneKind === '3d' && sceneError !== null && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'grid',
              placeItems: 'center',
              background: 'var(--ti-scene-backdrop)',
            }}
          >
            <div style={{ textAlign: 'center', color: '#fff', maxWidth: 420 }}>
              <div style={{ fontSize: 15, marginBottom: 8 }}>3D 场景不可用</div>
              <div style={{ opacity: 0.75, marginBottom: 8 }}>
                {sceneError.message}（{sceneError.kind}）
              </div>
              <div style={{ opacity: 0.55, fontSize: 12, marginBottom: 16 }}>
                按 §5.1 降级链此处应自动切换 2D P&amp;ID；2D 模板视图待 viz-2d 包就绪后接入（R2）。
              </div>
              <Button
                type="primary"
                onClick={() => {
                  setSceneError(null);
                  setProgress(0);
                  setManifest(null);
                  setReloadTick((value) => value + 1);
                }}
              >
                重试装载
              </Button>
            </div>
          </div>
        )}
        {sceneKind === '2d' && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
            <Empty description="2D P&ID 模板视图待 viz-2d 包交付后接入（M3 §5.1 降级目标 / 场景切换器入口已就位）" />
          </div>
        )}

        {/* 断线横幅（§4.3：已有值保留，连接状态显式） */}
        {(streamStatus === 'reconnecting' ||
          streamStatus === 'paused' ||
          streamStatus === 'failed') && (
          <div
            style={{
              position: 'absolute',
              top: 12,
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 20,
            }}
          >
            <Alert
              type={streamStatus === 'failed' ? 'error' : 'warning'}
              showIcon
              message={
                streamStatus === 'failed'
                  ? (streamDetail ?? '实时数据连接失败，可重试装载场景')
                  : '实时数据已暂停 · 重连中（已有数值保留，超时值将灰化）'
              }
            />
          </div>
        )}

        {/* KPI 悬浮层（§8.1①：四卡 + 收起记忆 + 下钻三向）。
            maxWidth 预留右侧工具栏带宽：窄视口时收起按钮换行而非被挤出遮挡
            （视觉门 r1 页1-2，1440px 下收起入口不可达）。 */}
        <div
          style={{
            position: 'absolute',
            top: 12,
            left: 12,
            zIndex: 10,
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            alignItems: 'flex-start',
            maxWidth: 'calc(100% - 520px)',
          }}
        >
          {kpiCollapsed ? (
            <Button size="small" onClick={toggleKpi}>
              显示 KPI
            </Button>
          ) : (
            <>
              <KpiCard
                title={
                  <Tooltip title="对标分析属 M11（P1）；能耗为能量累计点位当日窗口差值（R12 量型登记后点亮）">
                    当日能耗
                  </Tooltip>
                }
                value={kpi?.energy_today_kwh}
                sub={kpi === undefined ? undefined : `当期 ${formatKwh(kpi.energy_period_kwh)}`}
              />
              <KpiCard
                title={
                  <Tooltip title="节能量来自 M&V 域（M9，P1 占位）——接入 mv_report 后点亮">
                    节能量（当期）
                  </Tooltip>
                }
                value={kpi?.saving_period_kwh}
                placeholderNote={kpi?.saving_period_kwh == null ? 'M9 接入后点亮' : undefined}
              />
              <KpiCard
                title={
                  <Tooltip title="负荷率取冷机控制器负荷百分比点位（验收拍板 3）；无登记点位 → 引导态">
                    负荷率
                  </Tooltip>
                }
                value={kpi?.load_rate_linked ? kpi.load_rate_pct : null}
                unit="%"
                placeholderNote={kpi?.load_rate_linked === false ? '未接入' : undefined}
                onClick={() => {
                  void navigate('/monitor/equipments');
                }}
                clickable="查看设备工况"
              />
              <KpiCard
                title={
                  <Tooltip title="在用告警 open 总数；告警中心属 M4（O5 角标通道）">
                    在用告警
                  </Tooltip>
                }
                value={kpi?.alarms.open_total}
                unit="条"
                badge={
                  (kpi?.alarms.open_by_severity.critical ?? 0) > 0
                    ? {
                        color: 'red',
                        text: `critical × ${String(kpi?.alarms.open_by_severity.critical)}`,
                      }
                    : (kpi?.alarms.open_by_severity.major ?? 0) > 0
                      ? {
                          color: 'volcano',
                          text: `major × ${String(kpi?.alarms.open_by_severity.major)}`,
                        }
                      : undefined
                }
                onClick={() => {
                  void navigate('/alarms');
                }}
                clickable="M4 上线后开放"
              />
              <Button size="small" onClick={toggleKpi}>
                收起
              </Button>
            </>
          )}
        </div>

        {/* 回路筛选 + 图例（§5.3：只影响管路/阀门显隐，不改订阅集） */}
        <div
          style={{
            position: 'absolute',
            bottom: 12,
            left: 12,
            zIndex: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <Segmented
            size="small"
            value={filter}
            onChange={(value) => {
              setFilter(value as CircuitFilter);
            }}
            options={[
              { label: '全部', value: 'ALL' },
              { label: '冷冻水 CHW', value: 'CHW' },
              { label: '冷却水 CW', value: 'CW' },
            ]}
          />
          <Space size={4} wrap style={{ maxWidth: 360 }}>
            {CIRCUIT_ENTRIES.map(([key, meta]) => (
              <Tag
                key={key}
                style={{
                  cursor: 'pointer',
                  marginInlineEnd: 0,
                  borderColor: filter === key ? meta.color : undefined,
                }}
                onClick={() => {
                  setFilter(filter === key ? 'ALL' : (key as CircuitFilter));
                }}
              >
                <span style={{ color: meta.color }}>●</span> {meta.name} {key}
              </Tag>
            ))}
          </Space>
        </div>

        {/* 工具栏（§8.1③ 视图工具栏全集：总览/俯视/流向/标签/全屏 + 目录） */}
        <div
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            zIndex: 10,
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'flex-end',
            gap: 8,
            maxWidth: 'calc(100% - 420px)',
          }}
        >
          <Badge count={directoryAssets.length} size="small" offset={[-4, 2]}>
            <Button
              size="small"
              onClick={() => {
                setDirectoryOpen(true);
              }}
            >
              设备目录
            </Button>
          </Badge>
          <Button
            size="small"
            onClick={() => {
              setFlowOn((value) => !value);
            }}
          >
            {flowOn ? '暂停流向 (Space)' : '播放流向 (Space)'}
          </Button>
          <Button
            size="small"
            onClick={() => {
              setLabelsOn((value) => !value);
            }}
          >
            {labelsOn ? '隐藏标签' : '显示标签'}
          </Button>
          <Button size="small" onClick={() => sceneRef.current?.preset('overview')}>
            总览视角 (R)
          </Button>
          <Button size="small" onClick={() => sceneRef.current?.preset('plan')}>
            俯视
          </Button>
          <Button size="small" onClick={toggleFullscreen}>
            {fullscreen ? '退出全屏' : '全屏'}
          </Button>
        </div>

        {/* hover tooltip（§5.2：90ms 节流在引擎内） */}
        {hover !== null && hover.id !== selectedId && (
          <div
            style={{
              position: 'fixed',
              left: hover.x + 12,
              top: hover.y + 12,
              zIndex: 30,
              pointerEvents: 'none',
              background: token.colorBgSpotlight,
              color: token.colorTextLightSolid,
              padding: '2px 8px',
              borderRadius: 4,
              fontSize: 12,
            }}
          >
            {hover.name}
          </div>
        )}
      </Card>

      {/* 设备目录抽屉（§5.2：拾取的键盘可达替代入口） */}
      <Drawer
        title="设备目录"
        width={320}
        open={directoryOpen}
        onClose={() => {
          setDirectoryOpen(false);
        }}
        styles={{ body: { paddingTop: 8 } }}
      >
        <Input.Search
          placeholder="搜索名称 / 编号"
          allowClear
          value={directoryKeyword}
          onChange={(event) => {
            setDirectoryKeyword(event.target.value);
          }}
          style={{ marginBottom: 12 }}
        />
        {directoryAssets.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无匹配对象" />
        ) : (
          directoryAssets.map((asset) => {
            const state = evaluation?.states[asset.id];
            const highlight = evaluation?.highlights[asset.id];
            return (
              <div
                key={asset.id}
                onClick={() => {
                  select(asset.id);
                  sceneRef.current?.focus(asset.id);
                  setDirectoryOpen(false);
                }}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '6px 8px',
                  borderRadius: 4,
                  cursor: 'pointer',
                  background: selectedId === asset.id ? token.colorPrimaryBg : undefined,
                }}
              >
                <span>
                  <span
                    style={{
                      color:
                        state === 'running'
                          ? RUN_STATE_META.running.color
                          : RUN_STATE_META.standby.color,
                      marginRight: 6,
                    }}
                  >
                    ●
                  </span>
                  {asset.name}
                  <span style={{ color: token.colorTextTertiary, marginLeft: 8, fontSize: 12 }}>
                    {asset.id}
                  </span>
                </span>
                {highlight !== undefined && (
                  <Tag
                    color={highlight === 'alarm' ? 'red' : 'orange'}
                    style={{ marginInlineEnd: 0 }}
                  >
                    {highlight === 'alarm' ? '告警' : '预警'}
                  </Tag>
                )}
              </div>
            );
          })
        )}
      </Drawer>

      {/* 属性面板抽屉（§5.2：元数据 + 绑定槽实时值 + 只读下钻） */}
      <Drawer
        title={selectedAsset !== null ? `${selectedAsset.name}（${selectedAsset.id}）` : '属性面板'}
        width={360}
        open={inspectorOpen && selectedAsset !== null}
        onClose={() => {
          setInspectorOpen(false);
          select(null);
        }}
      >
        {selectedAsset !== null && evaluation !== null && (
          <>
            <Space direction="vertical" size={4} style={{ width: '100%', marginBottom: 12 }}>
              <span>
                类型：{selectedAsset.kind}　回路：{selectedAsset.circuit ?? '—'}
              </span>
              <span>
                运行状态：
                <Tag
                  style={{ marginInlineStart: 4 }}
                  color={stateTagColor(evaluation.states[selectedAsset.id])}
                >
                  {stateLabel(evaluation.states[selectedAsset.id])}
                </Tag>
              </span>
            </Space>
            {Object.entries(evaluation.values)
              .filter(([slot]) => slot.startsWith(`${selectedAsset.id}:`))
              .map(([slot, value]) => (
                <div
                  key={slot}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    padding: '6px 8px',
                    borderBottom: '1px solid var(--ti-border)',
                  }}
                >
                  <span>{slot}</span>
                  <span style={{ color: value.stale ? 'var(--ti-text-3)' : undefined }}>
                    {value.unknown ? '—' : (value.text ?? '—')}
                    {value.unit !== null ? ` ${value.unit}` : ''}
                    {value.stale ? '（超时）' : ''}
                  </span>
                </div>
              ))}
            <Space direction="vertical" style={{ marginTop: 16 }} size={8}>
              {selectedEquipment !== null && (
                <Button
                  type="primary"
                  size="small"
                  onClick={() => {
                    void navigate(`/monitor/equipments/${selectedEquipment.equipment.id}`);
                  }}
                >
                  设备工况详情（页面 2）
                </Button>
              )}
              {[...slotToPoint.entries()]
                .filter(([slot]) => slot.startsWith(`${selectedAsset.id}:`))
                .map(([slot, pointId]) => (
                  <Button
                    key={slot}
                    size="small"
                    onClick={() => {
                      void navigate(`/assets/points/${String(pointId)}`);
                    }}
                  >
                    点位详情 · {slot}
                  </Button>
                ))}
            </Space>
          </>
        )}
      </Drawer>
    </div>
  );
}

const CIRCUIT_ENTRIES = Object.entries(CIRCUITS);

function formatKwh(value: number | null | undefined): string {
  return value == null ? '— kWh' : `${value.toFixed(1)} kWh`;
}

/** 订阅状态行（§8.1③）：open 态带点位数与节流口径，其余态带点位数。 */
function streamLabel(status: StreamStatus, pointCount: number): string {
  const count = ` · ${String(pointCount)} 点`;
  if (status === 'open') return `SSE 订阅中 · ${String(pointCount)} 点 · 节流 2s`;
  return `${STREAM_LABEL[status]}${count}`;
}

function KpiCard(props: {
  title: ReactNode;
  value: number | null | undefined;
  unit?: string | undefined;
  sub?: string | undefined;
  placeholderNote?: string | undefined;
  badge?: { color: string; text: string } | undefined;
  onClick?: (() => void) | undefined;
  clickable?: string | undefined;
}): ReactNode {
  const { token } = theme.useToken();
  // 计数类（告警条数）不带小数；测量类保留 1 位
  const display =
    props.value == null
      ? '—'
      : Number.isInteger(props.value)
        ? String(props.value)
        : props.value.toFixed(1);
  const body = (
    <Card
      size="small"
      style={{
        width: 176,
        cursor: props.onClick !== undefined ? 'pointer' : undefined,
        boxShadow: token.boxShadowTertiary,
      }}
      styles={{ body: { padding: '8px 12px' } }}
      onClick={props.onClick}
    >
      <div
        style={{
          fontSize: 12,
          color: token.colorTextTertiary,
          display: 'flex',
          justifyContent: 'space-between',
        }}
      >
        <span>{props.title}</span>
        {props.badge !== undefined && (
          <Tag
            color={props.badge.color}
            style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: '16px' }}
          >
            {props.badge.text}
          </Tag>
        )}
      </div>
      <div style={{ fontSize: 20, fontWeight: 600 }}>
        {display}
        {props.value != null && props.unit !== undefined ? (
          <span style={{ fontSize: 12, fontWeight: 400 }}> {props.unit}</span>
        ) : null}
      </div>
      <div style={{ fontSize: 12, color: token.colorTextTertiary }}>
        {props.placeholderNote ??
          (props.value != null && props.sub !== undefined ? props.sub : (props.clickable ?? ''))}
      </div>
    </Card>
  );
  return props.onClick !== undefined ? <Tooltip title={props.clickable}>{body}</Tooltip> : body;
}

function stateLabel(state: string | undefined): string {
  return state === undefined
    ? RUN_STATE_META.unknown.label
    : RUN_STATE_META[state as keyof typeof RUN_STATE_META].label;
}

function stateTagColor(state: string | undefined): string {
  return state === undefined
    ? 'default'
    : RUN_STATE_META[state as keyof typeof RUN_STATE_META].color;
}
