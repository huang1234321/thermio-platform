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
import { TELEMETRY_SPAN_LIMIT_DAYS, type TelemetryInterval } from '@thermio/shared-types';
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
  };
}
