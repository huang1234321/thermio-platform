/**
 * React 薄封装（ui/viz-3d.md D1：命令式 Three.js + 薄 React 壳——React 只管
 * 生命周期与 props 同步，帧循环/拾取/后处理全在引擎，无 R3F）。
 *
 * 约定：
 * - 装载按 (manifestUrl, modelUrl, expectedSha256) 键重跑；StrictMode 双挂载安全
 *   （cleanup → PlantScene.dispose() → 内部 AbortController 中止在途 fetch）。
 * - 构造失败（jsdom / 无 WebGL）→ onError('webgl_unavailable')，页面走降级链
 *   （M3-monitor §5.1：错误块 / 切 2D 模板）；本组件不渲染业务错误 UI。
 * - states / highlights / fanSpeeds 是 bind-core 求值结果（§6.1），由页面喂入。
 * - 标签：引擎只做投影定位；样式归页面（baseline token）。labelIds × manifest
 *   决定渲染哪些锚点，renderLabel 出内容。
 * - themeColors 深浅色切换时热更新（outline 语义色）；材质外观不变（§6.3）。
 */
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { PlantScene } from '../engine/PlantScene.js';
import type {
  CircuitFilter,
  HighlightState,
  ObjectRunState,
  SceneErrorKind,
  SceneHoverInfo,
  SceneThemeColors,
} from '../engine/types.js';
import type { ManifestAsset, SceneManifest } from '../schema.js';

export interface Scene3DProps {
  readonly manifestUrl: string;
  readonly modelUrl: string;
  readonly expectedSha256?: string | undefined;
  /** Draco 解码器自托管路径（O1；默认 '/draco/'）。 */
  readonly decoderPath?: string | undefined;
  readonly themeColors?: SceneThemeColors | undefined;
  /** objectId → 运行态（bind-core states，§6.1）。 */
  readonly states?: Readonly<Record<string, ObjectRunState>> | undefined;
  /** objectId → 高亮级（bind-core highlights；null = 清除）。 */
  readonly highlights?: Readonly<Record<string, HighlightState>> | undefined;
  /** objectId → 转子转速 rad/s（motion-fan）。 */
  readonly fanSpeeds?: Readonly<Record<string, number>> | undefined;
  readonly selectedId?: string | null | undefined;
  readonly filter?: CircuitFilter | undefined;
  readonly flowEnabled?: boolean | undefined;
  readonly labelsEnabled?: boolean | undefined;
  readonly labelIds?: readonly string[] | undefined;
  readonly renderLabel?: ((asset: ManifestAsset) => ReactNode) | undefined;
  readonly className?: string | undefined;
  readonly style?: CSSProperties | undefined;
  readonly onReady?: ((scene: PlantScene, manifest: SceneManifest) => void) | undefined;
  readonly onProgress?: ((percent: number) => void) | undefined;
  readonly onSelect?: ((objectId: string | null) => void) | undefined;
  readonly onHover?: ((hover: SceneHoverInfo | null) => void) | undefined;
  readonly onError?: ((kind: SceneErrorKind, message: string) => void) | undefined;
  readonly onView?: ((label: string) => void) | undefined;
}

export function Scene3D(props: Scene3DProps): ReactNode {
  const {
    manifestUrl,
    modelUrl,
    expectedSha256,
    decoderPath,
    themeColors,
    states,
    highlights,
    fanSpeeds,
    selectedId,
    filter = 'ALL',
    flowEnabled = true,
    labelsEnabled = true,
    labelIds,
    renderLabel,
    className,
    style,
    onReady,
    onProgress,
    onSelect,
    onHover,
    onError,
    onView,
  } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<PlantScene | null>(null);
  const [manifest, setManifest] = useState<SceneManifest | null>(null);
  // 回调走 ref，避免 identity 变化触发重挂载（页面每渲染都会新建闭包）
  const callbacksRef = useRef({ onReady, onProgress, onSelect, onHover, onError, onView });
  callbacksRef.current = { onReady, onProgress, onSelect, onHover, onError, onView };

  // 生命周期：创建 → load →（cleanup）dispose。依赖只有装载键。
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    let disposed = false;
    let instance: PlantScene | null = null;
    const options = callbacksRef.current;
    // exactOptionalPropertyTypes：仅在提供时写入可选键
    const sceneOptions: { themeColors?: SceneThemeColors; decoderPath?: string } = {};
    if (themeColors !== undefined) sceneOptions.themeColors = themeColors;
    if (decoderPath !== undefined) sceneOptions.decoderPath = decoderPath;
    try {
      instance = new PlantScene(
        host,
        {
          onReady: (value) => {
            if (!disposed) setManifest(value);
            if (instance !== null) options.onReady?.(instance, value);
          },
          onProgress: (percent) => options.onProgress?.(percent),
          onSelect: (id) => options.onSelect?.(id),
          onHover: (hover) => options.onHover?.(hover),
          onError: (kind, message) => options.onError?.(kind, message),
          onView: (label) => options.onView?.(label),
        },
        sceneOptions,
      );
    } catch {
      options.onError?.('webgl_unavailable', '当前浏览器/环境不支持 WebGL 三维渲染');
      return;
    }
    sceneRef.current = instance;
    const loadOptions: { manifestUrl: string; modelUrl: string; expectedSha256?: string } = {
      manifestUrl,
      modelUrl,
    };
    if (expectedSha256 !== undefined) loadOptions.expectedSha256 = expectedSha256;
    instance.load(loadOptions).catch(() => {
      /* 错误已经 onError 通报；页面降级链接管 */
    });
    return () => {
      disposed = true;
      sceneRef.current = null;
      instance.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅装载键变化才重建场景
  }, [manifestUrl, modelUrl, expectedSha256]);

  // props → 引擎同步（幂等批接口；render 循环每帧消费，与数据推送解耦）
  useEffect(() => {
    if (states !== undefined) sceneRef.current?.applyStates(states);
  }, [states]);
  useEffect(() => {
    if (highlights !== undefined) sceneRef.current?.applyHighlight(highlights);
  }, [highlights]);
  useEffect(() => {
    if (fanSpeeds === undefined) return;
    for (const [id, speed] of Object.entries(fanSpeeds)) sceneRef.current?.applyFanSpeed(id, speed);
  }, [fanSpeeds]);
  useEffect(() => {
    sceneRef.current?.select(selectedId ?? null);
  }, [selectedId]);
  useEffect(() => {
    sceneRef.current?.setFilter(filter);
  }, [filter]);
  useEffect(() => {
    sceneRef.current?.setFlowEnabled(flowEnabled);
  }, [flowEnabled]);
  useEffect(() => {
    sceneRef.current?.setLabelsEnabled(labelsEnabled);
  }, [labelsEnabled]);
  useEffect(() => {
    if (themeColors !== undefined) sceneRef.current?.setThemeColors(themeColors);
  }, [themeColors]);
  // 场景重建后重放当前 props（load 完成前 apply 调用为空操作）
  useEffect(() => {
    const scene = sceneRef.current;
    if (scene === null || !scene.isReady()) return;
    if (states !== undefined) scene.applyStates(states);
    if (highlights !== undefined) scene.applyHighlight(highlights);
    scene.select(selectedId ?? null);
    scene.setFilter(filter);
  }, [manifest, states, highlights, selectedId, filter]);

  const bindLabel = (id: string) => (element: HTMLElement | null) => {
    sceneRef.current?.bindLabel(id, element);
  };

  const labelAssets =
    manifest !== null && labelIds !== undefined && renderLabel !== undefined
      ? labelIds
          .map((id) => manifest.assets.find((asset) => asset.id === id))
          .filter((asset): asset is ManifestAsset => asset !== undefined)
      : [];

  return (
    <div
      ref={hostRef}
      className={className}
      style={{ position: 'relative', height: '100%', ...style }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          overflow: 'hidden',
          pointerEvents: 'none',
        }}
      >
        {labelAssets.map((asset) => (
          <div
            key={asset.id}
            ref={bindLabel(asset.id)}
            hidden
            style={{ position: 'absolute', left: 0, top: 0, willChange: 'transform' }}
          >
            {renderLabel !== undefined ? renderLabel(asset) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
