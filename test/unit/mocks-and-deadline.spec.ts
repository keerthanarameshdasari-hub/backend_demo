import { kycScenario } from '../../src/adapters/mock/mock-kyc.provider';
import { MockPaymentGateway, paymentScenario } from '../../src/adapters/mock/mock-payment.gateway';
import { withDeadline } from '../../src/domain';

describe('mock scenarios', () => {
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

  it('a hanging mock stops when aborted', async () => {
    const controller = new AbortController();
    const pending = new MockPaymentGateway().charge(
      { reference: 'r', amountMinor: 1, currency: 'INR', paymentToken: 'tok_timeout' },
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
  });
});

describe('withDeadline', () => {
  it('returns the task result when it is fast enough', async () => {
    await expect(withDeadline(100, async () => ({ outcome: 'approved' }))).resolves.toEqual({ outcome: 'approved' });
  });

  it('returns timeout and aborts the task when it is too slow', async () => {
    let aborted = false;
    const result = await withDeadline(10, (signal) => {
      signal.addEventListener('abort', () => (aborted = true));
      return new Promise<{ outcome: 'approved' }>(() => undefined);
    });
    expect(result).toEqual({ outcome: 'timeout' });
    expect(aborted).toBe(true);
  });

  it('propagates real errors from the task', async () => {
    await expect(withDeadline(100, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  });
});
