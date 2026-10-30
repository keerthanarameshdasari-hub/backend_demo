/**
 * 401 and 403 across the API. Every protected endpoint is listed once in
 * PROTECTED; each bad-token case is checked against all of them.
 */
import { createHarness, errorBody, type Harness } from './harness';

let h: Harness;
beforeAll(async () => (h = await createHarness()));
afterAll(async () => h.close());

type Method = 'get' | 'post';
const PROTECTED: [Method, string][] = [
  ['get', '/users/me'],
  ['get', '/kyc'],
  ['post', '/kyc'],
  ['get', '/wallet'],
  ['get', '/wallet/top-ups'],
  ['post', '/wallet/top-ups'],
];

const PUBLIC: [Method, string, number][] = [
  ['get', '/health', 200],
  ['get', '/ready', 200],
  ['get', '/meta/min-app-version', 200],
];

const call = (method: Method, path: string, headers: Record<string, string> = {}) => {
  const req = h.http[method](path).set(headers);
  return method === 'post' ? req.send({}) : req;
};

describe('401: protected endpoints need a valid bearer token', () => {
  const cases: [string, () => Promise<Record<string, string>>][] = [
    ['no Authorization header', async () => ({})],
    ['an empty Authorization header', async () => ({ Authorization: '' })],
    ['a non-Bearer scheme', async () => ({ Authorization: `Basic ${Buffer.from('a:b').toString('base64')}` })],
    ['"Bearer" with no token', async () => ({ Authorization: 'Bearer ' })],
    ['a token that is not a JWT', async () => ({ Authorization: 'Bearer not-a-jwt' })],
    [
      'a token signed with another secret',
      async () => ({ Authorization: `Bearer ${await h.sign({ sub: 'u' }, { secret: 'x'.repeat(40) })}` }),
    ],
    [
      'a token from another issuer',
      async () => ({ Authorization: `Bearer ${await h.sign({ sub: 'u' }, { issuer: 'someone-else' })}` }),
    ],
    [
      'an expired token',
      async () => ({ Authorization: `Bearer ${await h.sign({ sub: 'u', exp: Math.floor(Date.now() / 1000) - 60 })}` }),
    ],
    ['a token with no subject', async () => ({ Authorization: `Bearer ${await h.sign({ role: 'admin' })}` })],
    ['a token whose subject is not a string', async () => ({ Authorization: `Bearer ${await h.sign({ sub: 42 })}` })],
    [
      'an unsigned token (alg "none")',
      async () => ({ Authorization: `Bearer ${unsignedToken({ sub: 'u', iss: h.env.JWT_ISSUER })}` }),
    ],
  ];

  describe.each(PROTECTED)('%s %s', (method, path) => {
    it.each(cases)('rejects %s', async (_label, headers) => {
      const res = await call(method, path, await headers());
      expect(res.status).toBe(401);
      expect(res.body).toEqual(errorBody(401, 'UNAUTHORIZED'));
    });
  });

  it('never echoes the token back', async () => {
    const res = await h.http.get('/users/me').set('Authorization', 'Bearer abc.def.ghi');
    expect(JSON.stringify(res.body)).not.toContain('abc.def.ghi');
  });

  it.each(PUBLIC)('%s %s needs no token', async (method, path, status) => {
    await call(method, path).expect(status);
  });

  it('wrong credentials at login are a 401 that does not reveal whether the email exists', async () => {
    const { email } = await h.signUp();
    const wrongPassword = await h.http.post('/auth/login').send({ email, password: 'wrong-password-123' });
    const unknownEmail = await h.http.post('/auth/login').send({ email: 'nobody@example.com', password: 'wrong-password-123' });
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
    expect(wrongPassword.body).toEqual({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Invalid email or password' });
  });
});

describe('403: top-ups need approved KYC', () => {
  it.each(['NOT_STARTED', 'PENDING', 'REJECTED', 'TIMED_OUT'] as const)('refuses a user whose KYC is %s', async (status) => {
    const { auth } = await h.signUp(status);
    const before = h.payments.calls.length;
    const res = await h.http.post('/wallet/top-ups').set(auth).send({ amountMinor: 5_000, paymentToken: 'tok_card' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      statusCode: 403,
      code: 'FORBIDDEN',
      message: 'KYC must be approved before topping up the wallet',
    });
    expect(h.payments.calls.length).toBe(before);
  });

  it('lets the same user top up once KYC is approved', async () => {
    const { auth } = await h.signUp('APPROVED');
    await h.http.post('/wallet/top-ups').set(auth).send({ amountMinor: 5_000, paymentToken: 'tok_card' }).expect(201);
  });

  it('a user only ever sees their own wallet', async () => {
    const a = await h.signUp('APPROVED');
    const b = await h.signUp('APPROVED');
    await h.http.post('/wallet/top-ups').set(a.auth).send({ amountMinor: 5_000, paymentToken: 'tok_card' }).expect(201);
    expect((await h.http.get('/wallet').set(b.auth).expect(200)).body.balanceMinor).toBe(0);
    expect((await h.http.get('/wallet/top-ups').set(b.auth).expect(200)).body).toEqual([]);
  });
});

/** A JWT with `alg: none` and no signature: must never be accepted. */
function unsignedToken(payload: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.`;
}
