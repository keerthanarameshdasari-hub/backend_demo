import { MockKycProvider } from '../../src/adapters/mock/mock-kyc.provider';
import { ConflictError, KycService, ValidationError } from '../../src/domain';
import { FixedClock, InMemoryKyc, InMemoryStorage, InMemoryUsers, PDF, PNG, SequentialIds } from '../fakes';

const POLICY = { maxDocumentBytes: 1024, allowedMimeTypes: ['image/png', 'application/pdf'], providerTimeoutMs: 30 };

async function setup() {
  const users = new InMemoryUsers();
  const submissions = new InMemoryKyc();
  const storage = new InMemoryStorage();
  const clock = new FixedClock();
  const service = new KycService(users, submissions, storage, new MockKycProvider(), new SequentialIds(), clock, POLICY);
  await users.create({
    id: 'u1',
    email: 'a@example.com',
    fullName: 'A',
    passwordHash: 'x',
    kycStatus: 'NOT_STARTED',
    createdAt: clock.now(),
  });
  return { service, users, submissions, storage };
}

const png = { bytes: PNG, mimeType: 'image/png' };

describe('KycService.submit', () => {
  it('stores the document and approves', async () => {
    const { service, users, storage } = await setup();
    const result = await service.submit({ userId: 'u1', documentType: 'PASSPORT', documentNumber: 'P1234567', document: png });
    expect(result.status).toBe('APPROVED');
    expect(result.documentNumberLast4).toBe('4567');
    expect(storage.objects.has(result.documentKey)).toBe(true);
    expect(result.documentKey).toMatch(/^kyc\/u1\/.+\.png$/);
    expect((await users.findById('u1'))?.kycStatus).toBe('APPROVED');
  });

  it('records a rejection with the provider reason', async () => {
    const { service, users } = await setup();
    const result = await service.submit({ userId: 'u1', documentType: 'NATIONAL_ID', documentNumber: 'REJECT-1', document: png });
    expect(result.status).toBe('REJECTED');
    expect(result.decisionReason).toBe('document_unreadable');
    expect((await users.findById('u1'))?.kycStatus).toBe('REJECTED');
  });

  it('marks TIMED_OUT when the provider hangs, and allows a resubmission', async () => {
    const { service } = await setup();
    const timedOut = await service.submit({ userId: 'u1', documentType: 'PASSPORT', documentNumber: 'timeout-9', document: png });
    expect(timedOut.status).toBe('TIMED_OUT');
    const retry = await service.submit({ userId: 'u1', documentType: 'PASSPORT', documentNumber: 'P7654321', document: png });
    expect(retry.status).toBe('APPROVED');
  });

  it('refuses a new submission once approved', async () => {
    const { service } = await setup();
    await service.submit({ userId: 'u1', documentType: 'PASSPORT', documentNumber: 'P1234567', document: png });
    await expect(
      service.submit({ userId: 'u1', documentType: 'PASSPORT', documentNumber: 'P1234567', document: png }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it.each([
    ['unknown document type', { documentType: 'LIBRARY_CARD' }],
    ['bad document number', { documentNumber: 'no spaces allowed' }],
    ['disallowed mime type', { document: { bytes: PNG, mimeType: 'image/gif' } }],
    ['content not matching mime type', { document: { bytes: PDF, mimeType: 'image/png' } }],
    ['empty file', { document: { bytes: new Uint8Array(), mimeType: 'image/png' } }],
    ['oversized file', { document: { bytes: new Uint8Array(2048).fill(0x89), mimeType: 'image/png' } }],
  ])('rejects %s without storing anything', async (_label, override) => {
    const { service, storage, submissions } = await setup();
    await expect(
      service.submit({ userId: 'u1', documentType: 'PASSPORT', documentNumber: 'P1234567', document: png, ...override }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(storage.objects.size).toBe(0);
    expect(submissions.rows).toHaveLength(0);
  });

  it('records nothing if storing the document fails', async () => {
    const { service, storage, submissions, users } = await setup();
    storage.failNext = true;
    await expect(
      service.submit({ userId: 'u1', documentType: 'PASSPORT', documentNumber: 'P1234567', document: png }),
    ).rejects.toThrow('storage unavailable');
    expect(submissions.rows).toHaveLength(0);
    expect((await users.findById('u1'))?.kycStatus).toBe('NOT_STARTED');
  });
});
