/**
 * Builds the real Nest app (guards, validation pipe, error filter, multer,
 * controllers, domain services) for API tests, with every port swapped for
 * an in-memory fake through its DI token. Nothing listens on a port:
 * supertest drives the HTTP server in-process.
 */
import { type INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app/app.module';
import * as T from '../../src/app/tokens';
import { loadEnv, type Env } from '../../src/config/env';
import type { KycStatus } from '../../src/domain';
import {
  FakeKycProvider,
  FakePaymentGateway,
  InMemoryKyc,
  InMemoryStorage,
  InMemoryUsers,
  InMemoryWallets,
  PNG,
  SwitchableProbe,
} from '../fakes';

export const PASSWORD = 'correct-horse-battery-staple';

export interface Harness {
  app: INestApplication;
  http: ReturnType<typeof request>;
  env: Env;
  users: InMemoryUsers;
  submissions: InMemoryKyc;
  wallets: InMemoryWallets;
  storage: InMemoryStorage;
  kycProvider: FakeKycProvider;
  payments: FakePaymentGateway;
  probe: SwitchableProbe;
  /** Registers a fresh user and logs in. Returns the user id and its Authorization header. */
  signUp(kycStatus?: KycStatus): Promise<{ userId: string; email: string; token: string; auth: { Authorization: string } }>;
  /** Signs a token the way the app does (same secret, issuer, algorithm), with any payload. */
  sign(payload: object, options?: { secret?: string; issuer?: string; expiresIn?: number }): Promise<string>;
  close(): Promise<void>;
}

let counter = 0;

export async function createHarness(envOverrides: Partial<Env> = {}): Promise<Harness> {
  const env: Env = { ...loadEnv(), ...envOverrides };
  const users = new InMemoryUsers();
  const submissions = new InMemoryKyc();
  const wallets = new InMemoryWallets();
  const storage = new InMemoryStorage();
  const kycProvider = new FakeKycProvider();
  const payments = new FakePaymentGateway();
  const probe = new SwitchableProbe();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(T.ENV)
    .useValue(env)
    .overrideProvider(T.DATABASE)
    .useValue({ disconnect: async () => undefined })
    .overrideProvider(T.USER_REPOSITORY)
    .useValue(users)
    .overrideProvider(T.KYC_SUBMISSION_REPOSITORY)
    .useValue(submissions)
    .overrideProvider(T.WALLET_REPOSITORY)
    .useValue(wallets)
    .overrideProvider(T.READINESS_PROBES)
    .useValue([probe])
    .overrideProvider(T.FILE_STORAGE)
    .useValue(storage)
    .overrideProvider(T.KYC_PROVIDER)
    .useValue(kycProvider)
    .overrideProvider(T.PAYMENT_GATEWAY)
    .useValue(payments)
    .compile();

  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  const http = request(app.getHttpServer());

  return {
    app,
    http,
    env,
    users,
    submissions,
    wallets,
    storage,
    kycProvider,
    payments,
    probe,
    async signUp(kycStatus = 'NOT_STARTED') {
      counter += 1;
      const email = `user${counter}@example.com`;
      const reg = await http.post('/auth/register').send({ email, password: PASSWORD, fullName: `User ${counter}` }).expect(201);
      const login = await http.post('/auth/login').send({ email, password: PASSWORD }).expect(200);
      const userId = reg.body.id as string;
      if (kycStatus !== 'NOT_STARTED') await users.updateKycStatus(userId, kycStatus);
      const token = login.body.accessToken as string;
      return { userId, email, token, auth: { Authorization: `Bearer ${token}` } };
    },
    async sign(payload, options = {}) {
      const jwt = new JwtService({ secret: options.secret ?? env.JWT_SECRET });
      return jwt.signAsync(payload, {
        algorithm: 'HS256',
        issuer: options.issuer ?? env.JWT_ISSUER,
        ...(options.expiresIn === undefined ? {} : { expiresIn: options.expiresIn }),
      });
    },
    close: () => app.close(),
  };
}

/** A valid multipart KYC upload; override any part. */
export function kycUpload(
  h: Harness,
  auth: { Authorization: string },
  parts: { documentType?: string; documentNumber?: string; file?: { bytes: Uint8Array | Buffer; contentType: string; filename?: string } | null } = {},
) {
  const req = h.http.post('/kyc').set(auth);
  if (parts.documentType !== undefined) req.field('documentType', parts.documentType);
  else req.field('documentType', 'PASSPORT');
  if (parts.documentNumber !== undefined) req.field('documentNumber', parts.documentNumber);
  else req.field('documentNumber', 'P1234567');
  const file = parts.file === undefined ? { bytes: PNG, contentType: 'image/png' } : parts.file;
  if (file) req.attach('document', Buffer.from(file.bytes), { filename: file.filename ?? 'document', contentType: file.contentType });
  return req;
}

/** The error body every failure returns. */
export const errorBody = (statusCode: number, code: string) => ({ statusCode, code, message: expect.any(String) });
