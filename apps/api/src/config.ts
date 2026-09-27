/**
 * 环境配置（zod 收口，TS-02：边界数据不裸穿越）。
 *
 * dev 栈对接（伞仓 deploy/docker-compose.dev.yml 独立栈纪律）：
 * - Kafka EXTERNAL listener 暴露在宿主 localhost:9092 → KAFKA_BROKERS=localhost:9092；
 *   未设置时 kafka 接线整体停用（骨架期本地无 broker 也能起服务、跑测试）。
 * - 端口 8080 与伞仓 deploy/prometheus/prometheus.yml 预留的 thermio-api 刮取目标
 *   （host.docker.internal:8080）对齐。
 * - TSDB 走宿主映射 5433（TSDB_READ_URL，只读账号 tsdb_api）；PG 走 5432
 *   （PG_URL，业务真相源）。两者未设置时遥测查询端点显式降级 503
 *   （telemetry.store_unavailable），服务本体照常起（与 kafka 同一停用形态）。
 */
import {
  STREAM_LIMITS,
  TELEMETRY_SPAN_LIMIT_DAYS,
  type TelemetryInterval,
} from '@thermio/shared-types';
import { z } from 'zod';

const AppConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  KAFKA_BROKERS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((broker) => broker.trim())
        .filter((broker) => broker.length > 0),
    ),
  KAFKA_CLIENT_ID: z.string().min(1).default('thermio-api'),
  KAFKA_CONSUMER_GROUP_ID: z.string().min(1).default('thermio-api'),
  // ── 遥测查询（IMPL-12 / DAT-115）──
  /** api→TSDB 只读连接串（ddl.md §5.4 tsdb_api 角色：仅 SELECT）。留空 = 显式降级。 */
  TSDB_READ_URL: z.string().default(''),
  TSDB_READ_POOL_MAX: z.coerce.number().int().min(1).max(64).default(10),
  /** PG 业务真相源连接串（本卡仅点位档案存在性读；thermio_api 角色）。留空 = 显式降级。 */
  PG_URL: z.string().default(''),
  PG_POOL_MAX: z.coerce.number().int().min(1).max(64).default(10),
  /**
   * RLS 租户上下文（ddl.md §5.2 app.tenant_id）。IMPL-10 会话解析落地前的显式
   * dev 形态：配置级单租户；PG_URL 设置时必填（否则 RLS fail-closed 静默查空）。
   */
  PG_TENANT_ID: z.string().default(''),
  /** 跨度上限 env 覆盖位（platform.md §12：默认值钉死在 shared-types 常量）。 */
  TELEMETRY_RAW_SPAN_MAX_DAYS: z.coerce
    .number()
    .int()
    .positive()
    .default(TELEMETRY_SPAN_LIMIT_DAYS.raw),
  TELEMETRY_5MIN_SPAN_MAX_DAYS: z.coerce
    .number()
    .int()
    .positive()
    .default(TELEMETRY_SPAN_LIMIT_DAYS['5min']),
  TELEMETRY_1H_SPAN_MAX_DAYS: z.coerce
    .number()
    .int()
    .positive()
    .default(TELEMETRY_SPAN_LIMIT_DAYS['1h']),
  // ── SSE 实时通道（platform.md §10/§12，M3-monitor §3.5，IMPL-14）──
  /** 节流窗口 1–5s 可配默认 2s（ADR-013；测试可压至下限加速）。 */
  SSE_THROTTLE_WINDOW_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(5_000)
    .default(STREAM_LIMITS.throttle_window_default_ms),
  /** 心跳 `: ping` 间隔默认 15s（代理空闲超时之下；测试可压短加速）。 */
  SSE_HEARTBEAT_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(500)
    .default(STREAM_LIMITS.heartbeat_interval_default_ms),
  /** 每实例并发连接上限（超出 503 stream.server_busy + Retry-After: 5）。 */
  SSE_MAX_CONNECTIONS: z.coerce
    .number()
    .int()
    .min(1)
    .default(STREAM_LIMITS.max_connections_per_instance),
  // ── EMQX 内部端点（emqx.md §3/§5/§7，IMPL-7）──
  /** Bearer 服务凭证（platform.md §11：EMQX_INTERNAL_TOKEN = SVC_TOKEN_EMQX 同一枚）。 */
  EMQX_INTERNAL_TOKEN: z.string().default(''),
  /** 轮换双读窗口内的旧 token（SEC-KEY-04；空 = 无轮换进行中）。 */
  EMQX_INTERNAL_TOKEN_PREVIOUS: z.string().default(''),
  AUTH_DB_HOST: z.string().min(1).default('localhost'),
  AUTH_DB_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  AUTH_DB_NAME: z.string().min(1).default('thermio'),
  AUTH_DB_USER: z.string().min(1).default('thermio_auth'),
  AUTH_DB_PASSWORD: z.string().default(''),
  PLATFORM_DB_HOST: z.string().min(1).default('localhost'),
  PLATFORM_DB_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  PLATFORM_DB_NAME: z.string().min(1).default('thermio'),
  PLATFORM_DB_USER: z.string().min(1).default('thermio_api'),
  PLATFORM_DB_PASSWORD: z.string().default(''),
  /** EMQX 管理 API（§5.3 对账；空 = 对账停用，dev 栈内置认证形态）。 */
  EMQX_MANAGEMENT_BASE_URL: z.string().default(''),
  EMQX_MANAGEMENT_API_KEY: z.string().default(''),
  EMQX_MANAGEMENT_API_SECRET: z.string().default(''),
  EMQX_MANAGEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(3_000),
  EMQX_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(1_000).default(60_000),
  MQTT_AUTH_FAIL_LIMIT: z.coerce.number().int().min(1).default(10),
  MQTT_AUTH_FAIL_WINDOW_MS: z.coerce.number().int().min(1_000).default(300_000),
  // ── PG 连接（IMPL-10；ddl.md §5.1 角色矩阵：api 业务读写 / auth 登录解析旁路）──
  // 连接串含口令只来自环境变量（SEC-KEY-01）；空值 = 数据库未接线（骨架期健康起服）。
  PG_API_URL: z.string().default(''),
  PG_AUTH_URL: z.string().default(''),
  // ── 导入域 MQTT 下行通道（IMPL-15 / M2-import §8.4/§9.2；emqx.md §4 R6）──
  // svc-api 内部账号：down/config(retained)/down/read 发布 + config/ack 共享订阅。
  // 未设置 = 通道停用（apply 推送段降级跳过，登记保留——dev 无栈形态）。
  MQTT_BROKER_URL: z.string().default(''),
  MQTT_USERNAME: z.string().default('svc-api'),
  MQTT_PASSWORD: z.string().default(''),
  MQTT_CLIENT_ID: z.string().min(1).default('thermio-api-import'),
  // ── 认证会话（SEC-AZ-04：短时效 + 服务端可撤销）──
  AUTH_JWT_SECRET: z.string().min(32).default(''),
  AUTH_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  AUTH_REFRESH_TTL_SECONDS: z.coerce.number().int().min(600).max(2_592_000).default(604_800), // 7d
  // 登录防爆破限速（SEC-PW-04）："次数/窗口秒"，默认 10 次 / 300s（按 email+IP 计）
  AUTH_LOGIN_RATE_LIMIT: z
    .string()
    .regex(/^\d{1,4}\/\d{1,5}$/)
    .default('10/300'),
});

export interface AppConfig extends z.infer<typeof AppConfigSchema> {
  /** Kafka 是否启用（KAFKA_BROKERS 非空）。 */
  readonly kafkaEnabled: boolean;
  /** TSDB 只读连接是否启用（TSDB_READ_URL 非空）。 */
  readonly tsdbReadEnabled: boolean;
  /** PG 点位档案读是否启用（PG_URL 非空）。 */
  readonly pgLookupEnabled: boolean;
  /** 按 interval 分档的跨度上限（天）。 */
  readonly telemetrySpanLimitDays: Readonly<Record<TelemetryInterval, number>>;
  /** 对账是否启用（EMQX_MANAGEMENT_BASE_URL 非空）。 */
  readonly emqxReconcileEnabled: boolean;
  /** SSE 通道参数（platform.md §10/§12；M3-monitor §3.5）。 */
  readonly sse: {
    readonly throttleWindowMs: number;
    readonly heartbeatIntervalMs: number;
    readonly maxConnections: number;
  };
  /** 认证域是否启用（PG_API_URL/PG_AUTH_URL/AUTH_JWT_SECRET 三者齐备）。 */
  readonly authEnabled: boolean;
}

/** 解析并校验环境变量；畸形值直接失败快（启动期报错优于运行期漂移）。 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = AppConfigSchema.superRefine((cfg, ctx) => {
    if (cfg.PG_URL.length > 0 && !z.uuid().safeParse(cfg.PG_TENANT_ID).success) {
      ctx.addIssue({
        code: 'custom',
        path: ['PG_TENANT_ID'],
        message: 'PG_URL 已设置时 PG_TENANT_ID 必须为有效 uuid（RLS app.tenant_id，ddl.md §5.2）',
      });
    }
  }).parse(env);

  return {
    ...parsed,
    kafkaEnabled: parsed.KAFKA_BROKERS.length > 0,
    tsdbReadEnabled: parsed.TSDB_READ_URL.length > 0,
    pgLookupEnabled: parsed.PG_URL.length > 0,
    telemetrySpanLimitDays: {
      raw: parsed.TELEMETRY_RAW_SPAN_MAX_DAYS,
      '5min': parsed.TELEMETRY_5MIN_SPAN_MAX_DAYS,
      '1h': parsed.TELEMETRY_1H_SPAN_MAX_DAYS,
    },
    emqxReconcileEnabled: parsed.EMQX_MANAGEMENT_BASE_URL.length > 0,
    sse: {
      throttleWindowMs: parsed.SSE_THROTTLE_WINDOW_MS,
      heartbeatIntervalMs: parsed.SSE_HEARTBEAT_INTERVAL_MS,
      maxConnections: parsed.SSE_MAX_CONNECTIONS,
    },
    authEnabled:
      parsed.PG_API_URL.length > 0 &&
      parsed.PG_AUTH_URL.length > 0 &&
      parsed.AUTH_JWT_SECRET.length > 0,
  };
}
