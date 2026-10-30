/**
 * KycService against in-memory fakes of every port. No adapters, no I/O, and
 * fake timers drive the provider deadline, so the timeout path takes no real time.
 */
import { ConflictError, KycService, NotFoundError, ValidationError, type KycStatus } from '../../../src/domain';
import {
  aUser,
  FakeKycProvider,
  FixedClock,
  InMemoryKyc,
  InMemoryStorage,
  InMemoryUsers,
  JPEG,
  PDF,
  PNG,
  SequentialIds,
} from '../../fakes';
import { expectRule, track, untilDeadlineStarts } from '../../support/rules';

const TIMEOUT_MS = 5_000;
const POLICY = {
  maxDocumentBytes: 1024,
  allowedMimeTypes: ['image/jpeg', 'image/png', 'application/pdf'],
  providerTimeoutMs: TIMEOUT_MS,
};

async function setup(kycStatus: KycStatus = 'NOT_STARTED') {
  const users = new InMemoryUsers();
  const submissions = new InMemoryKyc();
  const storage = new InMemoryStorage();
  const provider = new FakeKycProvider();
  const clock = new FixedClock(new Date('2026-03-01T10:00:00.000Z'));
  const service = new KycService(users, submissions, storage, provider, new SequentialIds(), clock, POLICY);
  await users.create(aUser({ id: 'u1', fullName: 'Asha Rao', kycStatus }));
  const statusOf = async () => (await users.findById('u1'))?.kycStatus;
  return { service, users, submissions, storage, provider, clock, statusOf };
}

const png = { bytes: PNG, mimeType: 'image/png' };
const passport = (documentNumber = 'P1234567', document = png) => ({
  userId: 'u1',
  documentType: 'PASSPORT',
  documentNumber,
  document,
});

afterEach(() => jest.useRealTimers());

describe('KycService.submit — approval', () => {
  it('stores the document, records an APPROVED submission and approves the user', async () => {
    const { service, storage, provider, statusOf } = await setup();
    provider.willRespond({ outcome: 'approved', providerReference: 'kyc_777' });

    const result = await service.submit(passport('P1234567'));

    expect(result).toMatchObject({
      status: 'APPROVED',
      documentType: 'PASSPORT',
      documentNumberLast4: '4567',
      providerReference: 'kyc_777',
      decisionReason: null,
      documentMimeType: 'image/png',
      documentSizeBytes: PNG.byteLength,
    });
    expect(result.documentKey).toBe(`kyc/u1/${result.id}.png`);
    expect(storage.objects.get(result.documentKey)).toEqual({ body: PNG, contentType: 'image/png' });
    expect(await statusOf()).toBe('APPROVED');
  });

  it('sends the provider the full, trimmed document number and where the file is stored', async () => {
    const { service, provider } = await setup();
    const result = await service.submit(passport('  P1234567  '));
    expect(provider.calls).toHaveLength(1);
    expect(provider.lastCall?.request).toEqual({
      reference: result.id,
      userId: 'u1',
      fullName: 'Asha Rao',
      documentType: 'PASSPORT',
      documentNumber: 'P1234567',
      documentKey: result.documentKey,
    });
  });

  it('keeps only the last four characters of the document number', async () => {
    const { service, submissions } = await setup();
    await service.submit(passport('ABCD-9876'));
    expectRule('only the last 4 characters of a document number are stored (PII minimisation)', () => {
      expect(submissions.rows[0]?.documentNumberLast4).toBe('9876');
      expect(JSON.stringify(submissions.rows)).not.toContain('ABCD-9876');
    });
  });

  it.each([
    ['image/jpeg', JPEG, 'jpg'],
    ['image/png', PNG, 'png'],
    ['application/pdf', PDF, 'pdf'],
  ])('stores a %s document with a .%s key', async (mimeType, bytes, ext) => {
    const { service } = await setup();
    const result = await service.submit(passport('P1234567', { bytes, mimeType }));
    expect(result.documentKey.endsWith(`.${ext}`)).toBe(true);
  });

  it('timestamps creation before the provider call and the decision after it', async () => {
    jest.useFakeTimers({ now: new Date('2026-03-01T10:00:00.000Z') });
    const { service, provider, clock } = await setup();
    provider.willRespond({ after: 1_000, result: { outcome: 'approved', providerReference: 'r' } });

    const running = service.submit(passport());
    await untilDeadlineStarts();
    clock.advance(1_000);
    await jest.advanceTimersByTimeAsync(1_000);
    const result = await running;

    expect(result.createdAt.toISOString()).toBe('2026-03-01T10:00:00.000Z');
    expect(result.decidedAt?.toISOString()).toBe('2026-03-01T10:00:01.000Z');
  });
});

describe('KycService.submit — provider rejects the document', () => {
  it('records REJECTED with the provider reason and reference, and marks the user REJECTED', async () => {
    const { service, provider, statusOf } = await setup();
    provider.willRespond({ outcome: 'rejected', providerReference: 'kyc_rej_1', reason: 'document_expired' });

    const result = await service.submit(passport('P1234567'));
    const userStatus = await statusOf();

    expectRule('a rejection is recorded with the provider reason, and the user becomes REJECTED', () => {
      expect(result.status).toBe('REJECTED');
      expect(result.decisionReason).toBe('document_expired');
      expect(result.providerReference).toBe('kyc_rej_1');
      expect(result.decidedAt).toBeInstanceOf(Date);
      expect(userStatus).toBe('REJECTED');
    });
  });

  it('keeps the uploaded document and the submission for audit', async () => {
    const { service, provider, storage, submissions } = await setup();
    provider.willRespond({ outcome: 'rejected', providerReference: 'r', reason: 'document_unreadable' });
    const result = await service.submit(passport());
    expect(storage.objects.has(result.documentKey)).toBe(true);
    expect(submissions.rows).toHaveLength(1);
    await expect(service.latest('u1')).resolves.toMatchObject({ id: result.id, status: 'REJECTED' });
  });

  it('lets a rejected user submit again, and the new decision replaces the old one', async () => {
    const { service, provider, statusOf } = await setup();
    provider.willRespond(
      { outcome: 'rejected', providerReference: 'r1', reason: 'document_unreadable' },
      { outcome: 'approved', providerReference: 'r2' },
    );

    const first = await service.submit(passport('P0000001'));
    const second = await service.submit(passport('P0000002'));

    expect(first.status).toBe('REJECTED');
    expect(second.status).toBe('APPROVED');
    expect(second.id).not.toBe(first.id);
    expect(await statusOf()).toBe('APPROVED');
    await expect(service.latest('u1')).resolves.toMatchObject({ id: second.id });
  });

  it('refuses a submission from a user already REJECTED-then-APPROVED', async () => {
    const { service, provider } = await setup('REJECTED');
    provider.willRespond({ outcome: 'approved', providerReference: 'ok' });
    await service.submit(passport());
    await expect(service.submit(passport())).toBeRefusedWith(ConflictError, 'an approved user cannot submit KYC again');
  });
});

describe('KycService.submit — provider does not answer in time', () => {
  beforeEach(() => jest.useFakeTimers());

  it('waits until the deadline, then records TIMED_OUT and aborts the provider call', async () => {
    const { service, provider, submissions, statusOf } = await setup();
    provider.willRespond('hang');

    const running = track(service.submit(passport()));
    await untilDeadlineStarts();

    await jest.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    const statusWhileWaiting = await statusOf();
    expectRule('while the provider is thinking, the submission and the user are PENDING', () => {
      expect(running.settled).toBe(false);
      expect(submissions.rows[0]?.status).toBe('PENDING');
      expect(statusWhileWaiting).toBe('PENDING');
    });

    await jest.advanceTimersByTimeAsync(1);
    const result = await running.promise;
    const statusAfter = await statusOf();

    expectRule('a provider that misses the deadline gives TIMED_OUT, with no provider reference', () => {
      expect(result.status).toBe('TIMED_OUT');
      expect(result.providerReference).toBeNull();
      expect(result.decisionReason).toBe('Verification provider did not respond in time');
      expect(provider.lastCall?.signal.aborted).toBe(true);
      expect(statusAfter).toBe('TIMED_OUT');
    });
  });

  it('ignores an approval that arrives after the deadline', async () => {
    const { service, provider, statusOf } = await setup();
    provider.willRespond({ after: TIMEOUT_MS * 2, result: { outcome: 'approved', providerReference: 'late' } });

    const running = service.submit(passport());
    await untilDeadlineStarts();
    await jest.advanceTimersByTimeAsync(TIMEOUT_MS * 3);

    const result = await running;
    const userStatus = await statusOf();
    expectRule('an approval that arrives after the deadline must not approve the user', () => {
      expect(result.status).toBe('TIMED_OUT');
      expect(userStatus).toBe('TIMED_OUT');
    });
  });

  it('treats a provider that reports a timeout itself the same way', async () => {
    jest.useRealTimers();
    const { service, provider } = await setup();
    provider.willRespond({ outcome: 'timeout' });
    await expect(service.submit(passport())).resolves.toMatchObject({ status: 'TIMED_OUT', providerReference: null });
  });

  it('allows a resubmission after a timeout', async () => {
    const { service, provider } = await setup();
    provider.willRespond('hang', { outcome: 'approved', providerReference: 'ok' });

    const first = service.submit(passport());
    await untilDeadlineStarts();
    await jest.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect((await first).status).toBe('TIMED_OUT');

    await expect(service.submit(passport())).resolves.toMatchObject({ status: 'APPROVED' });
  });
});

describe('KycService.submit — who may submit', () => {
  it.each<[KycStatus, string]>([
    ['APPROVED', 'KYC is already approved'],
    ['PENDING', 'A KYC submission is already being processed'],
  ])('refuses a user whose KYC is %s, without storing or calling the provider', async (status, message) => {
    const { service, storage, provider, submissions } = await setup(status);
    await expect(service.submit(passport())).toBeRefusedWith(ConflictError, `no new KYC submission while ${status}`);
    await expect(service.submit(passport())).rejects.toThrow(message);
    expect(storage.objects.size).toBe(0);
    expect(submissions.rows).toHaveLength(0);
    expect(provider.calls).toHaveLength(0);
  });

  it.each<KycStatus>(['NOT_STARTED', 'REJECTED', 'TIMED_OUT'])('accepts a user whose KYC is %s', async (status) => {
    const { service } = await setup(status);
    await expect(service.submit(passport())).resolves.toMatchObject({ status: 'APPROVED' });
  });

  it('refuses an unknown user', async () => {
    const { service, storage } = await setup();
    await expect(service.submit({ ...passport(), userId: 'ghost' })).toBeRefusedWith(
      NotFoundError,
      'only existing users can submit KYC',
    );
    expect(storage.objects.size).toBe(0);
  });
});

describe('KycService.submit — input validation', () => {
  it.each([
    ['an unknown document type', { documentType: 'LIBRARY_CARD' }],
    ['a document number with spaces', { documentNumber: 'no spaces allowed' }],
    ['a 3-character document number', { documentNumber: 'P12' }],
    ['a 33-character document number', { documentNumber: 'P'.repeat(33) }],
    ['a disallowed mime type', { document: { bytes: PNG, mimeType: 'image/gif' } }],
    ['content that does not match its mime type', { document: { bytes: PDF, mimeType: 'image/png' } }],
    ['a JPEG claiming to be a PDF', { document: { bytes: JPEG, mimeType: 'application/pdf' } }],
    ['an empty file', { document: { bytes: new Uint8Array(), mimeType: 'image/png' } }],
    ['a file one byte over the limit', { document: { bytes: padded(PNG, POLICY.maxDocumentBytes + 1), mimeType: 'image/png' } }],
  ])('rejects %s, storing nothing and not calling the provider', async (_label, override) => {
    const { service, storage, submissions, provider, statusOf } = await setup();
    await expect(service.submit({ ...passport(), ...override })).toBeRefusedWith(
      ValidationError,
      `KYC input must be valid (${_label})`,
    );
    expect(storage.objects.size).toBe(0);
    expect(submissions.rows).toHaveLength(0);
    expect(provider.calls).toHaveLength(0);
    expect(await statusOf()).toBe('NOT_STARTED');
  });

  it('rejects a type the policy allows but whose content it cannot verify', async () => {
    const users = new InMemoryUsers();
    await users.create(aUser({ id: 'u1' }));
    const service = new KycService(
      users,
      new InMemoryKyc(),
      new InMemoryStorage(),
      new FakeKycProvider(),
      new SequentialIds(),
      new FixedClock(),
      {
        ...POLICY,
        allowedMimeTypes: [...POLICY.allowedMimeTypes, 'image/gif'],
      },
    );
    const gif = { bytes: new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), mimeType: 'image/gif' };
    await expect(service.submit(passport('P1234567', gif))).toBeRefusedWith(
      ValidationError,
      'documents are accepted only when their bytes can be checked against the declared type',
    );
  });

  it.each([
    ['a 4-character document number', { documentNumber: 'AB-1' }],
    ['a 32-character document number', { documentNumber: 'P'.repeat(32) }],
    ['a file exactly at the limit', { document: { bytes: padded(PNG, POLICY.maxDocumentBytes), mimeType: 'image/png' } }],
  ])('accepts %s', async (_label, override) => {
    const { service } = await setup();
    await expect(service.submit({ ...passport(), ...override })).resolves.toMatchObject({ status: 'APPROVED' });
  });
});

describe('KycService.submit — failures outside the domain', () => {
  it('records nothing if storing the document fails', async () => {
    const { service, storage, submissions, provider, statusOf } = await setup();
    storage.failNext = true;
    await expect(service.submit(passport())).rejects.toThrow('storage unavailable');
    expect(submissions.rows).toHaveLength(0);
    expect(provider.calls).toHaveLength(0);
    expect(await statusOf()).toBe('NOT_STARTED');
  });

  it('passes a provider outage (not a timeout) up to the caller', async () => {
    const { service, provider } = await setup();
    provider.willRespond(new Error('provider 503'));
    await expect(service.submit(passport())).rejects.toThrow('provider 503');
  });
});

describe('KycService.latest', () => {
  it('reports when there is no submission yet', async () => {
    const { service } = await setup();
    await expect(service.latest('u1')).toBeRefusedWith(NotFoundError, 'latest() with no submissions is NOT_FOUND');
  });

  it('returns the most recent submission', async () => {
    const { service, provider } = await setup();
    provider.willRespond({ outcome: 'rejected', providerReference: 'a', reason: 'blurry' });
    await service.submit(passport('P0000001'));
    const second = await service.submit(passport('P0000002'));
    await expect(service.latest('u1')).resolves.toMatchObject({ id: second.id, documentNumberLast4: '0002' });
  });
});

/** `prefix` followed by zeros, `size` bytes long: passes the magic-byte check. */
function padded(prefix: Uint8Array, size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(prefix);
  return bytes;
}
