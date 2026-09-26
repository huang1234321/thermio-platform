/**
 * 设备凭证校验七步（emqx.md §3.3 逐条，蓝本 IMPL-7 验收点 1）：
 *
 *  1 参数化查表（thermio_auth 旁路角色，DB-QRY-01）；
 *  2 查无此账号 → 对固定 dummy hash 同成本校验后 deny（SEC-PW-04 统一耗时）；
 *  3 argon2id 常量时间校验（SEC-PW-01）；
 *  4 clientid ↔ gateway.mqtt_client_id 绑定校验（防凭证串门）；
 *  5 enabled 检查；
 *  6 失败计数按 username + peerhost 限速；
 *  7 全通过 → allow。
 *
 * 内部异常（DB 不可达等）一律 deny + ERROR 日志（fail-closed，SEC-AZ-01）；
 * 日志只记 username/peerhost/clientid/result，永不记 password（CODE-LOG-01）。
 */
import { hash } from '@node-rs/argon2';
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import { APP_CONFIG } from '../infrastructure/core.module.js';
import { LOGGER } from '../infrastructure/logger.js';
import type { MqttAuthenticateRequest } from './contract.js';
import type { DbQueryPort } from './db.js';
import { AUTH_DB } from './db.js';
import { PASSWORD_VERIFIER, type PasswordVerifierPort } from './password-verifier.js';
import { MQTT_AUTH_FAILURE_COUNTER, type MqttAuthFailureCounterPort } from './failure-counter.js';

/** 认证结果：denyReason 为 null 即 allow（第七步）。 */
interface AuthenticationOutcome {
  readonly result: 'allow' | 'deny';
  readonly denyReason:
    | 'rate_limited'
    | 'unknown_account'
    | 'secret_mismatch'
    | 'unsupported_hash'
    | 'clientid_binding_mismatch'
    | 'credential_disabled'
    | 'internal_error'
    | null;
}

/** §3.3-1 查表行（type alias：pg 泛型约束需要隐式索引签名）。 */
type CredentialRow = {
  readonly secret_hash: string;
  readonly enabled: boolean;
  readonly gateway_id: string;
  readonly mqtt_client_id: string;
};

/** §3.3-1 原文形状（参数化，两表 JOIN）。 */
const CREDENTIAL_LOOKUP_SQL = `
SELECT c.secret_hash, c.enabled, g.id AS gateway_id, g.mqtt_client_id
FROM device_credential c
JOIN gateway g ON g.id = c.gateway_id
WHERE c.username = $1`;

@Injectable()
export class MqttAuthenticateService {
  private readonly logger: Logger;
  private readonly dummyHash: Promise<string>;

  constructor(
    @Inject(AUTH_DB) private readonly authDb: DbQueryPort,
    @Inject(PASSWORD_VERIFIER) private readonly verifier: PasswordVerifierPort,
    @Inject(MQTT_AUTH_FAILURE_COUNTER)
    private readonly failureCounter: MqttAuthFailureCounterPort,
    @Inject(LOGGER) rootLogger: Logger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.logger = rootLogger.child({ component: 'mqtt-authenticate' });
    // §3.3-2 固定 dummy hash：进程内一次生成、参数与真实凭证同档——
    // 查无账号时对它做一次真校验，耗时不泄露账号存在性（SEC-PW-04）。
    this.dummyHash = hash('thermio-dummy-verify-target', {});
  }

  async authenticate(req: MqttAuthenticateRequest): Promise<AuthenticationOutcome> {
    try {
      return await this.evaluate(req);
    } catch (err: unknown) {
      // fail-closed：任何内部异常按 deny 返回 + ERROR 留痕（§3.2 末段）。
      this.logger.error({
        msg: 'mqtt_auth_internal_error',
        username: req.username,
        peerhost: req.peerhost,
        clientid: req.clientid,
        err,
      });
      return { result: 'deny', denyReason: 'internal_error' };
    }
  }

  private async evaluate(req: MqttAuthenticateRequest): Promise<AuthenticationOutcome> {
    const peerhost = req.peerhost ?? 'unknown';
    const failure = (denyReason: Exclude<AuthenticationOutcome['denyReason'], null>) => {
      this.logger.info({
        msg: 'mqtt_auth_deny',
        username: req.username,
        peerhost,
        clientid: req.clientid,
        reason: denyReason,
      });
      return { result: 'deny' as const, denyReason };
    };

    // 第 6 步（早判）：触顶直接 deny，不碰 DB 也不做慢哈希。
    if (this.failureCounter.isBlocked(req.username, peerhost)) {
      // 触顶期间的每次尝试都留 WARN（防爆破进行中的信号）。
      this.logger.warn({
        msg: 'mqtt_auth_rate_limited',
        username: req.username,
        peerhost,
        clientid: req.clientid,
        limit: this.config.MQTT_AUTH_FAIL_LIMIT,
        window_ms: this.config.MQTT_AUTH_FAIL_WINDOW_MS,
      });
      return { result: 'deny', denyReason: 'rate_limited' };
    }

    // 第 1 步：参数化查表。
    const { rows } = await this.authDb.query<CredentialRow>(CREDENTIAL_LOOKUP_SQL, [req.username]);
    const credential = rows[0];

    // 第 2 步：查无账号 → dummy hash 同成本校验后 deny。
    if (credential === undefined) {
      const dummy = await this.dummyHash;
      const outcome = await this.verifier.verify(dummy, req.password);
      // dummy 比对结果本身无意义（大概率 mismatch），只为了耗时一致。
      if (outcome === 'mismatched' || outcome === 'matched') {
        this.failureCounter.recordFailure(req.username, peerhost);
      }
      return failure('unknown_account');
    }

    // 第 3 步：慢哈希常量时间校验。
    const verifyOutcome = await this.verifier.verify(credential.secret_hash, req.password);
    if (verifyOutcome === 'unsupported_hash') {
      return failure('unsupported_hash');
    }
    if (verifyOutcome === 'mismatched') {
      this.failureCounter.recordFailure(req.username, peerhost);
      return failure('secret_mismatch');
    }

    // 第 4 步：绑定校验——A 网关的凭证连不成 B 网关身份。
    if (req.clientid !== credential.mqtt_client_id) {
      return failure('clientid_binding_mismatch');
    }

    // 第 5 步：enabled 检查。
    if (!credential.enabled) {
      return failure('credential_disabled');
    }

    // 第 7 步：全通过。
    this.logger.info({
      msg: 'mqtt_auth_allow',
      username: req.username,
      peerhost,
      clientid: req.clientid,
      gateway_id: credential.gateway_id,
    });
    return { result: 'allow', denyReason: null };
  }
}
