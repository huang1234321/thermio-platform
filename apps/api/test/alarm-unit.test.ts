/**
 * 告警域单元测试（无 DB）：引擎状态机双窗 flap 吸收 + 边沿归一化 + 消费载荷解析 +
 * 游标编解码 + bcrypt dummy verify 时序对齐（DAT-110 跟踪项 1）+ 能力矩阵增量。
 *
 * 覆盖 M4-alarm.md §12「契约测试负路径最小组」中纯函数可承载的部分；
 * DB 路径（状态机 4xx/折叠/207/级联）在 alarm.e2e.test.ts（PG 门控）。
 */
import { describe, expect, it } from 'vitest';
import {
  applyClear,
  applyViolation,
  emptyEntry,
  qualityEdgeOf,
  recoveryDue,
  sustainedDue,
  type RuleSnapshot,
} from '../src/alarm/engine/engine-state.js';
import { parseQualityPayload } from '../src/alarm/quality.consumer.js';
import {
  decodeAlarmCursor,
  encodeAlarmCursor,
  timeKeysetPredicate,
} from '../src/alarm/alarm-cursor.js';
import { ReasonCodeException } from '../src/infrastructure/errors/reason-code.exception.js';
import { Argon2PasswordVerifier } from '../src/internal-mqtt/password-verifier.js';
import { capabilitiesForRole } from '@thermio/shared-types';

const RULE: RuleSnapshot = {
  ruleId: '00000000-0000-0000-0000-000000000001',
  severity: 'major',
  sustainedS: 60,
  recoveryS: 30,
};

describe('引擎状态机（M4-alarm.md §5.3/§4.1 双窗 flap 吸收）', () => {
  it('shouldOpenAlarm_whenViolationSustainedPastWindow', () => {
    const entry = applyViolation(emptyEntry(), 1_000, RULE);
    expect(sustainedDue(entry, 1_000 + 59_999)).toBe(false); // 防抖窗口内不开告警
    expect(sustainedDue(entry, 1_000 + 60_000)).toBe(true);
  });

  it('shouldCancelOpen_whenClearArrivesWithinSustainedWindow（set→clear 不开告警）', () => {
    let entry = applyViolation(emptyEntry(), 1_000, RULE);
    entry = applyClear(entry, 30_000);
    expect(sustainedDue(entry, 120_000)).toBe(false);
    expect(entry.violatingSince).toBeNull();
  });

  it('shouldCancelClose_whenViolationReturnsWithinRecoveryWindow（clear→set 不关告警）', () => {
    let entry = applyViolation(emptyEntry(), 1_000, RULE);
    entry = { ...entry, alarmId: 901 }; // 防抖达标已开（tick 执行面）
    entry = applyClear(entry, 10_000);
    expect(entry.pendingCloseAt).toBe(10_000 + 30_000);
    entry = applyViolation(entry, 20_000, RULE); // 回稳窗内复发
    expect(entry.pendingCloseAt).toBeNull(); // 取消关闭
    expect(entry.alarmId).toBe(901); // 活跃告警保持，不重开新行
  });

  it('shouldCloseWhenRecoveryWindowElapses', () => {
    let entry = applyViolation(emptyEntry(), 1_000, RULE);
    entry = { ...entry, alarmId: 901 };
    entry = applyClear(entry, 10_000);
    expect(recoveryDue(entry, 39_999)).toBe(false);
    expect(recoveryDue(entry, 40_000)).toBe(true);
  });

  it('shouldNeverOpen_withoutRule', () => {
    const entry = applyViolation(emptyEntry(), 1_000, null);
    expect(sustainedDue(entry, 999_999)).toBe(false); // 无规则 = 不会开告警
  });

  it('shouldNormalizeQualityEvents_toEdges（R7 值集）', () => {
    expect(qualityEdgeOf('stale_set')).toBe('violation');
    expect(qualityEdgeOf('stale_clear')).toBe('clear');
    // ts_skew/unit_unconverted 非边沿——告警去抖口径归 DAT-122 归属卡
    expect(qualityEdgeOf('ts_skew')).toBeNull();
    expect(qualityEdgeOf('unit_unconverted')).toBeNull();
  });
});

describe('质量事件载荷解析（ingest.md §8）', () => {
  it('shouldParseMinimalPayload', () => {
    const parsed = parseQualityPayload(
      JSON.stringify({ point_id: 42, gateway_id: 'g-1', ts: 123, event: 'stale_set' }),
    );
    expect(parsed).toEqual({ point_id: 42, gateway_id: 'g-1', ts: 123, event: 'stale_set' });
  });

  it('shouldRejectMalformedPayload', () => {
    expect(parseQualityPayload('not json')).toBeNull();
    expect(parseQualityPayload(JSON.stringify({ event: 'stale_set' }))).toBeNull();
    expect(parseQualityPayload(undefined)).toBeNull();
  });
});

describe('告警域游标（API-DSN-03；µs 时间键纪律）', () => {
  it('shouldRoundtripAndReject', () => {
    const encoded = encodeAlarmCursor({ k: ['1760000000000000'], id: '901' });
    expect(decodeAlarmCursor(encoded, 1)).toEqual({ k: ['1760000000000000'], id: '901' });
    expect(() => decodeAlarmCursor('bogus', 1)).toThrow(ReasonCodeException);
    // 非法游标 details.field=cursor
    try {
      decodeAlarmCursor('bogus', 1);
      expect.unreachable();
    } catch (error) {
      expect((error as ReasonCodeException).reasonCode).toBe('common.validation_failed');
    }
  });

  it('shouldBuildDescKeysetPredicate_withExactBigintCompare', () => {
    const predicate = timeKeysetPredicate(
      'desc',
      '((extract(epoch FROM a.opened_at) * 1000000)::bigint)',
      'a.id',
      { k: ['1760000000000000'], id: '901' },
      5,
    );
    expect(predicate.sql).toBe(
      '(((extract(epoch FROM a.opened_at) * 1000000)::bigint), a.id) < ($5::bigint, $6::bigint)',
    );
    expect(predicate.params).toEqual(['1760000000000000', '901']);
  });
});

describe('bcrypt dummy verify 时序对齐（DAT-110 跟踪项 1）', () => {
  it('shouldRunDummyVerify_onUnsupportedHashBranch抹平时序侧信道', async () => {
    const verifier = new Argon2PasswordVerifier(console as never);
    const start = performance.now();
    const outcome = await verifier.verify('$2b$12$somebcryptstylehashvalue', 'secret');
    const elapsed = performance.now() - start;
    expect(outcome).toBe('unsupported_hash');
    // 慢哈希同量级（Apple Silicon 上 argon2 m=19456/t=2 ≈ 10ms 量级）：
    // unsupported 分支不再瞬时返回（无 dummy 的裸分支 < 0.1ms——量级差即证据）
    expect(elapsed).toBeGreaterThan(5);
  }, 20_000);

  it('shouldKeepSupportedBranchSemantics', async () => {
    const verifier = new Argon2PasswordVerifier(console as never);
    const { hash } = await import('@node-rs/argon2');
    const hashValue = await hash('correct-password');
    expect(await verifier.verify(hashValue, 'correct-password')).toBe('matched');
    expect(await verifier.verify(hashValue, 'wrong-password')).toBe('mismatched');
  }, 20_000);
});

describe('能力矩阵增量（M7-auth §4.1 定稿三键）', () => {
  it('shouldGrantAlarmsAck_toOperatorNotSuppress', () => {
    const operator = capabilitiesForRole('operator');
    expect(operator).toContain('alarms.read');
    expect(operator).toContain('alarms.ack');
    expect(operator).not.toContain('alarms.suppress');
    expect(operator).not.toContain('alarm_rules.write');
  });

  it('shouldGrantAllAlarmKeys_toAdmin', () => {
    const admin = capabilitiesForRole('admin');
    expect(admin).toContain('alarms.ack');
    expect(admin).toContain('alarms.suppress');
    expect(admin).toContain('alarm_rules.write');
  });
});
