/**
 * @thermio/api —— NestJS：BFF + 业务域 + control-safety 仲裁层（ADR-010；仲裁层权责见 ADR-009）。
 *
 * IMPL-2 已落骨架（platform.md §8 #4）：全局异常过滤器错误信封（§5.1）、zod
 * validation pipe（§5.3）、pino 结构化日志（§7）、prom-client 指标（§7）、
 * kafkajs proposal/executed 两 topic 接线（ADR-004/016）、/healthz + /metrics。
 * 启动入口 src/main.ts；语言边界（ADR-016）：kafkajs 仅生产/消费业务事件，
 * 不做解析清洗；不直连 TimescaleDB 写路径。
 */
export { DEFAULT_CONTROL_MODE } from './default-control-mode.js';
