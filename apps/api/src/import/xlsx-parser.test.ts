/**
 * 解析与映射纯函数测试（M2-import §5/§6；DAT-118）。
 */
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { inspectXlsxContainer, parsePointTable } from './xlsx-parser.js';
import {
  autoMapRow,
  matchRule,
  resolveEquipment,
  similarSuggestions,
  tokenize,
  type EquipmentCandidate,
  type HistoryRow,
} from './import-mapping.js';

/** 构造 xlsx 缓冲（模板列头 + 数据行）。 */
async function buildXlsx(headers: string[], rows: Array<Array<string | null>>): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('点表');
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row);
  const data = await workbook.xlsx.writeBuffer();
  return Buffer.from(data);
}

describe('xlsx 容器嗅探（§5.3 同步段）', () => {
  it('shouldRejectNotXlsx_whenMagicMissing', () => {
    expect(inspectXlsxContainer(Buffer.from('plain text csv'))).toBe('not_xlsx');
    expect(inspectXlsxContainer(Buffer.alloc(0))).toBe('not_xlsx');
  });

  it('shouldRejectCorrupt_whenZipMagicPresentButNotOpc', () => {
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]);
    expect(inspectXlsxContainer(zip)).toBe('corrupt');
  });

  it('shouldAcceptRealWorkbook', async () => {
    expect(inspectXlsxContainer(await buildXlsx(['点号'], [['P1']]))).toBe('ok');
  });
});

describe('模板解析（§5.1/§5.2）', () => {
  it('shouldParseCanonicalAndAliasHeaders_withTolerantDirections', async () => {
    const buffer = await buildXlsx(
      ['Tag', 'description', 'unit', '读写'],
      [
        ['CHWS_T', '冷冻水供水温度', '℃', 'ro'],
        ['PUMP_RUN', '水泵运行状态', null, '写'],
        ['', '空点号行跳过', null, null],
      ],
    );
    const outcome = await parsePointTable(buffer);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rows).toHaveLength(2);
    expect(outcome.rows[0]).toMatchObject({
      row_no: 1,
      raw_name: 'CHWS_T',
      unit_raw: '℃',
      is_write: false,
    });
    expect(outcome.rows[1]).toMatchObject({ row_no: 2, is_write: true });
  });

  it('shouldFailWithTemplateMismatch_whenRawNameColumnMissing', async () => {
    const buffer = await buildXlsx(['描述', '单位'], [['x', 'y']]);
    const outcome = await parsePointTable(buffer);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe('template_mismatch');
    expect(outcome.failure.detail).toMatchObject({ missing: ['点号'] });
  });

  it('shouldFailWithTemplateMismatch_whenDirectionValueUnknown', async () => {
    // 从严拒绝（§5.2 定夺）：未知方向值不做 read 兜底——写点误判将绕过 P2-3
    const buffer = await buildXlsx(['点号', '方向'], [['P1', 'updown']]);
    const outcome = await parsePointTable(buffer);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe('template_mismatch');
    expect(outcome.failure.detail).toMatchObject({
      dirty_directions: [{ row: 2, value: 'updown' }],
    });
  });

  it('shouldFailWithSheetCorrupt_whenRawNameTooLong', async () => {
    const buffer = await buildXlsx(['点号'], [['X'.repeat(200)]]);
    const outcome = await parsePointTable(buffer);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe('sheet_corrupt');
  });

  it('shouldFailWithRowLimit_whenDataRowsExceed5000', async () => {
    const buffer = await buildXlsx(
      ['点号'],
      Array.from({ length: 5001 }, (_, i) => [`P${String(i)}`]),
    );
    const outcome = await parsePointTable(buffer);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe('row_limit_exceeded');
    expect(outcome.failure.detail).toMatchObject({ row_count: 5001, limit: 5000 });
  }, 20_000);

  it('shouldFailWithSheetCorrupt_whenNoDataRows', async () => {
    const buffer = await buildXlsx(['点号'], []);
    const outcome = await parsePointTable(buffer);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe('sheet_corrupt');
  });
});

describe('两级映射引擎（§6.1）', () => {
  const history: HistoryRow[] = [
    {
      raw_name: 'CHWS_T_1F',
      raw_description: '冷冻水供水温度',
      equipment_id: 'eq-1',
      quantity_type: 'chw_supply_temp',
      unit_std: 'degC',
    },
  ];
  const candidates: EquipmentCandidate[] = [
    { id: 'eq-chiller-1', name: '1号冷水机组', equipment_type: 'chiller' },
    { id: 'eq-chwp-1', name: '冷冻水泵P1', equipment_type: 'chwp_pump' },
  ];

  it('shouldAdoptHistoryExact_first', () => {
    const result = autoMapRow('CHWS_T_1F', '任何描述', history, candidates);
    expect(result).toMatchObject({
      source: 'history_exact',
      equipment_id: 'eq-1',
      quantity_type: 'chw_supply_temp',
    });
  });

  it('shouldFallBackToKeywordRules_withUniqueEquipmentResolution', () => {
    const result = autoMapRow('PUMP_01_STATUS', '冷冻水泵P1 运行状态', history, candidates);
    expect(result).toMatchObject({
      source: 'keyword_rule',
      quantity_type: 'run_status',
      equipment_id: 'eq-chwp-1', // 描述 token「泵/P1」唯一命中
      unit_std: null, // 枚态量不归一
    });
  });

  it('shouldLeaveEquipmentNull_whenAmbiguous', () => {
    const ambiguous: EquipmentCandidate[] = [
      { id: 'eq-a', name: '1号冷冻水泵', equipment_type: 'chwp_pump' },
      { id: 'eq-b', name: '2号冷冻水泵', equipment_type: 'chwp_pump' },
    ];
    const result = autoMapRow('PUMP_STATUS', '冷冻水供水温度', history, ambiguous);
    expect(result).not.toBeNull();
    expect(result?.equipment_id).toBeNull(); // 歧义留空 → equipment_unassigned 警告位
  });

  it('shouldReturnNull_whenNeitherLevelHits', () => {
    expect(autoMapRow('UNKNOWN_99', '未知描述', history, candidates)).toBeNull();
  });

  it('shouldMatchRuleBySubstring_caseInsensitive', () => {
    expect(matchRule('CHWS_SUPPLY', null)).not.toBeNull();
    expect(matchRule('x', 'CHWS supply temp')).not.toBeNull();
    expect(matchRule('PWR', '动力柜')).toBeNull();
  });
});

describe('equipment 解析与 suggestions（§6.1/§6.2）', () => {
  it('shouldTokenizeChineseAndAscii', () => {
    expect(tokenize('冷冻水泵 P1 供水')).toEqual(['p1', '冷', '冻', '水', '泵', '供', '水']);
  });

  it('shouldResolveOnlyOnUniqueHit', () => {
    const candidates: EquipmentCandidate[] = [
      { id: 'eq-1', name: 'CHL-01', equipment_type: 'chiller' },
      { id: 'eq-2', name: 'CHL-02', equipment_type: 'chiller' },
    ];
    expect(resolveEquipment('CHL-01_TEMP', null, candidates)).toBe('eq-1');
    expect(resolveEquipment('CHL_TEMP', null, candidates)).toBeNull(); // 双命中歧义
    expect(resolveEquipment('X', null, [])).toBeNull();
  });

  it('shouldScoreSimilarHistory_dedupedAndCapped', () => {
    const history: HistoryRow[] = [
      {
        raw_name: 'CHWS_T_2F',
        raw_description: '冷冻水供水温度2F',
        equipment_id: null,
        quantity_type: 'chw_supply_temp',
        unit_std: 'degC',
      },
      {
        raw_name: 'CHWS_T_3F',
        raw_description: '冷冻水供水温度3F',
        equipment_id: null,
        quantity_type: 'chw_supply_temp',
        unit_std: 'degC',
      },
      {
        raw_name: 'PWR_MAIN',
        raw_description: null,
        equipment_id: null,
        quantity_type: 'power',
        unit_std: 'kW',
      },
    ];
    const suggestions = similarSuggestions('CHWS_T_1F', '冷冻水供水温度1F', history, 2);
    expect(suggestions.length).toBeLessThanOrEqual(2);
    expect(suggestions[0]).toMatchObject({
      source: 'history_similar',
      quantity_type: 'chw_supply_temp',
    });
    expect(suggestions[0]?.score).toBeLessThan(1);
  });
});
