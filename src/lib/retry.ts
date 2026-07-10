// Bounded transient-retry with exponential backoff + full jitter. Pure and dependency-free so it
// can wrap any flaky external call (Cloudflare record creates, Mailcow writes) and be unit-tested.

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

// Full-jitter exponential backoff: a random delay in [exp/2, exp) where exp = base * 2^attempt,
// capped at `max`. Jitter spreads retries so a burst of parallel calls doesn't resynchronise and
// hammer the API in lockstep.
export function retryDelayMs(attempt: number, base = 500, max = 8000): number {
  const exp = Math.min(max, base * 2 ** attempt);
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}

export interface RetryOpts {
  attempts?: number; // total tries (default 4)
  base?: number; // backoff base ms (default 500)
  max?: number; // backoff cap ms (default 8000)
  // Optional extra minimum delay for a given result (e.g. honour an HTTP Retry-After header).
  extraDelayMs?: (result: unknown) => number;
}

// Run `attempt()`; if it throws OR `retryable(result)` is true, back off and try again up to
// `attempts` times. Returns the last result, or throws the last error if every attempt threw.
export async function retryTransient<T>(
  attempt: () => Promise<T>,
  retryable: (result: T) => boolean,
  opts: RetryOpts = {},
): Promise<T> {
  const attempts = opts.attempts ?? 4;
  let lastErr: unknown;
  let lastRes: T | undefined;
  let haveRes = false;

  for (let i = 0; i < attempts; i++) {
    let extra = 0;
    try {
      const res = await attempt();
      haveRes = true;
      lastRes = res;
      if (i === attempts - 1 || !retryable(res)) return res;
      extra = opts.extraDelayMs ? opts.extraDelayMs(res) : 0;
    } catch (err) {
      lastErr = err;
      haveRes = false;
      if (i === attempts - 1) throw err;
    }
    await sleep(Math.max(retryDelayMs(i, opts.base, opts.max), extra));
  }

  if (haveRes) return lastRes as T;
  throw lastErr;
}
