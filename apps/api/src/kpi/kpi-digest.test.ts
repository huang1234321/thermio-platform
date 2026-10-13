/**
 * M11 订阅调度纯函数单测（M11-kpi-dashboard §6.4；IMPL-22 / DAT-246）。
 * 周 tick 目标期：模拟时钟锚点（§9.5）——周一 08:00 前不投、08:00 后目标期 =
 * [本周一−7d, 本周一)（Asia/Shanghai 本地日界）。
 */
import { describe, expect, it } from 'vitest';
import { weeklyPeriodOf } from './kpi-digest.service.js';

/** 上海时刻 → Date（本地 y-m-d h:m）。 */
function shanghai(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - 8 * 3_600_000);
}

describe('weeklyPeriodOf（周投递目标期）', () => {
  it('shouldTargetLastCompleteWeek_onMonday0800', () => {
    // 2026-10-12 是周一；08:00 整 → 目标期 [10-05, 10-12)
    expect(weeklyPeriodOf(shanghai(2026, 10, 12, 8, 0))).toEqual({
      startDate: '2026-10-05',
      endDate: '2026-10-12',
      due: true,
    });
  });

  it('shouldNotDeliver_beforeMonday0800', () => {
    expect(weeklyPeriodOf(shanghai(2026, 10, 12, 7, 59)).due).toBe(false);
    expect(weeklyPeriodOf(shanghai(2026, 10, 12, 0, 1)).due).toBe(false);
    // 周日 20:00：本周（目标期 [10-05,10-12)）周一 08:00 早已过 → due=true 补投窗
    expect(weeklyPeriodOf(shanghai(2026, 10, 11, 20)).due).toBe(true);
  });

  it('shouldKeepSameTargetPeriod_laterInWeek（补投幂等窗）', () => {
    // 周三 14:00：目标期仍为上一完整自然周 [10-05, 10-12)
    expect(weeklyPeriodOf(shanghai(2026, 10, 14, 14))).toEqual({
      startDate: '2026-10-05',
      endDate: '2026-10-12',
      due: true,
    });
    // 下周一 08:00 → 滚动到 [10-12, 10-19)
    expect(weeklyPeriodOf(shanghai(2026, 10, 19, 8))).toEqual({
      startDate: '2026-10-12',
      endDate: '2026-10-19',
      due: true,
    });
  });

  it('shouldResolveMondayCorrectly_acrossMonthBoundary', () => {
    // 2026-11-02 周一 08:00 → [10-26, 11-02)
    expect(weeklyPeriodOf(shanghai(2026, 11, 2, 8))).toEqual({
      startDate: '2026-10-26',
      endDate: '2026-11-02',
      due: true,
    });
  });
});
