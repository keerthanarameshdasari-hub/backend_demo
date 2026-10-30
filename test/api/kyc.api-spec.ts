/** POST /kyc and GET /kyc. The KYC provider is a scripted fake. */
import { JPEG, PDF, PNG } from '../fakes';
import { createHarness, errorBody, kycUpload, type Harness } from './harness';

const MAX_BYTES = 2_048;

let h: Harness;
beforeAll(async () => (h = await createHarness({ KYC_MAX_DOCUMENT_BYTES: MAX_BYTES })));
afterAll(async () => h.close());

const submissionBody = {
  id: expect.any(String),
  documentType: 'PASSPORT',
  documentNumberLast4: '4567',
  status: expect.any(String),
  decisionReason: null,
  createdAt: expect.any(String),
  decidedAt: expect.any(String),
};

describe('POST /kyc', () => {
  it('201 APPROVED, stores the file and approves the user', async () => {
    const { userId, auth } = await h.signUp();
    h.kycProvider.willRespond({ outcome: 'approved', providerReference: 'kyc_ok' });
    const res = await kycUpload(h, auth).expect(201);
    expect(res.body).toEqual({ ...submissionBody, status: 'APPROVED' });
    expect(res.body).not.toHaveProperty('documentKey'); // internal storage location stays internal
    expect(res.body).not.toHaveProperty('providerReference');
    expect([...h.storage.objects.keys()].some((k) => k.startsWith(`kyc/${userId}/`))).toBe(true);
    expect((await h.http.get('/users/me').set(auth)).body.kycStatus).toBe('APPROVED');
  });

  it.each([
    ['JPEG', JPEG, 'image/jpeg'],
    ['PDF', PDF, 'application/pdf'],
  ])('accepts a %s document', async (_label, bytes, contentType) => {
    const { auth } = await h.signUp();
    await kycUpload(h, auth, { file: { bytes, contentType } }).expect(201);
  });

  it('201 REJECTED with the provider reason when the provider rejects', async () => {
    const { auth } = await h.signUp();
    h.kycProvider.willRespond({ outcome: 'rejected', providerReference: 'kyc_no', reason: 'document_expired' });
    const res = await kycUpload(h, auth).expect(201);
    expect(res.body).toEqual({ ...submissionBody, status: 'REJECTED', decisionReason: 'document_expired' });
    expect((await h.http.get('/users/me').set(auth)).body.kycStatus).toBe('REJECTED');
  });

  it('201 TIMED_OUT when the provider does not answer in time', async () => {
    const { auth } = await h.signUp();
    h.kycProvider.willRespond('hang');
    const res = await kycUpload(h, auth).expect(201);
    expect(res.body).toMatchObject({ status: 'TIMED_OUT', decisionReason: 'Verification provider did not respond in time' });
  });

  it('409 once approved', async () => {
    const { auth } = await h.signUp();
    await kycUpload(h, auth).expect(201);
    const res = await kycUpload(h, auth).expect(409);
    expect(res.body).toEqual({ statusCode: 409, code: 'CONFLICT', message: 'KYC is already approved' });
  });

  it('409 while a submission is being processed', async () => {
    const { auth } = await h.signUp('PENDING');
    await kycUpload(h, auth).expect(409);
  });

  describe('400 validation errors (nothing stored, provider not called)', () => {
    it.each([
      ['no file', { file: null }, 'BAD_REQUEST', /document file is required/],
      ['a missing documentType', { documentType: '' }, 'BAD_REQUEST', /documentType/],
      ['an unknown documentType', { documentType: 'LIBRARY_CARD' }, 'BAD_REQUEST', /documentType/],
      ['a missing documentNumber', { documentNumber: '' }, 'BAD_REQUEST', /documentNumber/],
      ['a documentNumber over 32 characters', { documentNumber: 'P'.repeat(33) }, 'BAD_REQUEST', /documentNumber/],
      ['a documentNumber with spaces', { documentNumber: 'P 123 456' }, 'VALIDATION', /documentNumber must be 4-32/],
      ['a GIF', { file: { bytes: Buffer.from('GIF89a'), contentType: 'image/gif' } }, 'VALIDATION', /document must be one of/],
      ['a PDF sent as PNG', { file: { bytes: PDF, contentType: 'image/png' } }, 'VALIDATION', /does not match its declared type/],
      ['an empty file', { file: { bytes: new Uint8Array(), contentType: 'image/png' } }, 'VALIDATION', /document is empty/],
    ] as const)('for %s', async (_label, parts, code, message) => {
      const { auth } = await h.signUp();
      const stored = h.storage.objects.size;
      const calls = h.kycProvider.calls.length;
      const res = await kycUpload(h, auth, parts as Parameters<typeof kycUpload>[2]).expect(400);
      expect(res.body).toEqual(errorBody(400, code));
      expect(res.body.message).toMatch(message);
      expect(h.storage.objects.size).toBe(stored);
      expect(h.kycProvider.calls.length).toBe(calls);
    });

    it('for an unknown form field', async () => {
      const { auth } = await h.signUp();
      await kycUpload(h, auth).field('userId', 'someone-else').expect(400);
    });

    it('for a JSON body instead of multipart', async () => {
      const { auth } = await h.signUp();
      await h.http.post('/kyc').set(auth).send({ documentType: 'PASSPORT', documentNumber: 'P1234567' }).expect(400);
    });
  });

  it('413 for a file over the size limit, before the domain sees it', async () => {
    const { auth } = await h.signUp();
    const big = new Uint8Array(MAX_BYTES + 512);
    big.set(PNG);
    const calls = h.kycProvider.calls.length;
    const res = await kycUpload(h, auth, { file: { bytes: big, contentType: 'image/png' } });
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ statusCode: 413 });
    expect(h.kycProvider.calls.length).toBe(calls);
  });

  it('accepts a file exactly at the size limit', async () => {
    const { auth } = await h.signUp();
    const exact = new Uint8Array(MAX_BYTES);
    exact.set(PNG);
    await kycUpload(h, auth, { file: { bytes: exact, contentType: 'image/png' } }).expect(201);
  });
});

describe('GET /kyc', () => {
  it('404 before any submission', async () => {
    const { auth } = await h.signUp();
    const res = await h.http.get('/kyc').set(auth).expect(404);
    expect(res.body).toEqual({ statusCode: 404, code: 'NOT_FOUND', message: 'No KYC submission yet' });
  });

  it('200 with the latest submission', async () => {
    const { auth } = await h.signUp();
    h.kycProvider.willRespond({ outcome: 'rejected', providerReference: 'r', reason: 'blurry' });
    await kycUpload(h, auth, { documentNumber: 'P0000001' }).expect(201);
    const second = await kycUpload(h, auth, { documentNumber: 'P0000002' }).expect(201);
    const res = await h.http.get('/kyc').set(auth).expect(200);
    expect(res.body).toEqual(second.body);
    expect(res.body).toMatchObject({ status: 'APPROVED', documentNumberLast4: '0002' });
  });
});
