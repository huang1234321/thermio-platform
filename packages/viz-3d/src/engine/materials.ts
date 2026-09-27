/**
 * 状态材质槽约定（ui/viz-3d.md §3.1③：材质槽名与高亮色抽离）。
 *
 * 两套色分工（M3-monitor §6.3）：材质是「资产外观」（demo 确认稿值原样保留——
 * 运行亮绿 / 备用灰、四回路管色）；高亮是「运行语义」（走 baseline token `--ti-sev-*`，
 * 由页面解析后经 options.themeColors 注入，此处仅浅色档缺省值）。
 */

/** 材质槽名（GLB 内约定：对象外观按槽名切换，demo setOperating 同源）。 */
export const STATUS_SLOT_NAMES = ['Status', 'Idle'] as const;

/** 运行 / 备用材质色（demo 确认稿：#70ddac 亮绿 emissive / #8c9da6 灰）。 */
export const STATUS_COLORS = {
  running: '#70ddac',
  standby: '#8c9da6',
} as const;

/** 管路材质色（demo 确认稿四回路；材质名 = 回路名）。 */
export const PIPE_SURFACE_COLORS = {
  CHWS: '#0878b5',
  CHWR: '#219eae',
  CWS: '#b97e27',
  CWR: '#a3391e',
} as const;

/** 材质名 → 管路色（运行时材质名可任意，查不到 = undefined；GLB 材质来自数据）。 */
export function pipeSurfaceColorOf(name: string): string | undefined {
  return PIPE_SURFACE_COLORS[name as keyof typeof PIPE_SURFACE_COLORS];
}

/** 高亮 / 选中缺省色（baseline §2 浅色档；深色档由页面注入覆盖）。 */
export const DEFAULT_THEME_COLORS = {
  selected: '#0B7285',
  warning: '#AD6800',
  alarm: '#CF1322',
} as const;

import type { ObjectRunState } from './types.js';

/** 纯函数：运行态 → 材质槽色（单测锚点：状态→材质映射）。 */
export function statusColorOf(state: ObjectRunState): string {
  return state === 'running' ? STATUS_COLORS.running : STATUS_COLORS.standby;
}
