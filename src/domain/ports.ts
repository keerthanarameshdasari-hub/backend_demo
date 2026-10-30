/**
 * Ports: the only way the domain talks to the outside world. Adapters in
 * src/adapters implement these; tests implement them with in-memory fakes.
 */
import type { DocumentType, KycStatus, KycSubmission, TopUp, User, Wallet } from './model';

// ---------------------------------------------------------------- time / ids

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, hash: string): Promise<boolean>;
}

// ---------------------------------------------------------------- persistence

export interface UserRepository {
  create(user: User): Promise<User>;
  findById(id: string): Promise<User | null>;
  /** `email` is already normalised (trimmed, lower-cased). */
  findByEmail(email: string): Promise<User | null>;
  updateKycStatus(userId: string, status: KycStatus): Promise<void>;
}

export interface KycSubmissionRepository {
  create(submission: KycSubmission): Promise<KycSubmission>;
  update(
    id: string,
    patch: Pick<KycSubmission, 'status' | 'providerReference' | 'decisionReason' | 'decidedAt'>,
  ): Promise<KycSubmission>;
  findLatestByUser(userId: string): Promise<KycSubmission | null>;
}

export interface WalletRepository {
  getOrCreate(userId: string, currency: string, now: Date): Promise<Wallet>;
  createTopUp(topUp: TopUp): Promise<TopUp>;
  findTopUpByIdempotencyKey(userId: string, key: string): Promise<TopUp | null>;
  listTopUps(userId: string, limit: number): Promise<TopUp[]>;
  /** Marks the top-up SUCCEEDED and credits the wallet in one atomic step. */
  completeTopUp(id: string, providerReference: string, completedAt: Date): Promise<{ topUp: TopUp; wallet: Wallet }>;
  failTopUp(id: string, status: 'FAILED' | 'TIMED_OUT', reason: string, completedAt: Date): Promise<TopUp>;
}

/** Lets /ready ask "can we reach the database?" without knowing it's Prisma. */
export interface ReadinessProbe {
  readonly name: string;
  check(): Promise<void>;
}

// ---------------------------------------------------------------- external services

export interface FileStorage {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
}

export interface PaymentRequest {
  /** Our top-up id; providers use it to de-duplicate retries. */
  reference: string;
  amountMinor: number;
  currency: string;
  /** Opaque token from the mobile payment SDK (e.g. a tokenised card). */
  paymentToken: string;
}

export type PaymentResult =
  { outcome: 'approved'; providerReference: string } | { outcome: 'rejected'; reason: string } | { outcome: 'timeout' };

export interface PaymentGateway {
  /** Must stop work and reject when `signal` aborts. */
  charge(request: PaymentRequest, signal: AbortSignal): Promise<PaymentResult>;
}

export interface KycVerificationRequest {
  reference: string;
  userId: string;
  fullName: string;
  documentType: DocumentType;
  documentNumber: string;
  documentKey: string;
}

export type KycResult =
  | { outcome: 'approved'; providerReference: string }
  | { outcome: 'rejected'; providerReference: string; reason: string }
  | { outcome: 'timeout' };

export interface KycProvider {
  /** Must stop work and reject when `signal` aborts. */
  verify(request: KycVerificationRequest, signal: AbortSignal): Promise<KycResult>;
}
