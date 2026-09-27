/**
 * reason_code 命名形状与映射表契约（platform.md §5.2；§8 对齐事项 1 收口面）。
 */
import { describe, expect, it } from 'vitest';
import {
  GATE_CAUSES,
  OVERVIEW_DESIGN_CODE_ALIASES,
  REASON_CODES,
  REASON_CODE_REGISTRY,
  ReasonCodeSchema,
  httpStatusForReasonCode,
  isReasonCode,
} from './reason-codes.js';

/** §5.2 命名规则：`<domain>.<cause>` 全小写蛇形。 */
const LOWER_SNAKE_DOMAIN_CAUSE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

describe('reason_code registry', () => {
  it('shouldMatchTheLowercaseSnakeShape_forEverySeedCode', () => {
    for (const code of REASON_CODES) {
      expect(code).toMatch(LOWER_SNAKE_DOMAIN_CAUSE);
    }
  });

  it('shouldRegisterExactlyThirtyCodes_eighteenSeedsPlusThreeBatches', () => {
    // §5.2 种子 18 码（common.not_found 随 DAT-119 / DAT-96 收尾增补）+ 三批增量
    // （数组注释留痕，均走 PR 治理）：IMPL-12 三遥测码（DAT-115）
    // + IMPL-7 auth.service_unauthorized（DAT-110，§11-2）
    // + IMPL-10 八码（DAT-113：common.rate_limited、auth.unauthenticated/
    // refresh_revoked、user.* 四码、role.unknown）。
    expect(REASON_CODES).toHaveLength(30);
  });

  it('shouldKeepTheRegistryComplete_whenReasonCodeSchemaParses', () => {
    for (const code of REASON_CODES) {
      expect(ReasonCodeSchema.safeParse(code).success).toBe(true);
    }
    expect(ReasonCodeSchema.safeParse('proposal.not_a_seed_code').success).toBe(false);
  });

  it('shouldAnswerMembership_andHttpStatus_forEverySeedCode', () => {
    expect(isReasonCode('proposal.gate_clamped')).toBe(true);
    expect(isReasonCode('proposal.gate_clamped_x')).toBe(false);
    expect(httpStatusForReasonCode('proposal.gate_clamped')).toBe(200);
    expect(httpStatusForReasonCode('proposal.gate_rate_limited')).toBe(429);
    expect(httpStatusForReasonCode('proposal.gate_circuit_open')).toBe(503);
    expect(httpStatusForReasonCode('common.internal_error')).toBe(500);
    expect(httpStatusForReasonCode('common.validation_failed')).toBe(422);
    expect(httpStatusForReasonCode('common.not_found')).toBe(404);
  });

  it('shouldTagExactlyFiveGates_withCauseSubstringsAsMetricLabels', () => {
    expect(GATE_CAUSES).toHaveLength(5);
    for (const cause of GATE_CAUSES) {
      const meta = REASON_CODE_REGISTRY[`proposal.${cause}` as const];
      expect(meta.gate).toBe(cause);
    }
  });
});

describe('OVERVIEW_DESIGN_CODE_ALIASES（§8 对齐事项 1 映射表）', () => {
  it('shouldMapEveryDesignCodeToTheLowercaseDomainCauseShape', () => {
    for (const [designCode, canonical] of Object.entries(OVERVIEW_DESIGN_CODE_ALIASES)) {
      expect(designCode).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(canonical).toMatch(LOWER_SNAKE_DOMAIN_CAUSE);
    }
  });

  it('shouldKeepTheFourExplicitMechanicalMappings_verbatimFromPlatformMdS52', () => {
    expect(OVERVIEW_DESIGN_CODE_ALIASES['PROPOSAL_STATE_INVALID']).toBe('proposal.state_invalid');
    expect(OVERVIEW_DESIGN_CODE_ALIASES['IMPORT_FILE_INVALID']).toBe('import.file_invalid');
    expect(OVERVIEW_DESIGN_CODE_ALIASES['STREAM_LIMIT_EXCEEDED']).toBe('stream.limit_exceeded');
    expect(OVERVIEW_DESIGN_CODE_ALIASES['SERVICE_UNAUTHORIZED']).toBe('auth.service_unauthorized');
  });

  it('shouldTargetSeedCodes_whereSemanticsMatchExactly', () => {
    expect(OVERVIEW_DESIGN_CODE_ALIASES['VALIDATION_FAILED']).toBe('common.validation_failed');
    expect(OVERVIEW_DESIGN_CODE_ALIASES['INTERNAL_ERROR']).toBe('common.internal_error');
    expect(OVERVIEW_DESIGN_CODE_ALIASES['TOKEN_EXPIRED']).toBe('auth.token_expired');
    expect(OVERVIEW_DESIGN_CODE_ALIASES['FORBIDDEN']).toBe('auth.forbidden');
    expect(OVERVIEW_DESIGN_CODE_ALIASES['LOGIN_FAILED']).toBe('auth.invalid_credentials');
    expect(OVERVIEW_DESIGN_CODE_ALIASES['POINT_NOT_FOUND']).toBe('asset.not_found');
    expect(OVERVIEW_DESIGN_CODE_ALIASES['ALARM_RULE_NOT_FOUND']).toBe('alarm.rule_not_found');
    expect(OVERVIEW_DESIGN_CODE_ALIASES['PROPOSAL_GATE_SYSTEM_FUSED']).toBe(
      'proposal.gate_circuit_open',
    );
  });

  it('shouldMarkDraftTargetsOnly_whenCanonicalIsOutsideTheSeedTable', () => {
    // 种子表目标必须真实在册（映射表不许指向不存在的种子码）；
    // 种子表外目标 = 草案码，随模块落码走 PR 注册后才可由服务端发出。
    for (const canonical of Object.values(OVERVIEW_DESIGN_CODE_ALIASES)) {
      if (isReasonCode(canonical)) {
        expect(REASON_CODE_REGISTRY[canonical]).toBeDefined();
      }
    }
  });
});
