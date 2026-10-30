import { ScryptPasswordHasher } from '../../src/adapters/system/system';
import { ConflictError, InvalidCredentialsError, isPlausibleEmail, UserService, ValidationError } from '../../src/domain';
import { FixedClock, InMemoryUsers, PlainHasher, SequentialIds } from '../fakes';

const make = () => new UserService(new InMemoryUsers(), new PlainHasher(), new SequentialIds(), new FixedClock());

describe('UserService', () => {
  it('registers with a normalised email and never exposes the hash', async () => {
    const user = await make().register({ email: '  Asha@Example.COM ', password: 'long-enough-pw', fullName: ' Asha ' });
    expect(user).toMatchObject({ email: 'asha@example.com', fullName: 'Asha', kycStatus: 'NOT_STARTED' });
    expect(user).not.toHaveProperty('passwordHash');
  });

  it('rejects a duplicate email regardless of case', async () => {
    const service = make();
    await service.register({ email: 'a@example.com', password: 'long-enough-pw', fullName: 'A' });
    await expect(service.register({ email: 'A@EXAMPLE.com', password: 'long-enough-pw', fullName: 'B' })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it.each([
    { email: 'not-an-email', password: 'long-enough-pw', fullName: 'A' },
    { email: 'a@example.com', password: 'short', fullName: 'A' },
    { email: 'a@example.com', password: 'long-enough-pw', fullName: '   ' },
  ])('rejects invalid input %#', async (input) => {
    await expect(make().register(input)).rejects.toBeInstanceOf(ValidationError);
  });

  it('gives the same error for an unknown email and a wrong password', async () => {
    const service = make();
    await service.register({ email: 'a@example.com', password: 'long-enough-pw', fullName: 'A' });
    await expect(service.authenticate('nobody@example.com', 'long-enough-pw')).rejects.toBeInstanceOf(InvalidCredentialsError);
    await expect(service.authenticate('a@example.com', 'wrong-password')).rejects.toBeInstanceOf(InvalidCredentialsError);
    await expect(service.authenticate('A@example.com', 'long-enough-pw')).resolves.toMatchObject({ email: 'a@example.com' });
  });
});

describe('isPlausibleEmail', () => {
  it.each(['a@b.co', 'first.last@sub.example.in', 'x+tag@example.com'])('accepts %s', (e) =>
    expect(isPlausibleEmail(e)).toBe(true),
  );

  it.each(['', 'plain', '@example.com', 'a@', 'a@b', 'a@.com', 'a@b.', 'a@@b.com', 'a@b@c.com', 'a b@c.com'])(
    'rejects %p',
    (e) => expect(isPlausibleEmail(e)).toBe(false),
  );

  it('rejects over-long input and stays fast on hostile input', () => {
    expect(isPlausibleEmail(`${'a'.repeat(250)}@b.co`)).toBe(false);
    const hostile = `!@!.${'!.'.repeat(100_000)}`; // the pattern CodeQL flagged for the old regex
    const started = Date.now();
    expect(isPlausibleEmail(hostile)).toBe(false);
    expect(Date.now() - started).toBeLessThan(50);
  });
});

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
