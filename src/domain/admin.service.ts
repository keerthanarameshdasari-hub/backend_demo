import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from './errors';
import {
  type KycStatus,
  type KycSubmission,
  type Page,
  type PageRequest,
  type PublicUser,
  type TopUp,
  type TopUpStatus,
  toPublicUser,
  type User,
} from './model';
import type { Clock, KycSubmissionRepository, UserRepository, WalletRepository } from './ports';
import { normaliseEmail } from './user.service';

export const MAX_PAGE_SIZE = 100;
export const MIN_REJECTION_REASON_LENGTH = 3;
export const MAX_REJECTION_REASON_LENGTH = 500;

/** Who a row belongs to, for listings that span every user. */
export type Owner = Pick<User, 'id' | 'email' | 'fullName'>;

export interface OwnedKycSubmission {
  submission: KycSubmission;
  owner: Owner | null;
}

export interface OwnedTopUp {
  topUp: TopUp;
  owner: Owner | null;
}

/**
 * Back-office operations. Every method takes the acting admin's id and checks
 * the role itself, so the HTTP guard is a second line of defence, not the only one.
 *
 * KYC review is an override: the provider still decides first, inside
 * KycService.submit. An admin may then approve a REJECTED or TIMED_OUT
 * submission, or reject an APPROVED or TIMED_OUT one. A PENDING submission is
 * still with the provider and can't be touched.
 */
export class AdminService {
  constructor(
    private readonly users: UserRepository,
    private readonly submissions: KycSubmissionRepository,
    private readonly wallets: WalletRepository,
    private readonly clock: Clock,
  ) {}

  /** Throws ForbiddenError unless `userId` is an existing ADMIN. */
  async assertAdmin(userId: string): Promise<PublicUser> {
    const user = await this.users.findById(userId);
    if (!user || user.role !== 'ADMIN') throw new ForbiddenError('Admin access required');
    return toPublicUser(user);
  }

  async listUsers(adminId: string, filter: { kycStatus?: KycStatus } & PageRequest): Promise<Page<PublicUser>> {
    await this.assertAdmin(adminId);
    const page = await this.users.list({ ...filter, ...checkPage(filter) });
    return { items: page.items.map(toPublicUser), total: page.total };
  }

  async listKycSubmissions(adminId: string, filter: { status?: KycStatus } & PageRequest): Promise<Page<OwnedKycSubmission>> {
    await this.assertAdmin(adminId);
    const page = await this.submissions.list({ ...filter, ...checkPage(filter) });
    const owners = await this.ownersOf(page.items.map((s) => s.userId));
    return {
      items: page.items.map((submission) => ({ submission, owner: owners.get(submission.userId) ?? null })),
      total: page.total,
    };
  }

  async listTopUps(adminId: string, filter: { userId?: string; status?: TopUpStatus } & PageRequest): Promise<Page<OwnedTopUp>> {
    await this.assertAdmin(adminId);
    const page = await this.wallets.listAllTopUps({ ...filter, ...checkPage(filter) });
    const owners = await this.ownersOf(page.items.map((t) => t.userId));
    return { items: page.items.map((topUp) => ({ topUp, owner: owners.get(topUp.userId) ?? null })), total: page.total };
  }

  async approveKyc(adminId: string, submissionId: string): Promise<OwnedKycSubmission> {
    return this.decide(adminId, submissionId, 'APPROVED', null);
  }

  async rejectKyc(adminId: string, submissionId: string, reason: string): Promise<OwnedKycSubmission> {
    const trimmed = reason.trim();
    if (trimmed.length < MIN_REJECTION_REASON_LENGTH || trimmed.length > MAX_REJECTION_REASON_LENGTH) {
      throw new ValidationError(`reason must be ${MIN_REJECTION_REASON_LENGTH}-${MAX_REJECTION_REASON_LENGTH} characters`);
    }
    return this.decide(adminId, submissionId, 'REJECTED', trimmed);
  }

  private async decide(
    adminId: string,
    submissionId: string,
    status: 'APPROVED' | 'REJECTED',
    reason: string | null,
  ): Promise<OwnedKycSubmission> {
    const admin = await this.assertAdmin(adminId);
    const submission = await this.submissions.findById(submissionId);
    if (!submission) throw new NotFoundError('KYC submission not found');
    if (submission.userId === admin.id) throw new ForbiddenError('Admins cannot review their own KYC submission');
    if (submission.status === 'PENDING') {
      throw new ConflictError('This submission is still with the verification provider');
    }
    if (submission.status === status) throw new ConflictError(`This submission is already ${status}`);

    // Only the newest submission sets the user's status, so only it can be overridden.
    const latest = await this.submissions.findLatestByUser(submission.userId);
    if (latest?.id !== submission.id) {
      throw new ConflictError("Only the user's latest KYC submission can be reviewed");
    }

    const updated = await this.submissions.update(submission.id, {
      status,
      decisionReason: reason,
      decidedAt: this.clock.now(),
      reviewedBy: admin.id,
    });
    await this.users.updateKycStatus(submission.userId, status);
    const owners = await this.ownersOf([submission.userId]);
    return { submission: updated, owner: owners.get(submission.userId) ?? null };
  }

  private async ownersOf(userIds: string[]): Promise<Map<string, Owner>> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return new Map();
    const users = await this.users.findByIds(unique);
    return new Map(users.map((u) => [u.id, { id: u.id, email: u.email, fullName: u.fullName }]));
  }
}

/**
 * Gives an existing account the ADMIN role. Used by the promote-admin script
 * only: there is no HTTP route that grants roles.
 */
export async function promoteToAdmin(users: UserRepository, email: string): Promise<PublicUser> {
  const user = await users.findByEmail(normaliseEmail(email));
  if (!user) throw new NotFoundError('User not found');
  if (user.role !== 'ADMIN') await users.updateRole(user.id, 'ADMIN');
  return toPublicUser({ ...user, role: 'ADMIN' });
}

function checkPage({ limit, offset }: PageRequest): PageRequest {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new ValidationError(`limit must be an integer from 1 to ${MAX_PAGE_SIZE}`);
  }
  if (!Number.isInteger(offset) || offset < 0) throw new ValidationError('offset must be a non-negative integer');
  return { limit, offset };
}
