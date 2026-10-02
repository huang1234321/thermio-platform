/**
 * Kafka 接线骨架单测（不依赖 broker；ADR-004 topic / ADR-017 trace_id 纪律）。
 */
import { describe, expect, it } from 'vitest';
import type { ProposalEnvelope } from '@thermio/shared-types';
import { pino } from 'pino';
import {
  TRACE_ID_HEADER,
  TOPIC_CONTROL_EXECUTED,
  TOPIC_CONTROL_PROPOSAL,
} from '../src/infrastructure/kafka/kafka.constants.js';
import { buildProposalMessage } from '../src/infrastructure/kafka/kafka-publisher.js';
import {
  consumeExecutedValue,
  resolveInboundTraceId,
} from '../src/infrastructure/kafka/executed.consumer.js';
import { INBOUND_ID_MAX_LENGTH } from '../src/infrastructure/request-id.js';
import { MetricsService } from '../src/infrastructure/metrics/metrics.service.js';

const PROPOSAL: ProposalEnvelope = {
  proposal_id: 'pp_kafka_01',
  algo: 'optimizer/chiller-sequencer',
  algo_version: '1.3.2',
  target: { equipment_id: 'chiller_01', point: 'chw_supply_temp_setpoint' },
  action: { op: 'set', value: 7.5, unit: 'degC' },
  previous_value: 6.0,
  rationale: '测试提案',
  expected_saving_kw: 42.3,
  confidence: 0.86,
  evidence: {},
  expires_at: '2026-09-26T15:30:00+08:00',
};

describe('kafka wiring（ADR-004 / ADR-017）', () => {
  it('shouldPinTheTwoControlTopics_perAdr004', () => {
    expect(TOPIC_CONTROL_PROPOSAL).toBe('thermio.control.proposal');
    expect(TOPIC_CONTROL_EXECUTED).toBe('thermio.control.executed');
    expect(TRACE_ID_HEADER).toBe('trace_id');
  });

  it('shouldBuildProposalMessage_withTraceIdHeaderAndProposalKey', () => {
    const message = buildProposalMessage(PROPOSAL, 'trc_abc123');
    expect(message.topic).toBe('thermio.control.proposal');
    expect(message.messages).toHaveLength(1);
    const entry = message.messages[0];
    if (entry === undefined) throw new Error('unreachable');
    expect(entry.key).toBe('pp_kafka_01'); // 同提案分区序
    expect(entry.headers[TRACE_ID_HEADER]).toBe('trc_abc123');
    expect(JSON.parse(entry.value) as unknown).toEqual(PROPOSAL);
  });
});

describe('consumeExecutedValue（executed 消费骨架）', () => {
  const logger = pino({ level: 'silent' });

  it('shouldRecordTheDecision_whenResultIsInControlResults', () => {
    const metrics = new MetricsService();
    const recorded = consumeExecutedValue(
      JSON.stringify({ proposal_id: 'pp_1', outcome: 'executed' }),
      'trc_1',
      logger,
      (decision) => {
        metrics.recordDecision(decision);
      },
    );
    expect(recorded).toBe(true);
  });

  it('shouldNotCrashTheLoop_whenPayloadIsMalformedOrUnknownResult', () => {
    expect(
      consumeExecutedValue(
        '{"proposal_id": "pp_2", "outcome": "executed"',
        'trc_2',
        logger,
        () => {},
      ),
    ).toBe(false);
    expect(consumeExecutedValue(undefined, null, logger, () => {})).toBe(false);
    expect(
      consumeExecutedValue(
        JSON.stringify({ proposal_id: 'pp_3', outcome: 'mystery' }),
        'trc_3',
        logger,
        () => {},
      ),
    ).toBe(false);
  });
});

describe('resolveInboundTraceId（DAT-123 消费侧 trace_id 白名单）', () => {
  // 与 request-id.test.ts 的纯函数矩阵对应，这里钉 Kafka 消费面：Buffer→utf8 解码
  // 路径 + 缺失/非法的「整体丢弃重生成 trc_」处置（与 HTTP 面同策略）。
  const REGENERATED = /^trc_[0-9a-f]{32}$/;

  it('shouldPassThrough_whenWhitelisted_asStringOrDecodedBuffer', () => {
    expect(resolveInboundTraceId('trc_abc123')).toBe('trc_abc123');
    // kafkajs 消费侧实际形状：header 值是 Buffer，utf8 解码后过白名单
    expect(resolveInboundTraceId(Buffer.from('trc_buf_01', 'utf8'))).toBe('trc_buf_01');
    expect(resolveInboundTraceId(Buffer.from('00-4bf92f35-00f067aa-01', 'utf8'))).toBe(
      '00-4bf92f35-00f067aa-01',
    );
  });

  it('shouldPassThrough_atExactlyTheMaxLengthBoundary', () => {
    const atCap = 'a'.repeat(INBOUND_ID_MAX_LENGTH);
    expect(resolveInboundTraceId(atCap)).toBe(atCap);
    expect(resolveInboundTraceId(Buffer.from(atCap, 'utf8'))).toBe(atCap);
  });

  it('shouldDropAndRegenerate_whenLongerThanTheMaxLength', () => {
    const overlong = 'a'.repeat(INBOUND_ID_MAX_LENGTH + 1);
    for (const regenerated of [
      resolveInboundTraceId(overlong),
      resolveInboundTraceId(Buffer.from(overlong, 'utf8')),
    ]) {
      expect(regenerated).not.toBe(overlong); // 整体丢弃，不截断
      expect(regenerated).toMatch(REGENERATED);
    }
  });

  it('shouldDropAndRegenerate_whenAnyCharIsOutsideTheWhitelist', () => {
    const illegals = [
      'bad id', // 空格
      'id"quote', // 引号（日志注入面）
      '{"injected":"json"}', // 花括号（伪造结构化日志）
      'trc_追踪1', // 非 ASCII（Buffer→utf8 解码路径）
      'a\tb', // 控制字符
      '', // 空串
    ];
    for (const raw of illegals) {
      const regenerated = resolveInboundTraceId(Buffer.from(raw, 'utf8'));
      expect(regenerated).not.toBe(raw);
      expect(regenerated).toMatch(REGENERATED);
    }
  });

  it('shouldRegenerate_whenHeaderIsMissingOrNotADecodableValue', () => {
    // 缺失头 / 空值 / kafkajs 数组头等非 string/Buffer 形状 → 服务端生成可用 id
    for (const raw of [undefined, null, {}, ['trc_x'], 42]) {
      expect(resolveInboundTraceId(raw)).toMatch(REGENERATED);
    }
  });
});
