/**
 * In-memory implementations of every domain port, for tests. Nothing here
 * imports from src/adapters, so domain unit tests exercise the domain alone.
 */
import type {
  Clock,
  FileStorage,
  IdGenerator,
  KycProvider,
  KycResult,
  KycStatus,
  KycSubmission,
  KycSubmissionRepository,
  KycVerificationRequest,
  Page,
  PageRequest,
  PasswordHasher,
  PaymentGateway,
  PaymentRequest,
  PaymentResult,
  ReadinessProbe,
  TopUp,
  TopUpStatus,
  User,
  UserRepository,
  UserRole,
  Wallet,
  WalletRepository,
} from '../src/domain';

export class FixedClock implements Clock {
  constructor(private current = new Date('2026-01-01T00:00:00.000Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class SequentialIds implements IdGenerator {
  private n = 0;
  next(): string {
    this.n += 1;
    return `00000000-0000-4000-8000-${String(this.n).padStart(12, '0')}`;
  }
}

/** Not a real hash: fast and readable in tests. */
export class PlainHasher implements PasswordHasher {
  async hash(plain: string): Promise<string> {
    return `hashed:${plain}`;
  }
  async verify(plain: string, hash: string): Promise<boolean> {
    return hash === `hashed:${plain}`;
  }
}

export class InMemoryUsers implements UserRepository {
  readonly rows = new Map<string, User>();
  async create(user: User): Promise<User> {
    this.rows.set(user.id, { ...user });
    return { ...user };
  }
  async findById(id: string): Promise<User | null> {
    const u = this.rows.get(id);
    return u ? { ...u } : null;
  }
  async findByEmail(email: string): Promise<User | null> {
    const u = [...this.rows.values()].find((r) => r.email === email);
    return u ? { ...u } : null;
  }
  async updateKycStatus(userId: string, status: KycStatus): Promise<void> {
    const u = this.rows.get(userId);
    if (!u) throw new Error('missing user');
    u.kycStatus = status;
  }
  async updateRole(userId: string, role: UserRole): Promise<void> {
    const u = this.rows.get(userId);
    if (!u) throw new Error('missing user');
    u.role = role;
  }
  async findByIds(ids: readonly string[]): Promise<User[]> {
    return ids.flatMap((id) => (this.rows.has(id) ? [{ ...this.rows.get(id)! }] : []));
  }
  async list({ kycStatus, limit, offset }: { kycStatus?: KycStatus } & PageRequest): Promise<Page<User>> {
    const matching = newestFirst([...this.rows.values()]).filter((u) => !kycStatus || u.kycStatus === kycStatus);
    return { items: matching.slice(offset, offset + limit).map((u) => ({ ...u })), total: matching.length };
  }
}

/** createdAt descending, then id descending: the order the Prisma adapters use. */
function newestFirst<T extends { id: string; createdAt: Date }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

export class InMemoryKyc implements KycSubmissionRepository {
  readonly rows: KycSubmission[] = [];
  async create(s: KycSubmission): Promise<KycSubmission> {
    this.rows.push({ ...s });
    return { ...s };
  }
  async update(id: string, patch: Partial<KycSubmission>): Promise<KycSubmission> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error('missing submission');
    Object.assign(row, patch);
    return { ...row };
  }
  async findLatestByUser(userId: string): Promise<KycSubmission | null> {
    const rows = this.rows.filter((r) => r.userId === userId);
    return rows.length ? { ...rows[rows.length - 1]! } : null;
  }
  async findById(id: string): Promise<KycSubmission | null> {
    const row = this.rows.find((r) => r.id === id);
    return row ? { ...row } : null;
  }
  /** Insertion order stands in for createdAt: last inserted is newest. */
  async list({ status, limit, offset }: { status?: KycStatus } & PageRequest): Promise<Page<KycSubmission>> {
    const matching = [...this.rows].reverse().filter((r) => !status || r.status === status);
    return { items: matching.slice(offset, offset + limit).map((r) => ({ ...r })), total: matching.length };
  }
}

export class InMemoryWallets implements WalletRepository {
  readonly wallets = new Map<string, Wallet>();
  readonly topUps: TopUp[] = [];

  async getOrCreate(userId: string, currency: string, now: Date): Promise<Wallet> {
    if (!this.wallets.has(userId)) this.wallets.set(userId, { userId, currency, balanceMinor: 0, updatedAt: now });
    return { ...this.wallets.get(userId)! };
  }
  async createTopUp(t: TopUp): Promise<TopUp> {
    if (t.idempotencyKey && this.topUps.some((x) => x.userId === t.userId && x.idempotencyKey === t.idempotencyKey)) {
      throw new Error('unique violation');
    }
    this.topUps.push({ ...t });
    return { ...t };
  }
  async findTopUpByIdempotencyKey(userId: string, key: string): Promise<TopUp | null> {
    const t = this.topUps.find((x) => x.userId === userId && x.idempotencyKey === key);
    return t ? { ...t } : null;
  }
  async listTopUps(userId: string, limit: number): Promise<TopUp[]> {
    return this.topUps
      .filter((t) => t.userId === userId)
      .reverse()
      .slice(0, limit)
      .map((t) => ({ ...t }));
  }
  /** Insertion order stands in for createdAt: last inserted is newest. */
  async listAllTopUps({
    userId,
    status,
    limit,
    offset,
  }: { userId?: string; status?: TopUpStatus } & PageRequest): Promise<Page<TopUp>> {
    const matching = [...this.topUps]
      .reverse()
      .filter((t) => (!userId || t.userId === userId) && (!status || t.status === status));
    return { items: matching.slice(offset, offset + limit).map((t) => ({ ...t })), total: matching.length };
  }
  async completeTopUp(id: string, providerReference: string, completedAt: Date) {
    const t = this.topUps.find((x) => x.id === id)!;
    const w = this.wallets.get(t.userId)!;
    if (t.status === 'PENDING') {
      Object.assign(t, { status: 'SUCCEEDED', providerReference, completedAt });
      w.balanceMinor += t.amountMinor;
      w.updatedAt = completedAt;
    }
    return { topUp: { ...t }, wallet: { ...w } };
  }
  async failTopUp(id: string, status: 'FAILED' | 'TIMED_OUT', reason: string, completedAt: Date): Promise<TopUp> {
    const t = this.topUps.find((x) => x.id === id)!;
    if (t.status === 'PENDING') Object.assign(t, { status, failureReason: reason, completedAt });
    return { ...t };
  }
}

export class InMemoryStorage implements FileStorage {
  readonly objects = new Map<string, { body: Uint8Array; contentType: string }>();
  failNext = false;
  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('storage unavailable');
    }
    this.objects.set(key, { body, contentType });
  }
}

// ---------------------------------------------------------------- external providers

/**
 * What a scripted provider does on one call:
 *   a result      -> answers with it straight away
 *   'hang'        -> never answers; rejects once the caller aborts (a dead provider)
 *   { after, result } -> answers after `after` ms of (possibly fake) time, ignoring abort
 *   an Error      -> fails with it (a provider outage, not a timeout)
 */
export type Step<R> = R | 'hang' | Error | { after: number; result: R };

/** Shared behaviour of the provider fakes: a queue of steps, a default, and a call log. */
abstract class ScriptedProvider<Req, Res> {
  readonly calls: { request: Req; signal: AbortSignal }[] = [];
  private readonly script: Step<Res>[] = [];

  protected constructor(private fallback: Step<Res>) {}

  /** Queue what the next calls do, in order. Once the queue is empty, the default applies. */
  willRespond(...steps: Step<Res>[]): this {
    this.script.push(...steps);
    return this;
  }

  /** What every call does once the queue is empty. */
  byDefault(step: Step<Res>): this {
    this.fallback = step;
    return this;
  }

  get lastCall(): { request: Req; signal: AbortSignal } | undefined {
    return this.calls[this.calls.length - 1];
  }

  protected play(request: Req, signal: AbortSignal): Promise<Res> {
    this.calls.push({ request, signal });
    const step = this.script.length > 0 ? this.script.shift()! : this.fallback;
    if (step === 'hang') return hangUntilAborted(signal);
    if (step instanceof Error) return Promise.reject(step);
    if (typeof step === 'object' && step !== null && 'after' in step) {
      return new Promise((resolve) => setTimeout(() => resolve(step.result), step.after));
    }
    return Promise.resolve(step);
  }
}

function hangUntilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new Error('aborted'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Approves every document unless told otherwise. */
export class FakeKycProvider extends ScriptedProvider<KycVerificationRequest, KycResult> implements KycProvider {
  constructor() {
    super({ outcome: 'approved', providerReference: 'kyc_ref_ok' });
  }
  verify(request: KycVerificationRequest, signal: AbortSignal): Promise<KycResult> {
    return this.play(request, signal);
  }
}

/** Approves every charge unless told otherwise. */
export class FakePaymentGateway extends ScriptedProvider<PaymentRequest, PaymentResult> implements PaymentGateway {
  constructor() {
    super({ outcome: 'approved', providerReference: 'pay_ref_ok' });
  }
  charge(request: PaymentRequest, signal: AbortSignal): Promise<PaymentResult> {
    return this.play(request, signal);
  }
}

// ---------------------------------------------------------------- ops

export class SwitchableProbe implements ReadinessProbe {
  readonly name = 'database';
  up = true;
  async check(): Promise<void> {
    if (!this.up) throw new Error('down');
  }
}

/** Smallest byte sequences that pass the magic-number checks. */
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
export const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);

/** A user row for seeding fakes; override any field. */
export function aUser(overrides: Partial<User> = {}): User {
  return {
    id: 'u1',
    email: 'asha@example.com',
    fullName: 'Asha Rao',
    passwordHash: 'hashed:irrelevant',
    role: 'USER',
    kycStatus: 'NOT_STARTED',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** A KYC submission row for seeding fakes; override any field. */
export function aSubmission(overrides: Partial<KycSubmission> = {}): KycSubmission {
  return {
    id: 's1',
    userId: 'u1',
    documentType: 'PASSPORT',
    documentNumberLast4: '4567',
    documentKey: 'kyc/u1/s1.png',
    documentMimeType: 'image/png',
    documentSizeBytes: 12,
    status: 'REJECTED',
    providerReference: 'kyc_ref',
    decisionReason: 'document_expired',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    decidedAt: new Date('2026-01-01T00:00:01.000Z'),
    reviewedBy: null,
    ...overrides,
  };
}

/** A top-up row for seeding fakes; override any field. */
export function aTopUp(overrides: Partial<TopUp> = {}): TopUp {
  return {
    id: 't1',
    userId: 'u1',
    amountMinor: 50_000,
    currency: 'INR',
    status: 'SUCCEEDED',
    idempotencyKey: null,
    providerReference: 'pay_ref',
    failureReason: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    completedAt: new Date('2026-01-01T00:00:01.000Z'),
    ...overrides,
  };
}
