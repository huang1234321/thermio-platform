/**
 * 控制面 MQTT 通道（control-safety.md §4，IMPL-18 / DAT-164）。
 *
 * - svc-control 内部账号：publish `thermio/gw/{clientid}/down/write`（QoS1）+
 *   共享订阅 `$share/control/thermio/gw/+/up/event`（§4.1〔R2〕激活的预留 topic）；
 * - 多副本关联状态全在 PG（§4.5）：本通道只做传输与事件回调，不做业务收敛——
 *   应答按 cmd_id 反查 proposal 由 executor 条件 UPDATE 单赢家完成；
 * - 停用形态（CONTROL_MQTT_BROKER_URL 未设置）：publish 抛 ChannelUnavailableError，
 *   executor 按 §4.4「EMQX 发布失败」语义走 verify_failed 路径（回写原值，不静默丢）；
 * - ACL 前置由 deploy/emqx/acl.conf 承载（§4.1 文本，IMPL-8 部署面已落）。
 */
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { Logger } from 'pino';
import type { MqttClient } from 'mqtt';
import {
  CONTROL_UP_EVENT_SUBSCRIBE_FILTER,
  ControlUpEventSchema,
  type ControlUpEvent,
  type ControlWriteCommand,
} from '@thermio/shared-types';
import type { AppConfig } from '../config.js';
import { APP_CONFIG } from '../infrastructure/core.module.js';
import { LOGGER } from '../infrastructure/logger.js';

/** up/event 订阅回调（payload.gw 与 topic clientid 的一致性在本通道校验，§4.3）。 */
export type ControlUpEventHandler = (event: ControlUpEvent) => void;

/** 传输层发布失败（§4.4：重试 3 次仍失败 → executor 转 verify_failed 路径）。 */
export class ControlChannelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlChannelUnavailableError';
  }
}

export interface ControlChannel {
  /** 发布 down/write（QoS1；发布异常内部重试 3 次，仍失败上抛）。 */
  publishCommand(gatewayClientId: string, command: ControlWriteCommand): Promise<void>;
  /** 注册 up/event 回调（连接前注册亦有效；多注册方按序调用）。 */
  onUpEvent(handler: ControlUpEventHandler): void;
  readonly enabled: boolean;
}

/** 停用形态：dev 无 EMQX 时执行链降级（仲裁照常、下行发布失败走回滚语义）。 */
@Injectable()
export class DisabledControlChannel implements ControlChannel {
  readonly enabled = false;

  constructor(private readonly reason: string) {}

  publishCommand(): Promise<void> {
    return Promise.reject(new ControlChannelUnavailableError(this.reason));
  }

  onUpEvent(): void {
    /* 停用形态无事件源 */
  }
}

@Injectable()
export class MqttControlChannel implements ControlChannel, OnApplicationShutdown {
  readonly enabled = true;
  private client: MqttClient | null = null;
  private readonly handlers: ControlUpEventHandler[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) rootLogger: Logger,
  ) {
    this.logger = rootLogger.child({ component: 'control-channel' });
  }

  private readonly logger: Logger;

  async connect(): Promise<void> {
    const mqtt = await import('mqtt');
    const client = mqtt.connect(this.config.CONTROL_MQTT_BROKER_URL, {
      clientId: this.config.CONTROL_MQTT_CLIENT_ID,
      username: this.config.CONTROL_MQTT_USERNAME,
      password: this.config.CONTROL_MQTT_PASSWORD,
      clean: true,
      reconnectPeriod: 5_000,
      connectTimeout: 10_000,
      protocolVersion: 5,
    });
    this.client = client;
    client.on('message', (topic, payload) => {
      this.dispatchMessage(topic, payload);
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('控制通道 MQTT 连接超时（10s）'));
      }, 10_000);
      client.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      client.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    await new Promise<void>((resolve, reject) => {
      client.subscribe(CONTROL_UP_EVENT_SUBSCRIBE_FILTER, { qos: 1 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    this.logger.info({
      msg: 'control_channel_connected',
      filter: CONTROL_UP_EVENT_SUBSCRIBE_FILTER,
    });
  }

  /** topic clientid 与 payload.gw 一致性纪律（§4.3：不一致丢弃 + WARN）。 */
  private dispatchMessage(topic: string, payload: Buffer): void {
    const match = /^thermio\/gw\/([^/]+)\/up\/event$/.exec(topic);
    if (match === null) return;
    const clientId = match[1] ?? '';
    let raw: unknown;
    try {
      raw = JSON.parse(payload.toString('utf8'));
    } catch {
      this.logger.warn({ msg: 'control_up_event_malformed_json', topic });
      return;
    }
    const parsed = ControlUpEventSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn({ msg: 'control_up_event_schema_rejected', topic });
      return;
    }
    if (parsed.data.gw !== clientId) {
      // GW_MISMATCH 同款语义（ingest.md §2）：安全关注，不进 DLQ（§4.3）
      this.logger.warn({
        msg: 'control_up_event_gw_mismatch',
        topic,
        payload_gw: parsed.data.gw,
        topic_clientid: clientId,
      });
      return;
    }
    for (const handler of this.handlers) handler(parsed.data);
  }

  async publishCommand(gatewayClientId: string, command: ControlWriteCommand): Promise<void> {
    const client = this.requireClient();
    const topic = `thermio/gw/${gatewayClientId}/down/write`;
    const body = JSON.stringify(command);
    const retries = 3; // §4.4 发布异常重试 3 次
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        await new Promise<void>((resolve, reject) => {
          client.publish(topic, body, { qos: 1 }, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        return;
      } catch (err: unknown) {
        lastError = err;
        this.logger.warn({ msg: 'control_publish_error', topic, attempt, err });
      }
    }
    throw new ControlChannelUnavailableError(
      `控制指令发布失败（重试 ${String(retries)} 次耗尽）：${String(lastError)}`,
    );
  }

  onUpEvent(handler: ControlUpEventHandler): void {
    this.handlers.push(handler);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.client !== null) await this.client.endAsync();
  }

  private requireClient(): MqttClient {
    if (this.client === null) {
      throw new ControlChannelUnavailableError(
        '控制通道未连接（CONTROL_MQTT_BROKER_URL 未设置或连接失败）',
      );
    }
    return this.client;
  }
}
