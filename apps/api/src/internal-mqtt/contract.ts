/**
 * EMQX → 中台内部端点契约（emqx.md §3.2 / §5.1，TS-02：边界数据不裸穿越）。
 *
 * 字段与 EMQX 5.x authenticator / webhook 原生字段逐项对齐；
 * 多余字段容忍（passthrough——EMQX 版本升级加字段不炸校验），
 * 缺关键字段拒绝（authenticate 走 deny 包形，events 走 422 信封，见各自控制器）。
 */
import { z } from 'zod';

/** §3.2 认证请求（HTTP authenticator 原生字段示例全集）。 */
export const MqttAuthenticateRequestSchema = z.looseObject({
  clientid: z.string().min(1).max(512),
  username: z.string().min(1).max(512),
  password: z.string().min(1).max(512),
  peerhost: z.string().max(64).optional(),
  proto_ver: z.number().int().optional(),
  clean_start: z.boolean().optional(),
});
export type MqttAuthenticateRequest = z.infer<typeof MqttAuthenticateRequestSchema>;

/** §3.2 响应：成功/失败同一 HTTP 200 包形（SEC-PW-04 不泄露账号存在性）。 */
export const MQTT_AUTH_ALLOW = { result: 'allow' } as const;
export const MQTT_AUTH_DENY = { result: 'deny' } as const;

/** §5.1 上下线事件体（$events/client_connected | client_disconnected）。 */
export const MqttClientEventSchema = z.looseObject({
  event: z.enum(['client.connected', 'client.disconnected']),
  clientid: z.string().min(1).max(512),
  username: z.string().max(512).optional(),
  peerhost: z.string().max(64).optional(),
  reason: z.string().max(64).optional(),
  ts: z.number().int().positive(),
});
export type MqttClientEvent = z.infer<typeof MqttClientEventSchema>;

/**
 * §5.2-3 离线告警联动的触发 reason 闭集；takeover/discarded 提级（配置事故信号）。
 * reconciler 补偿翻转（§5.3）以内部原因字面量 reconcile_no_session 走同一出口。
 */
export const OFFLINE_ALARM_REASONS = [
  'keepalive_timeout',
  'discarded',
  'takeover',
  'reconcile_no_session',
] as const;
export type OfflineAlarmReason = (typeof OFFLINE_ALARM_REASONS)[number];

/** 提级集合（emqx.md §5.1：多网关同 clientid / 会话被丢弃 = 配置事故，直接告警）。 */
export const ESCALATED_OFFLINE_REASONS: readonly OfflineAlarmReason[] = ['discarded', 'takeover'];

/** events 端点成功应答（EMQX webhook 只需 2xx；形状留观测用）。 */
export const MQTT_EVENTS_ACCEPTED = { accepted: true } as const;
