/**
 * 场景清单（manifest）入参收窄（ui/viz-3d.md §2 schema.ts / D2：边界数据 zod）。
 *
 * 字段与 demo plant-data.json 逐字一致（M3-monitor §2.2：移植零转换），仅
 * 增补版本元数据（tools/export_assets.py §3.8 产物：template_id/version/variant_key）；
 * demo 专有键（demo/source）非 strict 解析自动剥离。解析失败走 onError（页面降级链
 * §5.1），不崩画面（API-CT-03 宽松回退同纪律）。
 */
import { z } from 'zod';

export const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

export const ManifestAssetSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  name: z.string().min(1),
  /** 所属回路（CHW/CW 设备侧；管路/阀门为 CHWS/CHWR/CWS/CWR 四回路细分）。 */
  circuit: z.string().min(2).max(4).nullable().optional(),
  /** 父对象（阀门/管路 → 所属设备；高亮传播链用，M3-monitor §6.3）。 */
  parent: z.string().min(1).nullable().optional(),
  center: Vec3Schema,
  size: Vec3Schema,
  /** 标签投影锚点。 */
  anchor: Vec3Schema,
  /** 'fan' = 风机转子（可旋转部件，M3-monitor §2.2）。 */
  role: z.string().min(1).optional(),
});
export type ManifestAsset = z.infer<typeof ManifestAssetSchema>;

export const ManifestFlowPathSchema = z.object({
  id: z.string().min(1),
  /** 门控设备（运行态 → 该路径流向标记显隐，M3-monitor §5.4）。 */
  owner: z.string().min(1).nullable().optional(),
  circuit: z.string().min(2).max(4),
  radius: z.number().nonnegative(),
  points: z.array(Vec3Schema).min(2),
});
export type ManifestFlowPath = z.infer<typeof ManifestFlowPathSchema>;

export const SceneManifestSchema = z.object({
  title: z.string().optional(),
  assets: z.array(ManifestAssetSchema),
  flowPaths: z.array(ManifestFlowPathSchema),
  camera: z.object({
    position: Vec3Schema,
    target: Vec3Schema,
    width: z.number().positive(),
  }),
  // 版本元数据（scene_asset 注册用，ui/viz-3d.md §3.8；运行时引擎不消费）
  template_id: z.string().min(1).optional(),
  version: z.number().int().positive().optional(),
  variant_key: z.string().min(1).optional(),
  /** 工程注记（M3-monitor §5.8：「系统连接为概念示意，非施工图」保留项）。 */
  engineering_note: z.string().optional(),
});
export type SceneManifest = z.infer<typeof SceneManifestSchema>;
