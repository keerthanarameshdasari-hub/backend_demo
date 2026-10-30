import {
  ConflictError,
  DomainError,
  InvalidCredentialsError,
  KycRequiredError,
  NotFoundError,
  toPublicUser,
  ValidationError,
} from '../../../src/domain';
import { aUser } from '../../fakes';

describe('domain errors', () => {
  it.each([
    [new ValidationError('v'), 'ValidationError', 'VALIDATION'],
    [new NotFoundError('n'), 'NotFoundError', 'NOT_FOUND'],
    [new ConflictError('c'), 'ConflictError', 'CONFLICT'],
    [new InvalidCredentialsError(), 'InvalidCredentialsError', 'UNAUTHENTICATED'],
    [new KycRequiredError(), 'KycRequiredError', 'FORBIDDEN'],
  ])('%s carries its name and code', (error, name, code) => {
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe(name);
    expect(error.code).toBe(code);
  });

  it('explains why a top-up was refused before KYC', () => {
    expect(new KycRequiredError().message).toBe('KYC must be approved before topping up the wallet');
  });
});

describe('toPublicUser', () => {
  it('drops the password hash without touching the original', () => {
    const user = aUser({ passwordHash: 'secret-hash' });
    const shown = toPublicUser(user);
    expect(shown).not.toHaveProperty('passwordHash');
    expect(shown).toMatchObject({ id: user.id, email: user.email });
    expect(user.passwordHash).toBe('secret-hash');
  });
});
