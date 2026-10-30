import { Global, Inject, Module, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { MockKycProvider } from '../adapters/mock/mock-kyc.provider';
import { MockPaymentGateway } from '../adapters/mock/mock-payment.gateway';
import { PrismaKycSubmissionRepository } from '../adapters/prisma/prisma-kyc.repository';
import { PrismaUserRepository } from '../adapters/prisma/prisma-user.repository';
import { PrismaWalletRepository } from '../adapters/prisma/prisma-wallet.repository';
import { PrismaDatabase } from '../adapters/prisma/prisma.service';
import { S3FileStorage } from '../adapters/s3/s3-file-storage';
import { ScryptPasswordHasher, SystemClock, UuidGenerator } from '../adapters/system/system';
import type { Env } from '../config/env';
import type { FileStorage, KycProvider, PaymentGateway, ReadinessProbe } from '../domain';
import * as T from './tokens';

/**
 * The one place that decides which adapter backs each port, and it decides
 * only from validated env config. Adding a provider = one new adapter class,
 * one new enum value in env.ts, one new `case` here.
 */
export function createFileStorage(env: Env): FileStorage {
  switch (env.STORAGE_PROVIDER) {
    case 's3':
      return new S3FileStorage({
        bucket: env.S3_BUCKET,
        region: env.S3_REGION,
        endpoint: env.S3_ENDPOINT,
        forcePathStyle: env.S3_FORCE_PATH_STYLE,
        credentials:
          env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
            ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY }
            : undefined,
      });
  }
}

export function createPaymentGateway(env: Env): PaymentGateway {
  switch (env.PAYMENT_PROVIDER) {
    case 'mock':
      return new MockPaymentGateway();
  }
}

export function createKycProvider(env: Env): KycProvider {
  switch (env.KYC_PROVIDER) {
    case 'mock':
      return new MockKycProvider();
  }
}

class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(T.DATABASE) private readonly db: PrismaDatabase) {}
  async onApplicationShutdown(): Promise<void> {
    await this.db.disconnect();
  }
}

const providers: Provider[] = [
  { provide: T.CLOCK, useClass: SystemClock },
  { provide: T.ID_GENERATOR, useClass: UuidGenerator },
  { provide: T.PASSWORD_HASHER, useClass: ScryptPasswordHasher },

  { provide: T.DATABASE, inject: [T.ENV], useFactory: (env: Env) => new PrismaDatabase(env.DATABASE_URL) },
  DatabaseLifecycle,
  { provide: T.USER_REPOSITORY, inject: [T.DATABASE], useFactory: (db: PrismaDatabase) => new PrismaUserRepository(db) },
  {
    provide: T.KYC_SUBMISSION_REPOSITORY,
    inject: [T.DATABASE],
    useFactory: (db: PrismaDatabase) => new PrismaKycSubmissionRepository(db),
  },
  { provide: T.WALLET_REPOSITORY, inject: [T.DATABASE], useFactory: (db: PrismaDatabase) => new PrismaWalletRepository(db) },
  { provide: T.READINESS_PROBES, inject: [T.DATABASE], useFactory: (db: ReadinessProbe): ReadinessProbe[] => [db] },

  { provide: T.FILE_STORAGE, inject: [T.ENV], useFactory: createFileStorage },
  { provide: T.PAYMENT_GATEWAY, inject: [T.ENV], useFactory: createPaymentGateway },
  { provide: T.KYC_PROVIDER, inject: [T.ENV], useFactory: createKycProvider },
];

@Global()
@Module({
  providers,
  exports: providers
    .filter((p): p is Provider & { provide: symbol } => typeof p === 'object' && 'provide' in p)
    .map((p) => p.provide),
})
export class AdaptersModule {}
