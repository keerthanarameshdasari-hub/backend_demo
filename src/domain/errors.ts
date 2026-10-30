/**
 * Business errors raised by the domain. The HTTP layer maps each `code` to a
 * status; the domain itself knows nothing about HTTP.
 */
export type DomainErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN';

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends DomainError {
  constructor(message: string) {
    super('VALIDATION', message);
  }
}

export class NotFoundError extends DomainError {
  constructor(message: string) {
    super('NOT_FOUND', message);
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) {
    super('CONFLICT', message);
  }
}

export class InvalidCredentialsError extends DomainError {
  constructor() {
    super('UNAUTHENTICATED', 'Invalid email or password');
  }
}

export class KycRequiredError extends DomainError {
  constructor() {
    super('FORBIDDEN', 'KYC must be approved before topping up the wallet');
  }
}
