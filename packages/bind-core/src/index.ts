/**
 * @thermio/bind-core —— 绑定求值引擎（point_id ↔ 节点属性），viz-2d / viz-3d 共用
 * （ADR-010；M3-monitor §6：纯函数求值——绑定规则 × 最新值 → 槽位状态/值/质量）。
 *
 * 架构纪律（M3-monitor §6.1）：
 * - 求值器与渲染器解耦：viz-3d 引擎只消费求值结果（applyStates / applyHighlight /
 *   applyFanSpeed + 面板值），不内嵌绑定逻辑；本包不依赖 viz-3d / admin；
 * - 输入 = SSE latest-value store（服务端唯一节流，客户端 O(1) 覆写）+ 告警快照
 *   （进页拉取，IMPL-13 合入前为 stub）+ 高亮规则；输出全部为纯数据，可独立单测。
 *
 * 依赖边界（platform §2.2：bind-core ← shared-types 单向）：绑定/高亮输入形状在本包
 * 以结构类型镜像 @thermio/scene-schema 的 SceneConfig（slot/kind/fmt/level 逐字一致），
 * admin 侧直接传 SceneConfig 结构兼容；镜像一致性由 admin 侧 monitor 契约测试钉住。
 *
 * 求值规则锚点（M3-monitor）：
 * - §6.2 状态映射：state-run 枚举默认 {"1":"running","0":"standby"}（绑定可覆盖）；
 * - §6.3 高亮：threshold 越限 + alarm-linked open 告警，多规则取最严（warning < alarm），
 *   沿 slot → owner（manifest parent 链）向上传播（父级取子级最严）；
 * - §5.5 stale：绑定值超 stale_timeout_s → 值槽灰化（quality 判定独立于 stale）。
 */

// ---------------------------------------------------------------------------
// 输入形状（scene-schema SceneConfig 结构镜像——见文件头依赖边界注记）
// ---------------------------------------------------------------------------

export type BindingKind = 'state-run' | 'value-text' | 'motion-fan';
export type ValueTextFmt = 'int' | '1-dec';
export type HighlightLevel = 'warning' | 'alarm';
/** 告警级别（M4 域枚举镜像；shared-types 收口后随 DAT-104 迁移）。 */
export type AlarmSeverity = 'info' | 'warning' | 'minor' | 'major' | 'critical';

export interface SceneBindingInput {
  readonly slot: string;
  readonly point_id: number;
  readonly kind: BindingKind;
  // 可选键显式 | undefined（exactOptionalPropertyTypes：scene-schema 解析结果
  // 的可选键带 undefined，镜像必须收得下——结构兼容由 admin 一致性测试钉住）
  readonly enum?: Readonly<Record<string, 'running' | 'standby'>> | undefined;
  readonly fmt?: ValueTextFmt | undefined;
  readonly unit?: string | undefined;
  readonly rad_s_per_hz?: number | undefined;
}

export interface ThresholdRuleInput {
  readonly kind: 'threshold';
  readonly slot: string;
  readonly op: '>' | '>=' | '<' | '<=';
  readonly threshold: number;
  readonly level: HighlightLevel;
}

export interface AlarmLinkedRuleInput {
  readonly kind: 'alarm-linked';
  readonly object_ids: readonly string[];
  readonly level: HighlightLevel;
}

export type HighlightRuleInput = ThresholdRuleInput | AlarmLinkedRuleInput;

export interface SceneConfigInput {
  readonly bindings: readonly SceneBindingInput[];
  readonly highlight_rules: readonly HighlightRuleInput[];
}

// ---------------------------------------------------------------------------
// 求值输入 / 输出
// ---------------------------------------------------------------------------

/** 单点最新值（SSE store / 批量快照统一形态；M3-monitor §3.5/§3.6 值域）。 */
export interface LatestValue {
  readonly value: number | null;
  readonly value_text: string | null;
  /** ISO 时间戳；无数据为 null。 */
  readonly ts: string | null;
  /** quality 位掩码（0 = good，透传不解释）。 */
  readonly quality: number;
}

export type LatestStore = ReadonlyMap<number, LatestValue>;

/** 告警快照条目（页面由 GET /alarms?status=open 聚合；stub 期由 fixtures 提供）。 */
export interface AlarmEntry {
  readonly id: string;
  readonly severity: AlarmSeverity;
  /** 该告警关联的 3D 对象 id（设备对象或传感器所在对象）。 */
  readonly object_ids: readonly string[];
}

export interface EvaluateOptions {
  /** 求值时刻（ms）；测试可注入固定时钟。 */
  readonly nowMs: number;
  /** 绑定值超时转 stale（秒）；M3-monitor §4.2/§5.5。 */
  readonly staleTimeoutS: number;
  /** manifest parent 链（objectId → 父 objectId）；省略则不做向上传播。 */
  readonly parents?: Readonly<Record<string, string>> | undefined;
}

/** value-text 槽位求值结果（属性面板 / 2D 值槽共用）。 */
export interface SlotValue {
  readonly slot: string;
  /** 展示文本（已按 fmt 格式化；unknown → null，页面显「—」）。 */
  readonly text: string | null;
  readonly unit: string | null;
  readonly quality: number;
  readonly stale: boolean;
  /** 是否从未收到值（unknown，§5.5）。 */
  readonly unknown: boolean;
  readonly ts: string | null;
}

export interface SceneEvaluation {
  /** objectId → 运行态（仅 state-run 绑定对象；无绑定对象由引擎按 standby 默认，§5.5）。 */
  readonly states: Readonly<Record<string, 'running' | 'standby'>>;
  /** objectId → 高亮级别（多规则取最严；已含 parent 链向上传播）。 */
  readonly highlights: Readonly<Record<string, HighlightLevel>>;
  /** objectId → 转子角速度 rad/s（motion-fan；无值不产出——引擎随运行态恒速兜底）。 */
  readonly fanSpeeds: Readonly<Record<string, number>>;
  /** slot → 值槽求值（value-text 绑定）。 */
  readonly values: Readonly<Record<string, SlotValue>>;
}

const DEFAULT_RUN_ENUM: Readonly<Record<string, 'running' | 'standby'>> = {
  '1': 'running',
  '0': 'standby',
};

/** 越限比较（threshold 规则；进入/退出滞回随告警域收口，客户端 MVP 直判）。 */
function thresholdHit(op: ThresholdRuleInput['op'], value: number, threshold: number): boolean {
  if (op === '>') return value > threshold;
  if (op === '>=') return value >= threshold;
  if (op === '<') return value < threshold;
  return value <= threshold;
}

/** state-run 绑定求值：value_text 优先（枚态量），数值量回退 String(value)。 */
function resolveRunState(
  binding: SceneBindingInput,
  latest: LatestValue | undefined,
): 'running' | 'standby' | null {
  if (latest === undefined) return null;
  const raw = latest.value_text ?? (latest.value !== null ? String(latest.value) : null);
  if (raw === null) return null;
  const mapping = binding.enum ?? DEFAULT_RUN_ENUM;
  return mapping[raw] ?? null;
}

function formatValueText(value: number, fmt: ValueTextFmt): string {
  return fmt === 'int' ? String(Math.round(value)) : value.toFixed(1);
}

function isStale(ts: string | null, nowMs: number, staleTimeoutS: number): boolean {
  if (ts === null) return true;
  const ageMs = nowMs - Date.parse(ts);
  return !Number.isFinite(ageMs) || ageMs > staleTimeoutS * 1000;
}

function slotObject(slot: string): string {
  return slot.slice(0, slot.indexOf(':'));
}

/**
 * 场景求值主入口（纯函数）。畸形绑定（slot 指向不存在对象等）由配置层校验；
 * 运行时防御（M3-monitor §10.3）：缺值不阻塞其余绑定，逐条独立求值。
 */
export function evaluateScene(
  config: SceneConfigInput,
  latest: LatestStore,
  alarms: readonly AlarmEntry[],
  options: EvaluateOptions,
): SceneEvaluation {
  const states: Record<string, 'running' | 'standby'> = {};
  const highlights: Record<string, HighlightLevel> = {};
  const fanSpeeds: Record<string, number> = {};
  const values: Record<string, SlotValue> = {};

  const raiseHighlight = (objectId: string, level: HighlightLevel): void => {
    const current = highlights[objectId];
    if (current === undefined || level === 'alarm') highlights[objectId] = level;
  };

  // ① 直接绑定：state-run / value-text / motion-fan
  for (const binding of config.bindings) {
    const objectId = slotObject(binding.slot);
    const pointLatest = latest.get(binding.point_id);
    if (binding.kind === 'state-run') {
      const state = resolveRunState(binding, pointLatest);
      if (state !== null) states[objectId] = state;
      continue;
    }
    if (binding.kind === 'motion-fan') {
      if (pointLatest !== undefined && pointLatest.value !== null) {
        fanSpeeds[objectId] = (binding.rad_s_per_hz ?? 0.02) * pointLatest.value;
      }
      continue;
    }
    // value-text
    if (
      pointLatest === undefined ||
      (pointLatest.value === null && pointLatest.value_text === null)
    ) {
      values[binding.slot] = {
        slot: binding.slot,
        text: null,
        unit: binding.unit ?? null,
        quality: pointLatest?.quality ?? 0,
        stale: false,
        unknown: true,
        ts: null,
      };
      continue;
    }
    const stale = isStale(pointLatest.ts, options.nowMs, options.staleTimeoutS);
    const text =
      pointLatest.value !== null
        ? formatValueText(pointLatest.value, binding.fmt ?? '1-dec')
        : (pointLatest.value_text ?? null);
    values[binding.slot] = {
      slot: binding.slot,
      text,
      unit: binding.unit ?? null,
      quality: pointLatest.quality,
      stale,
      unknown: false,
      ts: pointLatest.ts,
    };
  }

  // ② threshold 高亮（对 value-text 槽最新值直判）
  for (const rule of config.highlight_rules) {
    if (rule.kind !== 'threshold') continue;
    const slotValue = values[rule.slot];
    if (slotValue?.text === null || slotValue?.text === undefined) continue;
    const numeric = Number(slotValue.text);
    if (Number.isNaN(numeric)) continue;
    if (thresholdHit(rule.op, numeric, rule.threshold)) {
      raiseHighlight(slotObject(rule.slot), rule.level);
    }
  }

  // ③ alarm-linked：规则圈定的对象与告警快照求交
  for (const rule of config.highlight_rules) {
    if (rule.kind !== 'alarm-linked') continue;
    for (const alarm of alarms) {
      for (const objectId of alarm.object_ids) {
        if (rule.object_ids.includes(objectId)) raiseHighlight(objectId, rule.level);
      }
    }
  }

  // ④ 告警快照直映射（接缝语义：任何关联 open 告警的对象都进高亮集，§6.3 状态升级）
  for (const alarm of alarms) {
    const level: HighlightLevel =
      alarm.severity === 'info' || alarm.severity === 'warning' ? 'warning' : 'alarm';
    for (const objectId of alarm.object_ids) raiseHighlight(objectId, level);
  }

  // ⑤ 状态传播：传感器槽 → 所属设备 → 父链（schematic §5.3 同规则，manifest parent 链）
  propagateHighlights(highlights, options.parents);

  return { states, highlights, fanSpeeds, values };
}

/** 取最严向上传播（父级取子级最严；M3-monitor §6.3）。guard 防 parent 环。 */
function propagateHighlights(
  highlights: Record<string, HighlightLevel>,
  parents: Readonly<Record<string, string>> | undefined,
): void {
  if (parents === undefined) return;
  let changed = true;
  let guard = 0;
  while (changed && guard < 16) {
    changed = false;
    guard += 1;
    for (const [objectId, level] of Object.entries(highlights)) {
      const parent = parents[objectId];
      if (parent === undefined) continue;
      const current = highlights[parent];
      if (current === undefined || (level === 'alarm' && current !== 'alarm')) {
        highlights[parent] = level;
        changed = true;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 设备 run_state 求值（页面 2 检索/详情共用；M3-monitor §3.2）
// ---------------------------------------------------------------------------

export interface EquipmentRunInput {
  /** run_status 点位最新值（value_text 或 value 的字符串形态）。 */
  readonly raw: string | null;
  /** 该设备存在 open 告警（非 running 时 → fault，M3-monitor §3.2 求值式）。 */
  readonly hasOpenAlarm: boolean;
  /** 枚举映射（state-run 绑定同款；缺省 {"1":"running","0":"standby"}）。 */
  readonly enumMap?: Readonly<Record<string, 'running' | 'standby'>> | undefined;
}

export type EquipmentRunState = 'running' | 'standby' | 'fault' | 'unknown';

/** run_state 求值（§3.2：fault = 存在 open 告警且非 running）。 */
export function resolveEquipmentRunState(input: EquipmentRunInput): EquipmentRunState {
  if (input.raw === null) return 'unknown';
  const state = (input.enumMap ?? DEFAULT_RUN_ENUM)[input.raw] ?? null;
  if (state === 'running') return 'running';
  if (input.hasOpenAlarm) return 'fault';
  if (state === 'standby') return 'standby';
  return 'unknown';
}

/** 多源高亮取最严（页面徽标着色用）。 */
export function maxHighlightLevel(levels: readonly HighlightLevel[]): HighlightLevel | null {
  let worst: HighlightLevel | null = null;
  for (const level of levels) {
    if (worst === null || (level === 'alarm' && worst !== 'alarm')) worst = level;
  }
  return worst;
}
