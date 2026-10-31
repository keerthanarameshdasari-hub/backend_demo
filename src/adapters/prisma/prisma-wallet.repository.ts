import type { Page, PageRequest, TopUp, TopUpStatus, Wallet, WalletRepository } from '../../domain';
import type { TopUp as TopUpRow, Wallet as WalletRow } from '../../generated/prisma/client';
import type { PrismaDatabase } from './prisma.service';

const toWallet = (row: WalletRow): Wallet => {
  const balance = Number(row.balanceMinor);
  if (!Number.isSafeInteger(balance)) throw new Error('Wallet balance exceeds the safe integer range');
  return { userId: row.userId, currency: row.currency, balanceMinor: balance, updatedAt: row.updatedAt };
};

const toTopUp = (row: TopUpRow): TopUp => ({ ...row });

export class PrismaWalletRepository implements WalletRepository {
  constructor(private readonly db: PrismaDatabase) {}

  async getOrCreate(userId: string, currency: string, now: Date): Promise<Wallet> {
    const row = await this.db.client.wallet.upsert({
      where: { userId },
      create: { userId, currency, balanceMinor: 0n, updatedAt: now },
      update: {},
    });
    return toWallet(row);
  }

  async createTopUp(topUp: TopUp): Promise<TopUp> {
    return toTopUp(await this.db.client.topUp.create({ data: topUp }));
  }

  async findTopUpByIdempotencyKey(userId: string, key: string): Promise<TopUp | null> {
    const row = await this.db.client.topUp.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey: key } },
    });
    return row ? toTopUp(row) : null;
  }

  async listTopUps(userId: string, limit: number): Promise<TopUp[]> {
    const rows = await this.db.client.topUp.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map(toTopUp);
  }

  async listAllTopUps({
    userId,
    status,
    limit,
    offset,
  }: { userId?: string; status?: TopUpStatus } & PageRequest): Promise<Page<TopUp>> {
    const where = { ...(userId ? { userId } : {}), ...(status ? { status } : {}) };
    const [rows, total] = await this.db.client.$transaction([
      this.db.client.topUp.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: offset, take: limit }),
      this.db.client.topUp.count({ where }),
    ]);
    return { items: rows.map(toTopUp), total };
  }

  async completeTopUp(id: string, providerReference: string, completedAt: Date): Promise<{ topUp: TopUp; wallet: Wallet }> {
    return this.db.client.$transaction(async (tx) => {
      // The status guard makes the credit happen at most once, even if called twice.
      const { count } = await tx.topUp.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'SUCCEEDED', providerReference, completedAt },
      });
      const topUp = await tx.topUp.findUniqueOrThrow({ where: { id } });
      const wallet =
        count === 1
          ? await tx.wallet.update({
              where: { userId: topUp.userId },
              data: { balanceMinor: { increment: BigInt(topUp.amountMinor) }, updatedAt: completedAt },
            })
          : await tx.wallet.findUniqueOrThrow({ where: { userId: topUp.userId } });
      return { topUp: toTopUp(topUp), wallet: toWallet(wallet) };
    });
  }

  async failTopUp(id: string, status: 'FAILED' | 'TIMED_OUT', reason: string, completedAt: Date): Promise<TopUp> {
    await this.db.client.topUp.updateMany({
      where: { id, status: 'PENDING' },
      data: { status, failureReason: reason, completedAt },
    });
    return toTopUp(await this.db.client.topUp.findUniqueOrThrow({ where: { id } }));
  }
}
