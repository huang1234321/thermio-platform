/**
 * 资产与接入管理契约（modules/M1-asset.md v1.2，IMPL-11 / DAT-114）。
 *
 * 端点全集（蓝本 implementation-plan IMPL-11 范围 = §3.1–§3.6/§3.8/§3.9；
 * §3.7 遥测读取实现归 IMPL-12（telemetry.ts），§3.10 物理编辑随 DAT-151 另派）：
 * - 楼宇/系统/设备 CRUD（§3.1–§3.3）；
 * - 点位跨层级检索/详情/语义白名单 PATCH/启停（§3.4–§3.6）；
 * - 网关登记/编辑 + 凭证生成/轮换/吊销（§3.8/§3.9）。
 *
 * 资源字段与 ddl.md §4 六表逐列对齐（M1-asset §2 验收锚点）：DDL 列名 = API 字段名
 * （snake_case 直传，无别名层）；tenant_id 一律不暴露（会话解析）；
 * secret_hash / cert_fingerprint 永不暴露（SEC-KEY-02）。
 *
 * 数值治理（platform.md §12）：分页/批量/凭证上限默认值钉死本包常量，
 * 调整走表修订 PR，不散落代码常量（CODE-ST-03）。
 */
import { z } from 'zod';
import {
  BuildingTypeSchema,
  ControlModeSchema,
  DirectionSchema,
  EquipmentTypeSchema,
  QuantityTypeSchema,
  SystemTypeSchema,
} from './enums.js';
import { Rfc3339Schema } from './telemetry.js';

// ---------------------------------------------------------------------------
// 上限参数（platform.md §12 + M1-asset 定夺，env 可覆盖口径见各 consuming 服务）
// ---------------------------------------------------------------------------

/** 游标分页（API-DSN-03 / platform.md §12：默认 50，上限 200）。 */
export const ASSET_PAGE_LIMIT_DEFAULT = 50;
export const ASSET_PAGE_LIMIT_MAX = 200;

/** 批量启停 ids 上限（platform §12 容量表；沿 M4 batch-ack 先例 207 逐项）。 */
export const POINT_BATCH_MAX_IDS = 100;

/** 每网关活跃（enabled）凭证上限（M1-asset §4：生成 + 一枚轮换过渡）。 */
export const CREDENTIAL_ACTIVE_LIMIT = 2;

/** offline_action.writes 项数上限（M1-asset §3.8 loose schema）。 */
export const OFFLINE_ACTION_MAX_WRITES = 64;

/** 网关 secret 字节数（≥256-bit，SEC-KEY-01；base64url 编码后下发仅一次）。 */
export const GATEWAY_SECRET_BYTES = 32;

/** 网关 serial 字符集（M1-asset §2.5：保证 MQTT clientid/topic 安全）。 */
export const GATEWAY_SERIAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 游标不透明串（API-DSN-03：base64url ≤512，客户端不解析）。 */
export const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;

/** limit 公共形状（platform §12：1–200；默认值由各查询 schema default 提供）。 */
const limitSchema = z.coerce.number().int().min(1).max(ASSET_PAGE_LIMIT_MAX);
const cursorSchema = z.string().regex(CURSOR_PATTERN).optional();

// ---------------------------------------------------------------------------
// 通用信封
// ---------------------------------------------------------------------------

/** 列表信封（platform §12：{items, next_cursor}，无 total——O6 降级口径）。 */
export interface Page<T> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
}

// ---------------------------------------------------------------------------
// §2.1 Building（ddl §4 表 building，10 列；暴露 9——tenant_id 不暴露）
// ---------------------------------------------------------------------------

export const BuildingSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(128),
  address: z.string().max(256).nullable(),
  geo_lat: z.number().min(-90).max(90).nullable(),
  geo_lon: z.number().min(-180).max(180).nullable(),
  building_type: BuildingTypeSchema.nullable(),
  gross_area_m2: z.number().positive().nullable(),
  climate_zone: z.string().max(32).nullable(),
  created_at: Rfc3339Schema,
});
export type Building = z.infer<typeof BuildingSchema>;

/**
 * 创建请求。枚举字段（building_type）**刻意收宽为 string**：值域外要发
 * `asset.building_type_unknown` 422（M1-asset §1.2 专用码，非 common.validation_failed），
 * 枚举治理在服务层判（清单 shared-types BUILDING_TYPES）。
 */
export const BuildingCreateSchema = z.object({
  name: z.string().min(1).max(128),
  address: z.string().max(256).nullish(),
  geo_lat: z.number().min(-90).max(90).nullish(),
  geo_lon: z.number().min(-180).max(180).nullish(),
  building_type: z.string().max(32).nullish(),
  gross_area_m2: z.number().positive().nullish(),
  climate_zone: z.string().max(32).nullish(),
});
export type BuildingCreate = z.infer<typeof BuildingCreateSchema>;

/** PATCH ≥1 字段（空对象 → 422 common.validation_failed）。 */
export const BuildingUpdateSchema = BuildingCreateSchema.partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, '至少提供一个可更新字段');
export type BuildingUpdate = z.infer<typeof BuildingUpdateSchema>;

export const BuildingListQuerySchema = z
  .object({
    keyword: z.string().min(1).max(64).optional(),
    limit: limitSchema.default(ASSET_PAGE_LIMIT_DEFAULT),
    cursor: cursorSchema,
  })
  .strict();
export type BuildingListQuery = z.infer<typeof BuildingListQuerySchema>;

export const BuildingListResponseSchema = z.object({
  items: z.array(BuildingSchema),
  next_cursor: z.string().nullable(),
});
export type BuildingListResponse = z.infer<typeof BuildingListResponseSchema>;

// ---------------------------------------------------------------------------
// §2.2 HvacSystem（ddl §4 表 hvac_system，5 列；无 created_at——R9 排序键 (type,name,id)）
// ---------------------------------------------------------------------------

export const HvacSystemSchema = z.object({
  id: z.uuid(),
  building_id: z.uuid(),
  system_type: SystemTypeSchema,
  name: z.string().min(1).max(128),
});
export type HvacSystem = z.infer<typeof HvacSystemSchema>;

/** system_type 同 BuildingCreate 注记：服务层判值域发 asset.system_type_unknown。 */
export const SystemCreateSchema = z
  .object({
    building_id: z.uuid(),
    system_type: z.string().min(1).max(32),
    name: z.string().min(1).max(128),
  })
  .strict();
export type SystemCreate = z.infer<typeof SystemCreateSchema>;

export const SystemUpdateSchema = z
  .object({
    name: z.string().min(1).max(128).optional(),
    system_type: z.string().min(1).max(32).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, '至少提供一个可更新字段');
export type SystemUpdate = z.infer<typeof SystemUpdateSchema>;

export const SystemListQuerySchema = z
  .object({
    system_type: SystemTypeSchema.optional(),
    limit: limitSchema.default(ASSET_PAGE_LIMIT_DEFAULT),
    cursor: cursorSchema,
  })
  .strict();
export type SystemListQuery = z.infer<typeof SystemListQuerySchema>;

export const SystemListResponseSchema = z.object({
  items: z.array(HvacSystemSchema),
  next_cursor: z.string().nullable(),
});
export type SystemListResponse = z.infer<typeof SystemListResponseSchema>;

// ---------------------------------------------------------------------------
// §2.3 Equipment（ddl §4 表 equipment，9 列；rated_params 自由结构 ≤16KB）
// ---------------------------------------------------------------------------

/** rated_params：铭牌参数自由结构（键名随设备类型/厂商），仅结构与大小校验。 */
export const RatedParamsSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (value) => utf8ByteLength(JSON.stringify(value)) <= 16 * 1024,
    'rated_params 序列化后不得超过 16KB',
  );

/** 纯 TS 的 UTF-8 字节数（本包平台无关——RN/web 消费面不可依赖 Node Buffer）。 */
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.codePointAt(i) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (code > 0xffff) i += 1; // 跳过代理对低位
  }
  return bytes;
}

/** commission_date：ISO 8601 date（不设未来约束——预投运登记合法）。 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'commission_date 须为 ISO 8601 date');

export const EquipmentSchema = z.object({
  id: z.uuid(),
  system_id: z.uuid(),
  equipment_type: EquipmentTypeSchema,
  name: z.string().min(1).max(128),
  local_id: z.string().max(64).nullable(),
  vendor_model: z.string().max(128).nullable(),
  rated_params: RatedParamsSchema.nullable(),
  commission_date: isoDate.nullable(),
});
export type Equipment = z.infer<typeof EquipmentSchema>;

export const EquipmentCreateSchema = z
  .object({
    system_id: z.uuid(),
    equipment_type: z.string().min(1).max(64),
    name: z.string().min(1).max(128),
    local_id: z.string().max(64).nullish(),
    vendor_model: z.string().max(128).nullish(),
    rated_params: RatedParamsSchema.nullish(),
    commission_date: isoDate.nullish(),
  })
  .strict();
export type EquipmentCreate = z.infer<typeof EquipmentCreateSchema>;

export const EquipmentUpdateSchema = z
  .object({
    equipment_type: z.string().min(1).max(64).optional(),
    name: z.string().min(1).max(128).optional(),
    local_id: z.string().max(64).nullish(),
    vendor_model: z.string().max(128).nullish(),
    rated_params: RatedParamsSchema.nullish(),
    commission_date: isoDate.nullish(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, '至少提供一个可更新字段');
export type EquipmentUpdate = z.infer<typeof EquipmentUpdateSchema>;

export const EquipmentListQuerySchema = z
  .object({
    equipment_type: EquipmentTypeSchema.optional(),
    limit: limitSchema.default(ASSET_PAGE_LIMIT_DEFAULT),
    cursor: cursorSchema,
  })
  .strict();
export type EquipmentListQuery = z.infer<typeof EquipmentListQuerySchema>;

export const EquipmentListResponseSchema = z.object({
  items: z.array(EquipmentSchema),
  next_cursor: z.string().nullable(),
});
export type EquipmentListResponse = z.infer<typeof EquipmentListResponseSchema>;

// ---------------------------------------------------------------------------
// §2.4 Point（ddl §4 表 point，26 列；读侧全字段暴露——除 tenant_id）
// ---------------------------------------------------------------------------

export const PointSchema = z.object({
  id: z.number().int().positive(),
  building_id: z.uuid(),
  equipment_id: z.uuid().nullable(),
  source_type: z.enum(['mqtt_gateway', 'bacnet', 'virtual']),
  gateway_id: z.uuid().nullable(),
  protocol_address: z.record(z.string(), z.unknown()).nullable(),
  raw_name: z.string().min(1).max(128),
  sample_interval_s: z.number().int().nullable(),
  quantity_type: QuantityTypeSchema.nullable(),
  display_name: z.string().max(128).nullable(),
  description: z.string().max(1024).nullable(),
  unit_raw: z.string().max(32).nullable(),
  unit_std: z.string().max(32).nullable(),
  direction: DirectionSchema,
  is_controllable: z.boolean(),
  clamp_min: z.number().nullable(),
  clamp_max: z.number().nullable(),
  write_rate_limit_per_hour: z.number().int().nullable(),
  control_mode: ControlModeSchema,
  stale_timeout_s: z.number().int(),
  valid_range_min: z.number().nullable(),
  valid_range_max: z.number().nullable(),
  status: z.enum(['active', 'disabled']),
  created_at: Rfc3339Schema,
  updated_at: Rfc3339Schema,
});
export type Point = z.infer<typeof PointSchema>;

/** §3.4 设备点位列表项：点位 + 实时值快照（无遥测行 → latest:null）。 */
export const PointListItemSchema = z.object({
  point: PointSchema,
  latest: z
    .object({
      ts: Rfc3339Schema,
      value: z.number().nullable(),
      value_text: z.string().nullable(),
      quality: z.number().int(),
    })
    .nullable(),
});
export type PointListItem = z.infer<typeof PointListItemSchema>;

export const PointListResponseSchema = z.object({
  items: z.array(PointListItemSchema),
  next_cursor: z.string().nullable(),
});
export type PointListResponse = z.infer<typeof PointListResponseSchema>;

/** §3.4 点位详情：面包屑上下文（经 equipment 链推导 system）。 */
export const PointDetailSchema = PointSchema.extend({
  context: z.object({
    building: z.object({ id: z.uuid(), name: z.string() }),
    system: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    equipment: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    gateway: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  }),
});
export type PointDetail = z.infer<typeof PointDetailSchema>;

/** 设备点位列表查询（§3.4）。 */
export const EquipmentPointsQuerySchema = z
  .object({
    quantity_type: QuantityTypeSchema.optional(),
    direction: DirectionSchema.optional(),
    limit: limitSchema.default(ASSET_PAGE_LIMIT_DEFAULT),
    cursor: cursorSchema,
  })
  .strict();
export type EquipmentPointsQuery = z.infer<typeof EquipmentPointsQuerySchema>;

/** GET /points 跨层级检索白名单（§3.4/§6：白名单外参数 → 422，不静默忽略）。 */
export const PointSearchQuerySchema = z
  .object({
    building_id: z.uuid().optional(),
    equipment_id: z.uuid().optional(),
    gateway_id: z.uuid().optional(),
    quantity_type: QuantityTypeSchema.optional(),
    direction: DirectionSchema.optional(),
    is_controllable: z.enum(['true', 'false']).optional(),
    control_mode: ControlModeSchema.optional(),
    status: z.enum(['active', 'disabled']).optional(),
    keyword: z.string().min(1).max(64).optional(),
    limit: limitSchema.default(ASSET_PAGE_LIMIT_DEFAULT),
    cursor: cursorSchema,
  })
  .strict();
export type PointSearchQuery = z.infer<typeof PointSearchQuerySchema>;

export const PointSearchResponseSchema = z.object({
  items: z.array(PointSchema),
  next_cursor: z.string().nullable(),
});
export type PointSearchResponse = z.infer<typeof PointSearchResponseSchema>;

// ---------------------------------------------------------------------------
// §3.5 点位语义编辑（operator+；白名单五字段 + If-Match 弱校验）
// ---------------------------------------------------------------------------

/** 语义白名单（§2.4 写路径分治；路由隔离守卫的 details.allowed 就是这五个键）。 */
export const POINT_SEMANTIC_FIELDS = [
  'display_name',
  'description',
  'quantity_type',
  'unit_raw',
  'unit_std',
] as const;
export type PointSemanticField = (typeof POINT_SEMANTIC_FIELDS)[number];

/** 闸门字段（M8 专用端点编辑，IMPL-18；本模块只读 + 路由隔离守卫定向）。 */
export const POINT_GATE_FIELDS = [
  'is_controllable',
  'clamp_min',
  'clamp_max',
  'write_rate_limit_per_hour',
  'control_mode',
] as const;

/** 物理层字段（§3.10 DAT-151 专用端点；本卡不接——details.allowed 定向提示用）。 */
export const POINT_PHYSICAL_FIELDS = [
  'raw_name',
  'gateway_id',
  'protocol_address',
  'direction',
] as const;

/**
 * 语义 PATCH 请求体。**刻意不 strict**：路由隔离守卫（point.field_not_allowed 400）
 * 要看白名单外的键名才能定向（闸门→M8、物理→§3.10、status→§3.6），
 * 键层收窄在控制器守卫完成，类型/长度仍由本 schema 校验（422）。
 */
export const PointSemanticsPatchSchema = z.object({
  display_name: z.string().max(128).nullish(),
  description: z.string().max(1024).nullish(),
  /** quantity_type 服务层判值域发 point.quantity_type_unknown（同族注记）。 */
  quantity_type: z.string().max(32).nullish(),
  unit_raw: z.string().max(32).nullish(),
  unit_std: z.string().max(32).nullish(),
});
export type PointSemanticsPatch = z.infer<typeof PointSemanticsPatchSchema>;

// ---------------------------------------------------------------------------
// §3.6 点位启停（admin；reason 必填入结构化日志）
// ---------------------------------------------------------------------------

export const PointStatusPatchSchema = z
  .object({
    status: z.enum(['active', 'disabled']),
    reason: z.string().min(1).max(512),
  })
  .strict();
export type PointStatusPatch = z.infer<typeof PointStatusPatchSchema>;

export const PointBatchStatusSchema = z
  .object({
    ids: z
      .array(z.number().int().positive())
      .min(1)
      .max(POINT_BATCH_MAX_IDS)
      .refine((ids) => new Set(ids).size === ids.length, 'ids 须去重'),
    status: z.enum(['active', 'disabled']),
    reason: z.string().min(1).max(512),
  })
  .strict();
export type PointBatchStatus = z.infer<typeof PointBatchStatusSchema>;

/** 207 逐项结果（API-DSN-05；沿 overview M4 batch-ack 先例）。 */
export const PointBatchStatusItemSchema = z.object({
  point_id: z.number().int(),
  ok: z.boolean(),
  error: z
    .object({
      reason_code: z.string(),
    })
    .optional(),
});
export type PointBatchStatusItem = z.infer<typeof PointBatchStatusItemSchema>;

export const PointBatchStatusResponseSchema = z.object({
  items: z.array(PointBatchStatusItemSchema),
});
export type PointBatchStatusResponse = z.infer<typeof PointBatchStatusResponseSchema>;

// ---------------------------------------------------------------------------
// §2.5 Gateway（ddl §4 表 gateway，11 列；status/last_seen_at 只读——EMQX 维护）
// ---------------------------------------------------------------------------

/**
 * offline_action loose schema（§3.8：结构校验在 M1，引用校验在 M2 apply）。
 * writes[].value 单位口径 = **unit_std**（control-safety §4.2 下行消息一律
 * unit_std——ADR-005 归一纪律；DAT-148 验收注记，源 DAT-128 gateway.md §14.2 差异 4）。
 */
export const OfflineActionSchema = z
  .object({
    writes: z
      .array(
        z.object({
          raw_name: z.string().min(1).max(128),
          value: z.number(),
        }),
      )
      .max(OFFLINE_ACTION_MAX_WRITES),
  })
  .strict();
export type OfflineAction = z.infer<typeof OfflineActionSchema>;

export const GatewaySchema = z.object({
  id: z.uuid(),
  building_id: z.uuid(),
  name: z.string().min(1).max(128),
  serial: z.string().regex(GATEWAY_SERIAL_PATTERN),
  vendor_model: z.string().max(128).nullable(),
  mqtt_client_id: z.string().min(1),
  status: z.enum(['online', 'offline']),
  last_seen_at: Rfc3339Schema.nullable(),
  offline_action: OfflineActionSchema.nullable(),
  created_at: Rfc3339Schema,
});
export type Gateway = z.infer<typeof GatewaySchema>;

export const GatewayCreateSchema = z
  .object({
    serial: z.string().regex(GATEWAY_SERIAL_PATTERN),
    name: z.string().min(1).max(128),
    building_id: z.uuid(),
    vendor_model: z.string().max(128).nullish(),
    offline_action: OfflineActionSchema.nullish(),
  })
  .strict();
export type GatewayCreate = z.infer<typeof GatewayCreateSchema>;

/** serial / mqtt_client_id / building_id 不可改（迁移 = 重新登记）。 */
export const GatewayUpdateSchema = z
  .object({
    name: z.string().min(1).max(128).optional(),
    vendor_model: z.string().max(128).nullish(),
    offline_action: OfflineActionSchema.nullish(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, '至少提供一个可更新字段');
export type GatewayUpdate = z.infer<typeof GatewayUpdateSchema>;

export const GatewayListQuerySchema = z
  .object({
    building_id: z.uuid().optional(),
    status: z.enum(['online', 'offline']).optional(),
    limit: limitSchema.default(ASSET_PAGE_LIMIT_DEFAULT),
    cursor: cursorSchema,
  })
  .strict();
export type GatewayListQuery = z.infer<typeof GatewayListQuerySchema>;

export const GatewayListResponseSchema = z.object({
  items: z.array(GatewaySchema),
  next_cursor: z.string().nullable(),
});
export type GatewayListResponse = z.infer<typeof GatewayListResponseSchema>;

// ---------------------------------------------------------------------------
// §2.6 DeviceCredential（8 列；secret_hash/cert_fingerprint 永不暴露）
// ---------------------------------------------------------------------------

/** 凭证元数据（列表/详情唯一暴露面；secret 仅生成响应返回一次，SEC-KEY-01/02）。 */
export const CredentialMetaSchema = z.object({
  id: z.uuid(),
  username: z.string().min(1),
  enabled: z.boolean(),
  created_at: Rfc3339Schema,
});
export type CredentialMeta = z.infer<typeof CredentialMetaSchema>;

/** GET /gateways/{id} 详情（§3.8 R2 增补：凭证元数据数组）。 */
export const GatewayDetailSchema = GatewaySchema.extend({
  credentials: z.array(CredentialMetaSchema),
});
export type GatewayDetail = z.infer<typeof GatewayDetailSchema>;

/** POST /gateways/{id}/credentials 201：元数据 + secret（仅本次返回）。 */
export const CredentialIssueResponseSchema = z.object({
  credential: CredentialMetaSchema,
  secret: z.string().min(43),
});
export type CredentialIssueResponse = z.infer<typeof CredentialIssueResponseSchema>;

export const CredentialDisableRequestSchema = z
  .object({
    reason: z.string().max(512).optional(),
  })
  .strict();
export type CredentialDisableRequest = z.infer<typeof CredentialDisableRequestSchema>;
