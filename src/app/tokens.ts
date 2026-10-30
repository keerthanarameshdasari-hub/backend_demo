/** Dependency-injection tokens for ports. Domain code never sees these. */
export const ENV = Symbol('ENV');

export const CLOCK = Symbol('Clock');
export const ID_GENERATOR = Symbol('IdGenerator');
export const PASSWORD_HASHER = Symbol('PasswordHasher');

export const DATABASE = Symbol('Database');
export const USER_REPOSITORY = Symbol('UserRepository');
export const KYC_SUBMISSION_REPOSITORY = Symbol('KycSubmissionRepository');
export const WALLET_REPOSITORY = Symbol('WalletRepository');
export const READINESS_PROBES = Symbol('ReadinessProbes');

export const FILE_STORAGE = Symbol('FileStorage');
export const PAYMENT_GATEWAY = Symbol('PaymentGateway');
export const KYC_PROVIDER = Symbol('KycProvider');
