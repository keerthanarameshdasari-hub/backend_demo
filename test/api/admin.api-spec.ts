/** The /admin endpoints used by the admin portal: authz, listings, KYC overrides. */
import { createHarness, errorBody, kycUpload, type Harness } from './harness';

let h: Harness;
beforeAll(async () => (h = await createHarness()));
afterAll(async () => h.close());

const UNKNOWN_ID = '00000000-0000-4000-8000-00000000ffff';

// Every row has three entries: with fewer, Jest passes its `done` callback in the gap.
const ROUTES: [string, string, object | undefined][] = [
  ['get', '/admin/users', undefined],
  ['get', '/admin/kyc', undefined],
  ['get', '/admin/top-ups', undefined],
  ['post', `/admin/kyc/${UNKNOWN_ID}/approve`, undefined],
  ['post', `/admin/kyc/${UNKNOWN_ID}/reject`, { reason: 'unreadable' }],
];

function call(method: string, path: string, body?: object) {
  const req = method === 'get' ? h.http.get(path) : h.http.post(path);
  return body ? req.send(body) : req;
}

/** A user whose KYC the provider has decided, and that decision's submission id. */
async function decidedUser(outcome: 'approved' | 'rejected') {
  const user = await h.signUp();
  h.kycProvider.willRespond(
    outcome === 'approved'
      ? { outcome: 'approved', providerReference: 'kyc_ok' }
      : { outcome: 'rejected', providerReference: 'kyc_no', reason: 'document_expired' },
  );
  const submission = await kycUpload(h, user.auth).expect(201);
  return { ...user, submissionId: submission.body.id as string };
}

describe('access', () => {
  it.each(ROUTES)('%s %s: 401 without a token', async (method, path, body) => {
    const res = await call(method, path, body).expect(401);
    expect(res.body).toEqual(errorBody(401, 'UNAUTHORIZED'));
  });

  it.each(ROUTES)('%s %s: 403 for a regular user', async (method, path, body) => {
    const { auth } = await h.signUp();
    const res = await call(method, path, body).set(auth).expect(403);
    expect(res.body).toEqual({ statusCode: 403, code: 'FORBIDDEN', message: 'Admin access required' });
  });

  it('checks the role on every request, so a demotion applies to tokens already issued', async () => {
    const admin = await h.signUpAdmin();
    await h.http.get('/admin/users').set(admin.auth).expect(200);
    await h.users.updateRole(admin.userId, 'USER');
    await h.http.get('/admin/users').set(admin.auth).expect(403);
  });

  it("GET /users/me reports the admin's role, so the portal can refuse non-admins up front", async () => {
    const admin = await h.signUpAdmin();
    expect((await h.http.get('/users/me').set(admin.auth).expect(200)).body.role).toBe('ADMIN');
  });
});

describe('GET /admin/users', () => {
  it('pages users newest first with the total, without password hashes', async () => {
    const admin = await h.signUpAdmin();
    const res = await h.http.get('/admin/users?limit=2&offset=0').set(admin.auth).expect(200);
    expect(res.body).toEqual({ items: expect.any(Array), total: expect.any(Number), limit: 2, offset: 0 });
    expect(res.body.items).toHaveLength(2);
    expect(res.body.total).toBe(h.users.rows.size);
    expect(res.body.items[0]).toEqual({
      id: expect.any(String),
      email: expect.any(String),
      fullName: expect.any(String),
      role: expect.stringMatching(/^(USER|ADMIN)$/),
      kycStatus: expect.any(String),
      createdAt: expect.any(String),
    });
  });

  it('defaults to 50 per page and filters by kycStatus', async () => {
    const admin = await h.signUpAdmin();
    await h.signUp('TIMED_OUT');
    const res = await h.http.get('/admin/users?kycStatus=TIMED_OUT').set(admin.auth).expect(200);
    expect(res.body.limit).toBe(50);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items.every((u: { kycStatus: string }) => u.kycStatus === 'TIMED_OUT')).toBe(true);
  });

  it.each([
    ['limit=0', /limit/],
    ['limit=101', /limit/],
    ['limit=abc', /limit/],
    ['offset=-1', /offset/],
    ['kycStatus=MAYBE', /kycStatus/],
    ['sort=email', /sort/],
  ])('400 for ?%s', async (query, message) => {
    const admin = await h.signUpAdmin();
    const res = await h.http.get(`/admin/users?${query}`).set(admin.auth).expect(400);
    expect(res.body.message).toMatch(message);
  });
});

describe('GET /admin/kyc', () => {
  it("lists submissions with their owner, never the stored document's location", async () => {
    const admin = await h.signUpAdmin();
    const { email, userId, submissionId } = await decidedUser('rejected');

    const res = await h.http.get('/admin/kyc?status=REJECTED&limit=100').set(admin.auth).expect(200);
    const row = res.body.items.find((s: { id: string }) => s.id === submissionId);
    expect(row).toEqual({
      id: submissionId,
      userId,
      user: { id: userId, email, fullName: expect.any(String) },
      documentType: 'PASSPORT',
      documentNumberLast4: '4567',
      documentMimeType: 'image/png',
      status: 'REJECTED',
      decisionReason: 'document_expired',
      reviewedBy: null,
      createdAt: expect.any(String),
      decidedAt: expect.any(String),
    });
    expect(row).not.toHaveProperty('documentKey');
    expect(row).not.toHaveProperty('providerReference');
    expect(res.body.items.every((s: { status: string }) => s.status === 'REJECTED')).toBe(true);
  });
});

describe('POST /admin/kyc/:id/approve', () => {
  it('overrides a provider rejection: the user is approved and can now top up', async () => {
    const admin = await h.signUpAdmin();
    const user = await decidedUser('rejected');
    await h.http.post('/wallet/top-ups').set(user.auth).send({ amountMinor: 50_000, paymentToken: 'tok_visa' }).expect(403);

    const res = await h.http.post(`/admin/kyc/${user.submissionId}/approve`).set(admin.auth).expect(200);
    expect(res.body).toMatchObject({ id: user.submissionId, status: 'APPROVED', decisionReason: null, reviewedBy: admin.userId });

    expect((await h.http.get('/users/me').set(user.auth)).body.kycStatus).toBe('APPROVED');
    expect((await h.http.get('/kyc').set(user.auth)).body).toMatchObject({ status: 'APPROVED', decisionReason: null });
    await h.http.post('/wallet/top-ups').set(user.auth).send({ amountMinor: 50_000, paymentToken: 'tok_visa' }).expect(201);
  });

  it('409 when it is already approved', async () => {
    const admin = await h.signUpAdmin();
    const user = await decidedUser('approved');
    const res = await h.http.post(`/admin/kyc/${user.submissionId}/approve`).set(admin.auth).expect(409);
    expect(res.body).toEqual({ statusCode: 409, code: 'CONFLICT', message: 'This submission is already APPROVED' });
  });

  it('404 for an unknown id, 400 for a malformed one', async () => {
    const admin = await h.signUpAdmin();
    await h.http.post(`/admin/kyc/${UNKNOWN_ID}/approve`).set(admin.auth).expect(404);
    await h.http.post('/admin/kyc/not-a-uuid/approve').set(admin.auth).expect(400);
  });
});

describe('POST /admin/kyc/:id/reject', () => {
  it('overrides a provider approval with a reason the user can see', async () => {
    const admin = await h.signUpAdmin();
    const user = await decidedUser('approved');

    const res = await h.http
      .post(`/admin/kyc/${user.submissionId}/reject`)
      .set(admin.auth)
      .send({ reason: '  Name does not match the account  ' })
      .expect(200);
    expect(res.body).toMatchObject({
      status: 'REJECTED',
      decisionReason: 'Name does not match the account',
      reviewedBy: admin.userId,
    });

    expect((await h.http.get('/kyc').set(user.auth)).body).toMatchObject({
      status: 'REJECTED',
      decisionReason: 'Name does not match the account',
    });
    await h.http.post('/wallet/top-ups').set(user.auth).send({ amountMinor: 50_000, paymentToken: 'tok_visa' }).expect(403);
    // A rejected user may submit again, as after a provider rejection.
    h.kycProvider.willRespond({ outcome: 'approved', providerReference: 'kyc_ok' });
    await kycUpload(h, user.auth).expect(201);
  });

  it.each([
    ['no body', undefined, /reason/],
    ['a short reason', { reason: 'no' }, /reason must be 3-500/],
    ['an over-long reason', { reason: 'x'.repeat(501) }, /reason/],
    ['an unknown field', { reason: 'unreadable', notify: false }, /notify/],
  ])('400 for %s, and nothing changes', async (_label, body, message) => {
    const admin = await h.signUpAdmin();
    const user = await decidedUser('approved');
    const req = h.http.post(`/admin/kyc/${user.submissionId}/reject`).set(admin.auth);
    const res = await (body ? req.send(body) : req).expect(400);
    expect(res.body.message).toMatch(message);
    expect((await h.http.get('/users/me').set(user.auth)).body.kycStatus).toBe('APPROVED');
  });

  it('409 while the provider is still deciding', async () => {
    const admin = await h.signUpAdmin();
    const { userId } = await h.signUp('PENDING');
    await h.submissions.create({
      id: '00000000-0000-4000-8000-0000000000aa',
      userId,
      documentType: 'PASSPORT',
      documentNumberLast4: '4567',
      documentKey: `kyc/${userId}/x.png`,
      documentMimeType: 'image/png',
      documentSizeBytes: 12,
      status: 'PENDING',
      providerReference: null,
      decisionReason: null,
      createdAt: new Date(),
      decidedAt: null,
      reviewedBy: null,
    });
    await h.http
      .post('/admin/kyc/00000000-0000-4000-8000-0000000000aa/reject')
      .set(admin.auth)
      .send({ reason: 'unreadable' })
      .expect(409);
  });
});

describe('GET /admin/top-ups', () => {
  it("lists every user's top-ups with their owner, filterable by user and status", async () => {
    const admin = await h.signUpAdmin();
    const user = await h.signUp('APPROVED');
    await h.http.post('/wallet/top-ups').set(user.auth).send({ amountMinor: 12_345, paymentToken: 'tok_visa' }).expect(201);
    h.payments.willRespond({ outcome: 'rejected', reason: 'card_declined' });
    await h.http.post('/wallet/top-ups').set(user.auth).send({ amountMinor: 999, paymentToken: 'tok_reject' }).expect(201);

    const mine = await h.http.get(`/admin/top-ups?userId=${user.userId}`).set(admin.auth).expect(200);
    expect(mine.body.total).toBe(2);
    expect(mine.body.items.map((t: { amountMinor: number }) => t.amountMinor)).toEqual([999, 12_345]);
    expect(mine.body.items[1]).toEqual({
      id: expect.any(String),
      userId: user.userId,
      user: { id: user.userId, email: user.email, fullName: expect.any(String) },
      amountMinor: 12_345,
      currency: 'INR',
      status: 'SUCCEEDED',
      failureReason: null,
      createdAt: expect.any(String),
      completedAt: expect.any(String),
    });

    const failed = await h.http.get(`/admin/top-ups?userId=${user.userId}&status=FAILED`).set(admin.auth).expect(200);
    expect(failed.body.items).toEqual([expect.objectContaining({ status: 'FAILED', failureReason: 'card_declined' })]);
  });

  it.each(['userId=42', 'status=REFUNDED'])('400 for ?%s', async (query) => {
    const admin = await h.signUpAdmin();
    await h.http.get(`/admin/top-ups?${query}`).set(admin.auth).expect(400);
  });
});
