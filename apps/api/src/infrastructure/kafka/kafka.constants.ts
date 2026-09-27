/**
 * Kafka 接线常量（ADR-004 topic 清单 / ADR-016 语言边界 / ADR-017 trace 透传）。
 *
 * api 对 Kafka 的全部职责 = 生产/消费业务事件，不做解析清洗（那是 ingest 的职责）。
 * trace_id header 纪律：api ↔ ingest ↔ algo 全链路消息头透传（首期不做全链路 trace）。
 */

/** ADR-004：thermio.control.proposal（分区 16，保留 30d）。 */
export const TOPIC_CONTROL_PROPOSAL = 'thermio.control.proposal';

/** ADR-004：thermio.control.executed（分区 16，保留 30d）。 */
export const TOPIC_CONTROL_EXECUTED = 'thermio.control.executed';

/** ADR-004：thermio.telemetry.quality（质量事件；M4 引擎消费，保留 ≥24h——R7）。 */
export const TOPIC_TELEMETRY_QUALITY = 'thermio.telemetry.quality';

/** 消息头键名（ADR-017：Kafka 消息头 trace_id 透传）。 */
export const TRACE_ID_HEADER = 'trace_id';
