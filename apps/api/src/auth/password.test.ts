/**
 * 密码域单测（SEC-PW-01 argon2id；SEC-PW-04 哑路径不泄露）。
 */
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyDummy, verifyPassword } from './password.js';

describe('argon2id password', () => {
  it('shouldHashWithTheArgon2idPrefix_andVerifyRoundtrip', async () => {
    const hashed = await hashPassword('correct horse battery 9');
    expect(hashed.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hashed, 'correct horse battery 9')).toBe(true);
    expect(await verifyPassword(hashed, 'wrong password 1')).toBe(false);
  });

  it('shouldSwallowMalformedHashes_asPlainFailure', async () => {
    expect(await verifyPassword('not-a-hash', 'whatever1')).toBe(false);
  });

  it('shouldAlwaysFailTheDummyPath_withoutLeaking', async () => {
    expect(await verifyDummy('any-password-1')).toBe(false);
    expect(await verifyDummy('another-2')).toBe(false);
  });
});
