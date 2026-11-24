import { describe, expect, it } from 'vitest';
import { DUMMY_HASH, hashPassword, verifyPassword } from './passwords';

describe('passwords', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', stored)).toBe(true);
    expect(await verifyPassword('correct horse batterx', stored)).toBe(false);
  });

  it('never stores the password itself and salts every digest', async () => {
    const [a, b] = await Promise.all([hashPassword('same-password'), hashPassword('same-password')]);
    expect(a).toMatch(/^scrypt\$/);
    expect(a).not.toContain('same-password');
    expect(a).not.toBe(b);
  });

  it('rejects malformed stored values instead of throwing', async () => {
    for (const stored of ['', 'plain-text', 'md5$abc$def', 'scrypt$only-salt']) {
      expect(await verifyPassword('anything', stored)).toBe(false);
    }
  });

  it('has a placeholder digest that no password matches', async () => {
    expect(await verifyPassword('', DUMMY_HASH)).toBe(false);
    expect(await verifyPassword('delta-demo', DUMMY_HASH)).toBe(false);
  });
});
