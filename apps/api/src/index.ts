/**
 * @thermio/api —— NestJS：BFF + 业务域 + control-safety 仲裁层（ADR-010；仲裁层权责见 ADR-009）。
 *
 * 骨架占位：服务实现在 IMPL-2 落地（platform.md §8 #4——全局异常过滤器错误信封、
 * zod validation pipe、pino 日志、prom-client 指标、kafkajs 两 topic 接线）。
 * 语言边界（ADR-016）：kafkajs 仅生产/消费业务事件，不做解析清洗；不直连 TimescaleDB 写路径。
 */
import type { ControlMode } from '@thermio/shared-types';

/** DATA-MODEL §3.3：control_mode 默认 advisory（secure by default）。 */
export const DEFAULT_CONTROL_MODE: ControlMode = 'advisory';
