import { kycScenario, MockKycProvider } from '../../../src/adapters/mock/mock-kyc.provider';
import { MockPaymentGateway, paymentScenario } from '../../../src/adapters/mock/mock-payment.gateway';

describe('mock provider scenarios', () => {
  it.each([
    ['tok_visa', 'approve'],
    ['tok_reject', 'reject'],
    ['tok_reject_insufficient_funds', 'reject'],
    ['tok_timeout', 'timeout'],
  ])('payment token %s -> %s', (token, scenario) => expect(paymentScenario(token)).toBe(scenario));

  it.each([
    ['P1234567', 'approve'],
    ['REJECT-01', 'reject'],
    ['reject99', 'reject'],
    ['TIMEOUT-1', 'timeout'],
  ])('document %s -> %s', (doc, scenario) => expect(kycScenario(doc)).toBe(scenario));

  it('a hanging payment mock stops when aborted', async () => {
    const controller = new AbortController();
    const pending = new MockPaymentGateway().charge(
      { reference: 'r', amountMinor: 1, currency: 'INR', paymentToken: 'tok_timeout' },
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
  });

  it('a hanging KYC mock rejects at once if already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const request = {
      reference: 'r',
      userId: 'u',
      fullName: 'A',
      documentType: 'PASSPORT' as const,
      documentNumber: 'TIMEOUT-1',
      documentKey: 'k',
    };
    await expect(new MockKycProvider().verify(request, controller.signal)).rejects.toThrow('aborted');
  });
});
