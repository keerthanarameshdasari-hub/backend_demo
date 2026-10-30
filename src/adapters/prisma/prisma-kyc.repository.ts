import type { KycSubmission, KycSubmissionRepository } from '../../domain';
import type { KycSubmission as KycRow } from '../../generated/prisma/client';
import type { PrismaDatabase } from './prisma.service';

const toSubmission = (row: KycRow): KycSubmission => ({ ...row });

export class PrismaKycSubmissionRepository implements KycSubmissionRepository {
  constructor(private readonly db: PrismaDatabase) {}

  async create(submission: KycSubmission): Promise<KycSubmission> {
    return toSubmission(await this.db.client.kycSubmission.create({ data: submission }));
  }

  async update(
    id: string,
    patch: Pick<KycSubmission, 'status' | 'providerReference' | 'decisionReason' | 'decidedAt'>,
  ): Promise<KycSubmission> {
    return toSubmission(await this.db.client.kycSubmission.update({ where: { id }, data: patch }));
  }

  async findLatestByUser(userId: string): Promise<KycSubmission | null> {
    const row = await this.db.client.kycSubmission.findFirst({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return row ? toSubmission(row) : null;
  }
}
