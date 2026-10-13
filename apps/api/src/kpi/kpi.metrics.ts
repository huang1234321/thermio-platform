/**
 * M11 kpi 域指标（M11-kpi-dashboard.md §6.3/§6.4 埋点；IMPL-22 / DAT-246）。
 *
 * 埋点三枚（ADR-017 同栈）：kpi_dashboard_loaded / fdd_report_exported /
 * fdd_digest_delivered——Counter 承载（label 只取低基数值域，DAT-242 R2 同款纪律：
 * 不带 job_id 等高基数维度）。
 */
import { Injectable } from '@nestjs/common';
import { Counter } from 'prom-client';
import { MetricsService } from '../infrastructure/metrics/metrics.service.js';

@Injectable()
export class KpiMetrics {
  /** 看板加载埋点（PRD §9.2）。 */
  readonly lifecycleEvents: Counter;

  constructor(metrics: MetricsService) {
    const register = metrics.registry;
    this.lifecycleEvents = new Counter({
      name: 'thermio_kpi_lifecycle_events_total',
      help: 'M11 生命周期埋点（event：kpi_dashboard_loaded/fdd_report_exported/fdd_digest_delivered/fdd_digest_skipped）',
      labelNames: ['event'],
      registers: [register],
    });
  }
}
