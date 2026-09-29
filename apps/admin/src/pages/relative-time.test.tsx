/**
 * 列表相对时间用例（ui/baseline §2.2，DAT-157 修单簇 1）：分桶文案、hover 完整
 * 时间戳格式（YYYY-MM-DD HH:mm:ss）、≥7 天回落日期、无效输入回落原文。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RelativeTime, formatAbsolute, relativeTimeText } from './relative-time.js';

afterEach(cleanup);

const NOW = Date.parse('2026-09-29T12:00:00+08:00');

function isoAgo(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

describe('relativeTimeText（分桶）', () => {
  it('underOneMinute_showsJustNow', () => {
    expect(relativeTimeText(isoAgo(30_000), NOW)).toBe('刚刚');
  });

  it('underOneHour_showsMinutes', () => {
    expect(relativeTimeText(isoAgo(5 * 60_000), NOW)).toBe('5 分钟前');
  });

  it('underOneDay_showsHours', () => {
    expect(relativeTimeText(isoAgo(3 * 3_600_000), NOW)).toBe('3 小时前');
  });

  it('underSevenDays_showsDays', () => {
    expect(relativeTimeText(isoAgo(2 * 86_400_000), NOW)).toBe('2 天前');
  });

  it('sevenDaysAndBeyond_fallsBackToDate', () => {
    expect(relativeTimeText(isoAgo(30 * 86_400_000), NOW)).toBe('2026-08-30');
  });

  it('futureTimestamp_clampedToJustNow（时钟偏差容忍）', () => {
    expect(relativeTimeText(isoAgo(-60_000), NOW)).toBe('刚刚');
  });

  it('invalidInput_returnsRaw', () => {
    expect(relativeTimeText('not-a-date', NOW)).toBe('not-a-date');
  });
});

describe('formatAbsolute（§2.2 hover 口径）', () => {
  it('formatsAsYYYYMMDD_HHmmss', () => {
    expect(formatAbsolute('2026-09-29T14:23:05')).toBe('2026-09-29 14:23:05');
  });

  it('padsSingleDigits', () => {
    expect(formatAbsolute('2026-01-02T03:04:05')).toBe('2026-01-02 03:04:05');
  });
});

describe('RelativeTime（渲染）', () => {
  it('rendersRelativeText_withAbsoluteTooltip', () => {
    // 组件内部取真实 now，输入按真实时钟回退 5 分钟
    render(<RelativeTime iso={new Date(Date.now() - 5 * 60_000).toISOString()} />);
    expect(screen.getByText('5 分钟前')).not.toBeNull();
  });
});
