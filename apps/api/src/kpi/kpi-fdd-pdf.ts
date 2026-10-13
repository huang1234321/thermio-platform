/**
 * M11 FDD 周报导出 PDF 渲染（M11-kpi-dashboard.md §6.1/§6.2；IMPL-22 / DAT-246）。
 *
 * 渲染引擎裁决（§6.1，深审 2026-10-13）：export_job worker 按 resource_type 分发——
 * fdd_report = puppeteer + 随镜像 Chromium（HTML→PDF 复用页面同构渲染，保 AC-9
 * 一致性）；与 mv_report 的进程内 PDF 库两引擎并存（deploy.md §5 两行分列）。
 *
 * 实现形态：puppeteer-core + FDD_PDF_CHROMIUM_PATH（随镜像系统 Chromium——npm 不
 * 拉浏览器，离线镜像纪律；dev/e2e 无 Chromium 时渲染器不可用 → 导出任务 failed
 * 可见可重试，AC-9 失败注入的合法形态）。HTML 模板自包含（无外链，离线实跑；
 * 单主题 light——文档嵌入/打印消费，图示规范收窄 2026-09-27）。
 */
import type { Logger } from 'pino';
import { ALARM_SEVERITIES, type FddReportItem } from '@thermio/shared-types';

/** §6.2 内容规格输入：报告本体（页面同构数据）+ 出域追溯三件。 */
export interface FddPdfInput {
  readonly report: FddReportItem;
  /** 导出编号（export_job 短 id 展示形，EJ-xxxxxxxx）。 */
  readonly exportNo: string;
  readonly exportedByName: string;
  readonly exportedAt: string;
}

/** 渲染器出口（KPI_PDF_RENDERER token；e2e 覆写为确定性 fake）。 */
export interface FddPdfRenderer {
  render(input: FddPdfInput): Promise<Uint8Array>;
}

/** 报告编号展示形（§6.2：RPT-… 同页面 id 展示形）。 */
export function reportNoOf(reportId: string, generatedAt: string): string {
  return `RPT-${generatedAt.slice(0, 4)}-${reportId.slice(0, 6)}`;
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#cf1322',
  major: '#d46b08',
  minor: '#d4b106',
  warning: '#faad14',
  info: '#1677ff',
};

const SEVERITY_LABELS: Record<string, string> = {
  critical: '紧急',
  major: '重要',
  minor: '次要',
  warning: '警告',
  info: '提示',
};

/** §6.2 HTML 模板（自包含；三计数卡 + severity 双条 + 健康度排名 top 10 + 追溯头/脚）。 */
export function buildFddReportHtml(input: FddPdfInput): string {
  const { report } = input;
  const severityBar = (by: Record<string, number>): string => {
    const total = ALARM_SEVERITIES.reduce((sum, s) => sum + (by[s] ?? 0), 0);
    if (total === 0) return '<div class="empty">无</div>';
    const segs = [...ALARM_SEVERITIES]
      .reverse()
      .map(
        (s) =>
          `<div style="width:${String(((by[s] ?? 0) / total) * 100)}%;background:${SEVERITY_COLORS[s] ?? '#999'}"></div>`,
      )
      .join('');
    const legend = [...ALARM_SEVERITIES]
      .reverse()
      .map((s) => `${SEVERITY_LABELS[s] ?? s} ${String(by[s] ?? 0)}`)
      .join(' · ');
    return `<div class="bar">${segs}</div><div class="legend">${legend}</div>`;
  };
  const ranking =
    report.summary.health_ranking.length === 0
      ? '<div class="empty">本期无未决发现</div>'
      : `<table class="rank"><thead><tr><th>#</th><th>设备</th><th>类型</th><th>未决数</th><th>加权分</th></tr></thead><tbody>${report.summary.health_ranking
          .map(
            (r, i) =>
              `<tr><td>${String(i + 1)}</td><td>${escapeHtml(r.equipment_name)}</td><td>${escapeHtml(
                r.equipment_type,
              )}</td><td>${String(r.open_count)}</td><td>${String(r.weighted_score)}</td></tr>`,
          )
          .join('')}</tbody></table>`;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
         color: #1f1f1f; font-size: 12px; padding: 28px 32px; }
  .cover { border-bottom: 2px solid #134a4a; padding-bottom: 12px; margin-bottom: 16px; }
  .cover h1 { font-size: 19px; color: #134a4a; margin-bottom: 6px; }
  .meta { color: #595959; line-height: 1.8; }
  .trace { margin-top: 6px; color: #595959; }
  .cards { display: flex; gap: 24px; margin: 14px 0 18px; }
  .card { border: 1px solid #e4e4e4; border-radius: 6px; padding: 10px 18px; min-width: 130px; }
  .card .label { color: #8c8c8c; font-size: 11px; }
  .card .value { font-size: 26px; font-weight: 600; margin-top: 2px; }
  h2 { font-size: 14px; margin: 18px 0 8px; color: #134a4a; }
  .bars { display: flex; gap: 40px; margin-bottom: 6px; }
  .bar { display: flex; height: 12px; border-radius: 6px; overflow: hidden; margin-top: 6px; min-width: 260px; }
  .legend { color: #595959; font-size: 11px; margin-top: 6px; }
  .empty { color: #8c8c8c; padding: 8px 0; }
  table.rank { width: 100%; border-collapse: collapse; margin-top: 4px; }
  table.rank th, table.rank td { border-bottom: 1px solid #f0f0f0; text-align: left; padding: 6px 8px; }
  table.rank th { color: #8c8c8c; font-weight: 500; font-size: 11px; }
  .footer { position: fixed; bottom: 18px; left: 32px; right: 32px; border-top: 1px solid #e4e4e4;
            padding-top: 6px; color: #8c8c8c; font-size: 10px; display: flex; justify-content: space-between; }
</style>
</head>
<body>
  <div class="cover">
    <h1>FDD 周报 · ${escapeHtml(report.building.name)}</h1>
    <div class="meta">
      报告编号 <b>${reportNoOf(report.id, report.generated_at)}</b> ·
      报告期 ${report.period.start} ~ ${report.period.end}（闭开，终日不含） ·
      生成时间 ${report.generated_at} · algo ${report.algo_version ?? '—'}
    </div>
    <div class="trace">导出编号 ${input.exportNo} · 导出人 ${escapeHtml(input.exportedByName)} · 导出时间 ${input.exportedAt}</div>
  </div>
  <div class="cards">
    <div class="card"><div class="label">新增发现</div><div class="value">${String(report.summary.counts.new)}</div></div>
    <div class="card"><div class="label">消除</div><div class="value">${String(report.summary.counts.resolved)}</div></div>
    <div class="card"><div class="label">期末持续</div><div class="value">${String(report.summary.counts.persisting)}</div></div>
  </div>
  <h2>severity 分布（左：期初新增；右：期末未决）</h2>
  <div class="bars">
    <div>${severityBar(report.summary.new_by_severity)}</div>
    <div>${severityBar(report.summary.open_by_severity)}</div>
  </div>
  <h2>设备健康度排名（按加权分降序，top 10）</h2>
  ${ranking}
  <div class="footer"><span>内部资料 · thermio 节能平台生成</span><span>${reportNoOf(report.id, report.generated_at)}</span></div>
</body>
</html>`;
}

/** puppeteer 渲染器（每任务一次 browser 生命周期——单渲染槽语义，§12 v1.8 并发 1）。 */
export function puppeteerFddPdfRenderer(chromiumPath: string, logger: Logger): FddPdfRenderer {
  return {
    async render(input: FddPdfInput): Promise<Uint8Array> {
      const puppeteer = await import('puppeteer-core');
      const browser = await puppeteer.launch({
        executablePath: chromiumPath,
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      });
      try {
        const page = await browser.newPage();
        await page.setContent(buildFddReportHtml(input), { waitUntil: 'load' });
        const buffer = await page.pdf({
          format: 'A4',
          printBackground: true,
          margin: { top: '18mm', bottom: '20mm', left: '14mm', right: '14mm' },
        });
        return new Uint8Array(buffer);
      } finally {
        await browser.close().catch((err: unknown) => {
          logger.warn({ msg: 'kpi_pdf_browser_close_failed', err });
        });
      }
    },
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
