/**
 * Excel 点表解析（M2-import §5 模板规格与解析规则；异步解析 worker 的核心）。
 *
 * - 同步/异步分界（§5.3）：本模块只做**异步段**——xlsx 容器已过同步预检
 *   （ZIP magic + [Content_Types].xml 可定位，见 imports.service），此处做
 *   工作表解析/表头判定/列识别/行提取/行数上限，失败 → 作业 failed + failure
 *   （template_mismatch / row_limit_exceeded / sheet_corrupt），不落 HTTP 码；
 * - 表头识别：首行逐列 trim + 别名表匹配，必列 = 点号；方向未知值从严拒绝
 *   （template_mismatch，避免写点误判为读点绕过 P2-3）；
 * - raw_name trim 1..128：超长 = sheet_corrupt 行级形态（不静默截断物理身份）；
 *   点号为空的行跳过（不计 row_no），全空尾行忽略；
 * - 表内 raw_name 重复允许入库（DDL 仅 UNIQUE(tenant, job, row_no)），dry-run 拦。
 */
import {
  IMPORT_ROW_LIMIT,
  IMPORT_TOLERANT_DIRECTIONS,
  type ImportFailure,
} from '@thermio/shared-types';
import ExcelJS from 'exceljs';

/** 列头别名表（§5.1：canonical + 别名，trim + 全半角空格归一后匹配）。 */
const COLUMN_ALIASES: ReadonlyArray<{
  canonical: 'raw_name' | 'description' | 'unit' | 'direction';
  aliases: readonly string[];
}> = [
  { canonical: 'raw_name', aliases: ['点号', 'raw_name', '点位', 'tag'] },
  { canonical: 'description', aliases: ['描述', 'description', '说明'] },
  { canonical: 'unit', aliases: ['单位', 'unit'] },
  { canonical: 'direction', aliases: ['方向', 'direction', '读写'] },
];

export interface ParsedRow {
  row_no: number;
  raw_name: string;
  raw_description: string | null;
  unit_raw: string | null;
  is_write: boolean;
}

export type ParseOutcome =
  | { ok: true; rows: ParsedRow[] }
  | {
      ok: false;
      failure: Pick<ImportFailure, 'code' | 'message'> & { detail: Record<string, unknown> };
    };

/** 同步容器预检（POST /imports 请求内，§5.3）：ZIP magic + [Content_Types].xml 可定位。 */
export function inspectXlsxContainer(buffer: Buffer): 'ok' | 'corrupt' | 'not_xlsx' {
  // xlsx 容器 = ZIP（OPC 包）：local file header magic PK\x03\x04
  if (
    buffer.length < 4 ||
    buffer[0] !== 0x50 ||
    buffer[1] !== 0x4b ||
    buffer[2] !== 0x03 ||
    buffer[3] !== 0x04
  ) {
    return 'not_xlsx';
  }
  // OPC 必备部件（local header 与 central directory 双处出现，字节级包含即视为可定位；
  // 完整 ZIP 解析留给异步段 exceljs，此处只做容器嗅探不做库级校验）
  return buffer.includes(Buffer.from('[Content_Types].xml', 'latin1')) ? 'ok' : 'corrupt';
}

function normalizeHeader(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .trim();
}

function cellText(value: unknown): string | null {
  // exceljs：富文本对象取 richText 拼接；公式取 result；null/undefined → null
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') {
    const obj = value as {
      richText?: Array<{ text?: string }>;
      result?: unknown;
      text?: unknown;
      hyperlink?: unknown;
    };
    if (Array.isArray(obj.richText)) {
      const joined = obj.richText.map((part) => part.text ?? '').join('');
      return joined.length > 0 ? joined : null;
    }
    if (obj.result !== undefined && obj.result !== null) return cellText(obj.result);
    if (typeof obj.text === 'string') return obj.text;
    if (obj.hyperlink !== undefined) return cellText(obj.hyperlink);
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value.toString();
  }
  return null; // 日期等复杂对象：模板列语义不承载，置空走「未标注」
}

/**
 * 解析入口（异步段）。任何 exceljs 抛错 → sheet_corrupt（工作表不可读/公式异常）。
 *
 * **静态默认导入（QA 阻塞 #1 修复）**：exceljs@4 为 CJS 且 `module.exports = <变量>`
 * ——Node ESM 动态 import 的命名空间只有 default（cjs-module-lexer 不识别变量属性
 * 作命名导出），`namespace.Workbook` 在编译产物（dist）运行时为 undefined（vitest
 * 的 CJS interop 会合成命名导出，故测试面探测不到）。default 即 module.exports
 * 对象，`.Workbook` 恒可用。
 */
export async function parsePointTable(buffer: Buffer): Promise<ParseOutcome> {
  let workbook: InstanceType<typeof ExcelJS.Workbook>;
  try {
    workbook = new ExcelJS.Workbook();
    // 5 MB / 5,000 行的量级下全量读入安全（platform §12 容量上限即输入上限）
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    return {
      ok: false,
      failure: { code: 'sheet_corrupt', message: '工作表不可读或容器损坏', detail: {} },
    };
  }

  const sheet = workbook.worksheets[0];
  if (sheet === undefined) {
    return {
      ok: false,
      failure: { code: 'sheet_corrupt', message: '工作簿内无工作表', detail: {} },
    };
  }

  // ── 表头判定（首行）：识别到的 canonical 列 → 列号映射 ──
  const columnMap = new Map<string, number>(); // canonical → 1-based col
  const headerRow = sheet.getRow(1);
  headerRow.eachCell({ includeEmpty: false }, (cell, col) => {
    const header = normalizeHeader(cellText(cell.value));
    if (header.length === 0) return;
    for (const spec of COLUMN_ALIASES) {
      if (spec.aliases.includes(header.toLowerCase()) && !columnMap.has(spec.canonical)) {
        columnMap.set(spec.canonical, col);
      }
    }
  });
  const matched = [...columnMap.keys()].sort();
  if (!columnMap.has('raw_name')) {
    return {
      ok: false,
      failure: {
        code: 'template_mismatch',
        message: '表头不符：未识别到「点号」列',
        detail: { expected_columns: ['点号'], matched, missing: ['点号'] },
      },
    };
  }

  // ── 逐行提取（表头后；row_no = 数据行序 1 起） ──
  const rows: ParsedRow[] = [];
  const dirtyDirections: Array<{ row: number; value: string }> = [];
  const longRawNames: Array<{ row: number; length: number }> = [];
  const rawNameCol = columnMap.get('raw_name');
  if (rawNameCol === undefined) {
    return {
      ok: false,
      failure: { code: 'template_mismatch', message: '未识别到「点号」列', detail: { matched } },
    };
  }
  const descCol = columnMap.get('description');
  const unitCol = columnMap.get('unit');
  const dirCol = columnMap.get('direction');

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return; // 表头
    const rawName = cellText(row.getCell(rawNameCol).value);
    if (rawName === null) return; // 点号为空的行跳过（不计 row_no）

    const rowNo = rows.length + 1;
    const description = descCol !== undefined ? cellText(row.getCell(descCol).value) : null;
    const unitRaw = unitCol !== undefined ? cellText(row.getCell(unitCol).value) : null;
    let isWrite = false;
    if (dirCol !== undefined) {
      const dirRaw = cellText(row.getCell(dirCol).value);
      if (dirRaw !== null) {
        const key = dirRaw.toLowerCase();
        const folded =
          key in IMPORT_TOLERANT_DIRECTIONS
            ? (IMPORT_TOLERANT_DIRECTIONS[key as keyof typeof IMPORT_TOLERANT_DIRECTIONS] as string)
            : undefined;
        if (folded === undefined) {
          dirtyDirections.push({ row: rowNumber, value: dirRaw });
        } else {
          isWrite = folded === 'write' || folded === 'readwrite';
        }
      }
    }

    const trimmedName = rawName.trim();
    if (trimmedName.length > 128) {
      longRawNames.push({ row: rowNumber, length: trimmedName.length });
    }
    rows.push({
      row_no: rowNo,
      raw_name: trimmedName,
      raw_description: description,
      unit_raw: unitRaw !== null ? unitRaw.slice(0, 32) : null,
      is_write: isWrite,
    });
  });

  // 方向未知值：解析期从严（§5.2 定夺）——template_mismatch（detail 列出脏值）
  if (dirtyDirections.length > 0) {
    return {
      ok: false,
      failure: {
        code: 'template_mismatch',
        message: '方向列存在未知值（从严拒绝，避免写点误判为读点）',
        detail: {
          expected_columns: ['点号'],
          matched,
          missing: [],
          dirty_directions: dirtyDirections.slice(0, 20),
        },
      },
    };
  }
  // raw_name 超长：sheet_corrupt 行级形态（detail 记行位置，不静默截断）
  if (longRawNames.length > 0) {
    return {
      ok: false,
      failure: {
        code: 'sheet_corrupt',
        message: '点号超长（>128，物理身份不截断）',
        detail: { long_raw_names: longRawNames.slice(0, 20) },
      },
    };
  }
  // 行数上限（platform §12）：不静默截断
  if (rows.length > IMPORT_ROW_LIMIT) {
    return {
      ok: false,
      failure: {
        code: 'row_limit_exceeded',
        message: `数据行超过上限 ${String(IMPORT_ROW_LIMIT)}`,
        detail: { row_count: rows.length, limit: IMPORT_ROW_LIMIT },
      },
    };
  }
  if (rows.length === 0) {
    return {
      ok: false,
      failure: {
        code: 'sheet_corrupt',
        message: '表头后无有效数据行',
        detail: { matched },
      },
    };
  }
  return { ok: true, rows };
}
