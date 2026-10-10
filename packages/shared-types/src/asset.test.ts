/**
 * 资产域契约测试（M1-asset §2/§3 schema 面）：
 * - 枚举字段收宽为 string 的请求 schema 不误吞类型错误（z.number 等）；
 * - strict 白名单：不可变字段（gateway serial 等）在 PATCH 面 422；
 * - offline_action loose schema：value 数值（unit_std 口径注记）与项数上限；
 * - rated_params 16KB 上限（纯 TS UTF-8 计数器）；
 * - batch-status ids 去重/上限；PointListItem/PointDetail 形状。
 */
import { describe, expect, it } from 'vitest';
import {
  BuildingCreateSchema,
  BuildingUpdateSchema,
  EquipmentCreateSchema,
  GatewayCreateSchema,
  GatewayUpdateSchema,
  OfflineActionSchema,
  PointBatchStatusSchema,
  PointPhysicalPatchSchema,
  PointSearchQuerySchema,
  PointStatusPatchSchema,
  RatedParamsSchema,
  SystemCreateSchema,
} from './asset.js';

describe('资产域请求 schema（M1-asset §3）', () => {
  it('shouldAcceptKnownEnumValues_asPlainStrings_serviceLayerGuards', () => {
    expect(BuildingCreateSchema.safeParse({ name: 'A', building_type: 'office' }).success).toBe(
      true,
    );
    expect(
      SystemCreateSchema.safeParse({
        building_id: '123e4567-e89b-42d3-a456-426614174001',
        system_type: 'ahu',
        name: 's',
      }).success,
    ).toBe(true);
    expect(
      EquipmentCreateSchema.safeParse({
        system_id: '123e4567-e89b-42d3-a456-426614174001',
        equipment_type: 'chiller',
        name: 'e',
      }).success,
    ).toBe(true);
    // 未知枚举值在 schema 面仍通过（string）——专用码由服务层发（asset.*_unknown）
    expect(BuildingCreateSchema.safeParse({ name: 'A', building_type: 'stadium' }).success).toBe(
      true,
    );
  });

  it('shouldRejectTypeErrors_beforeServiceLayer', () => {
    expect(BuildingCreateSchema.safeParse({ name: 'A', gross_area_m2: 'large' }).success).toBe(
      false,
    );
    expect(BuildingCreateSchema.safeParse({ name: '', building_type: 'office' }).success).toBe(
      false,
    );
  });

  it('shouldRejectEmptyPatchObjects', () => {
    expect(BuildingUpdateSchema.safeParse({}).success).toBe(false);
    expect(GatewayUpdateSchema.safeParse({}).success).toBe(false);
  });

  it('shouldKeepGatewayImmutableFields_outOfUpdateWhitelist', () => {
    expect(GatewayUpdateSchema.safeParse({ serial: 'X' }).success).toBe(false);
    expect(GatewayUpdateSchema.safeParse({ mqtt_client_id: 'X' }).success).toBe(false);
    expect(
      GatewayUpdateSchema.safeParse({ building_id: '123e4567-e89b-42d3-a456-426614174001' })
        .success,
    ).toBe(false);
    expect(GatewayUpdateSchema.safeParse({ name: 'N' }).success).toBe(true);
  });

  it('shouldEnforceSerialCharset_onCreate', () => {
    expect(
      GatewayCreateSchema.safeParse({
        serial: 'ABC.123-4_5',
        name: 'g',
        building_id: '123e4567-e89b-42d3-a456-426614174001',
      }).success,
    ).toBe(true);
    expect(
      GatewayCreateSchema.safeParse({
        serial: '9bad serial!',
        name: 'g',
        building_id: '123e4567-e89b-42d3-a456-426614174001',
      }).success,
    ).toBe(false);
    expect(
      GatewayCreateSchema.safeParse({
        serial: '-leading-dash',
        name: 'g',
        building_id: '123e4567-e89b-42d3-a456-426614174001',
      }).success,
    ).toBe(false);
  });

  it('shouldValidateOfflineAction_looseSchema_valueMustBeNumeric_unitStd', () => {
    expect(OfflineActionSchema.safeParse({ writes: [{ raw_name: 'A', value: 0 }] }).success).toBe(
      true,
    );
    expect(
      OfflineActionSchema.safeParse({ writes: [{ raw_name: 'A', value: 'zero' }] }).success,
    ).toBe(false);
    expect(OfflineActionSchema.safeParse({ writes: [] }).success).toBe(true);
    expect(
      OfflineActionSchema.safeParse({
        writes: Array.from({ length: 65 }, () => ({ raw_name: 'A', value: 1 })),
      }).success,
    ).toBe(false);
    expect(OfflineActionSchema.safeParse({ retries: 3 }).success).toBe(false); // strict
  });

  it('shouldCapRatedParams_at16KB_serialized', () => {
    expect(RatedParamsSchema.safeParse({ k: 'v'.repeat(1024) }).success).toBe(true);
    const big: Record<string, string> = {};
    for (let i = 0; i < 64; i += 1) big[String(i)] = 'v'.repeat(300); // ~19KB
    expect(RatedParamsSchema.safeParse(big).success).toBe(false);
    // 非 ASCII 字节计数正确（纯 TS UTF-8 计数器）
    expect(RatedParamsSchema.safeParse({ note: '冷'.repeat(6000) }).success).toBe(false);
  });

  it('shouldValidateBatchStatus_idsDedupedAndCapped', () => {
    expect(
      PointBatchStatusSchema.safeParse({ ids: [1, 2], status: 'disabled', reason: 'r' }).success,
    ).toBe(true);
    expect(
      PointBatchStatusSchema.safeParse({ ids: [1, 1], status: 'disabled', reason: 'r' }).success,
    ).toBe(false);
    expect(
      PointBatchStatusSchema.safeParse({
        ids: Array.from({ length: 101 }, (_, i) => i + 1),
        status: 'active',
        reason: 'r',
      }).success,
    ).toBe(false);
    expect(PointBatchStatusSchema.safeParse({ ids: [1], status: 'disabled' }).success).toBe(false); // reason 必填
  });

  it('shouldValidateStatusPatch_strictShape', () => {
    expect(PointStatusPatchSchema.safeParse({ status: 'disabled', reason: 'r' }).success).toBe(
      true,
    );
    expect(PointStatusPatchSchema.safeParse({ status: 'paused', reason: 'r' }).success).toBe(false);
    expect(PointStatusPatchSchema.safeParse({ status: 'disabled', reason: '' }).success).toBe(
      false,
    );
    expect(
      PointStatusPatchSchema.safeParse({ status: 'disabled', reason: 'r', extra: 1 }).success,
    ).toBe(false);
  });

  it('shouldRejectNonWhitelistedSearchParams', () => {
    expect(PointSearchQuerySchema.safeParse({ quantity_type: 'power' }).success).toBe(true);
    expect(PointSearchQuerySchema.safeParse({ building_name: 'x' }).success).toBe(false);
    expect(PointSearchQuerySchema.safeParse({ limit: 201 }).success).toBe(false);
    expect(PointSearchQuerySchema.safeParse({}).success).toBe(true); // limit 默认 50
  });
});

describe('物理层 PATCH schema（M1-asset §3.10，DAT-151）', () => {
  it('shouldTrimRawName_beforeLengthChecks', () => {
    const parsed = PointPhysicalPatchSchema.safeParse({ raw_name: '  CHW.T01  ', reason: 'r' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.raw_name).toBe('CHW.T01');
    expect(PointPhysicalPatchSchema.safeParse({ raw_name: '   ', reason: 'r' }).success).toBe(
      false,
    ); // trim 后空 → 422
    expect(
      PointPhysicalPatchSchema.safeParse({ raw_name: 'x'.repeat(129), reason: 'r' }).success,
    ).toBe(false);
  });

  it('shouldRejectGatewayIdNull_with422_notNullable', () => {
    expect(PointPhysicalPatchSchema.safeParse({ gateway_id: null, reason: 'r' }).success).toBe(
      false,
    ); // 不可置 null（§3.10：v1 注册来源仅 mqtt_gateway）
  });

  it('shouldRejectProtocolAddress_nonObject_orOver4KB', () => {
    expect(
      PointPhysicalPatchSchema.safeParse({ protocol_address: { ref: 'a' }, reason: 'r' }).success,
    ).toBe(true);
    // 非对象（数组/字符串/null）→ 422
    expect(
      PointPhysicalPatchSchema.safeParse({ protocol_address: ['x'], reason: 'r' }).success,
    ).toBe(false);
    expect(PointPhysicalPatchSchema.safeParse({ protocol_address: 'x', reason: 'r' }).success).toBe(
      false,
    );
    expect(
      PointPhysicalPatchSchema.safeParse({ protocol_address: null, reason: 'r' }).success,
    ).toBe(false);
    // 超 4KB（loose schema 上限）
    const big = { pad: 'x'.repeat(4096) };
    expect(PointPhysicalPatchSchema.safeParse({ protocol_address: big, reason: 'r' }).success).toBe(
      false,
    );
  });

  it('shouldRejectDirectionOutsideEnum_andRequireReason', () => {
    expect(
      PointPhysicalPatchSchema.safeParse({ direction: 'readwrite', reason: 'r' }).success,
    ).toBe(true);
    expect(PointPhysicalPatchSchema.safeParse({ direction: 'rw', reason: 'r' }).success).toBe(
      false,
    );
    // reason 必填 1..512（缺失/空/超长）
    expect(PointPhysicalPatchSchema.safeParse({ direction: 'read' }).success).toBe(false);
    expect(PointPhysicalPatchSchema.safeParse({ direction: 'read', reason: '' }).success).toBe(
      false,
    );
    expect(
      PointPhysicalPatchSchema.safeParse({ direction: 'read', reason: 'x'.repeat(513) }).success,
    ).toBe(false);
  });
});
