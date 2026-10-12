/**
 * M&V 报告 PDF 渲染器（M9-mv-report.md §1.6 R7：api 进程内 PDF 库 + 内置 CJK 字体；
 * §6.5 单模板钉死——报告模板自定义/多语言为非目标，随首个客户交付反馈重议）。
 *
 * - pdf-lib + @pdf-lib/fontkit（无浏览器依赖，离线交付友好）；字体 = 内置
 *   Noto Sans CJK SC 子集（assets/fonts/NotoSansSC-MvReport.otf，GB2312 全集 +
 *   符号，OFL 1.1——随文件同目录留许可证副本）；
 * - 内容与页面同源（§6.12：渲染 = 报告当前快照，report_no 必带 §3.6）；
 * - 纯函数：输入报告详情 + 元信息，输出 PDF 字节——单测直接断言（mv-pdf.test.ts）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { MvReportDetail } from '@thermio/shared-types';

const FONT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../assets/fonts/NotoSansSC-MvReport.otf',
);

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 48;
const BODY = 10.5;
const INK = rgb(0.13, 0.15, 0.2);
const MUTED = rgb(0.45, 0.48, 0.55);
const ACCENT = rgb(0.09, 0.4, 0.7);
const LINE = rgb(0.85, 0.87, 0.9);
const BANNER_BG = rgb(1, 0.98, 0.92);
const BANNER_INK = rgb(0.7, 0.45, 0.05);

export interface MvReportPdfMeta {
  readonly building_name: string;
  readonly baseline_period: { start: string; end: string };
  readonly method_label: string;
  readonly weather_source: string;
  readonly metering_points: readonly { point_id: number; name: string }[];
}

/** 渲染报告 PDF（A4 多页流式布局）。 */
export async function renderMvReportPdf(
  report: MvReportDetail,
  meta: MvReportPdfMeta,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const fontBytes = fs.readFileSync(FONT_PATH);
  const font = await pdf.embedFont(fontBytes, { subset: false });
  pdf.setTitle(`M&V 节能量核证报告 ${report.report_no}`);
  pdf.setProducer('thermio-platform api');
  pdf.setCreator('thermio M9');

  const ctx = new Layout(pdf, font);
  const fmt = (v: number | null | undefined, digits = 1): string =>
    v === null || v === undefined ? '—' : v.toFixed(digits);

  // ── 页眉 ──
  ctx.title('M&V 节能量核证报告');
  ctx.muted(`报告编号 ${report.report_no}`, 9);
  ctx.gap(6);
  ctx.rule();

  // ── 概要块 ──
  ctx.section('一、报告概要');
  ctx.kv('楼宇', meta.building_name);
  ctx.kv('核证方法', meta.method_label);
  ctx.kv(
    '报告期',
    `${report.report_period.start} ~ ${report.report_period.end}（半开区间，终日不含）`,
  );
  ctx.kv('报告期天数', String(report.series.length));
  ctx.kv('生成时间', report.generated_at);
  ctx.kv(
    '审批状态',
    report.status === 'approved' ? `已审批（${report.approved_at ?? '—'}）` : '待审批',
  );
  ctx.gap(4);

  // ── 横幅（降级/缓冲期/不确定性，§3.6-4/6）──
  if (report.degraded) {
    ctx.banner('本期天气数据缺失，节能量为未归一化口径（weather_adjusted_saving_kwh 为空）');
  }
  if (report.late_buffer) {
    ctx.banner('补传缓冲期内：报告期止距生成不足 5 天，建议期满后删除重出');
  }
  if (report.confidence_interval?.uncertainty_high === true) {
    ctx.banner('不确定性警示：置信区间半宽超过节能量一半（IPMVP 警示线，呈现不阻断）');
  }
  ctx.gap(6);

  // ── 节能量卡（口径 A/B 并列，§3.6-3/4）──
  ctx.section('二、节能量（双口径并列）');
  const ci = report.confidence_interval;
  ctx.kv('实际能耗（kWh）', fmt(report.actual_energy_kwh));
  ctx.kv('基线参照能耗 · 口径 A（kWh）', fmt(report.baseline_energy_kwh));
  ctx.kv('节能量 · 口径 A 未归一化（kWh）', fmt(report.raw_saving_kwh));
  if (!report.degraded) {
    ctx.kv('节能量 · 口径 B 天气归一化（kWh）', fmt(report.weather_adjusted_saving_kwh));
    if (ci !== null) {
      ctx.kv(
        `置信区间（${String(Math.round(ci.level * 100))}%）`,
        `${fmt(ci.lower_kwh)} ~ ${fmt(ci.upper_kwh)}（半宽 ${fmt(ci.half_width_kwh)}）`,
      );
      ctx.muted(
        `σ=${fmt(ci.sigma_kwh)} kWh · CVRMSE=${fmt(ci.cvrmse_pct)}% · n=${String(ci.n_obs)} · ` +
          `天气覆盖率=${fmt(ci.weather_coverage_pct * 100)}% · 插补日=${String(ci.imputed_days)}`,
        8.5,
      );
    }
  } else {
    ctx.kv('节能量 · 口径 B 天气归一化（kWh）', '—（降级：天气覆盖率不足 95%）');
  }
  ctx.kv('插补日数', String(report.imputed_days));
  ctx.gap(6);

  // ── 口径说明（模型参数摘要，PRD R2）──
  ctx.section('三、口径说明（基线模型）');
  const calib = report.calib;
  if (calib.model_params !== null) {
    const p = calib.model_params;
    ctx.kv('模型形式', '日粒度 OLS：E = β0 + β1·CDD + β2·HDD + β3·周末（选项 C 整楼度量）');
    ctx.kv(
      '平衡点 / 哑变量',
      `T_cool=${String(p.spec.t_cool_c)}℃ · T_heat=${String(p.spec.t_heat_c)}℃ · 周末哑变量${p.spec.weekend_dummy ? '开' : '关'}`,
    );
    if (p.coefficients !== null) {
      ctx.kv(
        '拟合系数 β',
        `β0=${fmt(p.coefficients.b0)} · β1=${fmt(p.coefficients.b1)} · β2=${fmt(p.coefficients.b2)}` +
          (p.coefficients.b3 !== null ? ` · β3=${fmt(p.coefficients.b3)}` : ''),
      );
    }
    if (p.metrics !== null) {
      ctx.kv(
        '拟合度量',
        `R²=${fmt(p.metrics.r2, 3)} · CVRMSE=${fmt(p.metrics.cvrmse_pct)}% · NMBE=${fmt(p.metrics.nmbe_pct, 2)}% · n=${String(p.n_obs)}`,
      );
    }
    ctx.kv(
      '基线期 / 季覆盖',
      `${meta.baseline_period.start} ~ ${meta.baseline_period.end} · season_coverage=${p.season_coverage}`,
    );
    ctx.kv('天气站点', meta.weather_source);
  } else {
    ctx.kv('模型参数', '—（无校核快照）');
  }
  const gaps = calib.validation?.window.gaps ?? [];
  if (gaps.length > 0) {
    ctx.kv('基线期数据缺口', `${String(gaps.length)} 段（明细见校核记录）`);
  }
  ctx.gap(6);

  // ── 计量边界 ──
  ctx.section('四、计量边界（能量点位集）');
  for (const point of meta.metering_points) {
    ctx.bullet(`point:${String(point.point_id)} · ${point.name}`);
  }
  ctx.gap(6);

  // ── 日序列表 ──
  ctx.section('五、日粒度序列（基线预测 / 实际）');
  ctx.table(
    ['日期', '基线预测 S_hat（kWh）', '实际 E（kWh）'],
    report.series.map((point) => [
      point.date,
      point.baseline_pred_kwh === null ? '—' : fmt(point.baseline_pred_kwh),
      point.actual_kwh === null ? '—' : fmt(point.actual_kwh),
    ]),
  );

  // ── 审批页 ──
  ctx.pageBreak();
  ctx.section('六、审批（结算依据锁定）');
  ctx.body(
    report.status === 'approved'
      ? `本报告已审批锁定：审批人 ${report.approved_by ?? '—'}，审批时间 ${report.approved_at ?? '—'}。审批后不可修改、不可删除（结算纪律）。`
      : '本报告待审批。审批后内容锁定不可篡改；审批前可删除重出。',
  );
  ctx.gap(18);
  ctx.body('审批人签字：____________________');
  ctx.gap(10);
  ctx.body('日期：____________________');
  ctx.gap(24);
  ctx.muted(
    '口径依据：IPMVP 选项 C（整楼度量 + 天气归一化）；AShRAE Guideline 14 合格线（CVRMSE ≤ 30%、|NMBE| ≤ 10%）；报告编号与页面同源。',
    8.5,
  );

  return pdf.save();
}

/** 流式布局器（页溢出自动分页；CJK 逐字断行）。 */
class Layout {
  private page: PDFPage;
  private y: number;

  constructor(
    private readonly pdf: PDFDocument,
    private readonly font: PDFFont,
  ) {
    this.page = this.pdf.addPage(A4);
    this.y = A4[1] - MARGIN;
  }

  private ensure(height: number): void {
    if (this.y - height < MARGIN) {
      this.page = this.pdf.addPage(A4);
      this.y = A4[1] - MARGIN;
    }
  }

  private width(text: string, size: number): number {
    return this.font.widthOfTextAtSize(text, size);
  }

  private draw(text: string, size: number, color = INK, x = MARGIN): void {
    this.ensure(size * 1.5);
    this.page.drawText(text, { x, y: this.y - size, size, font: this.font, color });
    this.y -= size * 1.45;
  }

  title(text: string): void {
    this.ensure(34);
    this.page.drawText(text, {
      x: MARGIN,
      y: this.y - 20,
      size: 17,
      font: this.font,
      color: INK,
    });
    this.y -= 30;
  }

  section(text: string): void {
    this.gap(6);
    this.ensure(26);
    this.page.drawText(text, {
      x: MARGIN,
      y: this.y - 14,
      size: 12.5,
      font: this.font,
      color: ACCENT,
    });
    this.y -= 22;
    this.rule();
  }

  kv(label: string, value: string): void {
    this.ensure(BODY * 1.6);
    const labelWidth = 190;
    this.page.drawText(label, {
      x: MARGIN,
      y: this.y - BODY,
      size: BODY,
      font: this.font,
      color: MUTED,
    });
    this.wrap(value, BODY, INK, MARGIN + labelWidth, A4[0] - MARGIN - labelWidth, labelWidth);
  }

  body(text: string, size = BODY): void {
    this.wrap(text, size, INK, MARGIN, A4[0] - 2 * MARGIN, 0);
  }

  muted(text: string, size = 9): void {
    this.wrap(text, size, MUTED, MARGIN, A4[0] - 2 * MARGIN, 0);
  }

  bullet(text: string): void {
    this.wrap(`·  ${text}`, BODY, INK, MARGIN + 6, A4[0] - 2 * MARGIN - 6, 0);
  }

  banner(text: string): void {
    this.ensure(30);
    const width = A4[0] - 2 * MARGIN;
    this.page.drawRectangle({
      x: MARGIN,
      y: this.y - 24,
      width,
      height: 22,
      color: BANNER_BG,
      borderColor: BANNER_INK,
      borderWidth: 0.6,
    });
    this.page.drawText(`※ ${text}`, {
      x: MARGIN + 8,
      y: this.y - 17,
      size: 9,
      font: this.font,
      color: BANNER_INK,
    });
    this.y -= 30;
  }

  rule(): void {
    this.ensure(8);
    this.page.drawLine({
      start: { x: MARGIN, y: this.y - 3 },
      end: { x: A4[0] - MARGIN, y: this.y - 3 },
      thickness: 0.7,
      color: LINE,
    });
    this.y -= 9;
  }

  table(header: readonly string[], rows: readonly (readonly string[])[]): void {
    const colX = [MARGIN, MARGIN + 240, MARGIN + 400];
    this.ensure(BODY * 2);
    header.forEach((cell, i) => {
      this.page.drawText(cell, {
        x: colX[i] ?? MARGIN,
        y: this.y - BODY,
        size: 9.5,
        font: this.font,
        color: MUTED,
      });
    });
    this.y -= BODY * 1.4;
    this.rule();
    for (const row of rows) {
      this.ensure(BODY * 1.5);
      row.forEach((cell, i) => {
        this.page.drawText(cell, {
          x: colX[i] ?? MARGIN,
          y: this.y - BODY,
          size: 9,
          font: this.font,
          color: INK,
        });
      });
      this.y -= BODY * 1.35;
    }
  }

  pageBreak(): void {
    this.page = this.pdf.addPage(A4);
    this.y = A4[1] - MARGIN;
  }

  gap(height: number): void {
    this.y -= height;
  }

  /** 断行绘制：CJK 逐字、ASCII 词内不断；悬挂缩进对齐标签列。 */
  private wrap(
    text: string,
    size: number,
    color: typeof INK,
    x: number,
    maxWidth: number,
    hangIndent: number,
  ): void {
    let line = '';
    let lineWidth = 0;
    let first = true;
    const flush = (): void => {
      this.ensure(size * 1.5);
      this.page.drawText(line, {
        x: first ? x : x + hangIndent,
        y: this.y - size,
        size,
        font: this.font,
        color,
      });
      this.y -= size * 1.4;
      line = '';
      lineWidth = 0;
      first = false;
    };
    for (const ch of text) {
      const w = this.width(ch, size);
      if (lineWidth + w > maxWidth && line.length > 0) {
        flush();
      }
      line += ch;
      lineWidth += w;
    }
    if (line.length > 0) flush();
  }
}
