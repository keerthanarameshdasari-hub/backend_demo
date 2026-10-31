import {
  type KycStatus,
  type Page,
  type PageRequest,
  type User,
  type UserRepository,
  type UserRole,
  ConflictError,
} from '../../domain';
import { Prisma, type User as UserRow } from '../../generated/prisma/client';
import type { PrismaDatabase } from './prisma.service';

const toUser = (row: UserRow): User => ({
  id: row.id,
  email: row.email,
  fullName: row.fullName,
  passwordHash: row.passwordHash,
  role: row.role,
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

  async updateRole(userId: string, role: UserRole): Promise<void> {
    await this.db.client.user.update({ where: { id: userId }, data: { role } });
  }

  async findByIds(ids: readonly string[]): Promise<User[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.client.user.findMany({ where: { id: { in: [...ids] } } });
    return rows.map(toUser);
  }

  async list({ kycStatus, limit, offset }: { kycStatus?: KycStatus } & PageRequest): Promise<Page<User>> {
    const where = kycStatus ? { kycStatus } : {};
    const [rows, total] = await this.db.client.$transaction([
      this.db.client.user.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: offset, take: limit }),
      this.db.client.user.count({ where }),
    ]);
    return { items: rows.map(toUser), total };
  }
}
