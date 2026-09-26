/**
 * 环境配置（zod 收口，TS-02：边界数据不裸穿越）。
 *
 * dev 栈对接（伞仓 deploy/docker-compose.dev.yml 独立栈纪律）：
 * - Kafka EXTERNAL listener 暴露在宿主 localhost:9092 → KAFKA_BROKERS=localhost:9092；
 *   未设置时 kafka 接线整体停用（骨架期本地无 broker 也能起服务、跑测试）。
 * - 端口 8080 与伞仓 deploy/prometheus/prometheus.yml 预留的 thermio-api 刮取目标
 *   （host.docker.internal:8080）对齐。
 */
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
});

export interface AppConfig extends z.infer<typeof AppConfigSchema> {
  /** Kafka 是否启用（KAFKA_BROKERS 非空）。 */
  readonly kafkaEnabled: boolean;
}

/** 解析并校验环境变量；畸形值直接失败快（启动期报错优于运行期漂移）。 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = AppConfigSchema.parse(env);
  return { ...parsed, kafkaEnabled: parsed.KAFKA_BROKERS.length > 0 };
}
