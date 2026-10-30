import { withDeadline } from '../../../src/domain';
import { track } from '../../support/rules';

afterEach(() => jest.useRealTimers());

describe('withDeadline', () => {
  it('returns the task result when it is fast enough', async () => {
    await expect(withDeadline(100, async () => ({ outcome: 'approved' }))).resolves.toEqual({ outcome: 'approved' });
  });

  it('times out exactly at the deadline, not before, and aborts the task', async () => {
    jest.useFakeTimers();
    let signal: AbortSignal | undefined;
    const running = track(
      withDeadline(1_000, (s) => {
        signal = s;
        return new Promise<{ outcome: 'approved' }>(() => undefined);
      }),
    );

    await jest.advanceTimersByTimeAsync(999);
    expect(running.settled).toBe(false);
    expect(signal?.aborted).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    await expect(running.promise).resolves.toEqual({ outcome: 'timeout' });
    expect(signal?.aborted).toBe(true);
  });

  it('turns the task rejecting because it was aborted into a timeout, not an error', async () => {
    jest.useFakeTimers();
    const running = withDeadline(
      50,
      (signal) =>
        new Promise<{ outcome: 'approved' }>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    );
    await jest.advanceTimersByTimeAsync(50);
    await expect(running).resolves.toEqual({ outcome: 'timeout' });
  });

  it('clears its timer once the task finishes', async () => {
    jest.useFakeTimers();
    await withDeadline(10_000, async () => ({ outcome: 'approved' }));
    expect(jest.getTimerCount()).toBe(0);
  });

  it('propagates real errors from the task', async () => {
    await expect(withDeadline(100, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  });
});
