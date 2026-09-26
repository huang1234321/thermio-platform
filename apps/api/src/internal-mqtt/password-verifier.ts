/**
 * 设备凭证慢哈希校验（SEC-PW-01，emqx.md §3.3-3）。
 *
 * 存储格式带算法前缀（ddl.md device_credential.secret_hash 注释）：
 * - `$argon2*` → @node-rs/argon2 verify（推荐算法，v1 唯一发放格式）；
 * - 其余前缀（含 bcrypt `$2*`）→ v1 无存量、未实现双读：fail-closed 拒绝 + ERROR 留痕
 *   （bcrypt 迁移期双读在真有存量导入时按 SEC-KEY-04 思路补，本文件是唯一收口点）。
 */
import { verify } from '@node-rs/argon2';
import { type InjectionToken } from '@nestjs/common';
import type { Logger } from 'pino';

export type PasswordVerifyOutcome = 'matched' | 'mismatched' | 'unsupported_hash';

export interface PasswordVerifierPort {
  /** 常量时间语义由 argon2 算法本身保证（同参数哈希比对耗时与明文无关）。 */
  verify(secretHash: string, password: string): Promise<PasswordVerifyOutcome>;
}

export const PASSWORD_VERIFIER: InjectionToken<PasswordVerifierPort> = Symbol('PASSWORD_VERIFIER');

export class Argon2PasswordVerifier implements PasswordVerifierPort {
  constructor(private readonly logger: Logger) {}

  async verify(secretHash: string, password: string): Promise<PasswordVerifyOutcome> {
    if (secretHash.startsWith('$argon2')) {
      return (await verify(secretHash, password)) ? 'matched' : 'mismatched';
    }
    // 不泄露具体前缀值（哈希格式是内部细节）；只留足够定位的信号。
    this.logger.error({ msg: 'device_secret_hash_unsupported_algorithm' });
    return 'unsupported_hash';
  }
}
