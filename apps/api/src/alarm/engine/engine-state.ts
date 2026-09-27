/**
 * 告警引擎状态机（纯函数，M4-alarm.md §5.3；IMPL-13 / DAT-116）。
 *
 * 对称双窗 flap 吸收（§4.1）：
 * - violation 边沿起算 sustained_s，窗内 clear → 取消开启；
 * - clear 边沿起算 recovery_s，窗内再 violation → 取消关闭（活跃告警保持，不重开新行）。
 *
 * 状态表（进程内，§5.3-2）：key (tenant_id, category, source_type, source_id) →
 * { violatingSince, pendingCloseAt, alarmId, rule 快照 }。重启重建见 §5.6
 * （质量通道 2h 重放 + gateway 通道电平真值对账 + 本模块边沿幂等重放）。
 */

/** 求值用规则快照（边沿时点捕获；规则 PATCH 不回溯在途，§3.9）。 */
export interface RuleSnapshot {
  readonly ruleId: string;
  readonly severity: 'info' | 'warning' | 'minor' | 'major' | 'critical';
  readonly sustainedS: number;
  readonly recoveryS: number;
}

/** 进程内状态表条目（时间统一 epoch ms）。 */
export interface EngineEntry {
  violatingSince: number | null;
  pendingCloseAt: number | null;
  /** 关联的活跃告警（open/acked/suppressed）；null = 未开或已关。 */
  alarmId: number | null;
  /** violation 边沿捕获的规则快照（无规则 = 不会开告警，仅记 violating 态用于 WARN 去重）。 */
  rule: RuleSnapshot | null;
}

export function emptyEntry(): EngineEntry {
  return { violatingSince: null, pendingCloseAt: null, alarmId: null, rule: null };
}

/** violation 边沿（§5.3-3）：记/续 violating_since，取消未决关闭（flap 吸收）。 */
export function applyViolation(
  entry: EngineEntry,
  at: number,
  rule: RuleSnapshot | null,
): EngineEntry {
  return {
    ...entry,
    violatingSince: entry.violatingSince ?? at,
    pendingCloseAt: null,
    rule: rule ?? entry.rule,
  };
}

/** clear 边沿（§5.3-5）：未开 → 清 violating；已开 → 记 pending_close（回稳窗）。
 * rule 为 clear 边沿时点的规则快照（§3.9「变更只影响后续求值」——回稳窗按当前参数，
 * 已在计的 pending_close 不回溯调整）。 */
export function applyClear(
  entry: EngineEntry,
  at: number,
  rule?: RuleSnapshot | null,
): EngineEntry {
  if (entry.alarmId === null) {
    return { ...entry, violatingSince: null, pendingCloseAt: null, rule: null };
  }
  const effective = rule ?? entry.rule;
  const recoveryS = effective?.recoveryS ?? 0;
  return {
    ...entry,
    violatingSince: null,
    pendingCloseAt: at + recoveryS * 1000,
    rule: effective ?? null,
  };
}

/** 防抖到期（§5.3-4）：violating 持续 sustained_s 无 clear 且尚无活跃告警。 */
export function sustainedDue(entry: EngineEntry, now: number): boolean {
  if (entry.violatingSince === null || entry.alarmId !== null || entry.rule === null) {
    return false;
  }
  return now >= entry.violatingSince + entry.rule.sustainedS * 1000;
}

/** 回稳到期（§5.3-6）：pending_close 到点（告警已开）。 */
export function recoveryDue(entry: EngineEntry, now: number): boolean {
  return entry.pendingCloseAt !== null && entry.alarmId !== null && now >= entry.pendingCloseAt;
}

/** 引擎键（去重键 §5.3-3：活跃告警存在 → 不重复开）。 */
export interface EngineKey {
  readonly tenantId: string;
  readonly category: string;
  readonly sourceType: 'point' | 'equipment' | 'system' | 'gateway';
  readonly sourceId: string;
}

export function engineKeyString(key: EngineKey): string {
  return `${key.tenantId}|${key.category}|${key.sourceType}|${key.sourceId}`;
}

/** 质量事件 → 边沿事件（§5.3-1 归一化；ts_skew/unit_unconverted 非边沿 → null）。 */
export type QualityEdge = 'violation' | 'clear';

export function qualityEdgeOf(event: string): QualityEdge | null {
  if (event === 'stale_set') return 'violation';
  if (event === 'stale_clear') return 'clear';
  return null;
}
