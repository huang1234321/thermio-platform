/**
 * 语义映射引擎（M2-import §6：两级自动映射 + 读侧建议，MVP 确定性两源）。
 *
 * 执行序（对每 unmapped 行，§6.1）：
 * 1. 历史精确命中：同租户 status ∈ {applied, checked} 历史作业行 raw_name 完全一致
 *    → 整组采纳（source='history_exact'，score=1）；
 * 2. 关键词规则：静态规则表（发版资产，DM §6 纪律）命中 → quantity_type + unit_std
 *    归一目标；equipment 解析 = 描述 token × 楼宇内设备清单，唯一命中才写。
 *
 * suggestions（§6.2）：读侧历史相似（token 重叠 <1），不自动写库。
 */
import type { RowSuggestion } from '@thermio/shared-types';

/** 关键词规则表 v1（M2-import §6.1 示例 = 首版全集；不区分大小写子串；扩充走 PR）。 */
export interface MappingRule {
  readonly keywords: readonly string[];
  readonly quantity_type: string;
  readonly unit_std: string | null;
}

export const MAPPING_RULES_V1: readonly MappingRule[] = [
  {
    keywords: ['冷冻水供水温度', 'chws', 'chws supply'],
    quantity_type: 'chw_supply_temp',
    unit_std: 'degC',
  },
  { keywords: ['功率', 'kw', 'power'], quantity_type: 'power', unit_std: 'kW' },
  { keywords: ['运行状态', '启停', 'run status'], quantity_type: 'run_status', unit_std: null },
];

/** 历史行（模板知识库面：§6.4 apply 成功作业的行映射即知识库）。 */
export interface HistoryRow {
  readonly raw_name: string;
  readonly raw_description: string | null;
  readonly equipment_id: string | null;
  readonly quantity_type: string | null;
  readonly unit_std: string | null;
}

/** 楼宇内设备清单（equipment 解析候选）。 */
export interface EquipmentCandidate {
  readonly id: string;
  readonly name: string;
  readonly equipment_type: string;
}

/** 自动映射结果（命中两级之一才非 null）。 */
export interface AutoMapResult {
  readonly equipment_id: string | null;
  readonly quantity_type: string | null;
  readonly unit_std: string | null;
  readonly source: 'history_exact' | 'keyword_rule';
}

/** 分词（中英混合：英文/数字 token + 单汉字拆分 + 全角归一）。 */
export function tokenize(text: string): string[] {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return [];
  const tokens = normalized.match(/[a-z0-9_]+/g) ?? [];
  const chars = normalized.match(/[一-鿿]/g) ?? [];
  return [...tokens, ...chars];
}

/** 规则表匹配（raw_name/raw_description 拼接文本，子串不区分大小写）。 */
export function matchRule(rawName: string, rawDescription: string | null): MappingRule | null {
  const haystack = `${rawName} ${rawDescription ?? ''}`.toLowerCase();
  for (const rule of MAPPING_RULES_V1) {
    for (const keyword of rule.keywords) {
      if (haystack.includes(keyword.toLowerCase())) return rule;
    }
  }
  return null;
}

/** CJK 连续段二元组（设备解析粒度：单汉字过粗——「冷水机组」与「冷冻水泵」共享冷/水即误命中；跨段不组词）。 */
export function cjkBigrams(text: string): string[] {
  const normalized = text.toLowerCase();
  const bigrams: string[] = [];
  for (const run of normalized.match(/[一-鿿]+/g) ?? []) {
    for (let i = 0; i + 1 < run.length; i += 1) {
      bigrams.push(run.slice(i, i + 2));
    }
  }
  return bigrams;
}

/** 设备匹配粒度 token：ascii token + CJK 连续段二元组（单汉字不参与——过粗易误命中）。 */
function matchTokens(text: string): Set<string> {
  const normalized = text.toLowerCase();
  const ascii = normalized.match(/[a-z0-9_]+/g) ?? [];
  return new Set([...ascii, ...cjkBigrams(normalized)]);
}

/**
 * equipment 解析（§6.1）：分级匹配，唯一命中才写——
 * 1 级 = 设备名整串子串（现场点号常直接携带设备位号，如 CHL-01_TEMP，强信号优先）；
 * 2 级 = token 重叠（ascii token + CJK 二元组）。同级多命中 = 歧义留空。
 */
export function resolveEquipment(
  rawName: string,
  rawDescription: string | null,
  candidates: readonly EquipmentCandidate[],
): string | null {
  if (candidates.length === 0) return null;
  const text = `${rawName} ${rawDescription ?? ''}`.toLowerCase();
  const tokens = matchTokens(text);

  const nameHits: string[] = [];
  const tokenHits: string[] = [];
  for (const candidate of candidates) {
    const candidateName = candidate.name.trim().toLowerCase();
    if (candidateName.length > 0 && text.includes(candidateName)) {
      nameHits.push(candidate.id);
      continue;
    }
    const candidateTokens = matchTokens(`${candidate.name} ${candidate.equipment_type}`);
    if (candidateTokens.size > 0 && [...candidateTokens].some((token) => tokens.has(token))) {
      tokenHits.push(candidate.id);
    }
  }
  const strong = nameHits.length > 0 ? nameHits : tokenHits;
  return strong.length === 1 ? (strong[0] ?? null) : null; // 歧义/零命中 → null（equipment_unassigned 警告位）
}

/** 两级引擎单行执行（历史精确 → 关键词规则）。 */
export function autoMapRow(
  rawName: string,
  rawDescription: string | null,
  history: readonly HistoryRow[],
  equipmentCandidates: readonly EquipmentCandidate[],
): AutoMapResult | null {
  // 1. 历史精确命中（raw_name 完全一致 → 整组采纳）
  for (const row of history) {
    if (row.raw_name === rawName && row.quantity_type !== null) {
      return {
        equipment_id: row.equipment_id,
        quantity_type: row.quantity_type,
        unit_std: row.unit_std,
        source: 'history_exact',
      };
    }
  }
  // 2. 关键词规则
  const rule = matchRule(rawName, rawDescription);
  if (rule !== null) {
    return {
      equipment_id: resolveEquipment(rawName, rawDescription, equipmentCandidates),
      quantity_type: rule.quantity_type,
      unit_std: rule.unit_std,
      source: 'keyword_rule',
    };
  }
  return null;
}

/** 读侧建议（§6.2 历史相似：token 重叠率，score < 1；不落库）。 */
export function similarSuggestions(
  rawName: string,
  rawDescription: string | null,
  history: readonly HistoryRow[],
  limit = 3,
): RowSuggestion[] {
  const target = new Set(tokenize(`${rawName} ${rawDescription ?? ''}`));
  if (target.size === 0) return [];
  const scored: RowSuggestion[] = [];
  for (const row of history) {
    if (row.quantity_type === null || row.raw_name === rawName) continue;
    const source = new Set(tokenize(`${row.raw_name} ${row.raw_description ?? ''}`));
    let overlap = 0;
    for (const token of source) {
      if (target.has(token)) overlap += 1;
    }
    const score = overlap / Math.max(target.size, source.size);
    if (score > 0) {
      scored.push({
        equipment_id: row.equipment_id,
        quantity_type: row.quantity_type,
        unit_std: row.unit_std,
        source: 'history_similar',
        score: Number(score.toFixed(2)),
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const deduped: RowSuggestion[] = [];
  for (const item of scored) {
    const key = `${item.equipment_id ?? ''}|${item.quantity_type ?? ''}|${item.unit_std ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
    if (deduped.length >= limit) break;
  }
  return deduped;
}
