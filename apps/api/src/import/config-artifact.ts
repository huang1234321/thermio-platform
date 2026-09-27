/**
 * 网关配置产物（M2-import §8.4；M1-R10 回写锚点，IMPL-8 对接面）。
 *
 * - points = 本网关**全量已注册点快照**（全量替换语义，retained 推送——网关重连
 *   即取最新配置，覆盖「apply 时离线 → 上线后自动收敛」场景）；
 * - offline_action = gateway 行原样透传（M1 §3.8 loose schema）；
 * - 不落库、可重 derive（§8.3-b：从已登记 point + gateway 行组装）。
 */
import { IMPORT_CONFIG_SCHEMA_VERSION, type GatewayConfigArtifact } from '@thermio/shared-types';

/** 已注册点（point 表快照行，apply 后查询所得——非 import_row）。 */
export interface RegisteredPointSnapshot {
  readonly raw_name: string;
  readonly unit_raw: string | null;
  readonly unit_std: string | null;
}

export function buildConfigArtifact(
  jobId: string,
  points: readonly RegisteredPointSnapshot[],
  offlineAction: object | null,
  generatedAt = new Date(),
): GatewayConfigArtifact {
  return {
    schema_version: IMPORT_CONFIG_SCHEMA_VERSION,
    job_id: jobId,
    generated_at: generatedAt.toISOString(),
    points: points.map((p) => ({
      raw_name: p.raw_name,
      ref: p.raw_name, // 点表无结构化地址列（O1）：点号即网关侧采集引用
      unit_raw: p.unit_raw,
      unit_std: p.unit_std,
    })),
    offline_action: offlineAction,
  };
}
