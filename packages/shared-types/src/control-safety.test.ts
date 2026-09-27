/**
 * control-safety 契约测试（IMPL-18 / DAT-164）：
 * - §11 参数快照：默认值钉死（platform.md §12 同机制）——数值修订 = 发版动作，
 *   必须显式改快照；熔断五行默认值与 ddl.md §9.3 逐字一致；
 * - §4 MQTT 契约：信封/应答形状解析（含拒绝面）；
 * - §2 阶段机值集：与 §3.7 非终态集合的关系；
 * - §10 Kafka 消息体：outcome 四值封闭。
 */
import { describe, expect, it } from 'vitest';
import {
  CONTROL_ACTIVE_PHASES,
  CONTROL_EXECUTED_OUTCOMES,
  CONTROL_EXECUTION_PHASES,
  CONTROL_FUSE_CONSECUTIVE_FAILS,
  CONTROL_FUSE_COOLDOWN_S,
  CONTROL_FUSE_EVAL_INTERVAL_S,
  CONTROL_FUSE_RATE_THRESHOLD,
  CONTROL_FUSE_RELEASE_RATE,
  CONTROL_FUSE_WINDOW_S,
  CONTROL_LEASE_TTL_S,
  CONTROL_RATE_LIMIT_DEFAULT,
  CONTROL_SAFETY_PARAMS,
  CONTROL_UP_EVENT_SUBSCRIBE_FILTER,
  ControlExecutedEventSchema,
  ControlReadResultSchema,
  ControlUpEventSchema,
  ControlWriteAckSchema,
  ControlWriteCommandSchema,
  controlDownWriteTopic,
} from './control-safety.js';

describe('control-safety §11 参数快照（platform.md §12 机制）', () => {
  it('shouldPinDefaultValues_explicitlyInSnapshot', () => {
    expect(CONTROL_SAFETY_PARAMS).toMatchInlineSnapshot(`
      {
        "CONTROL_ACK_TIMEOUT_S": 10,
        "CONTROL_CONFLICT_QUEUE_MAX": 3,
        "CONTROL_CONFLICT_WAIT_TIMEOUT_S": 300,
        "CONTROL_EXECUTION_BUDGET_S": 90,
        "CONTROL_FUSE_CONSECUTIVE_FAILS": 3,
        "CONTROL_FUSE_COOLDOWN_S": 1800,
        "CONTROL_FUSE_EVAL_INTERVAL_S": 60,
        "CONTROL_FUSE_RATE_THRESHOLD": 0.3,
        "CONTROL_FUSE_RELEASE_RATE": 0.05,
        "CONTROL_FUSE_WINDOW_S": 900,
        "CONTROL_LEASE_HEARTBEAT_INTERVAL_S": 30,
        "CONTROL_LEASE_SWEEP_INTERVAL_S": 30,
        "CONTROL_LEASE_TTL_S": 900,
        "CONTROL_RATE_LIMIT_DEFAULT": 6,
        "CONTROL_READ_TIMEOUT_S": 10,
        "CONTROL_VERIFY_DELAY_S": 5,
        "CONTROL_VERIFY_TOLERANCE": 0,
        "CONTROL_WRITE_RETRY_MAX": 1,
      }
    `);
  });

  it('shouldMatchDdlMdS93_fuseFiveDefaults_verbatim', () => {
    // ddl.md §9.3 评估参数表：15min 窗口 / 30% 或连续 3 / <5% 持续 30min
    expect(CONTROL_FUSE_WINDOW_S).toBe(15 * 60);
    expect(CONTROL_FUSE_RATE_THRESHOLD).toBe(0.3);
    expect(CONTROL_FUSE_CONSECUTIVE_FAILS).toBe(3);
    expect(CONTROL_FUSE_RELEASE_RATE).toBe(0.05);
    expect(CONTROL_FUSE_COOLDOWN_S).toBe(30 * 60);
    // ADR-009 租约默认 15min；M8 熔断页轮询节奏与评估节奏耦合（M8 §11-3）
    expect(CONTROL_LEASE_TTL_S).toBe(15 * 60);
    expect(CONTROL_FUSE_EVAL_INTERVAL_S).toBe(60);
  });
});

describe('§2 阶段机值集', () => {
  it('shouldKeepActivePhases_asASubsetOfAllPhases', () => {
    for (const phase of CONTROL_ACTIVE_PHASES) {
      expect(CONTROL_EXECUTION_PHASES).toContain(phase);
    }
    // 闸门 4 判定口径不含排队态（排队由队列深度/合并策略单独管理，§3.7）
    expect(CONTROL_ACTIVE_PHASES).not.toContain('queued');
  });
});

describe('§4 MQTT 契约', () => {
  it('shouldParseValidWriteCommand_andRejectMissingExpires', () => {
    const cmd = {
      msg_type: 'write_cmd',
      ver: 1,
      cmd_id: '0192a7f0-5c1e-7abc-9def-1234567890ab',
      point_ref: 'CHW_ST_SP_01',
      value: 7.5,
      unit: 'degC',
      issued_at: '2026-09-26T15:00:00.250+08:00',
      expires_in_s: 30,
    };
    expect(ControlWriteCommandSchema.safeParse(cmd).success).toBe(true);
    expect(ControlWriteCommandSchema.safeParse({ ...cmd, expires_in_s: undefined }).success).toBe(
      false,
    );
    // read_cmd 不带 value/unit（§4.2）
    expect(
      ControlWriteCommandSchema.safeParse({
        msg_type: 'read_cmd',
        ver: 1,
        cmd_id: cmd.cmd_id,
        point_ref: 'CHW_ST_SP_01',
        issued_at: cmd.issued_at,
        expires_in_s: 30,
      }).success,
    ).toBe(true);
  });

  it('shouldParseUpEvents_viaDiscriminatedUnion', () => {
    const ack = {
      msg_type: 'write_ack',
      ver: 1,
      cmd_id: '0192a7f0-5c1e-7abc-9def-1234567890ab',
      gw: 'GW2026001',
      result: 'accepted',
      code: null,
      at: '2026-09-26T15:00:01.100+08:00',
    };
    expect(ControlWriteAckSchema.safeParse(ack).success).toBe(true);
    expect(ControlUpEventSchema.safeParse(ack).success).toBe(true);
    expect(ControlUpEventSchema.safeParse({ ...ack, result: 'maybe' }).success).toBe(false);

    const read = {
      msg_type: 'read_result',
      ver: 1,
      cmd_id: '0192a7f0-5c1e-7abc-9def-1234567890ab',
      gw: 'GW2026001',
      value: 7.5,
      unit: 'degC',
      quality: 'good',
      ts: '2026-09-26T15:00:07.300+08:00',
      at: '2026-09-26T15:00:07.301+08:00',
    };
    expect(ControlReadResultSchema.safeParse(read).success).toBe(true);
    expect(ControlUpEventSchema.safeParse(read).success).toBe(true);
    // quality 封闭集（§4.3：≠ good 按读失败处理）
    expect(ControlReadResultSchema.safeParse({ ...read, quality: 'stale' }).success).toBe(false);
  });

  it('shouldBuildTopics_perContract', () => {
    expect(controlDownWriteTopic('GW2026001')).toBe('thermio/gw/GW2026001/down/write');
    expect(CONTROL_UP_EVENT_SUBSCRIBE_FILTER).toBe('$share/control/thermio/gw/+/up/event');
  });
});

describe('§10 Kafka control.executed 消息体', () => {
  it('shouldParseTheReferencePayload', () => {
    const event = {
      proposal_id: '0192a7f0-5c1e-7abc-9def-1234567890ab',
      tenant_id: '0192a7f0-0000-7000-8000-000000000001',
      trace_id: 'trace-1',
      point_id: 101,
      equipment_id: '0192a7f0-0000-7000-8000-000000000002',
      system_id: null,
      algo: 'optimizer/chiller-sequencer',
      algo_version: '1.3.2',
      outcome: 'executed',
      reason_code: null,
      value_before: 6,
      value_commanded: 7.8,
      value_effective: 7.5,
      clamped: true,
      decided_by: null,
      actor_type: 'algo',
      verify: {
        readings: [{ at: '2026-09-26T15:00:12+08:00', value: 7.5, match: true }],
        retries_write: 0,
      },
      at: '2026-09-26T15:00:12+08:00',
    };
    expect(ControlExecutedEventSchema.safeParse(event).success).toBe(true);
    expect(ControlExecutedEventSchema.safeParse({ ...event, outcome: 'half_done' }).success).toBe(
      false,
    );
  });

  it('shouldKeepOutcomeClosed_fourValuesIncludingGateRejection', () => {
    // flows.md §2 拒绝分支事件 → rejected_by_gate（§10/〔R5〕）
    expect(CONTROL_EXECUTED_OUTCOMES).toEqual([
      'executed',
      'verify_failed',
      'reverted',
      'rejected_by_gate',
    ]);
  });
});

describe('§3.3 频率兜底默认', () => {
  it('shouldDefaultToSixPerHour_safetyDefaultNotNullUnlimited', () => {
    expect(CONTROL_RATE_LIMIT_DEFAULT).toBe(6);
  });
});
