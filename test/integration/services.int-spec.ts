/**
 * The domain services wired to the real Prisma adapters, with scripted
 * provider fakes. Checks that what the domain decides is what lands in
 * Postgres, including the KYC-reject and payment-timeout paths.
 */
import { PrismaKycSubmissionRepository } from '../../src/adapters/prisma/prisma-kyc.repository';
import { PrismaUserRepository } from '../../src/adapters/prisma/prisma-user.repository';
import { PrismaWalletRepository } from '../../src/adapters/prisma/prisma-wallet.repository';
import type { PrismaDatabase } from '../../src/adapters/prisma/prisma.service';
import { UuidGenerator } from '../../src/adapters/system/system';
import { KycRequiredError, KycService, UserService, WalletService } from '../../src/domain';
import { FakeKycProvider, FakePaymentGateway, FixedClock, InMemoryStorage, PlainHasher, PNG } from '../fakes';
import { connect, truncateAll } from './database';

const TIMEOUT_MS = 100;

let db: PrismaDatabase;
beforeAll(() => (db = connect()));
beforeEach(async () => truncateAll(db));
afterAll(async () => {
  await truncateAll(db);
  await db.disconnect();
});

async function setup() {
  const usersRepo = new PrismaUserRepository(db);
  const kycRepo = new PrismaKycSubmissionRepository(db);
  const walletRepo = new PrismaWalletRepository(db);
  const ids = new UuidGenerator();
  const clock = new FixedClock(new Date('2026-06-01T12:00:00.000Z'));
  const kycProvider = new FakeKycProvider();
  const payments = new FakePaymentGateway();
  const userService = new UserService(usersRepo, new PlainHasher(), ids, clock);
  const kyc = new KycService(usersRepo, kycRepo, new InMemoryStorage(), kycProvider, ids, clock, {
    maxDocumentBytes: 1024,
    allowedMimeTypes: ['image/png'],
    providerTimeoutMs: TIMEOUT_MS,
  });
  const wallet = new WalletService(usersRepo, walletRepo, payments, ids, clock, {
    currency: 'INR',
    minTopUpMinor: 100,
    maxTopUpMinor: 1_000_000,
    providerTimeoutMs: TIMEOUT_MS,
  });
  const user = await userService.register({ email: 'flow@example.com', password: 'long-enough-pw', fullName: 'Flow' });
  const submit = (documentNumber = 'P1234567') =>
    kyc.submit({ userId: user.id, documentType: 'PASSPORT', documentNumber, document: { bytes: PNG, mimeType: 'image/png' } });
  return { db, user, kyc, wallet, kycProvider, payments, submit, clock };
}

describe('KYC, persisted', () => {
  it('a provider rejection is stored on the submission and the user, and blocks top-ups', async () => {
    const { user, submit, kycProvider, wallet } = await setup();
    kycProvider.willRespond({ outcome: 'rejected', providerReference: 'kyc_rej', reason: 'document_expired' });

    const result = await submit();

    const row = await db.client.kycSubmission.findUniqueOrThrow({ where: { id: result.id } });
    expect(row).toMatchObject({
      status: 'REJECTED',
      decisionReason: 'document_expired',
      providerReference: 'kyc_rej',
      documentNumberLast4: '4567',
    });
    expect(row.decidedAt).not.toBeNull();
    expect((await db.client.user.findUniqueOrThrow({ where: { id: user.id } })).kycStatus).toBe('REJECTED');
    await expect(wallet.topUp({ userId: user.id, amountMinor: 500, paymentToken: 'tok' })).rejects.toBeInstanceOf(
      KycRequiredError,
    );
  });

  it('a rejected user can resubmit; both submissions are kept and the latest wins', async () => {
    const { user, submit, kycProvider, kyc, clock } = await setup();
    kycProvider.willRespond({ outcome: 'rejected', providerReference: 'r1', reason: 'blurry' });
    await submit('P0000001');
    clock.advance(1_000);
    const second = await submit('P0000002');

    expect(await db.client.kycSubmission.count({ where: { userId: user.id } })).toBe(2);
    await expect(kyc.latest(user.id)).resolves.toMatchObject({ id: second.id, status: 'APPROVED' });
    expect((await db.client.user.findUniqueOrThrow({ where: { id: user.id } })).kycStatus).toBe('APPROVED');
  });

  it('a provider that never answers is stored as TIMED_OUT', async () => {
    const { user, submit, kycProvider } = await setup();
    kycProvider.willRespond('hang');
    const result = await submit();
    expect(result.status).toBe('TIMED_OUT');
    expect((await db.client.user.findUniqueOrThrow({ where: { id: user.id } })).kycStatus).toBe('TIMED_OUT');
  });
});

describe('top-ups, persisted', () => {
  async function approved() {
    const ctx = await setup();
    await ctx.submit();
    return ctx;
  }

  it('a payment timeout is stored as TIMED_OUT and never credits the wallet', async () => {
    const { user, wallet, payments } = await approved();
    payments.willRespond('hang');

    const started = Date.now();
    const result = await wallet.topUp({ userId: user.id, amountMinor: 5_000, paymentToken: 'tok' });
    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS * 20);

    const row = await db.client.topUp.findUniqueOrThrow({ where: { id: result.topUp.id } });
    expect(row).toMatchObject({
      status: 'TIMED_OUT',
      failureReason: 'Payment provider did not respond in time',
      providerReference: null,
    });
    expect(row.completedAt).not.toBeNull();
    expect((await db.client.wallet.findUniqueOrThrow({ where: { userId: user.id } })).balanceMinor).toBe(0n);
    expect(payments.lastCall?.signal.aborted).toBe(true);
  });

  it('approved, declined and timed-out top-ups add up to the right balance', async () => {
    const { user, wallet, payments, clock } = await approved();
    payments.willRespond(
      { outcome: 'approved', providerReference: 'p1' },
      { outcome: 'rejected', reason: 'card_declined' },
      'hang',
      { outcome: 'approved', providerReference: 'p2' },
    );
    for (const amountMinor of [1_000, 2_000, 4_000, 8_000]) {
      await wallet.topUp({ userId: user.id, amountMinor, paymentToken: 'tok' });
      clock.advance(1_000); // distinct created_at, so "newest first" is well defined
    }
    expect((await wallet.getWallet(user.id)).balanceMinor).toBe(9_000);
    expect((await wallet.listTopUps(user.id)).map((t) => t.status)).toEqual(['SUCCEEDED', 'TIMED_OUT', 'FAILED', 'SUCCEEDED']);
  });

  it('a retried request with the same Idempotency-Key is charged once', async () => {
    const { user, wallet, payments } = await approved();
    const request = { userId: user.id, amountMinor: 700, paymentToken: 'tok', idempotencyKey: 'order-0001' };
    const first = await wallet.topUp(request);
    const replay = await wallet.topUp(request);
    expect(replay).toMatchObject({ replayed: true, topUp: { id: first.topUp.id } });
    expect(payments.calls).toHaveLength(1);
    expect(await db.client.topUp.count({ where: { userId: user.id } })).toBe(1);
    expect((await wallet.getWallet(user.id)).balanceMinor).toBe(700);
  });
});
