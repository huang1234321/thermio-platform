/**
 * 引擎公共类型（ui/viz-3d.md §2 engine/types.ts）。
 *
 * 引擎只吃求值结果（M3-monitor §6.1）：运行态 / 高亮 / 转速由页面层求值后经
 * applyStates / applyHighlight / applyFanSpeed 喂入，引擎不含业务数据逻辑。
 */

/** 回路筛选值（§5.3：ALL/CHW/CW + 图例四回路细分透传）。 */
export type CircuitFilter = 'ALL' | 'CHW' | 'CW' | 'CHWS' | 'CHWR' | 'CWS' | 'CWR';

/** 对象运行态（bind-core 求值结果；无绑定对象由引擎按 standby 默认，§5.5）。 */
export type ObjectRunState = 'running' | 'standby';

/** 高亮级别（§6.3：warning 轮廓 / alarm 轮廓 + 脉动；null = 清除）。 */
export type HighlightState = 'warning' | 'alarm' | null;

/** 错误类别（§5.1 降级链判据；页面按类别决定「切 2D」或「错误块」）。 */
export type SceneErrorKind =
  | 'webgl_unavailable'
  | 'context_lost'
  | 'manifest_invalid'
  | 'asset_unavailable'
  | 'sha256_mismatch'
  | 'load_failed';

/** 高亮/选中色（UI chrome 走 token：页面解析 CSS var 后传入；缺省用浅色档值）。 */
export interface SceneThemeColors {
  readonly selected: string;
  readonly warning: string;
  readonly alarm: string;
}

export interface SceneHoverInfo {
  readonly id: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
}

export interface SceneCallbacks {
  onReady?: (manifest: import('../schema').SceneManifest) => void;
  onProgress?: (percent: number) => void;
  onSelect?: (objectId: string | null) => void;
  onHover?: (hover: SceneHoverInfo | null) => void;
  onError?: (kind: SceneErrorKind, message: string) => void;
  onView?: (label: string) => void;
}

export interface LoadSceneOptions {
  readonly manifestUrl: string;
  readonly modelUrl: string;
  /** GLB sha256（SceneDetail.assets.model.sha256；不符 → sha256_mismatch → 降级）。 */
  readonly expectedSha256?: string;
  readonly signal?: AbortSignal;
}
