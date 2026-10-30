import { type KycStatus, type User, type UserRepository, ConflictError } from '../../domain';
import { Prisma, type User as UserRow } from '../../generated/prisma/client';
import type { PrismaDatabase } from './prisma.service';

const toUser = (row: UserRow): User => ({
  id: row.id,
  email: row.email,
  fullName: row.fullName,
  passwordHash: row.passwordHash,
  kycStatus: row.kycStatus,
  createdAt: row.createdAt,
});

export class PrismaUserRepository implements UserRepository {
  constructor(private readonly db: PrismaDatabase) {}

  async create(user: User): Promise<User> {
    try {
      return toUser(await this.db.client.user.create({ data: user }));
    } catch (error) {
      // Two concurrent sign-ups with the same email: the unique index wins.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError('An account with this email already exists');
      }
      throw error;
    }
  }

  async findById(id: string): Promise<User | null> {
    const row = await this.db.client.user.findUnique({ where: { id } });
    return row ? toUser(row) : null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const row = await this.db.client.user.findUnique({ where: { email } });
    return row ? toUser(row) : null;
  }

  async updateKycStatus(userId: string, status: KycStatus): Promise<void> {
    await this.db.client.user.update({ where: { id: userId }, data: { kycStatus: status } });
  }
}
