/**
 * Kafka 生产者骨架（kafkajs；ADR-004 topic / ADR-016 边界 / ADR-017 trace_id 纪律）。
 *
 * 纯类不绑 Nest DI：生命周期由 KafkaGateway 驱动，测试可脱离 broker 直接 new。
 * trace_id 取请求上下文（无则生成）——每条出站消息必带 trace_id header（纪律面，
 * buildProposalMessage 纯函数钉死形状，单测覆盖）。
 */
import type { Logger } from 'pino';
import { Kafka, type Producer } from 'kafkajs';
import type { ProposalEnvelope } from '@thermio/shared-types';
import { currentTraceId } from '../request-context.js';
import { newTraceId } from '../request-id.js';
import { TRACE_ID_HEADER, TOPIC_CONTROL_PROPOSAL } from './kafka.constants.js';

export interface OutboundMessage {
  readonly topic: string;
  readonly messages: ReadonlyArray<{
    readonly key: string;
    readonly value: string;
    readonly headers: Readonly<Record<string, string>>;
  }>;
}

/** 提案事件消息（纯函数）：key=proposal_id 保同提案分区序，headers 带 trace_id。 */
export function buildProposalMessage(proposal: ProposalEnvelope, traceId: string): OutboundMessage {
  return {
    topic: TOPIC_CONTROL_PROPOSAL,
    messages: [
      {
        key: proposal.proposal_id,
        value: JSON.stringify(proposal),
        headers: { [TRACE_ID_HEADER]: traceId },
      },
    ],
  };
}

export class KafkaPublisher {
  private readonly producer: Producer;

  constructor(
    brokers: readonly string[],
    clientId: string,
    private readonly logger: Logger,
  ) {
    this.producer = new Kafka({ brokers: [...brokers], clientId }).producer();
  }

  async connect(): Promise<void> {
    await this.producer.connect();
    this.logger.info({ msg: 'kafka_producer_connected' });
  }

  async disconnect(): Promise<void> {
    await this.producer.disconnect();
    this.logger.info({ msg: 'kafka_producer_disconnected' });
  }

  async publishProposal(proposal: ProposalEnvelope): Promise<void> {
    const traceId = currentTraceId(newTraceId);
    const message = buildProposalMessage(proposal, traceId);
    await this.producer.send({
      topic: message.topic,
      messages: message.messages.map((entry) => ({
        key: entry.key,
        value: entry.value,
        headers: { ...entry.headers },
      })),
    });
    this.logger.info({
      msg: 'kafka_proposal_published',
      topic: message.topic,
      proposal_id: proposal.proposal_id,
      trace_id: traceId,
    });
  }
}

/** 两种形态的共同接口（真连 / 停用，KafkaModule 决定实现）。 */
export interface KafkaPublisherPort {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  publishProposal(proposal: ProposalEnvelope): Promise<void>;
}
