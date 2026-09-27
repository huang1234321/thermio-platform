/**
 * control-safety 单元测试（IMPL-18 / DAT-164）——纯逻辑面，无 PG/MQTT 门控：
 * - 闸门 2 clamp 纯函数（§3.2：空侧不夹 / 调整不拒绝 / from-to 留痕）；
 * - reason_code → 指标 label 机械映射（§3.6 同源，v1.5）；
 * - execution_result 渐进合并件（appendCmd/appendReading/终态化 mutate 语义）；
 * - Kafka 消息构建（§10：key=point_id + headers tenant/trace）。
 */
import { describe, expect, it } from 'vitest';
import { GATE_CAUSE_LABELS, type GateLabel } from '@thermio/shared-types';
import { clampOf } from '../src/control-safety/arbitration.service.js';
import {
  appendCmd,
  appendReading,
  buildExecutedEvent,
  gateLabelOfReasonCode,
  type ExecutionResult,
} from '../src/control-safety/execution-store.js';
import { buildControlExecutedMessage } from '../src/infrastructure/kafka/kafka-publisher.js';

describe('闸门 2 clamp（§3.2）', () => {
  it('shouldNotClamp_whenValueWithinRange_orSideNull', () => {
    expect(clampOf(7.5, 5, 9)).toEqual({ effective: 7.5, clamped: false, detail: null });
    expect(clampOf(7.5, null, null)).toEqual({ effective: 7.5, clamped: false, detail: null });
    expect(clampOf(0, null, 9)).toEqual({ effective: 0, clamped: false, detail: null });
    expect(clampOf(20, 5, null)).toEqual({ effective: 20, clamped: false, detail: null });
  });

  it('shouldClampToBoundary_whenValueOutside_withFromToDetail', () => {
    expect(clampOf(9.5, 5, 9)).toEqual({
      effective: 9,
      clamped: true,
      detail: { from: 9.5, to: 9 },
    });
    expect(clampOf(4.2, 5, 9)).toEqual({
      effective: 5,
      clamped: true,
      detail: { from: 4.2, to: 5 },
    });
  });
});

describe('reason_code → 指标 label（§3.6 v1.5 同源）', () => {
  it('shouldMapEveryGateCause_toItsGateSubstring', () => {
    expect(gateLabelOfReasonCode('proposal.gate_whitelist_denied')).toBe<GateLabel>('whitelist');
    expect(gateLabelOfReasonCode('proposal.gate_rate_limited')).toBe<GateLabel>('rate');
    expect(gateLabelOfReasonCode('proposal.gate_conflict_queued')).toBe<GateLabel>('conflict');
    expect(gateLabelOfReasonCode('proposal.gate_conflict_overflow')).toBe<GateLabel>('conflict');
    expect(gateLabelOfReasonCode('proposal.gate_conflict_timeout')).toBe<GateLabel>('conflict');
    expect(gateLabelOfReasonCode('proposal.gate_system_fused')).toBe<GateLabel>('fuse');
  });

  it('shouldCoverAllCauses_inTheStaticMap', () => {
    for (const cause of Object.keys(GATE_CAUSE_LABELS)) {
      expect(gateLabelOfReasonCode(`proposal.${cause}`)).toBeDefined();
    }
    // 未知码防御性兜底（不崩——API-CT-03 宽松面）
    expect(gateLabelOfReasonCode('proposal.unknown')).toBe<GateLabel>('conflict');
  });
});

describe('execution_result 渐进合并件', () => {
  it('shouldAppendCmds_preservingHistory', () => {
    let result: ExecutionResult = { phase: 'dispatching' };
    result = appendCmd(result, { cmd_id: 'c1', kind: 'write' });
    result = appendCmd(result, { cmd_id: 'c2', kind: 'read' });
    result = appendCmd(result, { cmd_id: 'c3', kind: 'revert' });
    expect(result.cmds?.map((c) => c.kind)).toEqual(['write', 'read', 'revert']);
    expect(result.cmds?.every((c) => c.ack === null)).toBe(true);
  });

  it('shouldAppendReadings_progressively', () => {
    let result: ExecutionResult = { phase: 'awaiting_readback' };
    result = appendReading(result, { at: 't1', value: 6.0, match: false });
    result = appendReading(result, { at: 't2', value: 7.5, match: true });
    expect(result.verify?.readings).toHaveLength(2);
    expect(result.verify?.readings[1]?.match).toBe(true);
  });
});

describe('Kafka control.executed 消息构建（§10）', () => {
  it('shouldKeyByPointId_andCarryTenantAndTraceHeaders', () => {
    const event = buildExecutedEvent({
      tenantId: '0192a7f0-0000-7000-8000-000000000001',
      proposalId: '0192a7f0-5c1e-7abc-9def-1234567890ab',
      pointId: 101,
      equipmentId: '0192a7f0-0000-7000-8000-000000000002',
      systemId: null,
      algo: 'optimizer/chiller-sequencer',
      algoVersion: '1.3.2',
      outcome: 'executed',
      reasonCode: null,
      valueBefore: 6,
      valueCommanded: 7.8,
      valueEffective: 7.5,
      clamped: true,
      decidedBy: null,
      verify: { readings: [], retries_write: 0 },
    });
    const message = buildControlExecutedMessage(event);
    expect(message.messages[0]?.key).toBe('101'); // 同点位保序
    expect(message.messages[0]?.headers).toMatchObject({
      trace_id: `ctl-${event.proposal_id}`,
      tenant_id: event.tenant_id,
    });
    // 三值链完整（ADR-004 学习闭环）
    expect(JSON.parse(message.messages[0]?.value ?? '{}')).toMatchObject({
      value_before: 6,
      value_commanded: 7.8,
      value_effective: 7.5,
      clamped: true,
      outcome: 'executed',
    });
  });
});
