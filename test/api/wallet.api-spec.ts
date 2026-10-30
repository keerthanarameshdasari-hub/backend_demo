/** GET /wallet, GET /wallet/top-ups and POST /wallet/top-ups. The payment gateway is a scripted fake. */
import { createHarness, errorBody, type Harness } from './harness';

let h: Harness;
beforeAll(async () => (h = await createHarness()));
afterAll(async () => h.close());

const card = (amountMinor = 5_000) => ({ amountMinor, paymentToken: 'tok_card' });

describe('GET /wallet', () => {
  it('200 with an empty wallet for a new user', async () => {
    const { auth } = await h.signUp();
    const res = await h.http.get('/wallet').set(auth).expect(200);
    expect(res.body).toEqual({ currency: h.env.WALLET_CURRENCY, balanceMinor: 0, updatedAt: expect.any(String) });
  });
});

describe('POST /wallet/top-ups', () => {
  it('201 SUCCEEDED and credits the wallet', async () => {
    const { auth } = await h.signUp('APPROVED');
    h.payments.willRespond({ outcome: 'approved', providerReference: 'pay_1' });
    const res = await h.http.post('/wallet/top-ups').set(auth).send(card(5_000)).expect(201);
    expect(res.body).toEqual({
      topUp: {
        id: expect.any(String),
        amountMinor: 5_000,
        currency: 'INR',
        status: 'SUCCEEDED',
        failureReason: null,
        createdAt: expect.any(String),
        completedAt: expect.any(String),
      },
      wallet: { currency: 'INR', balanceMinor: 5_000, updatedAt: expect.any(String) },
    });
    expect((await h.http.get('/wallet').set(auth)).body.balanceMinor).toBe(5_000);
  });

  it('201 FAILED, balance unchanged, when the payment is declined', async () => {
    const { auth } = await h.signUp('APPROVED');
    h.payments.willRespond({ outcome: 'rejected', reason: 'card_declined' });
    const res = await h.http.post('/wallet/top-ups').set(auth).send(card()).expect(201);
    expect(res.body.topUp).toMatchObject({ status: 'FAILED', failureReason: 'card_declined' });
    expect(res.body.wallet.balanceMinor).toBe(0);
  });

  it('201 TIMED_OUT, balance unchanged, when the payment provider does not answer', async () => {
    const { auth } = await h.signUp('APPROVED');
    h.payments.willRespond('hang');
    const res = await h.http.post('/wallet/top-ups').set(auth).send(card()).expect(201);
    expect(res.body.topUp).toMatchObject({ status: 'TIMED_OUT', failureReason: 'Payment provider did not respond in time' });
    expect(res.body.wallet.balanceMinor).toBe(0);
    expect(h.payments.lastCall?.signal.aborted).toBe(true);
  });

  describe('Idempotency-Key', () => {
    it('200 replay with the original result, charged once', async () => {
      const { auth } = await h.signUp('APPROVED');
      const headers = { ...auth, 'Idempotency-Key': 'order-0001' };
      const calls = h.payments.calls.length;
      const first = await h.http.post('/wallet/top-ups').set(headers).send(card(2_500)).expect(201);
      const again = await h.http.post('/wallet/top-ups').set(headers).send(card(2_500)).expect(200);
      expect(again.body.topUp).toEqual(first.body.topUp);
      expect(again.body.wallet.balanceMinor).toBe(2_500);
      expect(h.payments.calls.length).toBe(calls + 1);
    });

    it('409 for the same key with a different amount', async () => {
      const { auth } = await h.signUp('APPROVED');
      const headers = { ...auth, 'Idempotency-Key': 'order-0002' };
      await h.http.post('/wallet/top-ups').set(headers).send(card(2_500)).expect(201);
      const res = await h.http.post('/wallet/top-ups').set(headers).send(card(9_999)).expect(409);
      expect(res.body).toEqual(errorBody(409, 'CONFLICT'));
    });

    it.each(['short', 'has spaces in it', 'x'.repeat(65), 'semi;colon!'])('400 for a malformed key %p', async (key) => {
      const { auth } = await h.signUp('APPROVED');
      const res = await h.http.post('/wallet/top-ups').set({ ...auth, 'Idempotency-Key': key }).send(card()).expect(400);
      expect(res.body.message).toMatch(/Idempotency-Key must be 8-64/);
    });
  });

  describe('400 validation errors (nothing charged)', () => {
    it.each([
      ['an empty body', {}, 'BAD_REQUEST'],
      ['a missing amount', { paymentToken: 'tok_card' }, 'BAD_REQUEST'],
      ['an amount as a string', { amountMinor: '5000', paymentToken: 'tok_card' }, 'BAD_REQUEST'],
      ['a fractional amount', { amountMinor: 50.5, paymentToken: 'tok_card' }, 'BAD_REQUEST'],
      ['a zero amount', { amountMinor: 0, paymentToken: 'tok_card' }, 'BAD_REQUEST'],
      ['a negative amount', { amountMinor: -100, paymentToken: 'tok_card' }, 'BAD_REQUEST'],
      ['an amount below the minimum', { amountMinor: 99, paymentToken: 'tok_card' }, 'VALIDATION'],
      ['an amount above the maximum', { amountMinor: 10_000_001, paymentToken: 'tok_card' }, 'VALIDATION'],
      ['a missing payment token', { amountMinor: 5_000 }, 'BAD_REQUEST'],
      ['an empty payment token', { amountMinor: 5_000, paymentToken: '' }, 'BAD_REQUEST'],
      ['a blank payment token', { amountMinor: 5_000, paymentToken: '   ' }, 'VALIDATION'],
      ['a payment token over 200 characters', { amountMinor: 5_000, paymentToken: 't'.repeat(201) }, 'BAD_REQUEST'],
      ['an unknown field', { amountMinor: 5_000, paymentToken: 'tok_card', currency: 'USD' }, 'BAD_REQUEST'],
      ['a userId in the body', { amountMinor: 5_000, paymentToken: 'tok_card', userId: 'someone-else' }, 'BAD_REQUEST'],
    ])('for %s', async (_label, body, code) => {
      const { auth } = await h.signUp('APPROVED');
      const calls = h.payments.calls.length;
      const res = await h.http.post('/wallet/top-ups').set(auth).send(body).expect(400);
      expect(res.body).toEqual(errorBody(400, code));
      expect(h.payments.calls.length).toBe(calls);
    });
  });

  it('a validation error wins over the KYC check (400, not 403)', async () => {
    const { auth } = await h.signUp('NOT_STARTED');
    await h.http.post('/wallet/top-ups').set(auth).send({ amountMinor: -1, paymentToken: 'tok_card' }).expect(400);
  });
});

describe('GET /wallet/top-ups', () => {
  it('200 with top-ups newest first, limited', async () => {
    const { auth } = await h.signUp('APPROVED');
    h.payments.willRespond(
      { outcome: 'approved', providerReference: 'a' },
      { outcome: 'rejected', reason: 'card_declined' },
      { outcome: 'approved', providerReference: 'c' },
    );
    for (const amount of [100, 200, 300]) await h.http.post('/wallet/top-ups').set(auth).send(card(amount)).expect(201);

    const all = await h.http.get('/wallet/top-ups').set(auth).expect(200);
    expect(all.body.map((t: { amountMinor: number; status: string }) => [t.amountMinor, t.status])).toEqual([
      [300, 'SUCCEEDED'],
      [200, 'FAILED'],
      [100, 'SUCCEEDED'],
    ]);
    expect((await h.http.get('/wallet/top-ups?limit=2').set(auth).expect(200)).body).toHaveLength(2);
  });

  it('200 with an empty list for a new user', async () => {
    const { auth } = await h.signUp();
    await h.http.get('/wallet/top-ups').set(auth).expect(200, []);
  });

  it('400 for a fractional limit', async () => {
    const { auth } = await h.signUp();
    const res = await h.http.get('/wallet/top-ups?limit=1.5').set(auth).expect(400);
    expect(res.body).toEqual(errorBody(400, 'BAD_REQUEST'));
  });

  it.each([
    ['empty', ''],
    // Current behaviour: the global ValidationPipe turns "abc" into NaN, which
    // DefaultValuePipe treats as missing, so it is not a 400.
    ['not a number', 'abc'],
  ])('falls back to the default limit when the limit is %s', async (_label, limit) => {
    const { auth } = await h.signUp();
    await h.http.get(`/wallet/top-ups?limit=${limit}`).set(auth).expect(200);
  });
});
