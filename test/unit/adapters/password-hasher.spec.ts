import { ScryptPasswordHasher } from '../../../src/adapters/system/system';

describe('ScryptPasswordHasher', () => {
  it('verifies the right password only, with a fresh salt each time', async () => {
    const hasher = new ScryptPasswordHasher();
    const a = await hasher.hash('correct horse');
    const b = await hasher.hash('correct horse');
    expect(a).not.toBe(b);
    expect(a.startsWith('scrypt$')).toBe(true);
    await expect(hasher.verify('correct horse', a)).resolves.toBe(true);
    await expect(hasher.verify('wrong horse', a)).resolves.toBe(false);
    await expect(hasher.verify('correct horse', 'garbage')).resolves.toBe(false);
  });
});
