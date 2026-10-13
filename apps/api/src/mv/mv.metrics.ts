/**
 * M&V 域指标（M9-mv-report.md §5 可观测行：mv_generation_duration_s /
 * mv_generation_failures_total{stage}；埋点四枚的结构化日志由服务层承担，
 * 本文件承载可刮取面——import.metrics 同款纪律）。
 *
 * R2 标签基数收口（DAT-242 验收发现，随 DAT-246 捎带）：耗时观测去 job_id label
 * ——任务 id 为无界基数（每次生成新序列），入 label 会撑爆 Prometheus 序列数；
 * 单值 Gauge（最新观测）+ 排障经结构化日志 job_id。
 */
import { Injectable } from '@nestjs/common';
import { Counter, Gauge } from 'prom-client';
import { MetricsService } from '../infrastructure/metrics/metrics.service.js';

@Injectable()
export class MvMetrics {
  /** 生成任务耗时（秒；succeeded 收口时观测，无 label——R2 基数收口）。 */
  readonly generationDuration: Gauge;
  /** 生成任务失败分类（failure.stage 值域：precheck/query/compute/commit/timeout）。 */
  readonly generationFailures: Counter;
  /** 生命周期埋点计数（PRD §9.2 四枚：activated/generated/approved/exported）。 */
  readonly lifecycleEvents: Counter;

  constructor(metrics: MetricsService) {
    const register = metrics.registry;
    this.generationDuration = new Gauge({
      name: 'thermio_mv_generation_duration_s',
      help: 'M&V 报告生成任务耗时（秒，succeeded 观测；最新一次——job_id 经结构化日志，R2 基数收口）',
      registers: [register],
    });
    this.generationFailures = new Counter({
      name: 'thermio_mv_generation_failures_total',
      help: 'M&V 生成任务失败分类（stage：precheck/query/compute/commit/timeout）',
      labelNames: ['stage'],
      registers: [register],
    });
    this.lifecycleEvents = new Counter({
      name: 'thermio_mv_lifecycle_events_total',
      help: 'M&V 生命周期埋点（event：mv_baseline_activated/mv_report_generated/mv_report_approved/mv_report_exported）',
      labelNames: ['event'],
      registers: [register],
    });
  }
}
