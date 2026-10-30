import { MockPaymentGateway } from '../../src/adapters/mock/mock-payment.gateway';
import { ConflictError, KycRequiredError, ValidationError, WalletService } from '../../src/domain';
import { FixedClock, InMemoryUsers, InMemoryWallets, SequentialIds } from '../fakes';

const POLICY = { currency: 'INR', minTopUpMinor: 100, maxTopUpMinor: 1_000_000, providerTimeoutMs: 30 };

async function setup(kycStatus: 'APPROVED' | 'NOT_STARTED' = 'APPROVED') {
  const users = new InMemoryUsers();
  const wallets = new InMemoryWallets();
  const clock = new FixedClock();
  const service = new WalletService(users, wallets, new MockPaymentGateway(), new SequentialIds(), clock, POLICY);
  await users.create({
    id: 'u1',
    email: 'a@example.com',
    fullName: 'A',
    passwordHash: 'x',
    kycStatus,
    createdAt: clock.now(),
  });
  return { service, wallets };
}

describe('WalletService.topUp', () => {
  it('credits the wallet when the payment is approved', async () => {
    const { service } = await setup();
    const result = await service.topUp({ userId: 'u1', amountMinor: 5000, paymentToken: 'tok_visa' });
    expect(result.topUp.status).toBe('SUCCEEDED');
    expect(result.topUp.providerReference).toMatch(/^mockpay_/);
    expect(result.wallet.balanceMinor).toBe(5000);
  });

  it('records a FAILED top-up and leaves the balance alone when the payment is rejected', async () => {
    const { service } = await setup();
    const result = await service.topUp({ userId: 'u1', amountMinor: 5000, paymentToken: 'tok_reject_insufficient' });
    expect(result.topUp.status).toBe('FAILED');
    expect(result.topUp.failureReason).toBe('card_declined');
    expect(result.wallet.balanceMinor).toBe(0);
  });

  it('records TIMED_OUT, never credits, when the provider does not answer before the deadline', async () => {
    const { service } = await setup();
    const started = Date.now();
    const result = await service.topUp({ userId: 'u1', amountMinor: 5000, paymentToken: 'tok_timeout' });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.topUp.status).toBe('TIMED_OUT');
    expect(result.wallet.balanceMinor).toBe(0);
  });

  it('refuses to top up before KYC is approved', async () => {
    const { service, wallets } = await setup('NOT_STARTED');
    await expect(service.topUp({ userId: 'u1', amountMinor: 5000, paymentToken: 'tok_visa' })).rejects.toBeInstanceOf(
      KycRequiredError,
    );
    expect(wallets.topUps).toHaveLength(0);
  });

  it.each([0, 99, 1_000_001, 12.5, Number.NaN])('rejects amount %p', async (amountMinor) => {
    const { service } = await setup();
    await expect(service.topUp({ userId: 'u1', amountMinor, paymentToken: 'tok_visa' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('replays an idempotent request instead of charging twice', async () => {
    const { service, wallets } = await setup();
    const first = await service.topUp({ userId: 'u1', amountMinor: 700, paymentToken: 'tok_visa', idempotencyKey: 'key-00001' });
    const second = await service.topUp({ userId: 'u1', amountMinor: 700, paymentToken: 'tok_visa', idempotencyKey: 'key-00001' });
    expect(second.replayed).toBe(true);
    expect(second.topUp.id).toBe(first.topUp.id);
    expect(second.wallet.balanceMinor).toBe(700);
    expect(wallets.topUps).toHaveLength(1);
  });

  it('rejects an idempotency key reused with a different amount', async () => {
    const { service } = await setup();
    await service.topUp({ userId: 'u1', amountMinor: 700, paymentToken: 'tok_visa', idempotencyKey: 'key-00002' });
    await expect(
      service.topUp({ userId: 'u1', amountMinor: 800, paymentToken: 'tok_visa', idempotencyKey: 'key-00002' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
