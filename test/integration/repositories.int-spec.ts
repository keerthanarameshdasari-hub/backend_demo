/**
 * The Prisma adapters behind each persistence port, against the migrated
 * database. Every test starts from empty tables.
 */
import { PrismaKycSubmissionRepository } from '../../src/adapters/prisma/prisma-kyc.repository';
import { PrismaUserRepository } from '../../src/adapters/prisma/prisma-user.repository';
import { PrismaWalletRepository } from '../../src/adapters/prisma/prisma-wallet.repository';
import type { PrismaDatabase } from '../../src/adapters/prisma/prisma.service';
import { ConflictError, type KycSubmission, type TopUp, type User } from '../../src/domain';
import { connect, truncateAll } from './database';

const T0 = new Date('2026-05-01T08:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String((n += 1)).padStart(12, '0')}`;

let db: PrismaDatabase;
let users: PrismaUserRepository;
let kyc: PrismaKycSubmissionRepository;
let wallets: PrismaWalletRepository;

beforeAll(() => {
  db = connect();
  users = new PrismaUserRepository(db);
  kyc = new PrismaKycSubmissionRepository(db);
  wallets = new PrismaWalletRepository(db);
});
beforeEach(async () => truncateAll(db));
afterAll(async () => {
  await truncateAll(db);
  await db.disconnect();
});

const aUser = (overrides: Partial<User> = {}): User => ({
  id: uuid(),
  email: `user${n}@example.com`,
  fullName: 'Int Test',
  passwordHash: 'scrypt$x',
  kycStatus: 'NOT_STARTED',
  createdAt: T0,
  ...overrides,
});

const aSubmission = (userId: string, overrides: Partial<KycSubmission> = {}): KycSubmission => ({
  id: uuid(),
  userId,
  documentType: 'PASSPORT',
  documentNumberLast4: '4567',
  documentKey: `kyc/${userId}/doc.png`,
  documentMimeType: 'image/png',
  documentSizeBytes: 12,
  status: 'PENDING',
  providerReference: null,
  decisionReason: null,
  createdAt: T0,
  decidedAt: null,
  ...overrides,
});

const aTopUp = (userId: string, overrides: Partial<TopUp> = {}): TopUp => ({
  id: uuid(),
  userId,
  amountMinor: 1_500,
  currency: 'INR',
  status: 'PENDING',
  idempotencyKey: null,
  providerReference: null,
  failureReason: null,
  createdAt: T0,
  completedAt: null,
  ...overrides,
});

describe('database readiness', () => {
  it('passes against a reachable database', async () => {
    await expect(db.check()).resolves.toBeUndefined();
  });
});

describe('PrismaUserRepository', () => {
  it('round-trips a user exactly', async () => {
    const user = aUser({ kycStatus: 'REJECTED' });
    await expect(users.create(user)).resolves.toEqual(user);
    await expect(users.findById(user.id)).resolves.toEqual(user);
    await expect(users.findByEmail(user.email)).resolves.toEqual(user);
  });

  it('returns null for unknown ids and emails', async () => {
    await expect(users.findById(uuid())).resolves.toBeNull();
    await expect(users.findByEmail('nobody@example.com')).resolves.toBeNull();
  });

  it('turns the unique email index into a ConflictError', async () => {
    await users.create(aUser({ email: 'dup@example.com' }));
    await expect(users.create(aUser({ email: 'dup@example.com' }))).rejects.toBeInstanceOf(ConflictError);
  });

  it('settles two concurrent sign-ups with the same email: one wins, one conflicts', async () => {
    const results = await Promise.allSettled([
      users.create(aUser({ email: 'race@example.com' })),
      users.create(aUser({ email: 'race@example.com' })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(failed?.reason).toBeInstanceOf(ConflictError);
  });

  it('updates the KYC status', async () => {
    const user = await users.create(aUser());
    await users.updateKycStatus(user.id, 'APPROVED');
    expect((await users.findById(user.id))?.kycStatus).toBe('APPROVED');
  });
});

describe('PrismaKycSubmissionRepository', () => {
  it('round-trips and updates a submission', async () => {
    const user = await users.create(aUser());
    const submission = aSubmission(user.id);
    await expect(kyc.create(submission)).resolves.toEqual(submission);

    const decided = await kyc.update(submission.id, {
      status: 'REJECTED',
      providerReference: 'kyc_ref',
      decisionReason: 'document_expired',
      decidedAt: at(2),
    });
    expect(decided).toEqual({
      ...submission,
      status: 'REJECTED',
      providerReference: 'kyc_ref',
      decisionReason: 'document_expired',
      decidedAt: at(2),
    });
  });

  it('finds the latest submission per user, by creation time', async () => {
    const a = await users.create(aUser());
    const b = await users.create(aUser());
    await kyc.create(aSubmission(a.id, { createdAt: at(1), documentNumberLast4: '0001' }));
    await kyc.create(aSubmission(a.id, { createdAt: at(3), documentNumberLast4: '0003' }));
    await kyc.create(aSubmission(a.id, { createdAt: at(2), documentNumberLast4: '0002' }));
    await kyc.create(aSubmission(b.id, { createdAt: at(9), documentNumberLast4: '0009' }));

    expect((await kyc.findLatestByUser(a.id))?.documentNumberLast4).toBe('0003');
    await expect(kyc.findLatestByUser(uuid())).resolves.toBeNull();
  });

  it('refuses a submission for a user that does not exist (foreign key)', async () => {
    await expect(kyc.create(aSubmission(uuid()))).rejects.toThrow();
  });

  it('stores at most 4 characters of the document number', async () => {
    const user = await users.create(aUser());
    await expect(kyc.create(aSubmission(user.id, { documentNumberLast4: '12345' }))).rejects.toThrow();
  });
});

describe('PrismaWalletRepository', () => {
  let userId: string;
  beforeEach(async () => {
    userId = (await users.create(aUser())).id;
  });

  it('creates a wallet once and then returns it unchanged', async () => {
    const first = await wallets.getOrCreate(userId, 'INR', at(0));
    const again = await wallets.getOrCreate(userId, 'USD', at(5));
    expect(first).toEqual({ userId, currency: 'INR', balanceMinor: 0, updatedAt: at(0) });
    expect(again).toEqual(first);
  });

  it('round-trips a top-up and finds it by idempotency key, per user', async () => {
    const other = (await users.create(aUser())).id;
    const topUp = aTopUp(userId, { idempotencyKey: 'key-00001' });
    await expect(wallets.createTopUp(topUp)).resolves.toEqual(topUp);
    await expect(wallets.findTopUpByIdempotencyKey(userId, 'key-00001')).resolves.toEqual(topUp);
    await expect(wallets.findTopUpByIdempotencyKey(other, 'key-00001')).resolves.toBeNull();
  });

  it('enforces one top-up per (user, idempotency key) but allows many without a key', async () => {
    await wallets.createTopUp(aTopUp(userId, { idempotencyKey: 'key-00002' }));
    await expect(wallets.createTopUp(aTopUp(userId, { idempotencyKey: 'key-00002' }))).rejects.toThrow();
    await wallets.createTopUp(aTopUp(userId));
    await wallets.createTopUp(aTopUp(userId));
    expect(await wallets.listTopUps(userId, 10)).toHaveLength(3);
  });

  it('lists newest first and honours the limit', async () => {
    for (const s of [1, 3, 2]) await wallets.createTopUp(aTopUp(userId, { amountMinor: s * 100, createdAt: at(s) }));
    expect((await wallets.listTopUps(userId, 10)).map((t) => t.amountMinor)).toEqual([300, 200, 100]);
    expect(await wallets.listTopUps(userId, 2)).toHaveLength(2);
  });

  it('completes a top-up and credits the wallet in one step', async () => {
    await wallets.getOrCreate(userId, 'INR', at(0));
    const topUp = await wallets.createTopUp(aTopUp(userId, { amountMinor: 1_500 }));
    const { topUp: done, wallet } = await wallets.completeTopUp(topUp.id, 'pay_1', at(4));
    expect(done).toMatchObject({ status: 'SUCCEEDED', providerReference: 'pay_1', completedAt: at(4) });
    expect(wallet).toEqual({ userId, currency: 'INR', balanceMinor: 1_500, updatedAt: at(4) });
  });

  it('credits exactly once, even when completion is called twice at the same time', async () => {
    await wallets.getOrCreate(userId, 'INR', at(0));
    const topUp = await wallets.createTopUp(aTopUp(userId, { amountMinor: 1_500 }));
    await Promise.all([
      wallets.completeTopUp(topUp.id, 'p1', at(1)),
      wallets.completeTopUp(topUp.id, 'p1', at(1)),
      wallets.completeTopUp(topUp.id, 'p1', at(1)),
    ]);
    expect((await wallets.getOrCreate(userId, 'INR', at(2))).balanceMinor).toBe(1_500);
  });

  it('never credits a top-up that already failed or timed out', async () => {
    await wallets.getOrCreate(userId, 'INR', at(0));
    const topUp = await wallets.createTopUp(aTopUp(userId));
    await wallets.failTopUp(topUp.id, 'TIMED_OUT', 'no answer', at(1));
    const { topUp: after, wallet } = await wallets.completeTopUp(topUp.id, 'late', at(2));
    expect(after).toMatchObject({ status: 'TIMED_OUT', failureReason: 'no answer', providerReference: null });
    expect(wallet.balanceMinor).toBe(0);
  });

  it('does not fail a top-up that already succeeded', async () => {
    await wallets.getOrCreate(userId, 'INR', at(0));
    const topUp = await wallets.createTopUp(aTopUp(userId));
    await wallets.completeTopUp(topUp.id, 'p1', at(1));
    await expect(wallets.failTopUp(topUp.id, 'FAILED', 'late decline', at(2))).resolves.toMatchObject({
      status: 'SUCCEEDED',
      failureReason: null,
    });
  });

  it('keeps balances beyond 32-bit integers (BIGINT column)', async () => {
    await wallets.getOrCreate(userId, 'INR', at(0));
    for (let i = 0; i < 3; i += 1) {
      const t = await wallets.createTopUp(aTopUp(userId, { amountMinor: 1_000_000_000 }));
      await wallets.completeTopUp(t.id, `p${i}`, at(i));
    }
    expect((await wallets.getOrCreate(userId, 'INR', at(9))).balanceMinor).toBe(3_000_000_000);
  });

  it('deletes a user’s wallet and top-ups with the user (cascade)', async () => {
    await wallets.getOrCreate(userId, 'INR', at(0));
    await wallets.createTopUp(aTopUp(userId));
    await db.client.user.delete({ where: { id: userId } });
    await expect(wallets.listTopUps(userId, 10)).resolves.toEqual([]);
  });
});
