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
import { consumeExecutedValue } from '../src/infrastructure/kafka/executed.consumer.js';
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
      JSON.stringify({ proposal_id: 'pp_1', result: 'ok' }),
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
      consumeExecutedValue('{"proposal_id": "pp_2", "result": "ok"', 'trc_2', logger, () => {}),
    ).toBe(false);
    expect(consumeExecutedValue(undefined, null, logger, () => {})).toBe(false);
    expect(
      consumeExecutedValue(
        JSON.stringify({ proposal_id: 'pp_3', result: 'mystery' }),
        'trc_3',
        logger,
        () => {},
      ),
    ).toBe(false);
  });
});
