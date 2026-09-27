/**
 * 导入域指标（M2-import §8.3-d「ack 摘要进结构化日志与指标，不落库」的指标面）。
 *
 * 注册到全局 MetricsService registry（与 gate_rejections 等同栈，/metrics 出口）。
 * e2e 断言锚点：apply 后 thermio_import_apply_outcomes_total{result=...} 与
 * thermio_import_config_artifacts_total 可刮取——「网关配置产物生成」的可观测证明。
 */
import { Injectable } from '@nestjs/common';
import { Counter } from 'prom-client';
import { MetricsService } from '../infrastructure/metrics/metrics.service.js';

@Injectable()
export class ImportMetrics {
  /** apply 异步管线收敛结果（含 dev 停用通道的 skipped_mqtt_disabled 形态）。 */
  readonly applyOutcomes: Counter;
  /** 配置产物生成计数（§8.3-b：不落库可重 derive——生成面留指标痕）。 */
  readonly configArtifacts: Counter;
  /** 解析段失败分类（failure.code 值域）。 */
  readonly parseFailures: Counter;
  readonly dryRuns: Counter;
  readonly selfChecks: Counter;

  constructor(metrics: MetricsService) {
    const register = metrics.registry;
    this.applyOutcomes = new Counter({
      name: 'thermio_import_apply_outcomes_total',
      help: 'apply 异步管线收敛结果（register_skipped/ack_ok/ack_partial/ack_timeout/ack_failed/skipped_mqtt_disabled）',
      labelNames: ['result'],
      registers: [register],
    });
    this.configArtifacts = new Counter({
      name: 'thermio_import_config_artifacts_total',
      help: '网关配置产物生成计数（M2-import §8.4 契约产物，retained 推送面）',
      registers: [register],
    });
    this.parseFailures = new Counter({
      name: 'thermio_import_parse_failures_total',
      help: '解析段失败分类（failure.code：template_mismatch/row_limit_exceeded/sheet_corrupt）',
      labelNames: ['code'],
      registers: [register],
    });
    this.dryRuns = new Counter({
      name: 'thermio_import_dry_runs_total',
      help: 'dry-run 执行计数（passed 标签 = 阻塞项是否清零）',
      labelNames: ['passed'],
      registers: [register],
    });
    this.selfChecks = new Counter({
      name: 'thermio_import_self_checks_total',
      help: '自检完成计数（命中率报告产出次数）',
      registers: [register],
    });
  }
}
