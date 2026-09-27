/**
 * thermio.control.executed 消费骨架（kafkajs；ADR-004 / ADR-017）。
 *
 * 骨架职责仅三件：读 trace_id header 进日志（透传纪律）、按 DATA-MODEL §3.5
 * control_result 联动 thermio_proposal_decisions_total{decision}、结构化 INFO 落档。
 * 执行结果的业务加工（提案状态机推进、SSE 通知）随 M5 落地——消息体契约以
 * shared-types 后续演进为准，此处只 safeParse 最小面（consumeExecutedValue 纯函数，
 * 单测不依赖 broker）。
 */
import { Kafka, type Consumer, type EachMessagePayload } from 'kafkajs';
import type { Logger } from 'pino';
import { CONTROL_RESULTS, type ControlResult } from '@thermio/shared-types';
import { z } from 'zod';
import { TRACE_ID_HEADER, TOPIC_CONTROL_EXECUTED } from './kafka.constants.js';

/** 最小消费面：执行结果消息必带 proposal_id + outcome（§10 契约）。 */
const ExecutedEventSchema = z.object({
  proposal_id: z.string().min(1),
  outcome: z.string(),
});

export function isControlResult(value: string): value is ControlResult {
  return (CONTROL_RESULTS as readonly string[]).includes(value);
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * 单条 executed 消息加工（纯）：畸形/未知 outcome WARN 不 crash 消费循环；
 * 合法 outcome 联动指标 + INFO 日志。返回是否联动了指标（测试断言面）。
 *
 * IMPL-18 起消费 §10 正式契约（outcome 四值：executed|verify_failed|reverted|
 * rejected_by_gate）——决策指标按 §10「对齐 control_audit.result 四值」机械映射：
 * executed→ok、rejected_by_gate→rejected，其余同名。
 */
const OUTCOME_TO_CONTROL_RESULT: Readonly<Record<string, ControlResult>> = {
  executed: 'ok',
  verify_failed: 'verify_failed',
  reverted: 'reverted',
  rejected_by_gate: 'rejected',
};

export function consumeExecutedValue(
  value: string | undefined,
  traceId: string | null,
  logger: Logger,
  onDecision: (decision: ControlResult) => void,
): boolean {
  const parsed = ExecutedEventSchema.safeParse(
    value === undefined ? undefined : safeJsonParse(value),
  );
  if (!parsed.success) {
    logger.warn({ msg: 'kafka_executed_malformed', trace_id: traceId });
    return false;
  }
  const decision = OUTCOME_TO_CONTROL_RESULT[parsed.data.outcome];
  if (decision === undefined) {
    logger.warn({
      msg: 'kafka_executed_unknown_outcome',
      trace_id: traceId,
      outcome: parsed.data.outcome,
    });
    return false;
  }
  onDecision(decision);
  logger.info({
    msg: 'kafka_executed_consumed',
    trace_id: traceId,
    proposal_id: parsed.data.proposal_id,
    outcome: parsed.data.outcome,
    decision,
  });
  return true;
}

export class ExecutedResultConsumer {
  private readonly consumer: Consumer;

  constructor(
    brokers: readonly string[],
    clientId: string,
    groupId: string,
    private readonly logger: Logger,
    private readonly onDecision: (decision: ControlResult) => void,
  ) {
    this.consumer = new Kafka({ brokers: [...brokers], clientId }).consumer({ groupId });
  }

  async start(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: TOPIC_CONTROL_EXECUTED });
    await this.consumer.run({
      // 骨架处理是纯同步加工；显式 Promise 包装满足 kafkajs 的 EachMessageHandler 类型。
      eachMessage: (payload: EachMessagePayload): Promise<void> => {
        const rawTraceId = payload.message.headers?.[TRACE_ID_HEADER];
        // kafkajs 消费侧 header 值是 Buffer（生产侧接受 string）——统一收敛成 string。
        const traceId =
          typeof rawTraceId === 'string'
            ? rawTraceId
            : Buffer.isBuffer(rawTraceId)
              ? rawTraceId.toString('utf8')
              : null;
        consumeExecutedValue(
          payload.message.value?.toString('utf8'),
          traceId,
          this.logger,
          this.onDecision,
        );
        return Promise.resolve();
      },
    });
    this.logger.info({ msg: 'kafka_executed_consumer_started', topic: TOPIC_CONTROL_EXECUTED });
  }

  async stop(): Promise<void> {
    await this.consumer.disconnect();
    this.logger.info({ msg: 'kafka_executed_consumer_stopped' });
  }
}
