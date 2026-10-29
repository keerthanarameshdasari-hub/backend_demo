import { ConflictError, InvalidCredentialsError, NotFoundError, ValidationError } from './errors';
import { type PublicUser, toPublicUser } from './model';
import type { Clock, IdGenerator, PasswordHasher, UserRepository } from './ports';

export interface RegisterInput {
  email: string;
  password: string;
  fullName: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MIN_PASSWORD_LENGTH = 10;

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class UserService {
  constructor(
    private readonly users: UserRepository,
    private readonly hasher: PasswordHasher,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async register(input: RegisterInput): Promise<PublicUser> {
    const email = normaliseEmail(input.email);
    const fullName = input.fullName.trim();
    if (!EMAIL.test(email)) throw new ValidationError('email is not valid');
    if (input.password.length < MIN_PASSWORD_LENGTH) {
      throw new ValidationError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    if (fullName.length === 0) throw new ValidationError('fullName is required');

    if (await this.users.findByEmail(email)) {
      throw new ConflictError('An account with this email already exists');
    }

    const user = await this.users.create({
      id: this.ids.next(),
      email,
      fullName,
      passwordHash: await this.hasher.hash(input.password),
      kycStatus: 'NOT_STARTED',
      createdAt: this.clock.now(),
    });
    return toPublicUser(user);
  }

  /** Same error for "no such user" and "wrong password", so emails can't be enumerated. */
  async authenticate(email: string, password: string): Promise<PublicUser> {
    const user = await this.users.findByEmail(normaliseEmail(email));
    if (!user || !(await this.hasher.verify(password, user.passwordHash))) {
      throw new InvalidCredentialsError();
    }
    return toPublicUser(user);
  }

  async getProfile(userId: string): Promise<PublicUser> {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundError('User not found');
    return toPublicUser(user);
  }
}
