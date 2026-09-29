/**
 * building_type 中文映射用例（DAT-157 修单单点：总览卡片外显原始枚举扣分；
 * 契约五枚全表 + 空值/未知值回落）。
 */
import { describe, expect, it } from 'vitest';
import { buildingTypeLabel } from './asset-shared.js';

describe('buildingTypeLabel', () => {
  it('mapsAllFiveContractValues', () => {
    expect(buildingTypeLabel('office')).toBe('办公楼');
    expect(buildingTypeLabel('mall')).toBe('商场');
    expect(buildingTypeLabel('hospital')).toBe('医院');
    expect(buildingTypeLabel('campus')).toBe('校园');
    expect(buildingTypeLabel('gov')).toBe('政府机构');
  });

  it('nullFallsBackToDash', () => {
    expect(buildingTypeLabel(null)).toBe('—');
  });

  it('unknownValueFallsBackToRaw（枚举前向扩展）', () => {
    expect(buildingTypeLabel('data_center')).toBe('data_center');
  });
});
