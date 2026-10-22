export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${Math.round(ms / 1000)}s`);
    this.name = 'TimeoutError';
  }
}

export class CancelledError extends Error {
  constructor() {
    super('Request was cancelled');
    this.name = 'CancelledError';
  }
}

/**
 * Runs `fn` with its own abort signal that fires when the parent is cancelled or the timeout
 * elapses, and turns either into a typed error. Every leg of a workflow goes through this.
 */
export async function bounded<T>(
  what: string,
  parent: AbortSignal,
  timeoutMs: number | undefined,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (parent.aborted) throw new CancelledError();
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  parent.addEventListener('abort', onAbort, { once: true });
  const timer =
    timeoutMs && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : undefined;
  try {
    return await fn(controller.signal);
  } catch (err) {
    if (parent.aborted) throw new CancelledError();
    if (timedOut) throw new TimeoutError(what, timeoutMs!);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    parent.removeEventListener('abort', onAbort);
  }
}

export function isCancellation(err: unknown): boolean {
  return err instanceof CancelledError || (err instanceof Error && err.name === 'AbortError');
}
