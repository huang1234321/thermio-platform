/**
 * Kafka 接线模块（platform.md §8 #4：kafkajs proposal/executed 两 topic 接线骨架）。
 *
 * KAFKA_PUBLISHER 按 KAFKA_BROKERS 决定真连（dev 栈 = 伞仓 deploy/docker-compose.dev.yml
 * 独立栈，EXTERNAL listener localhost:9092）或停用（发布路径报错可见，不静默吞）。
 * KafkaGateway 是唯一生命周期持有者：驱动连接/断开与 executed 消费者；
 * 连接失败不阻断启动（dev 栈可能后起），ERROR 留痕后台补连。
 * 依赖注入自 @Global CoreModule（APP_CONFIG / LOGGER / MetricsService）。
 */
import {
  Inject,
  type InjectionToken,
  Injectable,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import type { Logger as PinoLogger } from 'pino';
import type { AppConfig } from '../../config.js';
import { APP_CONFIG } from '../core.module.js';
import { LOGGER } from '../logger.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { ExecutedResultConsumer } from './executed.consumer.js';
import { type KafkaPublisherPort, KafkaPublisher } from './kafka-publisher.js';

export const KAFKA_PUBLISHER: InjectionToken<KafkaPublisherPort> = Symbol('KAFKA_PUBLISHER');
const KAFKA_LOGGER: InjectionToken<PinoLogger> = Symbol('KAFKA_LOGGER');

/** 骨架期连接失败的重试间隔（ms）。 */
const CONNECT_RETRY_MS = 10_000;

@Injectable()
class KafkaGateway implements OnModuleInit, OnApplicationShutdown {
  private consumer: ExecutedResultConsumer | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(KAFKA_PUBLISHER) private readonly publisher: KafkaPublisherPort,
    @Inject(KAFKA_LOGGER) private readonly logger: PinoLogger,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    if (!this.config.kafkaEnabled) {
      this.logger.warn({ msg: 'kafka_module_disabled', hint: 'set KAFKA_BROKERS to enable' });
      return;
    }
    this.consumer = new ExecutedResultConsumer(
      this.config.KAFKA_BROKERS,
      this.config.KAFKA_CLIENT_ID,
      this.config.KAFKA_CONSUMER_GROUP_ID,
      this.logger,
      (decision) => {
        this.metrics.recordDecision(decision);
      },
    );
    void this.connectWithRetry();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.retryTimer !== null) clearInterval(this.retryTimer);
    await this.consumer?.stop();
    await this.publisher.disconnect();
  }

  private async connectWithRetry(): Promise<void> {
    try {
      await this.publisher.connect();
      await this.consumer?.start();
      if (this.retryTimer !== null) {
        clearInterval(this.retryTimer);
        this.retryTimer = null;
      }
    } catch (err: unknown) {
      this.logger.error({ msg: 'kafka_connect_failed', err, retry_ms: CONNECT_RETRY_MS });
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.stopping || this.retryTimer !== null) return;
    this.retryTimer = setInterval(() => {
      void this.connectWithRetry();
    }, CONNECT_RETRY_MS);
  }
}

@Module({
  providers: [
    {
      provide: KAFKA_PUBLISHER,
      useFactory: (config: AppConfig, logger: PinoLogger): KafkaPublisherPort =>
        config.kafkaEnabled
          ? new KafkaPublisher(
              config.KAFKA_BROKERS,
              config.KAFKA_CLIENT_ID,
              logger.child({ component: 'kafka-producer' }),
            )
          : disabledPublisher(logger),
      inject: [APP_CONFIG, LOGGER],
    },
    {
      provide: KAFKA_LOGGER,
      useFactory: (logger: PinoLogger): PinoLogger => logger.child({ component: 'kafka' }),
      inject: [LOGGER],
    },
    KafkaGateway,
  ],
  exports: [KAFKA_PUBLISHER],
})
export class KafkaModule {}

function disabledPublisher(logger: PinoLogger): KafkaPublisherPort {
  let announced = false;
  return {
    connect: () => {
      if (!announced) {
        announced = true;
        logger.warn({ msg: 'kafka_disabled', hint: 'set KAFKA_BROKERS to enable producer' });
      }
      return Promise.resolve();
    },
    disconnect: () => Promise.resolve(),
    publishProposal: () =>
      Promise.reject(new Error('kafka disabled: KAFKA_BROKERS not configured')),
  };
}
