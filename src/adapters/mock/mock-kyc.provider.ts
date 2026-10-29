import type { KycProvider, KycResult, KycVerificationRequest } from '../../domain';
import { hangUntilAborted, type MockScenario } from './scenario';

/**
 * Picks the outcome from the document number (case-insensitive):
 *   REJECT...   -> rejected
 *   TIMEOUT...  -> never answers (the caller's deadline turns it into a timeout)
 *   anything else -> approved
 */
export function kycScenario(documentNumber: string): MockScenario {
  const value = documentNumber.toUpperCase();
  if (value.startsWith('REJECT')) return 'reject';
  if (value.startsWith('TIMEOUT')) return 'timeout';
  return 'approve';
}

export class MockKycProvider implements KycProvider {
  async verify(request: KycVerificationRequest, signal: AbortSignal): Promise<KycResult> {
    const providerReference = `mockkyc_${request.reference}`;
    switch (kycScenario(request.documentNumber)) {
      case 'reject':
        return { outcome: 'rejected', providerReference, reason: 'document_unreadable' };
      case 'timeout':
        return hangUntilAborted(signal);
      case 'approve':
        return { outcome: 'approved', providerReference };
    }
  }
}
