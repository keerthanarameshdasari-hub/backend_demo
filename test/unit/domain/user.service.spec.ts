import {
  ConflictError,
  InvalidCredentialsError,
  isPlausibleEmail,
  MAX_EMAIL_LENGTH,
  MIN_PASSWORD_LENGTH,
  normaliseEmail,
  NotFoundError,
  UserService,
  ValidationError,
} from '../../../src/domain';
import { FixedClock, InMemoryUsers, PlainHasher, SequentialIds } from '../../fakes';
import { expectRule } from '../../support/rules';

function setup() {
  const users = new InMemoryUsers();
  const clock = new FixedClock(new Date('2026-02-02T02:02:02.000Z'));
  const service = new UserService(users, new PlainHasher(), new SequentialIds(), clock);
  return { service, users, clock };
}

const valid = { email: 'asha@example.com', password: 'long-enough-pw', fullName: 'Asha' };

describe('UserService.register', () => {
  it('registers with a normalised email and trimmed name, KYC not started', async () => {
    const { service, clock } = setup();
    const user = await service.register({ email: '  Asha@Example.COM ', password: 'long-enough-pw', fullName: ' Asha ' });
    expect(user).toEqual({
      id: '00000000-0000-4000-8000-000000000001',
      email: 'asha@example.com',
      fullName: 'Asha',
      kycStatus: 'NOT_STARTED',
      createdAt: clock.now(),
    });
  });

  it('stores only the password hash, and never returns it', async () => {
    const { service, users } = setup();
    const user = await service.register(valid);
    const stored = users.rows.get(user.id)!;
    expectRule('passwords are stored hashed and the hash never leaves the domain', () => {
      expect(stored.passwordHash).toBe('hashed:long-enough-pw');
      expect(JSON.stringify(stored)).not.toContain('"long-enough-pw"');
      expect(user).not.toHaveProperty('passwordHash');
    });
  });

  it('rejects a duplicate email regardless of case or spacing', async () => {
    const { service } = setup();
    await service.register(valid);
    await expect(service.register({ ...valid, email: ' ASHA@EXAMPLE.com ', fullName: 'B' })).toBeRefusedWith(
      ConflictError,
      'one account per email, case-insensitively',
    );
  });

  it.each([
    ['an invalid email', { email: 'not-an-email' }],
    ['an email over the length limit', { email: `${'a'.repeat(MAX_EMAIL_LENGTH)}@b.co` }],
    [`a password under ${MIN_PASSWORD_LENGTH} characters`, { password: 'x'.repeat(MIN_PASSWORD_LENGTH - 1) }],
    ['a blank full name', { fullName: '   ' }],
  ])('rejects %s', async (label, override) => {
    const { service, users } = setup();
    await expect(service.register({ ...valid, ...override })).toBeRefusedWith(
      ValidationError,
      `registration needs valid input (${label})`,
    );
    expect(users.rows.size).toBe(0);
  });

  it(`accepts a password of exactly ${MIN_PASSWORD_LENGTH} characters`, async () => {
    const { service } = setup();
    await expect(service.register({ ...valid, password: 'x'.repeat(MIN_PASSWORD_LENGTH) })).resolves.toBeDefined();
  });
});

describe('UserService.authenticate', () => {
  it('signs in with any casing of the email', async () => {
    const { service } = setup();
    await service.register(valid);
    await expect(service.authenticate(' ASHA@example.com', 'long-enough-pw')).resolves.toMatchObject({
      email: 'asha@example.com',
    });
  });

  it('gives the same error for an unknown email and a wrong password', async () => {
    const { service } = setup();
    await service.register(valid);
    const unknown = service.authenticate('nobody@example.com', 'long-enough-pw');
    const wrong = service.authenticate('asha@example.com', 'wrong-password');
    await expect(unknown).toBeRefusedWith(InvalidCredentialsError, 'unknown emails are indistinguishable from bad passwords');
    await expect(wrong).toBeRefusedWith(InvalidCredentialsError, 'a wrong password is refused');
    await expect(service.authenticate('nobody@example.com', 'x')).rejects.toThrow('Invalid email or password');
    await expect(service.authenticate('asha@example.com', 'x')).rejects.toThrow('Invalid email or password');
  });

  it('never returns the hash', async () => {
    const { service } = setup();
    await service.register(valid);
    expect(await service.authenticate('asha@example.com', 'long-enough-pw')).not.toHaveProperty('passwordHash');
  });
});

describe('UserService.getProfile', () => {
  it('returns the public profile', async () => {
    const { service } = setup();
    const created = await service.register(valid);
    await expect(service.getProfile(created.id)).resolves.toEqual(created);
  });

  it('reports an unknown user', async () => {
    await expect(setup().service.getProfile('ghost')).toBeRefusedWith(NotFoundError, 'unknown users are NOT_FOUND');
  });
});

describe('email helpers', () => {
  it('normalises by trimming and lower-casing', () => expect(normaliseEmail('  A@B.Co ')).toBe('a@b.co'));

  it.each(['a@b.co', 'first.last@sub.example.in', 'x+tag@example.com'])('accepts %s', (e) =>
    expect(isPlausibleEmail(e)).toBe(true),
  );

  it.each(['', 'plain', '@example.com', 'a@', 'a@b', 'a@.com', 'a@b.', 'a@@b.com', 'a@b@c.com', 'a b@c.com'])('rejects %p', (e) =>
    expect(isPlausibleEmail(e)).toBe(false),
  );

  it('rejects over-long input and stays fast on hostile input', () => {
    expect(isPlausibleEmail(`${'a'.repeat(250)}@b.co`)).toBe(false);
    const hostile = `!@!.${'!.'.repeat(100_000)}`; // the pattern CodeQL flagged for the old regex
    const started = Date.now();
    expect(isPlausibleEmail(hostile)).toBe(false);
    expect(Date.now() - started).toBeLessThan(50);
  });
});
