/**
 * Domain model: plain data shapes. Amounts are integers in minor units
 * (e.g. paise for INR) so no floating-point rounding ever touches money.
 */

export const KYC_STATUSES = ['NOT_STARTED', 'PENDING', 'APPROVED', 'REJECTED', 'TIMED_OUT'] as const;
export type KycStatus = (typeof KYC_STATUSES)[number];

export const DOCUMENT_TYPES = ['PASSPORT', 'NATIONAL_ID', 'DRIVING_LICENCE'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const TOP_UP_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT'] as const;
export type TopUpStatus = (typeof TOP_UP_STATUSES)[number];

export interface User {
  id: string;
  email: string;
  fullName: string;
  passwordHash: string;
  kycStatus: KycStatus;
  createdAt: Date;
}

/** What the outside world may see of a user (never the password hash). */
export type PublicUser = Omit<User, 'passwordHash'>;

export function toPublicUser(user: User): PublicUser {
  const { passwordHash: _omit, ...rest } = user;
  return rest;
}

export interface KycSubmission {
  id: string;
  userId: string;
  documentType: DocumentType;
  /** Only the last four characters are kept, to limit stored PII. */
  documentNumberLast4: string;
  documentKey: string;
  documentMimeType: string;
  documentSizeBytes: number;
  status: KycStatus;
  providerReference: string | null;
  decisionReason: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}

export interface Wallet {
  userId: string;
  currency: string;
  balanceMinor: number;
  updatedAt: Date;
}

export interface TopUp {
  id: string;
  userId: string;
  amountMinor: number;
  currency: string;
  status: TopUpStatus;
  idempotencyKey: string | null;
  providerReference: string | null;
  failureReason: string | null;
  createdAt: Date;
  completedAt: Date | null;
}
