/**
 * 导入域 MQTT 下行通道（emqx.md §4 R6 / M2-import §8.4/§9.2；IMPL-8 对接面）。
 *
 * - api 内部账号（svc-api）publish `thermio/gw/{client_id}/down/config`（retained）
 *   与 `down/read`；共享订阅 `$share/api/thermio/gw/+/up/config/ack` 消费网关应答；
 * - 停用形态（MQTT_BROKER_URL 未设置，与 KAFKA_BROKERS/TSDB_READ_URL 同款纪律）：
 *   publish 返回 'skipped'，apply 推送段按降级语义跳过（登记保留、job 停留 applied、
 *   结构化日志 + 指标留痕）——dev 无栈可跑其余端点与 e2e；
 * - ACL 前置（emqx.md §4 R6）：svc-api 的三条规则由部署面 provision（伞仓 deploy，
 *   IMPL-8 交付项）；本模块不依赖 ACL 存在性，连接失败按 publisher 错误上抛。
 */
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { Logger } from 'pino';
import type { MqttClient } from 'mqtt';
import {
  CONFIG_ACK_SUBSCRIBE_FILTER,
  IMPORT_CONFIG_PUSH_RETRIES,
  IMPORT_CONFIG_PUSH_TIMEOUT_S,
  type GatewayConfigAck,
  type GatewayConfigArtifact,
  type GatewayReadCommand,
  GatewayConfigAckSchema,
  gatewayDownTopic,
} from '@thermio/shared-types';
import type { AppConfig } from '../config.js';
import { APP_CONFIG } from '../infrastructure/core.module.js';
import { LOGGER } from '../infrastructure/logger.js';

export interface DownChannel {
  /** 发布 retained 配置（QoS1）+ 等待该 job 的网关应答（30s×3 退避重发）。 */
  publishConfigAndWaitAck(
    mqttClientId: string,
    artifact: GatewayConfigArtifact,
  ): Promise<GatewayConfigAck>;
  /** 发布自检读指令（QoS1，fire-and-forget；分批由调用方切）。 */
  publishRead(mqttClientId: string, command: GatewayReadCommand): Promise<void>;
  /** 停用形态判据（指标/日志分流用）。 */
  readonly enabled: boolean;
}

/** 停用形态：dev 无 EMQX 栈时 apply 推送段降级跳过（登记保留语义见 §8.3-d 定夺注）。 */
@Injectable()
export class DisabledDownChannel implements DownChannel {
  readonly enabled = false;

  constructor(private readonly reason: string) {}

  publishConfigAndWaitAck(): Promise<GatewayConfigAck> {
    return Promise.reject(
      new Error(`unreachable: 停用通道不应等待应答（${this.reason}）——调用方先判 enabled`),
    );
  }

  publishRead(): Promise<void> {
    return Promise.resolve(); // 停用形态：读指令无通道，自检统计仍可执行（回看窗内既有遥测）
  }
}

interface PendingAck {
  jobId: string;
  settle: (ack: GatewayConfigAck) => void;
}

@Injectable()
export class MqttDownChannel implements DownChannel, OnApplicationShutdown {
  readonly enabled = true;
  private client: MqttClient | null = null;
  private readonly pendingAcks = new Map<string, PendingAck[]>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) rootLogger: Logger,
  ) {
    this.logger = rootLogger.child({ component: 'import-down-channel' });
  }

  private readonly logger: Logger;

  async connect(): Promise<void> {
    const mqtt = await import('mqtt');
    const client = mqtt.connect(this.config.MQTT_BROKER_URL, {
      clientId: this.config.MQTT_CLIENT_ID,
      username: this.config.MQTT_USERNAME,
      password: this.config.MQTT_PASSWORD,
      clean: true,
      reconnectPeriod: 5_000,
      connectTimeout: 10_000,
      protocolVersion: 5,
    });
    this.client = client;
    client.on('message', (topic, payload) => {
      this.handleMessage(topic, payload).catch((err: unknown) => {
        this.logger.warn({ msg: 'config_ack_handle_failed', topic, err });
      });
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('MQTT 连接超时（10s）'));
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
    // 共享订阅：$share/api 前缀防 api 多实例重复消费（emqx.md §4 R6）
    await new Promise<void>((resolve, reject) => {
      client.subscribe(CONFIG_ACK_SUBSCRIBE_FILTER, { qos: 1 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private async handleMessage(topic: string, payload: Buffer): Promise<void> {
    if (!topic.endsWith('/up/config/ack')) return;
    let raw: unknown;
    try {
      raw = JSON.parse(payload.toString('utf8'));
    } catch {
      this.logger.warn({ msg: 'config_ack_malformed', topic });
      return;
    }
    const parsed = GatewayConfigAckSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn({ msg: 'config_ack_malformed', topic });
      return;
    }
    const queue = this.pendingAcks.get(parsed.data.job_id);
    const waiter = queue?.shift();
    if (queue !== undefined && queue.length === 0) this.pendingAcks.delete(parsed.data.job_id);
    waiter?.settle(parsed.data);
    await Promise.resolve();
  }

  async publishConfigAndWaitAck(
    mqttClientId: string,
    artifact: GatewayConfigArtifact,
  ): Promise<GatewayConfigAck> {
    const client = this.requireClient();
    const topic = gatewayDownTopic('config', mqttClientId);
    const payload = JSON.stringify(artifact);
    const timeoutMs = IMPORT_CONFIG_PUSH_TIMEOUT_S * 1000;
    const deadline = Date.now() + timeoutMs * IMPORT_CONFIG_PUSH_RETRIES;
    let attempt = 0;

    while (Date.now() < deadline) {
      attempt += 1;
      const ack = await this.publishAndWaitRound(
        client,
        topic,
        payload,
        artifact.job_id,
        timeoutMs,
      );
      if (ack !== null) return ack;
      this.logger.warn({ msg: 'config_ack_timeout_retry', job_id: artifact.job_id, attempt });
    }
    throw new AcksExhaustedError(attempt);
  }

  /** 单轮：publish（retained）→ 等应答直到 timeoutMs；超时/发布错误 → null（外层重发）。 */
  private publishAndWaitRound(
    client: MqttClient,
    topic: string,
    payload: string,
    jobId: string,
    timeoutMs: number,
  ): Promise<GatewayConfigAck | null> {
    return new Promise((resolve) => {
      const waiter: PendingAck = {
        jobId,
        settle: (ack) => {
          finish(ack);
        },
      };
      let settled = false;
      const timer = setTimeout(() => {
        finish(null);
      }, timeoutMs);
      const finish = (ack: GatewayConfigAck | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const queue = (this.pendingAcks.get(jobId) ?? []).filter((w) => w !== waiter);
        if (queue.length === 0) this.pendingAcks.delete(jobId);
        else this.pendingAcks.set(jobId, queue);
        resolve(ack);
      };

      const queue = this.pendingAcks.get(jobId);
      if (queue === undefined) this.pendingAcks.set(jobId, [waiter]);
      else queue.push(waiter);
      client.publish(topic, payload, { qos: 1, retain: true }, (err) => {
        if (err) {
          this.logger.warn({ msg: 'config_publish_error', topic, err });
          finish(null);
        }
      });
    });
  }

  async publishRead(mqttClientId: string, command: GatewayReadCommand): Promise<void> {
    const client = this.requireClient();
    const topic = gatewayDownTopic('read', mqttClientId);
    await new Promise<void>((resolve, reject) => {
      client.publish(topic, JSON.stringify(command), { qos: 1 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.client !== null) await this.client.endAsync();
  }

  private requireClient(): MqttClient {
    if (this.client === null) {
      throw new Error('MQTT 客户端未连接（connect 失败或尚未完成）');
    }
    return this.client;
  }
}

/** 应答重试耗尽（apply_push 段 gateway_ack_timeout）。 */
export class AcksExhaustedError extends Error {
  constructor(readonly attempts: number) {
    super(`网关应答超时（重试 ${String(attempts)} 次耗尽）`);
  }
}
