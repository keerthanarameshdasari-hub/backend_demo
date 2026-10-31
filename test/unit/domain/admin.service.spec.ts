/**
 * AdminService against in-memory fakes. The service checks the admin role
 * itself, so every operation is also tested as a non-admin and a missing user.
 */
import {
  AdminService,
  ConflictError,
  ForbiddenError,
  type KycStatus,
  NotFoundError,
  promoteToAdmin,
  ValidationError,
} from '../../../src/domain';
import { aSubmission, aTopUp, aUser, FixedClock, InMemoryKyc, InMemoryUsers, InMemoryWallets } from '../../fakes';

const NOW = new Date('2026-03-01T10:00:00.000Z');
const PAGE = { limit: 50, offset: 0 };

async function setup() {
  const users = new InMemoryUsers();
  const submissions = new InMemoryKyc();
  const wallets = new InMemoryWallets();
  const service = new AdminService(users, submissions, wallets, new FixedClock(NOW));
  await users.create(aUser({ id: 'admin', email: 'admin@example.com', fullName: 'Ada Admin', role: 'ADMIN' }));
  await users.create(aUser({ id: 'u1', email: 'asha@example.com', fullName: 'Asha Rao', kycStatus: 'REJECTED' }));
  return { service, users, submissions, wallets };
}

describe('AdminService', () => {
  describe('role check', () => {
    const operations: [string, (s: AdminService, actor: string) => Promise<unknown>][] = [
      ['listUsers', (s, a) => s.listUsers(a, PAGE)],
      ['listKycSubmissions', (s, a) => s.listKycSubmissions(a, PAGE)],
      ['listTopUps', (s, a) => s.listTopUps(a, PAGE)],
      ['approveKyc', (s, a) => s.approveKyc(a, 's1')],
      ['rejectKyc', (s, a) => s.rejectKyc(a, 's1', 'blurry photo')],
    ];

    it.each(operations)('%s refuses a regular user', async (_name, run) => {
      const { service, submissions } = await setup();
      await submissions.create(aSubmission());
      await expect(run(service, 'u1')).rejects.toThrow(new ForbiddenError('Admin access required'));
    });

    it.each(operations)('%s refuses an unknown user id', async (_name, run) => {
      const { service } = await setup();
      await expect(run(service, 'ghost')).rejects.toThrow(ForbiddenError);
    });

    it('assertAdmin returns the admin without the password hash', async () => {
      const { service } = await setup();
      const admin = await service.assertAdmin('admin');
      expect(admin).toMatchObject({ id: 'admin', role: 'ADMIN' });
      expect(admin).not.toHaveProperty('passwordHash');
    });
  });

  describe('listUsers', () => {
    it('pages newest first, filters by KYC status and never returns password hashes', async () => {
      const { service, users } = await setup();
      await users.create(aUser({ id: 'u2', email: 'b@example.com', createdAt: new Date('2026-02-01'), kycStatus: 'APPROVED' }));

      const all = await service.listUsers('admin', PAGE);
      expect(all.total).toBe(3);
      expect(all.items[0]!.id).toBe('u2');
      expect(all.items.every((u) => !('passwordHash' in u))).toBe(true);

      const approved = await service.listUsers('admin', { ...PAGE, kycStatus: 'APPROVED' });
      expect(approved).toEqual({ items: [expect.objectContaining({ id: 'u2' })], total: 1 });

      const second = await service.listUsers('admin', { limit: 1, offset: 1 });
      expect(second.items).toHaveLength(1);
      expect(second.total).toBe(3);
    });

    it.each([
      [{ limit: 0, offset: 0 }, /limit/],
      [{ limit: 101, offset: 0 }, /limit/],
      [{ limit: 1.5, offset: 0 }, /limit/],
      [{ limit: 10, offset: -1 }, /offset/],
      [{ limit: 10, offset: 0.5 }, /offset/],
    ])('rejects page %j', async (page, message) => {
      const { service } = await setup();
      await expect(service.listUsers('admin', page)).rejects.toThrow(ValidationError);
      await expect(service.listUsers('admin', page)).rejects.toThrow(message);
    });
  });

  describe('listKycSubmissions', () => {
    it('attaches each owner and filters by status', async () => {
      const { service, submissions } = await setup();
      await submissions.create(aSubmission({ id: 's1', status: 'REJECTED' }));
      await submissions.create(aSubmission({ id: 's2', status: 'APPROVED' }));

      const page = await service.listKycSubmissions('admin', { ...PAGE, status: 'REJECTED' });
      expect(page.total).toBe(1);
      expect(page.items[0]).toEqual({
        submission: expect.objectContaining({ id: 's1' }),
        owner: { id: 'u1', email: 'asha@example.com', fullName: 'Asha Rao' },
      });
    });

    it('returns a null owner when the user row is gone, and skips the lookup for an empty page', async () => {
      const { service, submissions, users } = await setup();
      await submissions.create(aSubmission({ userId: 'deleted' }));
      expect((await service.listKycSubmissions('admin', PAGE)).items[0]!.owner).toBeNull();

      const spy = jest.spyOn(users, 'findByIds');
      expect(await service.listKycSubmissions('admin', { ...PAGE, status: 'PENDING' })).toEqual({ items: [], total: 0 });
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('listTopUps', () => {
    it('lists every user, or one user, by status, newest first', async () => {
      const { service, wallets } = await setup();
      await wallets.createTopUp(aTopUp({ id: 't1', userId: 'u1' }));
      await wallets.createTopUp(aTopUp({ id: 't2', userId: 'admin', status: 'FAILED' }));

      const all = await service.listTopUps('admin', PAGE);
      expect(all.items.map((i) => i.topUp.id)).toEqual(['t2', 't1']);
      expect(all.items[1]!.owner).toEqual({ id: 'u1', email: 'asha@example.com', fullName: 'Asha Rao' });

      expect((await service.listTopUps('admin', { ...PAGE, userId: 'u1' })).items.map((i) => i.topUp.id)).toEqual(['t1']);
      expect((await service.listTopUps('admin', { ...PAGE, status: 'FAILED' })).total).toBe(1);
    });
  });

  describe('approveKyc', () => {
    it.each<KycStatus>(['REJECTED', 'TIMED_OUT'])(
      'approves a %s submission and the user, recording the reviewer',
      async (status) => {
        const { service, submissions, users } = await setup();
        await users.updateKycStatus('u1', status);
        await submissions.create(aSubmission({ status }));

        const result = await service.approveKyc('admin', 's1');

        expect(result.submission).toMatchObject({
          status: 'APPROVED',
          decisionReason: null,
          decidedAt: NOW,
          reviewedBy: 'admin',
        });
        expect(result.owner).toEqual({ id: 'u1', email: 'asha@example.com', fullName: 'Asha Rao' });
        expect((await users.findById('u1'))!.kycStatus).toBe('APPROVED');
      },
    );

    it('409 when already approved', async () => {
      const { service, submissions } = await setup();
      await submissions.create(aSubmission({ status: 'APPROVED' }));
      await expect(service.approveKyc('admin', 's1')).rejects.toThrow(new ConflictError('This submission is already APPROVED'));
    });
  });

  describe('rejectKyc', () => {
    it.each<KycStatus>(['APPROVED', 'TIMED_OUT'])('rejects a %s submission with a trimmed reason', async (status) => {
      const { service, submissions, users } = await setup();
      await users.updateKycStatus('u1', status);
      await submissions.create(aSubmission({ status, decisionReason: null }));

      const result = await service.rejectKyc('admin', 's1', '  Photo is unreadable  ');

      expect(result.submission).toMatchObject({
        status: 'REJECTED',
        decisionReason: 'Photo is unreadable',
        decidedAt: NOW,
        reviewedBy: 'admin',
      });
      expect((await users.findById('u1'))!.kycStatus).toBe('REJECTED');
    });

    it.each(['', '  ab  ', 'x'.repeat(501)])('rejects the reason %j', async (reason) => {
      const { service, submissions } = await setup();
      await submissions.create(aSubmission({ status: 'APPROVED' }));
      await expect(service.rejectKyc('admin', 's1', reason)).rejects.toThrow(/reason must be 3-500 characters/);
      expect((await submissions.findById('s1'))!.status).toBe('APPROVED');
    });

    it('409 when already rejected', async () => {
      const { service, submissions } = await setup();
      await submissions.create(aSubmission({ status: 'REJECTED' }));
      await expect(service.rejectKyc('admin', 's1', 'still bad')).rejects.toThrow(ConflictError);
    });
  });

  describe('either decision', () => {
    const decisions: [string, (s: AdminService, id: string) => Promise<unknown>][] = [
      ['approve', (s, id) => s.approveKyc('admin', id)],
      ['reject', (s, id) => s.rejectKyc('admin', id, 'not legible')],
    ];

    it.each(decisions)('%s: 404 for an unknown submission', async (_name, decide) => {
      const { service } = await setup();
      await expect(decide(service, 'nope')).rejects.toThrow(new NotFoundError('KYC submission not found'));
    });

    it.each(decisions)('%s: 409 while the provider is still deciding', async (_name, decide) => {
      const { service, submissions } = await setup();
      await submissions.create(aSubmission({ status: 'PENDING', decidedAt: null }));
      await expect(decide(service, 's1')).rejects.toThrow(/still with the verification provider/);
    });

    it.each(decisions)("%s: 409 for anything but the user's latest submission", async (_name, decide) => {
      const { service, submissions, users } = await setup();
      await submissions.create(aSubmission({ id: 'old', status: 'TIMED_OUT' }));
      await submissions.create(aSubmission({ id: 'new', status: 'TIMED_OUT' }));
      await expect(decide(service, 'old')).rejects.toThrow(/latest KYC submission/);
      expect((await users.findById('u1'))!.kycStatus).toBe('REJECTED'); // untouched
    });

    it.each(decisions)('%s: 403 on the admin’s own submission', async (_name, decide) => {
      const { service, submissions } = await setup();
      await submissions.create(aSubmission({ userId: 'admin', status: 'TIMED_OUT' }));
      await expect(decide(service, 's1')).rejects.toThrow(new ForbiddenError('Admins cannot review their own KYC submission'));
    });
  });
});

describe('promoteToAdmin', () => {
  it('promotes by normalised email and is idempotent', async () => {
    const users = new InMemoryUsers();
    await users.create(aUser({ id: 'u1', email: 'asha@example.com' }));
    const spy = jest.spyOn(users, 'updateRole');

    expect(await promoteToAdmin(users, '  Asha@Example.com ')).toMatchObject({ id: 'u1', role: 'ADMIN' });
    expect((await users.findById('u1'))!.role).toBe('ADMIN');
    await promoteToAdmin(users, 'asha@example.com');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('404 for an unknown email', async () => {
    await expect(promoteToAdmin(new InMemoryUsers(), 'nobody@example.com')).rejects.toThrow(NotFoundError);
  });
});
