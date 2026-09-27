/**
 * prom-client 指标骨架（platform.md §7 / ADR-017，OBS-MT-01 RED 基线 + 业务指标同栈）。
 *
 * - svc_http_request_duration_ms：api HTTP P99 的直方图（单位 ms 进名，OBS-MT-04）；
 * - thermio_gate_rejections_total{gate}：闸门拒绝计数，label 值域 whitelist/rate/
 *   conflict/fuse（platform.md §5.2 v1.5〔R1，DAT-132〕：label = cause 的闸门子串，
 *   闸门 4 三码同 conflict；与错误码一次定义两处消费）；
 * - thermio_gate_clamped_total{gate=clamp}：clamp 非拒绝的独立计数（§5.2 v1.5）；
 * - thermio_proposal_decisions_total{decision}：采纳率分母/分子，decision 取值
 *   来自 DATA-MODEL §3.5 control_result（CONTROL_RESULTS），不另造清单；
 * - control-safety §10 指标清单（IMPL-18）：executions_total / verify_duration /
 *   lease_expiries / fuse_state / conflict_queue_depth。
 */
import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import {
  CONTROL_RESULTS,
  GATE_LABELS,
  type ControlResult,
  type GateLabel,
} from '@thermio/shared-types';
import { OFFLINE_ALARM_REASONS, type OfflineAlarmReason } from '../../internal-mqtt/contract.js';
import {
  ALARM_CATEGORIES,
  ALARM_CLOSE_REASONS_SYSTEM,
  ALARM_SEVERITIES,
  QUALITY_EVENTS,
  type AlarmSeverity,
} from '@thermio/shared-types';

export const HTTP_DURATION_METRIC = 'svc_http_request_duration_ms';
export const GATE_REJECTIONS_METRIC = 'thermio_gate_rejections_total';
export const GATE_CLAMPED_METRIC = 'thermio_gate_clamped_total';
export const PROPOSAL_DECISIONS_METRIC = 'thermio_proposal_decisions_total';
export const CONTROL_EXECUTIONS_METRIC = 'thermio_control_executions_total';
export const CONTROL_VERIFY_DURATION_METRIC = 'thermio_control_verify_duration_seconds';
export const LEASE_EXPIRIES_METRIC = 'thermio_lease_expiries_total';
export const FUSE_STATE_METRIC = 'thermio_fuse_state';
export const CONFLICT_QUEUE_DEPTH_METRIC = 'thermio_proposal_conflict_queue_depth';
export const MQTT_AUTH_METRIC = 'svc_mqtt_auth_total';
export const MQTT_EVENTS_METRIC = 'svc_mqtt_events_total';
export const MQTT_OFFLINE_SIGNALS_METRIC = 'svc_mqtt_offline_signals_total';
export const MQTT_RECONCILE_CYCLES_METRIC = 'svc_mqtt_reconcile_cycles_total';
export const ALARM_OPENED_METRIC = 'thermio_alarm_opened_total';
export const ALARM_CLOSED_METRIC = 'thermio_alarm_closed_total';
export const ALARM_ACTIVE_METRIC = 'thermio_alarm_active';
export const ALARM_SUPPRESSED_ACTIVE_METRIC = 'thermio_alarm_suppressed_active';
export const QUALITY_EVENTS_METRIC = 'svc_quality_events_total';
export const SSE_ACTIVE_CONNECTIONS_METRIC = 'svc_sse_active_connections';
export const SSE_PUSH_METRIC = 'svc_sse_push_total';

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
    help: '闸门拒绝计数（label 值域 whitelist/rate/conflict/fuse，与 reason_code 同源，§5.2 v1.5）',
    labelNames: ['gate'],
    registers: [this.registry],
  });

  private readonly gateClampedTotal = new Counter({
    name: GATE_CLAMPED_METRIC,
    help: '闸门 2 clamp 介入计数（非拒绝，独立于 rejections；§5.2 v1.5〔R1，DAT-132〕）',
    labelNames: ['gate'],
    registers: [this.registry],
  });

  // ── control-safety 执行链指标（control-safety.md §10，IMPL-18）──
  private readonly controlExecutionsTotal = new Counter({
    name: CONTROL_EXECUTIONS_METRIC,
    help: '控制执行终态计数（result = control_audit.result 四值，control-safety §10）',
    labelNames: ['result'],
    registers: [this.registry],
  });

  private readonly controlVerifyDuration = new Histogram({
    name: CONTROL_VERIFY_DURATION_METRIC,
    help: '写后回读验证耗时分布（write_cmd 发布至回读终态，control-safety §10）',
    labelNames: [],
    buckets: [0.5, 1, 2, 5, 10, 20, 30, 60, 120],
    registers: [this.registry],
  });

  private readonly leaseExpiriesTotal = new Counter({
    name: LEASE_EXPIRIES_METRIC,
    help: '租约过期接管计数（control-safety §6.3/§10）',
    labelNames: [],
    registers: [this.registry],
  });

  private readonly fuseState = new Gauge({
    name: FUSE_STATE_METRIC,
    help: '系统熔断态 gauge（1=open / 0=closed；control-safety §10）',
    labelNames: ['system_id'],
    registers: [this.registry],
  });

  private readonly conflictQueueDepth = new Gauge({
    name: CONFLICT_QUEUE_DEPTH_METRIC,
    help: '每设备排队提案深度（control-safety §3.7/§10）',
    labelNames: ['equipment_id'],
    registers: [this.registry],
  });

  private readonly proposalDecisionsTotal = new Counter({
    name: PROPOSAL_DECISIONS_METRIC,
    help: '提案执行结果计数（采纳率观测，ADR-017；decision = CONTROL_RESULTS）',
    labelNames: ['decision'],
    registers: [this.registry],
  });

  // ── EMQX 内部端点指标（emqx.md §10 观测面同源，IMPL-7）──
  private readonly mqttAuthTotal = new Counter({
    name: MQTT_AUTH_METRIC,
    help: 'EMQX 设备认证结果计数（emqx.md §3；result=allow|deny）',
    labelNames: ['result'],
    registers: [this.registry],
  });

  private readonly mqttEventsTotal = new Counter({
    name: MQTT_EVENTS_METRIC,
    help: 'EMQX 上下线事件处理结果计数（emqx.md §5.2；单调卫语句吸收的旧事件单独可见）',
    labelNames: ['outcome'],
    registers: [this.registry],
  });

  private readonly mqttOfflineSignalsTotal = new Counter({
    name: MQTT_OFFLINE_SIGNALS_METRIC,
    help: '网关离线信号计数（emqx.md §5.2-3；IMPL-13 告警联动的留痕面，label 为触发 reason 闭集）',
    labelNames: ['reason'],
    registers: [this.registry],
  });

  private readonly mqttReconcileCyclesTotal = new Counter({
    name: MQTT_RECONCILE_CYCLES_METRIC,
    help: '对账循环计数（emqx.md §5.3；outcome=completed|failed）',
    labelNames: ['outcome'],
    registers: [this.registry],
  });

  // ── 告警引擎指标（M4-alarm.md §5.7 OBS-MT-04，IMPL-13）──
  private readonly alarmOpenedTotal = new Counter({
    name: ALARM_OPENED_METRIC,
    help: '告警开启计数（M4-alarm.md §5.7）',
    labelNames: ['category', 'severity'],
    registers: [this.registry],
  });

  private readonly alarmClosedTotal = new Counter({
    name: ALARM_CLOSED_METRIC,
    help: '告警关闭计数（恢复判据生效情况的运维证据：auto_recovered / root_group_cascade / point_disabled / manual）',
    labelNames: ['close_reason'],
    registers: [this.registry],
  });

  private readonly alarmActive = new Gauge({
    name: ALARM_ACTIVE_METRIC,
    help: '活跃告警 gauge（open/acked/suppressed；进程内增量维护，重启后随事件自愈近似）',
    labelNames: ['severity'],
    registers: [this.registry],
  });

  private readonly alarmSuppressedActive = new Gauge({
    name: ALARM_SUPPRESSED_ACTIVE_METRIC,
    help: '生效中抑制 gauge（进程内增量维护，重启后随事件自愈近似）',
    registers: [this.registry],
  });

  private readonly qualityEventsTotal = new Counter({
    name: QUALITY_EVENTS_METRIC,
    help: '质量事件消费计数（ingest.md §8；M4 引擎消费 stale_set/stale_clear，ts_skew/unit_unconverted 为观测面）',
    labelNames: ['event'],
    registers: [this.registry],
  });

  // ── SSE 实时通道指标（platform.md §10 可观测，M3-monitor，IMPL-14）──
  private readonly sseActiveConnections = new Gauge({
    name: SSE_ACTIVE_CONNECTIONS_METRIC,
    help: 'SSE 活跃连接 gauge（订阅状态为连接内存态，重启后客户端重连任意实例自愈）',
    registers: [this.registry],
  });

  private readonly ssePushTotal = new Counter({
    name: SSE_PUSH_METRIC,
    help: 'SSE telemetry 事件推送计数（节流窗口内变更点批量，每批量记 1）',
    registers: [this.registry],
  });

  constructor() {
    // 预热 label 取值：Counter 的 label 组合在首次 inc 前不进输出——显式 inc(0)
    // 让 /metrics 从第一刻起就暴露闸门/结果全维度零值，PromQL 不因「尚未发生」缺序列。
    for (const gate of GATE_LABELS) {
      if (gate === 'clamp') {
        this.gateClampedTotal.labels({ gate }).inc(0);
      } else {
        this.gateRejectionsTotal.labels({ gate }).inc(0);
      }
    }
    for (const decision of CONTROL_RESULTS) {
      this.proposalDecisionsTotal.labels({ decision }).inc(0);
    }
    for (const result of CONTROL_RESULTS) {
      this.controlExecutionsTotal.labels({ result }).inc(0);
    }
    this.leaseExpiriesTotal.inc(0);
    this.controlVerifyDuration.observe(0);
    for (const result of ['allow', 'deny'] as const) {
      this.mqttAuthTotal.labels({ result }).inc(0);
    }
    for (const outcome of ['applied', 'stale_ignored', 'unknown_client_ignored'] as const) {
      this.mqttEventsTotal.labels({ outcome }).inc(0);
    }
    for (const reason of OFFLINE_ALARM_REASONS) {
      this.mqttOfflineSignalsTotal.labels({ reason }).inc(0);
    }
    for (const outcome of ['completed', 'failed'] as const) {
      this.mqttReconcileCyclesTotal.labels({ outcome }).inc(0);
    }
    for (const category of ALARM_CATEGORIES) {
      for (const severity of ALARM_SEVERITIES) {
        this.alarmOpenedTotal.labels({ category, severity }).inc(0);
      }
    }
    for (const reason of [...ALARM_CLOSE_REASONS_SYSTEM, 'manual'] as const) {
      this.alarmClosedTotal.labels({ close_reason: reason }).inc(0);
    }
    for (const severity of ALARM_SEVERITIES) {
      this.alarmActive.labels({ severity }).inc(0);
    }
    this.alarmSuppressedActive.inc(0);
    for (const event of QUALITY_EVENTS) {
      this.qualityEventsTotal.labels({ event }).inc(0);
    }
    this.sseActiveConnections.inc(0);
    this.ssePushTotal.inc(0);
  }

  /** SSE 连接建立/释放（gauge 增减；platform.md §10）。 */
  sseConnectionOpened(): void {
    this.sseActiveConnections.inc(1);
  }

  sseConnectionClosed(): void {
    this.sseActiveConnections.dec(1);
  }

  /** SSE telemetry 事件推送（每批量记 1）。 */
  ssePushed(): void {
    this.ssePushTotal.inc(1);
  }

  recordHttpDuration(method: string, route: string, statusCode: number, durationMs: number): void {
    this.httpDurationMs
      .labels({ method, route, status_code: String(statusCode) })
      .observe(durationMs);
  }

  /** 闸门拒绝（label = 闸门子串；clamp 不走此口——recordClamped 独立计数）。 */
  recordGate(gate: GateLabel): void {
    if (gate === 'clamp') return; // 型面防误用：clamp 非拒绝
    this.gateRejectionsTotal.labels({ gate }).inc();
  }

  /** 闸门 2 clamp 介入（platform §5.2 v1.5：非拒绝，独立计数器）。 */
  recordClamped(): void {
    this.gateClampedTotal.labels({ gate: 'clamp' }).inc();
  }

  recordDecision(decision: ControlResult): void {
    this.proposalDecisionsTotal.labels({ decision }).inc();
  }

  // ── control-safety 执行链（§10）──

  recordControlExecution(result: ControlResult): void {
    this.controlExecutionsTotal.labels({ result }).inc();
  }

  observeVerifyDuration(seconds: number): void {
    this.controlVerifyDuration.observe(seconds);
  }

  recordLeaseExpiry(): void {
    this.leaseExpiriesTotal.inc();
  }

  setFuseState(systemId: string, open: boolean): void {
    this.fuseState.labels({ system_id: systemId }).set(open ? 1 : 0);
  }

  setConflictQueueDepth(equipmentId: string, depth: number): void {
    this.conflictQueueDepth.labels({ equipment_id: equipmentId }).set(depth);
  }

  recordMqttAuth(result: 'allow' | 'deny'): void {
    this.mqttAuthTotal.labels({ result }).inc();
  }

  recordMqttEvent(outcome: 'applied' | 'stale_ignored' | 'unknown_client_ignored'): void {
    this.mqttEventsTotal.labels({ outcome }).inc();
  }

  recordMqttOfflineSignal(reason: OfflineAlarmReason): void {
    this.mqttOfflineSignalsTotal.labels({ reason }).inc();
  }

  recordMqttReconcileCycle(outcome: 'completed' | 'failed'): void {
    this.mqttReconcileCyclesTotal.labels({ outcome }).inc();
  }

  // ── 告警引擎（M4-alarm.md §5.7）──

  recordAlarmOpened(category: string, severity: string): void {
    this.alarmOpenedTotal.labels({ category, severity }).inc();
  }

  /** close_reason label 闭集：系统机器标记 + manual（人工关闭自由文本的统一投影）。 */
  recordAlarmClosed(closeReason: string): void {
    const label = (ALARM_CLOSE_REASONS_SYSTEM as readonly string[]).includes(closeReason)
      ? closeReason
      : 'manual';
    this.alarmClosedTotal.labels({ close_reason: label }).inc();
  }

  changeAlarmActive(severity: AlarmSeverity, delta: number): void {
    this.alarmActive.labels({ severity }).inc(delta);
  }

  changeAlarmSuppressed(delta: number): void {
    this.alarmSuppressedActive.inc(delta);
  }

  recordQualityEvent(event: (typeof QUALITY_EVENTS)[number]): void {
    this.qualityEventsTotal.labels({ event }).inc();
  }

  /** Prometheus 文本格式暴露（registry.metrics() 为 async）。 */
  async render(): Promise<string> {
    return this.registry.metrics();
  }

  contentType(): string {
    return this.registry.contentType;
  }
}
