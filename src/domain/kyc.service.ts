import { withDeadline } from './deadline';
import { ConflictError, NotFoundError, ValidationError } from './errors';
import { DOCUMENT_TYPES, type DocumentType, type KycSubmission } from './model';
import type { Clock, FileStorage, IdGenerator, KycProvider, KycSubmissionRepository, UserRepository } from './ports';

export interface KycPolicy {
  maxDocumentBytes: number;
  allowedMimeTypes: readonly string[];
  providerTimeoutMs: number;
}

export interface SubmitKycInput {
  userId: string;
  documentType: string;
  documentNumber: string;
  document: { bytes: Uint8Array; mimeType: string };
}

const DOCUMENT_NUMBER = /^[A-Za-z0-9-]{4,32}$/;

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/pdf': 'pdf',
};

export class KycService {
  constructor(
    private readonly users: UserRepository,
    private readonly submissions: KycSubmissionRepository,
    private readonly storage: FileStorage,
    private readonly provider: KycProvider,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly policy: KycPolicy,
  ) {}

  async submit(input: SubmitKycInput): Promise<KycSubmission> {
    const documentType = this.parseDocumentType(input.documentType);
    const documentNumber = input.documentNumber.trim();
    if (!DOCUMENT_NUMBER.test(documentNumber)) {
      throw new ValidationError('documentNumber must be 4-32 letters, digits or dashes');
    }
    this.validateDocument(input.document);

    const user = await this.users.findById(input.userId);
    if (!user) throw new NotFoundError('User not found');
    if (user.kycStatus === 'APPROVED') throw new ConflictError('KYC is already approved');
    if (user.kycStatus === 'PENDING') throw new ConflictError('A KYC submission is already being processed');

    const id = this.ids.next();
    const extension = EXTENSIONS[input.document.mimeType] ?? 'bin';
    const documentKey = `kyc/${user.id}/${id}.${extension}`;

    // Store the document first: if this fails nothing has been recorded yet.
    await this.storage.put(documentKey, input.document.bytes, input.document.mimeType);

    const submission = await this.submissions.create({
      id,
      userId: user.id,
      documentType,
      documentNumberLast4: documentNumber.slice(-4),
      documentKey,
      documentMimeType: input.document.mimeType,
      documentSizeBytes: input.document.bytes.byteLength,
      status: 'PENDING',
      providerReference: null,
      decisionReason: null,
      createdAt: this.clock.now(),
      decidedAt: null,
    });
    await this.users.updateKycStatus(user.id, 'PENDING');

    const result = await withDeadline(this.policy.providerTimeoutMs, (signal) =>
      this.provider.verify(
        { reference: id, userId: user.id, fullName: user.fullName, documentType, documentNumber, documentKey },
        signal,
      ),
    );

    const decidedAt = this.clock.now();
    const decided =
      result.outcome === 'approved'
        ? { status: 'APPROVED' as const, providerReference: result.providerReference, decisionReason: null }
        : result.outcome === 'rejected'
          ? { status: 'REJECTED' as const, providerReference: result.providerReference, decisionReason: result.reason }
          : { status: 'TIMED_OUT' as const, providerReference: null, decisionReason: 'Verification provider did not respond in time' };

    const updated = await this.submissions.update(id, { ...decided, decidedAt });
    await this.users.updateKycStatus(user.id, decided.status);
    return updated;
  }

  async latest(userId: string): Promise<KycSubmission> {
    const submission = await this.submissions.findLatestByUser(userId);
    if (!submission) throw new NotFoundError('No KYC submission yet');
    return submission;
  }

  private parseDocumentType(value: string): DocumentType {
    if ((DOCUMENT_TYPES as readonly string[]).includes(value)) return value as DocumentType;
    throw new ValidationError(`documentType must be one of ${DOCUMENT_TYPES.join(', ')}`);
  }

  private validateDocument(document: SubmitKycInput['document']): void {
    if (document.bytes.byteLength === 0) throw new ValidationError('document is empty');
    if (document.bytes.byteLength > this.policy.maxDocumentBytes) {
      throw new ValidationError(`document must be at most ${this.policy.maxDocumentBytes} bytes`);
    }
    if (!this.policy.allowedMimeTypes.includes(document.mimeType)) {
      throw new ValidationError(`document must be one of ${this.policy.allowedMimeTypes.join(', ')}`);
    }
    if (!matchesMagicBytes(document.bytes, document.mimeType)) {
      throw new ValidationError('document content does not match its declared type');
    }
  }
}

/** Cheap check that the bytes really are what the client claims. */
function matchesMagicBytes(bytes: Uint8Array, mimeType: string): boolean {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  switch (mimeType) {
    case 'image/jpeg':
      return starts(0xff, 0xd8, 0xff);
    case 'image/png':
      return starts(0x89, 0x50, 0x4e, 0x47);
    case 'application/pdf':
      return starts(0x25, 0x50, 0x44, 0x46); // %PDF
    default:
      return false;
  }
}
