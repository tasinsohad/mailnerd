// Retry rules of a domain's setup run (src/server/domain-setup.ts), shared by the BullMQ worker and the
// in-process fallback in queue.ts. Leaf module (no imports) so tests can load it without the SSH/DB stack.

/** Attempts per setup run: the same as the queue's default job options. */
export const SETUP_ATTEMPTS = 3;
/** First wait between attempts; it doubles after each failure (30 s, then 60 s), like BullMQ's exponential backoff. */
export const RETRY_BASE_MS = 30_000;
/** How long a run waits before checking again when another setup is using its server. */
export const SERVER_BUSY_RECHECK_MS = 60_000;

/** Whether the attempt now running is the last: `attemptsMade` attempts already failed before it. */
export function isFinalAttempt(attemptsMade: number, attempts: number | undefined): boolean {
  return attemptsMade + 1 >= (attempts ?? 1);
}

/** The wait after `failedAttempts` failed attempts, before the next one. */
export function retryDelayMs(failedAttempts: number, baseMs = RETRY_BASE_MS): number {
  return baseMs * 2 ** Math.max(0, failedAttempts - 1);
}

/**
 * Another setup holds the server's IP (domain-locks.ts claimServer). Not a failed attempt: the run waits
 * SERVER_BUSY_RECHECK_MS and tries again, the way a job waits when another run holds its domain.
 */
export class ServerBusyError extends Error {
  constructor(readonly ip: string) {
    super(`Another setup is using server ${ip}. This one waits for it to finish.`);
    this.name = "ServerBusyError";
  }
}

// By name as well as class, in case the module is loaded twice (see events.ts on module registries).
export function isServerBusyError(err: unknown): err is ServerBusyError {
  return err instanceof ServerBusyError || (err instanceof Error && err.name === "ServerBusyError");
}

/**
 * Another run holds the domain itself (domain-locks.ts claimDomain) when an attempt starts: this run's own
 * claim went stale and was taken, for example by a manual mailbox run. Not a failed attempt either: the run
 * waits SERVER_BUSY_RECHECK_MS and tries again.
 */
export class DomainBusyError extends Error {
  constructor(readonly running: string) {
    super(`Waiting for the ${running} on this domain to finish before continuing.`);
    this.name = "DomainBusyError";
  }
}

export function isDomainBusyError(err: unknown): err is DomainBusyError {
  return err instanceof DomainBusyError || (err instanceof Error && err.name === "DomainBusyError");
}

/** Wait and try the same attempt again later: another run has the server or the domain. */
export function isBusyWait(err: unknown): err is ServerBusyError | DomainBusyError {
  return isServerBusyError(err) || isDomainBusyError(err);
}

/** The domain's setup_state now belongs to a newer run: this run stops without writing anything more. */
export class RunSupersededError extends Error {
  constructor() {
    super("A newer setup run replaced this one.");
    this.name = "RunSupersededError";
  }
}

export function isRunSupersededError(err: unknown): err is RunSupersededError {
  return (
    err instanceof RunSupersededError || (err instanceof Error && err.name === "RunSupersededError")
  );
}

/**
 * The in-process fallback's retry loop, matching the queue: up to `attempts` attempts with 30 s / 60 s
 * waits between failures. A busy server or domain waits and tries the same attempt again without counting
 * it. Returns the first successful result, or throws the last attempt's error.
 */
export async function runAttempts<T>(opts: {
  attempts: number;
  run: (attempt: number, finalAttempt: boolean) => Promise<T>;
  sleep: (ms: number) => Promise<void>;
  onRetry?: (failedAttempt: number, delayMs: number, err: unknown) => void;
  onBusy?: (err: ServerBusyError | DomainBusyError, waitMs: number) => void;
}): Promise<T> {
  let attempt = 1;
  for (;;) {
    const finalAttempt = isFinalAttempt(attempt - 1, opts.attempts);
    try {
      return await opts.run(attempt, finalAttempt);
    } catch (err) {
      if (isBusyWait(err)) {
        opts.onBusy?.(err, SERVER_BUSY_RECHECK_MS);
        await opts.sleep(SERVER_BUSY_RECHECK_MS);
        continue;
      }
      if (finalAttempt) throw err;
      const delay = retryDelayMs(attempt);
      opts.onRetry?.(attempt, delay, err);
      await opts.sleep(delay);
      attempt++;
    }
  }
}
