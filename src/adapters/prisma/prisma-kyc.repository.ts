import type { KycStatus, KycSubmission, KycSubmissionRepository, Page, PageRequest } from '../../domain';
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
    patch: Partial<Pick<KycSubmission, 'status' | 'providerReference' | 'decisionReason' | 'decidedAt' | 'reviewedBy'>>,
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

  async findById(id: string): Promise<KycSubmission | null> {
    const row = await this.db.client.kycSubmission.findUnique({ where: { id } });
    return row ? toSubmission(row) : null;
  }

  async list({ status, limit, offset }: { status?: KycStatus } & PageRequest): Promise<Page<KycSubmission>> {
    const where = status ? { status } : {};
    const [rows, total] = await this.db.client.$transaction([
      this.db.client.kycSubmission.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: offset,
        take: limit,
      }),
      this.db.client.kycSubmission.count({ where }),
    ]);
    return { items: rows.map(toSubmission), total };
  }
}
