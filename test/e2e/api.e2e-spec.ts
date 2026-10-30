/**
 * Full HTTP flow through the real Nest app with the real mock providers.
 * Only persistence and file storage are swapped for in-memory fakes, by
 * overriding the port tokens: the same seam an adapter swap uses.
 */
import { type INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app/app.module';
import * as T from '../../src/app/tokens';
import { InMemoryKyc, InMemoryStorage, InMemoryUsers, InMemoryWallets, PNG, SwitchableProbe } from '../fakes';

describe('wallet API (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const probe = new SwitchableProbe();
  const storage = new InMemoryStorage();
  const logged: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(T.DATABASE)
      .useValue({ disconnect: async () => undefined })
      .overrideProvider(T.USER_REPOSITORY)
      .useValue(new InMemoryUsers())
      .overrideProvider(T.KYC_SUBMISSION_REPOSITORY)
      .useValue(new InMemoryKyc())
      .overrideProvider(T.WALLET_REPOSITORY)
      .useValue(new InMemoryWallets())
      .overrideProvider(T.READINESS_PROBES)
      .useValue([probe])
      .overrideProvider(T.FILE_STORAGE)
      .useValue(storage)
      .compile();

    app = moduleRef.createNestApplication();
    const capture = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
    app.useLogger({ log: capture, error: capture, warn: capture, debug: capture, verbose: capture, fatal: capture });
    Logger.overrideLogger({ log: capture, error: capture, warn: capture, debug: capture, verbose: capture, fatal: capture });
    await app.init();
    http = request(app.getHttpServer());
  });

  afterAll(async () => app.close());

  const password = 'super-secret-password-123';
  let token = '';

  describe('ops', () => {
    it('GET /health is 200 without touching the database', async () => {
      probe.up = false;
      await http.get('/health').expect(200, { status: 'ok' });
      probe.up = true;
    });

    it('GET /ready reflects the database', async () => {
      await http.get('/ready').expect(200, { status: 'ready', checks: [{ name: 'database', status: 'up' }] });
      probe.up = false;
      await http.get('/ready').expect(503, { status: 'not_ready', checks: [{ name: 'database', status: 'down' }] });
      probe.up = true;
    });

    it('GET /meta/min-app-version returns the configured version', async () => {
      await http.get('/meta/min-app-version').expect(200, { minAppVersion: '1.2.0' });
    });
  });

  describe('auth', () => {
    it('registers and logs in', async () => {
      const reg = await http
        .post('/auth/register')
        .send({ email: 'Asha@Example.com', password, fullName: 'Asha Rao' })
        .expect(201);
      expect(reg.body).toMatchObject({ email: 'asha@example.com', kycStatus: 'NOT_STARTED' });
      expect(reg.body).not.toHaveProperty('passwordHash');

      const login = await http.post('/auth/login').send({ email: 'asha@example.com', password }).expect(200);
      expect(login.body).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
      token = login.body.accessToken;
    });

    it('rejects duplicates, bad passwords, unknown fields and missing tokens', async () => {
      await http.post('/auth/register').send({ email: 'asha@example.com', password, fullName: 'X' }).expect(409);
      await http.post('/auth/login').send({ email: 'asha@example.com', password: 'nope-nope-nope' }).expect(401);
      await http.post('/auth/register').send({ email: 'b@example.com', password, fullName: 'B', isAdmin: true }).expect(400);
      await http.get('/users/me').expect(401);
      await http.get('/users/me').set('Authorization', 'Bearer not-a-jwt').expect(401);
    });

    it('GET /users/me returns the signed-in user', async () => {
      const me = await http.get('/users/me').set('Authorization', `Bearer ${token}`).expect(200);
      expect(me.body.email).toBe('asha@example.com');
    });
  });

  describe('kyc and wallet', () => {
    const auth = () => ({ Authorization: `Bearer ${token}` });

    it('blocks top-ups before KYC', async () => {
      const res = await http.post('/wallet/top-ups').set(auth()).send({ amountMinor: 5000, paymentToken: 'tok_visa' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('validates the upload', async () => {
      await http.post('/kyc').set(auth()).field('documentType', 'PASSPORT').field('documentNumber', 'P1234567').expect(400);
      await http
        .post('/kyc')
        .set(auth())
        .field('documentType', 'PASSPORT')
        .field('documentNumber', 'P1234567')
        .attach('document', Buffer.from('GIF89a'), { filename: 'x.gif', contentType: 'image/gif' })
        .expect(400);
    });

    const submit = (documentNumber: string) =>
      http
        .post('/kyc')
        .set(auth())
        .field('documentType', 'PASSPORT')
        .field('documentNumber', documentNumber)
        .attach('document', Buffer.from(PNG), { filename: 'passport.png', contentType: 'image/png' });

    it('KYC: reject, then timeout, then approve', async () => {
      expect((await submit('REJECT-001').expect(201)).body.status).toBe('REJECTED');
      expect((await submit('TIMEOUT-001').expect(201)).body.status).toBe('TIMED_OUT');
      const ok = await submit('P1234567').expect(201);
      expect(ok.body).toMatchObject({ status: 'APPROVED', documentNumberLast4: '4567' });
      expect(storage.objects.size).toBe(3);
      await submit('P1234567').expect(409);
      expect((await http.get('/kyc').set(auth()).expect(200)).body.status).toBe('APPROVED');
    });

    it('top-up: approve, reject, timeout, idempotent replay', async () => {
      const ok = await http.post('/wallet/top-ups').set(auth()).send({ amountMinor: 5000, paymentToken: 'tok_visa' }).expect(201);
      expect(ok.body.topUp.status).toBe('SUCCEEDED');
      expect(ok.body.wallet).toMatchObject({ currency: 'INR', balanceMinor: 5000 });

      const declined = await http.post('/wallet/top-ups').set(auth()).send({ amountMinor: 5000, paymentToken: 'tok_reject' }).expect(201);
      expect(declined.body.topUp).toMatchObject({ status: 'FAILED', failureReason: 'card_declined' });
      expect(declined.body.wallet.balanceMinor).toBe(5000);

      const slow = await http.post('/wallet/top-ups').set(auth()).send({ amountMinor: 5000, paymentToken: 'tok_timeout' }).expect(201);
      expect(slow.body.topUp.status).toBe('TIMED_OUT');
      expect(slow.body.wallet.balanceMinor).toBe(5000);

      const once = { amountMinor: 2500, paymentToken: 'tok_visa' };
      const first = await http.post('/wallet/top-ups').set({ ...auth(), 'Idempotency-Key': 'order-0001' }).send(once).expect(201);
      const again = await http.post('/wallet/top-ups').set({ ...auth(), 'Idempotency-Key': 'order-0001' }).send(once).expect(200);
      expect(again.body.topUp.id).toBe(first.body.topUp.id);
      expect(again.body.wallet.balanceMinor).toBe(7500);
      await http
        .post('/wallet/top-ups')
        .set({ ...auth(), 'Idempotency-Key': 'order-0001' })
        .send({ ...once, amountMinor: 9999 })
        .expect(409);

      const list = await http.get('/wallet/top-ups?limit=10').set(auth()).expect(200);
      expect(list.body.map((t: { status: string }) => t.status)).toEqual(['SUCCEEDED', 'TIMED_OUT', 'FAILED', 'SUCCEEDED']);
      expect((await http.get('/wallet').set(auth()).expect(200)).body.balanceMinor).toBe(7500);
    });
  });

  it('never logs request bodies, tokens or secrets', () => {
    const all = logged.join('\n');
    expect(all).toMatch(/POST \/auth\/login 200/); // request lines are logged...
    for (const secret of [password, token, 'test-only-test-only', 'P1234567', 'tok_visa']) {
      expect(all).not.toContain(secret); // ...but nothing from inside them
    }
  });
});
