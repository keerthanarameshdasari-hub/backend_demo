/**
 * WalletService against in-memory fakes of every port. Fake timers drive the
 * payment deadline, so the timeout path is exact and takes no real time.
 */
import {
  ConflictError,
  KycRequiredError,
  NotFoundError,
  ValidationError,
  WalletService,
  type KycStatus,
} from '../../../src/domain';
import { aUser, FakePaymentGateway, FixedClock, InMemoryUsers, InMemoryWallets, SequentialIds } from '../../fakes';
import { expectRule, track, untilDeadlineStarts } from '../../support/rules';

const TIMEOUT_MS = 8_000;
const POLICY = { currency: 'INR', minTopUpMinor: 100, maxTopUpMinor: 1_000_000, providerTimeoutMs: TIMEOUT_MS };

async function setup(kycStatus: KycStatus = 'APPROVED') {
  const users = new InMemoryUsers();
  const wallets = new InMemoryWallets();
  const payments = new FakePaymentGateway();
  const clock = new FixedClock(new Date('2026-04-01T09:00:00.000Z'));
  const service = new WalletService(users, wallets, payments, new SequentialIds(), clock, POLICY);
  await users.create(aUser({ id: 'u1', kycStatus }));
  const balance = async (userId = 'u1') => (await service.getWallet(userId)).balanceMinor;
  return { service, users, wallets, payments, clock, balance };
}

const topUp = (overrides: Partial<{ userId: string; amountMinor: number; paymentToken: string; idempotencyKey: string }> = {}) => ({
  userId: 'u1',
  amountMinor: 5_000,
  paymentToken: 'tok_card',
  ...overrides,
});

afterEach(() => jest.useRealTimers());

describe('WalletService.topUp — payment approved', () => {
  it('records SUCCEEDED and credits the wallet', async () => {
    const { service, payments, balance } = await setup();
    payments.willRespond({ outcome: 'approved', providerReference: 'pay_123' });

    const result = await service.topUp(topUp({ amountMinor: 5_000 }));

    expect(result.replayed).toBe(false);
    expect(result.topUp).toMatchObject({
      status: 'SUCCEEDED',
      amountMinor: 5_000,
      currency: 'INR',
      providerReference: 'pay_123',
      failureReason: null,
    });
    expect(result.topUp.completedAt).toBeInstanceOf(Date);
    expect(result.wallet).toMatchObject({ currency: 'INR', balanceMinor: 5_000 });
    expect(await balance()).toBe(5_000);
  });

  it('charges the provider for exactly what was asked, referencing the top-up', async () => {
    const { service, payments } = await setup();
    const result = await service.topUp(topUp({ amountMinor: 1_234, paymentToken: 'tok_abc' }));
    expect(payments.calls).toHaveLength(1);
    expect(payments.lastCall?.request).toEqual({
      reference: result.topUp.id,
      amountMinor: 1_234,
      currency: 'INR',
      paymentToken: 'tok_abc',
    });
  });

  it('adds successive top-ups together', async () => {
    const { service, balance } = await setup();
    await service.topUp(topUp({ amountMinor: 700 }));
    await service.topUp(topUp({ amountMinor: 300 }));
    expect(await balance()).toBe(1_000);
  });
});

describe('WalletService.topUp — payment rejected', () => {
  it('records FAILED with the provider reason and leaves the balance alone', async () => {
    const { service, payments, balance } = await setup();
    await service.topUp(topUp({ amountMinor: 1_000 }));
    payments.willRespond({ outcome: 'rejected', reason: 'card_declined' });

    const result = await service.topUp(topUp({ amountMinor: 5_000 }));
    const after = await balance();

    expectRule('a declined payment is recorded as FAILED and never credits the wallet', () => {
      expect(result.topUp.status).toBe('FAILED');
      expect(result.topUp.failureReason).toBe('card_declined');
      expect(result.topUp.providerReference).toBeNull();
      expect(result.wallet.balanceMinor).toBe(1_000);
      expect(after).toBe(1_000);
    });
  });
});

describe('WalletService.topUp — payment provider times out', () => {
  beforeEach(() => jest.useFakeTimers());

  it('waits until the deadline, then records TIMED_OUT, aborts the charge and never credits', async () => {
    const { service, payments, wallets, balance } = await setup();
    payments.willRespond('hang');

    const running = track(service.topUp(topUp({ amountMinor: 5_000 })));
    await untilDeadlineStarts();

    await jest.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expectRule('until the deadline the top-up stays PENDING and nothing is credited', () => {
      expect(running.settled).toBe(false);
      expect(wallets.topUps[0]?.status).toBe('PENDING');
      expect(wallets.wallets.get('u1')?.balanceMinor).toBe(0);
    });

    await jest.advanceTimersByTimeAsync(1);
    const result = await running.promise;

    expectRule('a payment with no answer by the deadline is TIMED_OUT and must never credit the wallet', () => {
      expect(result.topUp.status).toBe('TIMED_OUT');
      expect(result.topUp.failureReason).toBe('Payment provider did not respond in time');
      expect(result.topUp.providerReference).toBeNull();
      expect(result.wallet.balanceMinor).toBe(0);
      expect(payments.lastCall?.signal.aborted).toBe(true);
    });
    expect(await balance()).toBe(0);
  });

  it('ignores an approval that arrives after the deadline', async () => {
    const { service, payments, balance } = await setup();
    payments.willRespond({ after: TIMEOUT_MS + 500, result: { outcome: 'approved', providerReference: 'late' } });

    const running = service.topUp(topUp());
    await untilDeadlineStarts();
    await jest.advanceTimersByTimeAsync(TIMEOUT_MS * 2);
    const result = await running;
    const after = await balance();

    expectRule('a late approval (after TIMED_OUT) must not credit the wallet', () => {
      expect(result.topUp.status).toBe('TIMED_OUT');
      expect(after).toBe(0);
    });
  });

  it('treats a provider that reports a timeout itself the same way', async () => {
    jest.useRealTimers();
    const { service, payments, balance } = await setup();
    payments.willRespond({ outcome: 'timeout' });
    const result = await service.topUp(topUp());
    expect(result.topUp.status).toBe('TIMED_OUT');
    expect(await balance()).toBe(0);
  });

  it('does not charge again when a timed-out request is retried with the same Idempotency-Key', async () => {
    const { service, payments, balance } = await setup();
    payments.willRespond('hang');

    const first = service.topUp(topUp({ idempotencyKey: 'order-0001' }));
    await untilDeadlineStarts();
    await jest.advanceTimersByTimeAsync(TIMEOUT_MS);
    const timedOut = await first;

    const retry = await service.topUp(topUp({ idempotencyKey: 'order-0001' }));
    expectRule('an unknown payment outcome is never re-charged on retry; reconciliation settles it', () => {
      expect(retry.replayed).toBe(true);
      expect(retry.topUp).toMatchObject({ id: timedOut.topUp.id, status: 'TIMED_OUT' });
      expect(payments.calls).toHaveLength(1);
    });
    expect(await balance()).toBe(0);
  });
});

describe('WalletService.topUp — KYC gate', () => {
  it.each<KycStatus>(['NOT_STARTED', 'PENDING', 'REJECTED', 'TIMED_OUT'])(
    'refuses a user whose KYC is %s, before any charge',
    async (status) => {
      const { service, wallets, payments } = await setup(status);
      await expect(service.topUp(topUp())).toBeRefusedWith(KycRequiredError, 'only KYC-APPROVED users can top up');
      expect(wallets.topUps).toHaveLength(0);
      expect(payments.calls).toHaveLength(0);
    },
  );

  it('refuses an unknown user', async () => {
    const { service, payments } = await setup();
    await expect(service.topUp(topUp({ userId: 'ghost' }))).toBeRefusedWith(NotFoundError, 'only existing users can top up');
    expect(payments.calls).toHaveLength(0);
  });
});

describe('WalletService.topUp — amount and token validation', () => {
  it.each([
    ['zero', 0],
    ['negative', -500],
    ['one below the minimum', POLICY.minTopUpMinor - 1],
    ['one above the maximum', POLICY.maxTopUpMinor + 1],
    ['fractional', 150.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['beyond safe integers', Number.MAX_SAFE_INTEGER + 2],
  ])('rejects a %s amount without charging', async (_label, amountMinor) => {
    const { service, payments, wallets } = await setup();
    await expect(service.topUp(topUp({ amountMinor }))).toBeRefusedWith(
      ValidationError,
      `top-up amounts must be whole numbers between ${POLICY.minTopUpMinor} and ${POLICY.maxTopUpMinor} (${_label})`,
    );
    expect(payments.calls).toHaveLength(0);
    expect(wallets.topUps).toHaveLength(0);
  });

  it.each([
    ['the minimum', POLICY.minTopUpMinor],
    ['the maximum', POLICY.maxTopUpMinor],
  ])('accepts exactly %s', async (_label, amountMinor) => {
    const { service } = await setup();
    await expect(service.topUp(topUp({ amountMinor }))).resolves.toMatchObject({ topUp: { status: 'SUCCEEDED' } });
  });

  it.each(['', '   '])('rejects a blank payment token %p', async (paymentToken) => {
    const { service, payments } = await setup();
    await expect(service.topUp(topUp({ paymentToken }))).toBeRefusedWith(ValidationError, 'a payment token is required');
    expect(payments.calls).toHaveLength(0);
  });
});

describe('WalletService.topUp — idempotency', () => {
  it('replays the original result instead of charging twice', async () => {
    const { service, payments, wallets, balance } = await setup();
    const first = await service.topUp(topUp({ amountMinor: 700, idempotencyKey: 'key-00001' }));
    const second = await service.topUp(topUp({ amountMinor: 700, idempotencyKey: 'key-00001' }));

    expectRule('the same Idempotency-Key never charges or credits twice', () => {
      expect(second.replayed).toBe(true);
      expect(second.topUp.id).toBe(first.topUp.id);
      expect(payments.calls).toHaveLength(1);
      expect(wallets.topUps).toHaveLength(1);
    });
    expect(await balance()).toBe(700);
  });

  it('replays with the current wallet balance', async () => {
    const { service } = await setup();
    await service.topUp(topUp({ amountMinor: 700, idempotencyKey: 'key-00001' }));
    await service.topUp(topUp({ amountMinor: 300 }));
    const replay = await service.topUp(topUp({ amountMinor: 700, idempotencyKey: 'key-00001' }));
    expect(replay.wallet.balanceMinor).toBe(1_000);
  });

  it('replays a declined top-up as declined, without charging again', async () => {
    const { service, payments } = await setup();
    payments.willRespond({ outcome: 'rejected', reason: 'card_declined' });
    await service.topUp(topUp({ idempotencyKey: 'key-00003' }));
    const replay = await service.topUp(topUp({ idempotencyKey: 'key-00003' }));
    expect(replay).toMatchObject({ replayed: true, topUp: { status: 'FAILED' } });
    expect(payments.calls).toHaveLength(1);
  });

  it('refuses a reused key with a different amount', async () => {
    const { service, payments } = await setup();
    await service.topUp(topUp({ amountMinor: 700, idempotencyKey: 'key-00002' }));
    await expect(service.topUp(topUp({ amountMinor: 800, idempotencyKey: 'key-00002' }))).toBeRefusedWith(
      ConflictError,
      'an Idempotency-Key cannot be reused for a different amount',
    );
    expect(payments.calls).toHaveLength(1);
  });

  it('scopes keys to the user: two users may use the same key', async () => {
    const { service, users, payments, balance } = await setup();
    await users.create(aUser({ id: 'u2', email: 'b@example.com', kycStatus: 'APPROVED' }));
    await service.topUp(topUp({ userId: 'u1', amountMinor: 100, idempotencyKey: 'shared-key' }));
    const other = await service.topUp(topUp({ userId: 'u2', amountMinor: 200, idempotencyKey: 'shared-key' }));
    expect(other.replayed).toBe(false);
    expect(payments.calls).toHaveLength(2);
    expect(await balance('u2')).toBe(200);
  });

  it('charges every request that has no key', async () => {
    const { service, payments, balance } = await setup();
    await service.topUp(topUp({ amountMinor: 100 }));
    await service.topUp(topUp({ amountMinor: 100 }));
    expect(payments.calls).toHaveLength(2);
    expect(await balance()).toBe(200);
  });
});

describe('WalletService.topUp — failures outside the domain', () => {
  it('passes a payment provider outage (not a timeout) up to the caller, crediting nothing', async () => {
    const { service, payments, wallets } = await setup();
    payments.willRespond(new Error('gateway 502'));
    await expect(service.topUp(topUp())).rejects.toThrow('gateway 502');
    expect(wallets.wallets.get('u1')?.balanceMinor).toBe(0);
  });
});

describe('WalletService.getWallet and listTopUps', () => {
  it('creates an empty wallet in the configured currency on first read', async () => {
    const { service, clock } = await setup();
    await expect(service.getWallet('u1')).resolves.toEqual({
      userId: 'u1',
      currency: 'INR',
      balanceMinor: 0,
      updatedAt: clock.now(),
    });
  });

  it('lists newest first', async () => {
    const { service, payments } = await setup();
    payments.willRespond({ outcome: 'approved', providerReference: 'a' }, { outcome: 'rejected', reason: 'no' });
    await service.topUp(topUp({ amountMinor: 100 }));
    await service.topUp(topUp({ amountMinor: 200 }));
    const list = await service.listTopUps('u1');
    expect(list.map((t) => [t.amountMinor, t.status])).toEqual([
      [200, 'FAILED'],
      [100, 'SUCCEEDED'],
    ]);
  });

  it.each([
    [undefined, 20],
    [0, 1],
    [-5, 1],
    [50, 50],
    [500, 100],
  ])('clamps limit %p to %p', async (requested, expected) => {
    const { service, wallets } = await setup();
    const spy = jest.spyOn(wallets, 'listTopUps');
    await service.listTopUps('u1', requested);
    expect(spy).toHaveBeenCalledWith('u1', expected);
  });
});
