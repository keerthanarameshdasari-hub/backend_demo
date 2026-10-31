import { Global, Module, type Provider } from '@nestjs/common';
import type { Env } from '../config/env';
import {
  AdminService,
  type Clock,
  type FileStorage,
  type IdGenerator,
  type KycProvider,
  KycService,
  type KycSubmissionRepository,
  type PasswordHasher,
  type PaymentGateway,
  type UserRepository,
  UserService,
  type WalletRepository,
  WalletService,
} from '../domain';
import * as T from './tokens';

export const KYC_ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'application/pdf'] as const;

/** Builds the plain domain services from whichever adapters were bound to the ports. */
const providers: Provider[] = [
  {
    provide: UserService,
    inject: [T.USER_REPOSITORY, T.PASSWORD_HASHER, T.ID_GENERATOR, T.CLOCK],
    useFactory: (users: UserRepository, hasher: PasswordHasher, ids: IdGenerator, clock: Clock) =>
      new UserService(users, hasher, ids, clock),
  },
  {
    provide: KycService,
    inject: [T.USER_REPOSITORY, T.KYC_SUBMISSION_REPOSITORY, T.FILE_STORAGE, T.KYC_PROVIDER, T.ID_GENERATOR, T.CLOCK, T.ENV],
    useFactory: (
      users: UserRepository,
      submissions: KycSubmissionRepository,
      storage: FileStorage,
      provider: KycProvider,
      ids: IdGenerator,
      clock: Clock,
      env: Env,
    ) =>
      new KycService(users, submissions, storage, provider, ids, clock, {
        maxDocumentBytes: env.KYC_MAX_DOCUMENT_BYTES,
        allowedMimeTypes: KYC_ALLOWED_MIME_TYPES,
        providerTimeoutMs: env.PROVIDER_TIMEOUT_MS,
      }),
  },
  {
    provide: WalletService,
    inject: [T.USER_REPOSITORY, T.WALLET_REPOSITORY, T.PAYMENT_GATEWAY, T.ID_GENERATOR, T.CLOCK, T.ENV],
    useFactory: (
      users: UserRepository,
      wallets: WalletRepository,
      payments: PaymentGateway,
      ids: IdGenerator,
      clock: Clock,
      env: Env,
    ) =>
      new WalletService(users, wallets, payments, ids, clock, {
        currency: env.WALLET_CURRENCY,
        minTopUpMinor: env.TOP_UP_MIN_MINOR,
        maxTopUpMinor: env.TOP_UP_MAX_MINOR,
        providerTimeoutMs: env.PROVIDER_TIMEOUT_MS,
      }),
  },
  {
    provide: AdminService,
    inject: [T.USER_REPOSITORY, T.KYC_SUBMISSION_REPOSITORY, T.WALLET_REPOSITORY, T.CLOCK],
    useFactory: (users: UserRepository, submissions: KycSubmissionRepository, wallets: WalletRepository, clock: Clock) =>
      new AdminService(users, submissions, wallets, clock),
  },
];

@Global()
@Module({ providers, exports: [UserService, KycService, WalletService, AdminService] })
export class DomainModule {}
