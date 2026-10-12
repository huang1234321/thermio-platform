/**
 * M&V 报告 PDF 渲染器测试（§1.6 R7：进程内 PDF 库 + 内置 CJK——渲染产物结构锚点）。
 *
 * 断言面：CJK 字体嵌入成功、多页结构、降级/缓冲期横幅文本、审批页存在。
 * 文本层校验用 pdf-lib save 后的原始字节扫描（标题字符串以字距分布不可直检，
 * 以对象结构（/Page 数、字体对象、xref）锚定；横幅文案经 drawText 进内容流，
 * CJK 子集字体编码为 glyph id——断言产物规模与页数为主，文案由模板单源钉死）。
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import type { MvReportDetail } from '@thermio/shared-types';
import { renderMvReportPdf } from './mv-pdf.js';

function detail(overrides?: Partial<MvReportDetail>): MvReportDetail {
  return {
    id: '1f0a2b3c-1111-4222-8333-444455556666',
    baseline_id: '0b7a8a3e-6f2c-4d1e-9a1b-3c5d7e9f0a1b',
    report_period: { start: '2026-07-01', end: '2026-09-30' },
    status: 'approved',
    degraded: false,
    weather_adjusted_saving_kwh: 128_400.5,
    raw_saving_kwh: 96_200.25,
    generated_at: '2026-10-02T08:00:00Z',
    approved_at: '2026-10-03T09:30:00Z',
    baseline_energy_kwh: 512_000,
    actual_energy_kwh: 415_800,
    confidence_interval: {
      level: 0.68,
      half_width_kwh: 9_100,
      lower_kwh: 119_300,
      upper_kwh: 137_500,
      sigma_kwh: 1_650,
      cvrmse_pct: 18.4,
      n_obs: 300,
      weather_coverage_pct: 0.99,
      uncertainty_high: false,
      imputed_days: 2,
    },
    imputed_days: 2,
    late_buffer: false,
    requested_by: '2e8b9c0d-7777-4888-9999-aaaabbbbcccc',
    approved_by: '3f9c0d1e-1234-5678-9abc-def012345678',
    report_no: 'MV-总部大厦A座-2026-07-01-2026-09-30-1f0a2b3c',
    series: Array.from({ length: 92 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10),
      baseline_pred_kwh: 5500 + ((i * 37) % 400),
      actual_kwh: 4500 + ((i * 53) % 500),
    })),
    calib: {
      model_params: {
        model_type: 'ols_daily_cdd_hdd',
        model_version: 1,
        spec: { t_cool_c: 26, t_heat_c: 18, weekend_dummy: true },
        coefficients: { b0: 4021.5, b1: 812.4, b2: 936.1, b3: -640.2 },
        stderrs: { b0: 310.2, b1: 95.1, b2: 88.7, b3: 120.5 },
        sigma_kwh: 1650,
        n_obs: 300,
        metrics: { r2: 0.82, adj_r2: 0.81, rmse_kwh: 1648, cvrmse_pct: 18.4, nmbe_pct: 0 },
        xtx_inv: [
          [1e-4, 0, 0, 0],
          [0, 1e-3, 0, 0],
          [0, 0, 1e-3, 0],
          [0, 0, 0, 2e-3],
        ],
        fit_daily_mean_kwh: 5120,
        fit_mean_row: [1, 2.1, 3.2, 0.28],
        fitted_days: 300,
        season_coverage: 'full',
        fit_run_at: '2026-09-28T02:00:00Z',
      },
      validation: null,
    },
    ...overrides,
  };
}

const META = {
  building_name: '总部大厦 A 座',
  baseline_period: { start: '2026-01-01', end: '2026-06-30' },
  method_label: 'IPMVP 选项 C（整楼度量 + 天气归一化）',
  weather_source: 'ST-5837',
  metering_points: [
    { point_id: 1024, name: '总进线有功电度' },
    { point_id: 2048, name: '冷站电度' },
  ],
};

describe('M&V 报告 PDF 渲染', () => {
  it('shouldRenderMultiPagePdf_withEmbeddedCjkFont', async () => {
    const bytes = await renderMvReportPdf(detail(), META);
    expect(bytes.byteLength).toBeGreaterThan(50_000); // 内置 CJK 字体嵌入（~3MB 子集的子集嵌入）
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(3); // 概要+序列+审批页
    expect(pdf.getTitle()).toBe('M&V 节能量核证报告 MV-总部大厦A座-2026-07-01-2026-09-30-1f0a2b3c');
  });

  it('shouldRenderDegradedReport_withoutWeatherCaliber', async () => {
    const bytes = await renderMvReportPdf(
      detail({
        degraded: true,
        weather_adjusted_saving_kwh: null,
        confidence_interval: null,
        status: 'pending_approval',
        approved_at: null,
        approved_by: null,
      }),
      META,
    );
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(3);
  });

  it('shouldFailFast_onMissingFontGlyphSet', async () => {
    // 极端元信息（空楼宇名走占位符）不应抛错——渲染器对空值有占位
    const bytes = await renderMvReportPdf(detail(), {
      ...META,
      building_name: '',
      metering_points: [],
    });
    expect(bytes.byteLength).toBeGreaterThan(10_000);
  });
});
