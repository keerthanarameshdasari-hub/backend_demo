/** POST /auth/register, POST /auth/login and GET /users/me. */
import { createHarness, errorBody, PASSWORD, type Harness } from './harness';

let h: Harness;
beforeAll(async () => (h = await createHarness()));
afterAll(async () => h.close());

const valid = () => ({ email: `new${Math.random().toString(36).slice(2, 8)}@example.com`, password: PASSWORD, fullName: 'Asha Rao' });

describe('POST /auth/register', () => {
  it('201 with the public profile, normalised, never the hash', async () => {
    const res = await h.http
      .post('/auth/register')
      .send({ email: 'Asha.Rao@Example.COM', password: PASSWORD, fullName: '  Asha Rao ' })
      .expect(201);
    expect(res.body).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      email: 'asha.rao@example.com',
      fullName: 'Asha Rao',
      kycStatus: 'NOT_STARTED',
      createdAt: expect.any(String),
    });
    expect(h.users.rows.get(res.body.id)?.passwordHash).not.toContain(PASSWORD);
  });

  it('409 for an email that is already registered, in any case', async () => {
    const body = valid();
    await h.http.post('/auth/register').send(body).expect(201);
    const res = await h.http.post('/auth/register').send({ ...body, email: body.email.toUpperCase() }).expect(409);
    expect(res.body).toEqual(errorBody(409, 'CONFLICT'));
  });

  it('400 for an empty body', async () => {
    const res = await h.http.post('/auth/register').send({}).expect(400);
    expect(res.body).toEqual(errorBody(400, 'BAD_REQUEST'));
  });

  it.each([
    ['a missing email', { email: undefined }],
    ['an email with surrounding spaces', { email: ' asha@example.com ' }],
    ['a malformed email', { email: 'not-an-email' }],
    ['an email over 254 characters', { email: `${'a'.repeat(250)}@example.com` }],
    ['a missing password', { password: undefined }],
    ['a 9-character password', { password: 'x'.repeat(9) }],
    ['a 129-character password', { password: 'x'.repeat(129) }],
    ['a numeric password', { password: 1234567890123 }],
    ['a missing full name', { fullName: undefined }],
    ['an empty full name', { fullName: '' }],
    ['a 121-character full name', { fullName: 'x'.repeat(121) }],
    ['an unknown field (mass assignment)', { isAdmin: true }],
    ['a kycStatus field (mass assignment)', { kycStatus: 'APPROVED' }],
  ])('400 for %s', async (_label, override) => {
    const before = h.users.rows.size;
    const res = await h.http.post('/auth/register').send({ ...valid(), ...override }).expect(400);
    expect(res.body).toEqual(errorBody(400, 'BAD_REQUEST'));
    expect(h.users.rows.size).toBe(before);
  });

  it('400 from the domain for a name that is only spaces', async () => {
    const res = await h.http.post('/auth/register').send({ ...valid(), fullName: '   ' }).expect(400);
    expect(res.body).toEqual({ statusCode: 400, code: 'VALIDATION', message: 'fullName is required' });
  });

  it('400 for a body that is not valid JSON', async () => {
    const res = await h.http.post('/auth/register').set('Content-Type', 'application/json').send('{"email":').expect(400);
    expect(res.body).toMatchObject({ statusCode: 400 });
  });

  it('names the broken rule in the message', async () => {
    const res = await h.http.post('/auth/register').send({ ...valid(), password: 'short' }).expect(400);
    expect(res.body.message).toMatch(/password must be longer than or equal to 10 characters/);
  });
});

describe('POST /auth/login', () => {
  it('200 with a bearer token that works on protected endpoints', async () => {
    const body = valid();
    await h.http.post('/auth/register').send(body).expect(201);
    const res = await h.http.post('/auth/login').send({ email: body.email.toUpperCase(), password: PASSWORD }).expect(200);
    expect(res.body).toEqual({ accessToken: expect.any(String), tokenType: 'Bearer', expiresIn: h.env.JWT_EXPIRES_IN_SECONDS });
    await h.http.get('/users/me').set('Authorization', `Bearer ${res.body.accessToken}`).expect(200);
  });

  it('401 for a wrong password', async () => {
    const { email } = await h.signUp();
    const res = await h.http.post('/auth/login').send({ email, password: 'not-the-password' }).expect(401);
    expect(res.body).toEqual(errorBody(401, 'UNAUTHENTICATED'));
    expect(res.body).not.toHaveProperty('accessToken');
  });

  it.each([
    ['an empty body', {}],
    ['a missing password', { email: 'a@example.com' }],
    ['a missing email', { password: PASSWORD }],
    ['an empty email', { email: '', password: PASSWORD }],
    ['a non-string password', { email: 'a@example.com', password: ['x'] }],
    ['an unknown field', { email: 'a@example.com', password: PASSWORD, remember: true }],
  ])('400 for %s', async (_label, body) => {
    const res = await h.http.post('/auth/login').send(body).expect(400);
    expect(res.body).toEqual(errorBody(400, 'BAD_REQUEST'));
  });
});

describe('GET /users/me', () => {
  it('200 with the signed-in user', async () => {
    const { userId, email, auth } = await h.signUp();
    const res = await h.http.get('/users/me').set(auth).expect(200);
    expect(res.body).toEqual({ id: userId, email, fullName: expect.any(String), kycStatus: 'NOT_STARTED', createdAt: expect.any(String) });
    expect(res.body).not.toHaveProperty('passwordHash');
  });

  it('reflects the current KYC status', async () => {
    const { auth } = await h.signUp('APPROVED');
    expect((await h.http.get('/users/me').set(auth).expect(200)).body.kycStatus).toBe('APPROVED');
  });

  it('404 for a valid token whose user no longer exists', async () => {
    const token = await h.sign({ sub: '00000000-0000-4000-8000-0000000000ff' });
    const res = await h.http.get('/users/me').set('Authorization', `Bearer ${token}`).expect(404);
    expect(res.body).toEqual(errorBody(404, 'NOT_FOUND'));
  });
});
