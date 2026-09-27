/**
 * control.executed 事件发布包装（control-safety.md §10，IMPL-18）。
 *
 * 发布失败不回滚业务终态（提案状态/审计已是真相源）：ERROR 留痕，指标可观测
 * 学习闭环缺口（ADR-004 ★：该 topic 是采纳率与节能学习的数据面）。停用形态
 * （KAFKA_BROKERS 空）WARN 一次不重复刷屏——与 KafkaModule 停用纪律一致。
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { ControlExecutedEvent } from '@thermio/shared-types';
import { KAFKA_PUBLISHER } from '../infrastructure/kafka/kafka.module.js';
import type { KafkaPublisherPort } from '../infrastructure/kafka/kafka-publisher.js';
import { LOGGER } from '../infrastructure/logger.js';

@Injectable()
export class ControlEventsPublisher {
  private readonly logger: Logger;
  private announcedDisabled = false;

  constructor(
    @Inject(KAFKA_PUBLISHER) private readonly kafka: KafkaPublisherPort,
    @Inject(LOGGER) rootLogger: Logger,
  ) {
    this.logger = rootLogger.child({ component: 'control-events' });
  }

  /** 发布终态事件；失败留痕不上抛（调用方在终态事务之后，不该被传输层拖回滚）。 */
  async publishControlExecuted(event: ControlExecutedEvent): Promise<void> {
    try {
      await this.kafka.publishControlExecuted(event);
    } catch (err: unknown) {
      const disabled = err instanceof Error && err.message.includes('kafka disabled');
      if (disabled) {
        if (!this.announcedDisabled) {
          this.announcedDisabled = true;
          this.logger.warn({
            msg: 'control_events_kafka_disabled',
            hint: 'set KAFKA_BROKERS to enable control.executed producer',
          });
        }
        return;
      }
      this.logger.error({
        msg: 'control_executed_publish_failed',
        proposal_id: event.proposal_id,
        outcome: event.outcome,
        err,
      });
    }
  }
}
