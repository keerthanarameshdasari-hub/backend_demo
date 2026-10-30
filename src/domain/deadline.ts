/**
 * Runs `task` with a hard deadline. When the deadline passes the task's
 * AbortSignal fires and the result is `{ outcome: 'timeout' }`, so callers
 * treat a slow provider exactly like a provider that reported a timeout.
 *
 * Plain timers only; no framework dependency.
 */
export async function withDeadline<T extends { outcome: string }>(
  timeoutMs: number,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T | { outcome: 'timeout' }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<{ outcome: 'timeout' }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ outcome: 'timeout' });
    }, timeoutMs);
  });

  // If the task rejects *because* we aborted it, that rejection is expected;
  // swallow it so it never surfaces as an unhandled rejection.
  const run = task(controller.signal).catch((error: unknown) => {
    if (controller.signal.aborted) return { outcome: 'timeout' as const };
    throw error;
  });

  try {
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
