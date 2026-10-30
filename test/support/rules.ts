/**
 * Helpers for domain unit tests: name the rule a check protects, and drive
 * provider deadlines with Jest's fake timers instead of real waiting.
 */

/**
 * Runs plain Jest assertions and, if one fails, prefixes the failure with
 * the business rule it protects, so the output reads "RULE BROKEN: …" first.
 */
export function expectRule(rule: string, assertions: () => void): void {
  try {
    assertions();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const wrapped = new Error(`RULE BROKEN: ${rule}\n\n${error.message}`);
    wrapped.stack = `${wrapped.message}\n${(error.stack ?? '')
      .split('\n')
      .filter((l) => l.trimStart().startsWith('at '))
      .join('\n')}`;
    throw wrapped;
  }
}

/**
 * Lets `promise` run until it has started its provider deadline timer, so a
 * test can then move fake time forward. Fails loudly if no timer ever starts
 * (for example, if the domain stopped putting a deadline on the provider call).
 */
export async function untilDeadlineStarts(): Promise<void> {
  for (let i = 0; i < 1_000 && jest.getTimerCount() === 0; i += 1) await Promise.resolve();
  if (jest.getTimerCount() === 0) {
    throw new Error('RULE BROKEN: provider calls must run under a deadline, but no deadline timer was started');
  }
}

/** Tracks whether a promise has settled yet, without awaiting it. */
export function track<T>(promise: Promise<T>): { readonly settled: boolean; readonly promise: Promise<T> } {
  const state = { settled: false, promise };
  promise.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );
  return state;
}
