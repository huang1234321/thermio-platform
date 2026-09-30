/**
 * FDD 共享纯函数单测（modules/M6-fdd.md §7/§8，IMPL-16 切片 / DAT-212）：
 * S3 采样预设（周一零点锚）、命中率展示（reviewed=0 →「—」）、概览标题。
 */
import { describe, expect, it } from 'vitest';
import type { FddOverview } from '@thermio/shared-types';
import { hitRateText, overviewTitle, weeklySamplePreset } from './fdd-shared.js';

function overviewOf(hitRate: number | null): FddOverview {
  return {
    building_id: null,
    open: { total: 0, by_severity: { info: 0, warning: 0, minor: 0, major: 0, critical: 0 } },
    health: null,
    review_stats: {
      window_from: '2026-09-23T02:00:00+00:00',
      new_findings: 10,
      reviewed: hitRate === null ? 0 : 4,
      confirmed: hitRate === null ? 0 : 3,
      false_positive: hitRate === null ? 0 : 1,
      hit_rate: hitRate,
    },
  };
}

describe('weeklySamplePreset（§5.2 S3 采样预设）', () => {
  // 比较取 epoch（toISOString 恒 Z 形——字面比较会误判相同时刻）
  it('周一 14:30 → 本周一零点起', () => {
    const preset = weeklySamplePreset(new Date('2026-09-28T14:30:00+08:00')); // 周一
    expect(Date.parse(preset.from)).toBe(Date.parse('2026-09-28T00:00:00+08:00'));
    expect(Date.parse(preset.to)).toBe(Date.parse('2026-09-28T14:30:00+08:00'));
  });

  it('周三 09:00 → 回退到本周一零点', () => {
    const preset = weeklySamplePreset(new Date('2026-09-30T09:00:00+08:00')); // 周三
    expect(Date.parse(preset.from)).toBe(Date.parse('2026-09-28T00:00:00+08:00'));
  });

  it('周日 20:00 → 回退 6 天到本周一（非上周一）', () => {
    const preset = weeklySamplePreset(new Date('2026-10-04T20:00:00+08:00')); // 周日
    expect(Date.parse(preset.from)).toBe(Date.parse('2026-09-28T00:00:00+08:00'));
  });
});

describe('hitRateText（§4.5 reviewed=0 → null →「—」）', () => {
  it('null → em dash', () => {
    expect(hitRateText(overviewOf(null))).toBe('—');
  });
  it('0.75 → 75%', () => {
    expect(hitRateText(overviewOf(0.75))).toBe('75%');
  });
});

describe('overviewTitle', () => {
  it('楼宇上下文可空', () => {
    expect(overviewTitle(undefined)).toBe('FDD 报告 · 全部楼宇');
    expect(overviewTitle('A1 楼')).toBe('FDD 报告 · A1 楼');
  });
});
