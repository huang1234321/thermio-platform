/**
 * 质量事件消费者（M4-alarm.md §5.1 通道①；ingest.md §8 载荷）。
 *
 * topic `thermio.telemetry.quality`（ADR-004），消费组 `thermio-alarm-engine`，
 * partition key point_id。重启重放（§5.6/R7）：GROUP_JOIN 后 seek 至 now−2h
 * （覆盖默认双窗上界；依赖 topic 保留 ≥24h），边沿幂等重放重建引擎状态表。
 *
 * 处理失败不外抛（kafkajs eachMessage 抛错会断消费循环）：ERROR 留痕，
 * 单条丢失由重启 2h 重放兜底（§8.3：不丢不重）。
 */
import { Kafka, type Admin, type Consumer, type EachMessagePayload } from 'kafkajs';
import type { Logger } from 'pino';
import {
  TRACE_ID_HEADER,
  TOPIC_TELEMETRY_QUALITY,
} from '../infrastructure/kafka/kafka.constants.js';
import type { AlarmEngineService } from './alarm-engine.service.js';

/** 重放窗（ms）：2h，覆盖 sustained/recovery 双窗默认上界（§5.6）。 */
const REPLAY_WINDOW_MS = 2 * 60 * 60 * 1000;

/** ingest §8 载荷最小面（引擎只消费 point_id/gateway_id/ts/event 边沿）。 */
const QualityPayloadFields = ['point_id', 'gateway_id', 'ts', 'event'] as const;

function safeJsonParse(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

/** 消息体校验（畸形 WARN 不 crash 消费循环，同 executed.consumer 纪律）。 */
export function parseQualityPayload(value: string | undefined): {
  point_id: number | string;
  gateway_id?: string | null;
  ts?: number | string;
  event: string;
} | null {
  const parsed = safeJsonParse(value);
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const pointId = record['point_id'];
  const event = record['event'];
  if ((typeof pointId !== 'number' && typeof pointId !== 'string') || typeof event !== 'string') {
    return null;
  }
  const gatewayId = record['gateway_id'];
  const ts = record['ts'];
  return {
    point_id: pointId,
    gateway_id: typeof gatewayId === 'string' ? gatewayId : null,
    ...(typeof ts === 'number' || typeof ts === 'string' ? { ts } : {}),
    event,
  };
}

export class QualityEventConsumer {
  private readonly consumer: Consumer;
  private admin: Admin | null = null;

  constructor(
    brokers: readonly string[],
    clientId: string,
    private readonly logger: Logger,
    private readonly engine: AlarmEngineService,
  ) {
    const kafka = new Kafka({ brokers: [...brokers], clientId });
    this.consumer = kafka.consumer({ groupId: 'thermio-alarm-engine' });
    this.admin = kafka.admin();
  }

  async start(): Promise<void> {
    await this.consumer.connect();
    await this.admin?.connect();
    await this.consumer.subscribe({ topic: TOPIC_TELEMETRY_QUALITY });
    // 重启重放（§5.6）：分配到位后 seek 至 now−2h，边沿幂等重建状态表
    this.consumer.on(this.consumer.events.GROUP_JOIN, ({ payload }) => {
      void this.seekToReplayWindow().catch((err: unknown) => {
        this.logger.error({ msg: 'quality_replay_seek_failed', err });
      });
      this.logger.info({
        msg: 'quality_consumer_group_joined',
        group: payload.groupId,
        replay_window_ms: REPLAY_WINDOW_MS,
      });
    });
    await this.consumer.run({
      eachMessage: (payload: EachMessagePayload): Promise<void> => {
        void this.handle(payload).catch((err: unknown) => {
          this.logger.error({ msg: 'quality_event_process_failed', err });
        });
        return Promise.resolve();
      },
    });
    this.logger.info({ msg: 'quality_consumer_started', topic: TOPIC_TELEMETRY_QUALITY });
  }

  async stop(): Promise<void> {
    await this.admin?.disconnect().catch(() => undefined);
    await this.consumer.disconnect().catch(() => undefined);
    this.logger.info({ msg: 'quality_consumer_stopped' });
  }

  private async seekToReplayWindow(): Promise<void> {
    if (this.admin === null) return;
    const offsets = await this.admin.fetchTopicOffsetsByTimestamp(
      TOPIC_TELEMETRY_QUALITY,
      Date.now() - REPLAY_WINDOW_MS,
    );
    for (const partition of offsets) {
      this.consumer.seek({
        topic: TOPIC_TELEMETRY_QUALITY,
        partition: partition.partition,
        offset: partition.offset,
      });
    }
  }

  private async handle(payload: EachMessagePayload): Promise<void> {
    const parsed = parseQualityPayload(payload.message.value?.toString('utf8'));
    if (parsed === null) {
      const rawTraceId = payload.message.headers?.[TRACE_ID_HEADER];
      this.logger.warn({
        msg: 'quality_event_malformed',
        trace_id: Buffer.isBuffer(rawTraceId) ? rawTraceId.toString('utf8') : null,
        fields: QualityPayloadFields,
      });
      return;
    }
    await this.engine.onQualityEvent(parsed);
  }
}
