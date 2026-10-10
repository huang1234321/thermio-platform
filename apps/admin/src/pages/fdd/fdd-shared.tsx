/**
 * FDD 域共享件（modules/M6-fdd.md §7，IMPL-16 切片 / DAT-212）：
 * 发现状态徽标、抽检徽标（§2.2 正交判定）、S3 采样预设等纯展示/纯函数件。
 * severity 五级色板复用告警域（--ti-sev-* token，跨页一致性）。
 */
import { Tag } from 'antd';
import type {
  Capability,
  FddFindingStatus,
  FddOverview,
  FddReviewResult,
} from '@thermio/shared-types';
import { useCapabilities } from '../../app/auth-context.js';

/** 发现状态机（§2.1：open 未决 / resolved 已消除〔系统〕/ ignored 已忽略〔人工〕）。 */
export const FDD_STATUS_LABEL: Record<FddFindingStatus, string> = {
  open: '未决',
  resolved: '已消除',
  ignored: '已忽略',
};

const FDD_STATUS_COLOR: Record<FddFindingStatus, string> = {
  open: 'error',
  resolved: 'default',
  ignored: 'warning',
};

export function FddStatusTag({ status }: { status: FddFindingStatus }): React.ReactNode {
  return <Tag color={FDD_STATUS_COLOR[status]}>{FDD_STATUS_LABEL[status]}</Tag>;
}

/** 抽检徽标（§7.2：✓真实 / ✗误报 / 未抽检灰点——正交判定不进状态机）。 */
export function ReviewBadge({
  review,
}: {
  review: { result: FddReviewResult } | null;
}): React.ReactNode {
  if (review === null) return <Tag style={{ marginInlineEnd: 0 }}>未抽检</Tag>;
  return review.result === 'confirmed' ? (
    <Tag color="green" style={{ marginInlineEnd: 0 }}>
      ✓ 真实故障
    </Tag>
  ) : (
    <Tag color="red" style={{ marginInlineEnd: 0 }}>
      ✗ 误报
    </Tag>
  );
}

export const REVIEW_RESULT_LABEL: Record<FddReviewResult, string> = {
  confirmed: '真实故障（现场确认）',
  false_positive: '误报',
};

/** 能力显隐（§5：浏览 fdd.read；抽检/忽略 fdd.write——operator+）。 */
export function useHasFddCapability(capability: Capability): boolean {
  const capabilities = useCapabilities();
  return capabilities.includes(capability);
}

/**
 * S3 采样预设（§5.2/§8）：本周一零点 + 未抽检。分母只计已抽检，存量 backlog
 * 一并进抽检池是**有意为之**（「不少于」语义）。
 */
export function weeklySamplePreset(now: Date = new Date()): { from: string; to: string } {
  // 周界锚定业务时区北京（UTC+8），与运行环境本地时区解耦：采样窗口是服务端
  // 查询口径（§5.2「本周一零点」为楼宇业务日），若按浏览器/runner 本地时区取整，
  // 非 +08 环境会偏移 8h（CI 为 UTC 时实测 3 例失败）。
  const BUS_TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
  const shifted = new Date(now.getTime() + BUS_TZ_OFFSET_MS);
  const day = shifted.getUTCDay(); // 0=周日
  const mondayOffset = day === 0 ? 6 : day - 1;
  const mondayShifted = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() - mondayOffset,
  );
  const monday = new Date(mondayShifted - BUS_TZ_OFFSET_MS);
  return { from: monday.toISOString(), to: now.toISOString() };
}

/** 命中率展示（§4.5：reviewed=0 → null →「—」；否则百分比整数）。 */
export function hitRateText(overview: FddOverview): string {
  const rate = overview.review_stats.hit_rate;
  return rate === null ? '—' : `${String(Math.round(rate * 100))}%`;
}

/** 概览页统一标题（楼宇上下文可空 = 全部授权楼宇聚合，§5.1）。 */
export function overviewTitle(buildingName: string | undefined): string {
  return buildingName === undefined ? 'FDD 报告 · 全部楼宇' : `FDD 报告 · ${buildingName}`;
}
