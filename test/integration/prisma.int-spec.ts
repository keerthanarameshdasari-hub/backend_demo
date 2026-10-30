/**
 * The Prisma adapters against a real, migrated Postgres. Skipped unless
 * TEST_DATABASE_URL is set; it wipes the tables it uses, so never point it
 * at data you care about.
 *
 *   docker compose up -d postgres migrate
 *   TEST_DATABASE_URL=postgresql://wallet:wallet@localhost:5432/wallet npm run test:integration
 */
import { PrismaKycSubmissionRepository } from '../../src/adapters/prisma/prisma-kyc.repository';
import { PrismaUserRepository } from '../../src/adapters/prisma/prisma-user.repository';
import { PrismaWalletRepository } from '../../src/adapters/prisma/prisma-wallet.repository';
import { PrismaDatabase } from '../../src/adapters/prisma/prisma.service';
import { MockPaymentGateway } from '../../src/adapters/mock/mock-payment.gateway';
import { ConflictError, WalletService } from '../../src/domain';
import { FixedClock, SequentialIds } from '../fakes';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('Prisma adapters (integration)', () => {
  let db: PrismaDatabase;
  let users: PrismaUserRepository;
  let wallets: PrismaWalletRepository;
  let kyc: PrismaKycSubmissionRepository;
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const uid = '11111111-1111-4111-8111-111111111111';

  beforeAll(async () => {
    db = new PrismaDatabase(url!);
    users = new PrismaUserRepository(db);
    wallets = new PrismaWalletRepository(db);
    kyc = new PrismaKycSubmissionRepository(db);
    await db.client.$executeRawUnsafe('TRUNCATE users CASCADE');
    await users.create({
      id: uid,
      email: 'int@example.com',
      fullName: 'Int Test',
      passwordHash: 'x',
      kycStatus: 'NOT_STARTED',
      createdAt: clock.now(),
    });
  });

  afterAll(async () => {
    await db.client.$executeRawUnsafe('TRUNCATE users CASCADE');
    await db.disconnect();
  });

  it('readiness check passes', async () => {
    await expect(db.check()).resolves.toBeUndefined();
  });

  it('enforces unique email as a ConflictError', async () => {
    await expect(
      users.create({
        id: '22222222-2222-4222-8222-222222222222',
        email: 'int@example.com',
        fullName: 'Dup',
        passwordHash: 'x',
        kycStatus: 'NOT_STARTED',
        createdAt: clock.now(),
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('stores and updates KYC submissions and status', async () => {
    const created = await kyc.create({
      id: ids.next(),
      userId: uid,
      documentType: 'PASSPORT',
      documentNumberLast4: '4567',
      documentKey: 'kyc/x.png',
      documentMimeType: 'image/png',
      documentSizeBytes: 12,
      status: 'PENDING',
      providerReference: null,
      decisionReason: null,
      createdAt: clock.now(),
      decidedAt: null,
    });
    await kyc.update(created.id, { status: 'APPROVED', providerReference: 'ref', decisionReason: null, decidedAt: clock.now() });
    await users.updateKycStatus(uid, 'APPROVED');
    expect((await kyc.findLatestByUser(uid))?.status).toBe('APPROVED');
    expect((await users.findById(uid))?.kycStatus).toBe('APPROVED');
  });

  it('credits exactly once, even if completion is called twice', async () => {
    await wallets.getOrCreate(uid, 'INR', clock.now());
    const topUp = await wallets.createTopUp({
      id: ids.next(),
      userId: uid,
      amountMinor: 1500,
      currency: 'INR',
      status: 'PENDING',
      idempotencyKey: null,
      providerReference: null,
      failureReason: null,
      createdAt: clock.now(),
      completedAt: null,
    });
    const first = await wallets.completeTopUp(topUp.id, 'p1', clock.now());
    const second = await wallets.completeTopUp(topUp.id, 'p1', clock.now());
    expect(first.wallet.balanceMinor).toBe(1500);
    expect(second.wallet.balanceMinor).toBe(1500);
    expect(second.topUp.status).toBe('SUCCEEDED');
  });

  it('runs the wallet service end to end, including idempotent replay', async () => {
    const service = new WalletService(users, wallets, new MockPaymentGateway(), ids, clock, {
      currency: 'INR',
      minTopUpMinor: 100,
      maxTopUpMinor: 1_000_000,
      providerTimeoutMs: 50,
    });
    const ok = await service.topUp({ userId: uid, amountMinor: 500, paymentToken: 'tok_visa', idempotencyKey: 'int-key-01' });
    const replay = await service.topUp({ userId: uid, amountMinor: 500, paymentToken: 'tok_visa', idempotencyKey: 'int-key-01' });
    const declined = await service.topUp({ userId: uid, amountMinor: 500, paymentToken: 'tok_reject' });
    const slow = await service.topUp({ userId: uid, amountMinor: 500, paymentToken: 'tok_timeout' });
    expect(ok.wallet.balanceMinor).toBe(2000);
    expect(replay).toMatchObject({ replayed: true, topUp: { id: ok.topUp.id } });
    expect(declined.topUp.status).toBe('FAILED');
    expect(slow.topUp.status).toBe('TIMED_OUT');
    expect((await service.getWallet(uid)).balanceMinor).toBe(2000);
    expect((await wallets.listTopUps(uid, 10)).map((t) => t.status)).toHaveLength(4);
  });
});
