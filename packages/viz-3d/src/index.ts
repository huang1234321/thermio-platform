/**
 * @thermio/viz-3d — 三维组态引擎（ui/viz-3d.md：demo 移植 + 命令式 API + React 薄壳）。
 *
 * 依赖边界（tooling/eslint ALLOWED_INTERNAL_DEPS）：本包只依赖 shared-types /
 * scene-schema；React 为 peerDep。消费方向：apps/* → 本包；scene-schema → bind-core
 * 是另一条独立链（求值与本包互不依赖，M3-monitor §6.1）。
 */
export { PlantScene } from './engine/PlantScene.js';
export { FlowSystem, buildRoute, sampleRoute } from './engine/FlowSystem.js';
export type { FlowRoute, RouteSample } from './engine/FlowSystem.js';
export {
  DEFAULT_THEME_COLORS,
  PIPE_SURFACE_COLORS,
  STATUS_COLORS,
  STATUS_SLOT_NAMES,
  statusColorOf,
} from './engine/materials.js';
export type {
  CircuitFilter,
  HighlightState,
  LoadSceneOptions,
  ObjectRunState,
  SceneCallbacks,
  SceneErrorKind,
  SceneHoverInfo,
  SceneThemeColors,
} from './engine/types.js';
export {
  ManifestAssetSchema,
  ManifestFlowPathSchema,
  SceneManifestSchema,
  Vec3Schema,
} from './schema.js';
export type { ManifestAsset, ManifestFlowPath, SceneManifest } from './schema.js';
export { Scene3D } from './react/Scene3D.js';
export type { Scene3DProps } from './react/Scene3D.js';
