/**
 * 设备凭证慢哈希校验（SEC-PW-01，emqx.md §3.3-3）。
 *
 * 存储格式带算法前缀（ddl.md device_credential.secret_hash 注释）：
 * - `$argon2*` → @node-rs/argon2 verify（推荐算法，v1 唯一发放格式）；
 * - 其余前缀（含 bcrypt `$2*`）→ v1 无存量、未实现双读：fail-closed 拒绝 + ERROR 留痕
 *   （bcrypt 迁移期双读在真有存量导入时按 SEC-KEY-04 思路补，本文件是唯一收口点）；
 *   分支侧**同跑一次 dummy argon2 verify**（DAT-110 跟踪项 1，随 IMPL-13 收口）：
 *   慢哈希耗时由参数决定与明文无关，两分支耗时对齐即抹平「哈希格式可被时序区分」
 *   的侧信道（v1 无 bcrypt 存量当前不可利用，防御性收口；双读实现时同形保持）。
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

/**
 * Dummy verify 哈希（固定字面量，@node-rs/argon2 默认参数 m=19456/t=2/p=1——
 * 与 v1 发放路径 hash() 默认参数一致，耗时同量级；明文域为公开测试固件非秘密）。
 */
const DUMMY_ARGON2_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$t5ZdCXiQQmnRKDgtztW+9g$5bmrtmuQdcMVaZmHZyMR7ztioYmuQ80HeEllXuKETIw';

export class Argon2PasswordVerifier implements PasswordVerifierPort {
  constructor(private readonly logger: Logger) {}

  async verify(secretHash: string, password: string): Promise<PasswordVerifyOutcome> {
    if (secretHash.startsWith('$argon2')) {
      return (await verify(secretHash, password)) ? 'matched' : 'mismatched';
    }
    // 不泄露具体前缀值（哈希格式是内部细节）；只留足够定位的信号。
    this.logger.error({ msg: 'device_secret_hash_unsupported_algorithm' });
    // 时序对齐（DAT-110）：与支持分支跑同量级 dummy verify，结果弃用
    await verify(DUMMY_ARGON2_HASH, password).catch(() => false);
    return 'unsupported_hash';
  }
}
