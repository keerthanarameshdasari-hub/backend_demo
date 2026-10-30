import { withDeadline } from './deadline';
import { ConflictError, KycRequiredError, NotFoundError, ValidationError } from './errors';
import type { TopUp, Wallet } from './model';
import type { Clock, IdGenerator, PaymentGateway, UserRepository, WalletRepository } from './ports';

export interface WalletPolicy {
  currency: string;
  minTopUpMinor: number;
  maxTopUpMinor: number;
  providerTimeoutMs: number;
}

export interface TopUpInput {
  userId: string;
  amountMinor: number;
  paymentToken: string;
  idempotencyKey?: string;
}

export interface TopUpOutcome {
  topUp: TopUp;
  wallet: Wallet;
  /** True when an earlier request with the same idempotency key was returned. */
  replayed: boolean;
}

export class WalletService {
  constructor(
    private readonly users: UserRepository,
    private readonly wallets: WalletRepository,
    private readonly payments: PaymentGateway,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly policy: WalletPolicy,
  ) {}

  async getWallet(userId: string): Promise<Wallet> {
    return this.wallets.getOrCreate(userId, this.policy.currency, this.clock.now());
  }

  async listTopUps(userId: string, limit = 20): Promise<TopUp[]> {
    return this.wallets.listTopUps(userId, Math.min(Math.max(limit, 1), 100));
  }

  async topUp(input: TopUpInput): Promise<TopUpOutcome> {
    const { amountMinor } = input;
    if (
      !Number.isSafeInteger(amountMinor) ||
      amountMinor < this.policy.minTopUpMinor ||
      amountMinor > this.policy.maxTopUpMinor
    ) {
      throw new ValidationError(
        `amountMinor must be a whole number between ${this.policy.minTopUpMinor} and ${this.policy.maxTopUpMinor}`,
      );
    }
    if (input.paymentToken.trim().length === 0) throw new ValidationError('paymentToken is required');

    const user = await this.users.findById(input.userId);
    if (!user) throw new NotFoundError('User not found');
    if (user.kycStatus !== 'APPROVED') throw new KycRequiredError();

    if (input.idempotencyKey) {
      const previous = await this.wallets.findTopUpByIdempotencyKey(user.id, input.idempotencyKey);
      if (previous) {
        if (previous.amountMinor !== amountMinor) {
          throw new ConflictError('Idempotency-Key was already used with a different amount');
        }
        return { topUp: previous, wallet: await this.getWallet(user.id), replayed: true };
      }
    }

    await this.wallets.getOrCreate(user.id, this.policy.currency, this.clock.now());
    const pending = await this.wallets.createTopUp({
      id: this.ids.next(),
      userId: user.id,
      amountMinor,
      currency: this.policy.currency,
      status: 'PENDING',
      idempotencyKey: input.idempotencyKey ?? null,
      providerReference: null,
      failureReason: null,
      createdAt: this.clock.now(),
      completedAt: null,
    });

    const result = await withDeadline(this.policy.providerTimeoutMs, (signal) =>
      this.payments.charge(
        { reference: pending.id, amountMinor, currency: this.policy.currency, paymentToken: input.paymentToken },
        signal,
      ),
    );

    const now = this.clock.now();
    switch (result.outcome) {
      case 'approved': {
        const { topUp, wallet } = await this.wallets.completeTopUp(pending.id, result.providerReference, now);
        return { topUp, wallet, replayed: false };
      }
      case 'rejected': {
        const topUp = await this.wallets.failTopUp(pending.id, 'FAILED', result.reason, now);
        return { topUp, wallet: await this.getWallet(user.id), replayed: false };
      }
      case 'timeout': {
        // Outcome unknown: never credit. A reconciliation job would settle it later.
        const topUp = await this.wallets.failTopUp(pending.id, 'TIMED_OUT', 'Payment provider did not respond in time', now);
        return { topUp, wallet: await this.getWallet(user.id), replayed: false };
      }
    }
  }
}
