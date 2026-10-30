/**
 * Shared behaviour for the mock providers. A mock looks at a field of its
 * input and either answers immediately or hangs until aborted, so tests and
 * local demos can drive every path: approve, reject and timeout.
 */
export type MockScenario = 'approve' | 'reject' | 'timeout';

/** Resolves never; rejects as soon as `signal` aborts. Simulates a provider that stopped answering. */
export function hangUntilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new Error('aborted'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
  });
}
