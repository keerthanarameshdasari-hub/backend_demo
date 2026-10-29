/** In-memory implementations of the persistence and storage ports, for tests. */
import type {
  Clock,
  FileStorage,
  IdGenerator,
  KycStatus,
  KycSubmission,
  KycSubmissionRepository,
  PasswordHasher,
  ReadinessProbe,
  TopUp,
  User,
  UserRepository,
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
