import type { PaymentGateway, PaymentRequest, PaymentResult } from '../../domain';
import { hangUntilAborted, type MockScenario } from './scenario';

/**
 * Picks the outcome from the payment token, like a card network's test cards:
 *   tok_reject...   -> rejected (card declined)
 *   tok_timeout...  -> never answers (the caller's deadline turns it into a timeout)
 *   anything else   -> approved
 */
export function paymentScenario(paymentToken: string): MockScenario {
  if (paymentToken.startsWith('tok_reject')) return 'reject';
  if (paymentToken.startsWith('tok_timeout')) return 'timeout';
  return 'approve';
}

export class MockPaymentGateway implements PaymentGateway {
  async charge(request: PaymentRequest, signal: AbortSignal): Promise<PaymentResult> {
    switch (paymentScenario(request.paymentToken)) {
      case 'reject':
        return { outcome: 'rejected', reason: 'card_declined' };
      case 'timeout':
        return hangUntilAborted(signal);
      case 'approve':
        return { outcome: 'approved', providerReference: `mockpay_${request.reference}` };
    }
  }
}
