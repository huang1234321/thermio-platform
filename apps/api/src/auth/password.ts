/**
 * 密码哈希与校验（SEC-PW-01：自适应慢哈希 argon2id；SEC-PW-04：不区分账号不存在/密码错）。
 *
 * - argon2id 参数取 @node-rs/argon2 默认（memory 19MiB / iterations 2 / parallelism 1，
 *   OWASP 推荐档位）；SEC-PW-01 只钉算法族与慢哈希属性，参数随库默认升级；
 * - 查无账号走 DUMMY_HASH 等耗时校验：两类失败的响应文案与耗时一致（SEC-PW-04）；
 *   DUMMY_HASH 启动时对固定哑口令现场计算（真实有效哈希，保证 verify 走完整 KDF，
 *   值本身公开非秘密）。
 */
import { hash, verify } from '@node-rs/argon2';

/** 启动期一次性计算的真实 argon2id 样本（等耗时路径用）。 */
const DUMMY_HASH: string = await hash('thermio-timing-dummy-password');

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain);
}

/** 校验密码；对「用户不存在」路径以同一函数对 DUMMY_HASH 校验，保证耗时与文案一致。 */
export async function verifyPassword(passwordHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(passwordHash, plain);
  } catch {
    // 哈希串损坏（如历史数据迁移异常）：按失败处理，不区分文案（SEC-PW-04）
    return false;
  }
}

/** 查无账号时的等耗时路径（结果恒 false，不泄露任何信息）。 */
export async function verifyDummy(plain: string): Promise<boolean> {
  return verify(DUMMY_HASH, plain).catch(() => false);
}
