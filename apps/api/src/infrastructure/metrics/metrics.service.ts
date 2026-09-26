/**
 * prom-client 指标骨架（platform.md §7 / ADR-017，OBS-MT-01 RED 基线 + 业务指标同栈）。
 *
 * - svc_http_request_duration_ms：api HTTP P99 的直方图（单位 ms 进名，OBS-MT-04）；
 * - thermio_gate_rejections_total{gate}：五道闸门介入计数，label 取值与 §5.2 的
 *   gate_* cause 子串同源（shared-types GATE_CAUSES——一次定义两处消费）；
 * - thermio_proposal_decisions_total{decision}：采纳率分母/分子，decision 取值
 *   来自 DATA-MODEL §3.5 control_result（CONTROL_RESULTS），不另造清单。
 */
import { Injectable } from '@nestjs/common';
import { Counter, Histogram, Registry } from 'prom-client';
import {
  CONTROL_RESULTS,
  GATE_CAUSES,
  type ControlResult,
  type GateCause,
} from '@thermio/shared-types';

export const HTTP_DURATION_METRIC = 'svc_http_request_duration_ms';
export const GATE_REJECTIONS_METRIC = 'thermio_gate_rejections_total';
export const PROPOSAL_DECISIONS_METRIC = 'thermio_proposal_decisions_total';

/** 直方图桶（ms）：单楼私有化低流量形态，覆盖 5ms–10s（ADR-017 api HTTP P99 观测窗）。 */
const HTTP_DURATION_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  private readonly httpDurationMs = new Histogram({
    name: HTTP_DURATION_METRIC,
    help: 'HTTP 请求耗时分布（RED 之 Duration；P99 对齐 ADR-017）',
    labelNames: ['method', 'route', 'status_code'],
    buckets: HTTP_DURATION_BUCKETS_MS,
    registers: [this.registry],
  });

  private readonly gateRejectionsTotal = new Counter({
    name: GATE_REJECTIONS_METRIC,
    help: '五道闸门介入计数（label 与 reason_code gate_* cause 同源，§5.2 咬合）',
    labelNames: ['gate'],
    registers: [this.registry],
  });

  private readonly proposalDecisionsTotal = new Counter({
    name: PROPOSAL_DECISIONS_METRIC,
    help: '提案执行结果计数（采纳率观测，ADR-017；decision = CONTROL_RESULTS）',
    labelNames: ['decision'],
    registers: [this.registry],
  });

  constructor() {
    // 预热 label 取值：Counter 的 label 组合在首次 inc 前不进输出——显式 inc(0)
    // 让 /metrics 从第一刻起就暴露五闸门/四结果全维度零值，PromQL 不因「尚未发生」缺序列。
    for (const gate of GATE_CAUSES) {
      this.gateRejectionsTotal.labels({ gate }).inc(0);
    }
    for (const decision of CONTROL_RESULTS) {
      this.proposalDecisionsTotal.labels({ decision }).inc(0);
    }
  }

  recordHttpDuration(method: string, route: string, statusCode: number, durationMs: number): void {
    this.httpDurationMs
      .labels({ method, route, status_code: String(statusCode) })
      .observe(durationMs);
  }

  recordGate(cause: GateCause): void {
    this.gateRejectionsTotal.labels({ gate: cause }).inc();
  }

  recordDecision(decision: ControlResult): void {
    this.proposalDecisionsTotal.labels({ decision }).inc();
  }

  /** Prometheus 文本格式暴露（registry.metrics() 为 async）。 */
  async render(): Promise<string> {
    return this.registry.metrics();
  }

  contentType(): string {
    return this.registry.contentType;
  }
}
