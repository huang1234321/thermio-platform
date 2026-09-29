/**
 * 资产页面共享件（M1-asset §7）：错误文案 + 能力判定 + 枚举中文映射。
 * 布局/三态/键盘规范继承 ui/baseline（§2–§4）不重述；antd 组件面与 settings-users 同源。
 */
import { useCapabilities } from '../../app/auth-context.js';
import { ApiError } from '../../app/api-client.js';
import type { BuildingType, Capability } from '@thermio/shared-types';

export function errorText(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? cause.parsed.message : fallback;
}

/** 当前会话是否持有某能力（SEC-AZ-05：UI 只看 /me 下发的 capabilities）。 */
export function useHasCapability(capability: Capability): boolean {
  return useCapabilities().includes(capability);
}

/**
 * building_type 枚举中文映射（契约五枚全表，DAT-157 修单：总览卡片外显原始枚举
 * 扣分）。M1-asset 未定义展示词表，本表为 UI 层展示映射；未命中回落原始值
 * （枚举扩展前不至于空白）。
 */
export const BUILDING_TYPE_LABEL: Record<BuildingType, string> = {
  office: '办公楼',
  mall: '商场',
  hospital: '医院',
  campus: '校园',
  gov: '政府机构',
};

export function buildingTypeLabel(value: string | null): string {
  if (value === null) return '—';
  // 经 as Record 放宽索引类型：API 前向扩展枚举时保留原始值回落，不致空白
  return (BUILDING_TYPE_LABEL as Record<string, string | undefined>)[value] ?? value;
}
