/**
 * 导入域契约测试（M2-import §1.6/§3/§6.5；DAT-104 挂接的封闭集纪律）。
 */
import { describe, expect, it } from 'vitest';
import {
  UNIT_CONVERSION_TABLE_V1,
  convertSample,
  findUnitConversion,
  gatewayDownTopic,
  GatewayConfigAckSchema,
  ImportJobListQuerySchema,
  ImportRowPatchSchema,
  ImportRowsQuerySchema,
  CONFIG_ACK_SUBSCRIBE_FILTER,
} from './import.js';
import { QUANTITY_KINDS, QUANTITY_TYPES } from './enums.js';

describe('unit conversion table v1（M2-import §6.5，双栈共享契约）', () => {
  it('shouldExposeCanonicalPairFor_knownTemperatureFamily', () => {
    // 温度族为 affine：degF→degC 含偏移，预览必须展示公式而非单因子
    const degf = findUnitConversion('°F', 'degC');
    expect(degf).not.toBeNull();
    expect(degf?.kind).toBe('affine');
    if (degf === null) throw new Error('°F→degC 应在表内');
    expect(convertSample(32, degf)).toBeCloseTo(0, 9);
    expect(convertSample(212, degf)).toBeCloseTo(100, 9);
  });

  it('shouldExposeIdentityAndLinearPairs_forNonTemperatureFamilies', () => {
    expect(findUnitConversion('℃', 'degC')?.kind).toBe('identity');
    expect(findUnitConversion('kW', 'kW')?.kind).toBe('identity');
    const w = findUnitConversion('W', 'kW');
    expect(w?.kind).toBe('linear');
    if (w === null) throw new Error('W→kW 应在表内');
    expect(convertSample(1500, w)).toBeCloseTo(1.5, 9);
  });

  it('shouldCoverIngestS52PressureEnergyFlowFamilies（验收 F3：内容源对齐）', () => {
    // 压力族 kPa/Pa/bar/psi/mmH2O（§5.2 逐项；1 psi = 6.894757293168361 kPa、
    // 1 mmH2O = 9.80665 Pa）
    const pair = (from: string, to: string) => {
      const entry = findUnitConversion(from, to);
      if (entry === null) throw new Error(`${from}→${to} 应在表内`);
      return entry;
    };
    expect(convertSample(1, pair('psi', 'kPa'))).toBeCloseTo(6.894757293168361, 9);
    expect(convertSample(1, pair('Pa', 'kPa'))).toBeCloseTo(0.001, 12);
    expect(convertSample(1, pair('mmH2O', 'kPa'))).toBeCloseTo(0.00980665, 12);
    expect(convertSample(1, pair('bar', 'kPa'))).toBeCloseTo(100, 9);
    // 能量族 kWh/Wh
    expect(convertSample(500, pair('Wh', 'kWh'))).toBeCloseTo(0.5, 9);
    // 流量族 m³/h / L/s（canonical 上标 ³ + ASCII 别名）
    expect(convertSample(2, pair('L/s', 'm³/h'))).toBeCloseTo(7.2, 9);
    expect(pair('m3/h', 'm³/h').kind).toBe('identity');
    // 恒等族 %/Hz/V/A/rpm（§5.2「等恒等族」）
    for (const unit of ['%', 'Hz', 'V', 'A', 'rpm']) {
      expect(findUnitConversion(unit, unit)?.kind).toBe('identity');
    }
  });

  it('shouldRejectMPa_perAcceptanceF3（源清单无 MPa，双栈一致不单侧放行）', () => {
    expect(findUnitConversion('MPa', 'kPa')).toBeNull();
  });

  it('shouldReturnNull_whenPairIsNotInTable', () => {
    // 未命中 = import.unit_conversion_unsupported（PATCH 即时 422 / dry-run 阻塞）
    expect(findUnitConversion('RT', 'kW')).toBeNull();
    expect(findUnitConversion('degC', 'kW')).toBeNull();
  });

  it('shouldKeepEveryEntryWellFormed', () => {
    const seen = new Set<string>();
    for (const entry of UNIT_CONVERSION_TABLE_V1) {
      expect(entry.from.length).toBeGreaterThan(0);
      expect(entry.to.length).toBeGreaterThan(0);
      expect(Number.isFinite(entry.scale)).toBe(true);
      expect(Number.isFinite(entry.offset)).toBe(true);
      if (entry.kind === 'identity' || entry.kind === 'linear') {
        expect(entry.offset).toBe(0);
      }
      const key = `${entry.from}→${entry.to}`;
      expect(seen.has(key)).toBe(false); // 对不重复
      seen.add(key);
    }
  });
});

describe('quantity kinds（P2-3 写点数值量判据）', () => {
  it('shouldCoverEveryQuantityType_exactly', () => {
    // 键集与 QUANTITY_TYPES 一致：扩充量类型必须同步维护分类（M2-import §1.6）
    expect(Object.keys(QUANTITY_KINDS).sort()).toEqual([...QUANTITY_TYPES].sort());
  });

  it('shouldClassifyRunStatusAsEnum_andTempsAsNumeric', () => {
    expect(QUANTITY_KINDS.run_status).toBe('enum');
    expect(QUANTITY_KINDS.chw_supply_temp).toBe('numeric');
    expect(QUANTITY_KINDS.power).toBe('numeric');
  });
});

describe('row patch schema（M2-import §3.5）', () => {
  it('shouldAcceptPartialSubset_andNullClearing', () => {
    expect(ImportRowPatchSchema.safeParse({ quantity_type: 'power' }).success).toBe(true);
    expect(
      ImportRowPatchSchema.safeParse({ equipment_id: null, quantity_type: null, unit_std: null })
        .success,
    ).toBe(true);
  });

  it('shouldRejectEmptyBody_andUnknownQuantity', () => {
    expect(ImportRowPatchSchema.safeParse({}).success).toBe(false);
    // raw_name/unit_raw/is_write 为物理层字段：白名单外键由控制器守卫拦（422，
    // details 列白名单）；schema 刻意不 strict（同 M1 口径）
    // 值域外 quantity_type 过 schema、由服务层发 point.quantity_type_unknown
    expect(ImportRowPatchSchema.safeParse({ quantity_type: 'flow_rate' }).success).toBe(true);
  });
});

describe('rows query schema（M2-import §3.4 白名单）', () => {
  it('shouldAcceptMappedFlag_issueStar_andKnownIssueCodes', () => {
    expect(ImportRowsQuerySchema.safeParse({ mapped: 'false' }).success).toBe(true);
    expect(ImportRowsQuerySchema.safeParse({ issue: '*' }).success).toBe(true);
    expect(ImportRowsQuerySchema.safeParse({ issue: 'row_unmapped' }).success).toBe(true);
  });

  it('shouldRejectUnknownIssueCode_andBadMapped', () => {
    expect(ImportRowsQuerySchema.safeParse({ issue: 'whatever' }).success).toBe(false);
    expect(ImportRowsQuerySchema.safeParse({ mapped: 'yes' }).success).toBe(false);
  });
});

describe('job list query schema', () => {
  it('shouldApplyDefaultLimit50_cap200_andStatusEnum', () => {
    expect(ImportJobListQuerySchema.parse({}).limit).toBe(50);
    expect(ImportJobListQuerySchema.safeParse({ limit: 201 }).success).toBe(false);
    expect(ImportJobListQuerySchema.safeParse({ status: 'importing' }).success).toBe(false);
  });
});

describe('gateway contract shapes（M2-import §8.4/§9.2；emqx.md §4 R6）', () => {
  it('shouldBuildDownTopics_perKind', () => {
    expect(gatewayDownTopic('config', 'gw-SN001')).toBe('thermio/gw/gw-SN001/down/config');
    expect(gatewayDownTopic('read', 'gw-SN001')).toBe('thermio/gw/gw-SN001/down/read');
  });

  it('shouldPinTheSharedSubscribeFilter', () => {
    expect(CONFIG_ACK_SUBSCRIBE_FILTER).toBe('$share/api/thermio/gw/+/up/config/ack');
  });

  it('shouldParseConfigAck_withFailedDefaultingToEmpty', () => {
    const ack = GatewayConfigAckSchema.parse({ job_id: 'j1', ok_count: 3 });
    expect(ack.failed).toEqual([]);
    expect(GatewayConfigAckSchema.safeParse({ job_id: 'j1', ok_count: 1, failed: 0 }).success).toBe(
      false,
    );
  });
});
