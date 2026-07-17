// Bounded-concurrency fan-out for health sweeps. Kept in its own leaf module — with NO imports —
// on purpose: `mapLimit` is a plain runtime export (the sweep uses it, and a unit test imports it),
// and health-actions.ts statically imports the SSH health engine (health-server.ts → @/lib/ssh →
// ssh2 + node:net/tls). If this lived in health-actions.ts, that plain export would turn the module
// "mixed" — createServerFns AND runtime values — which TanStack Start can't stub out of the client
// bundle, dragging ssh2 into the Domains/Jobs pages (the exact leak server-fixes.ts:41 documents).
// A pure module keeps health-actions.ts a stubbable server-fn-only module.

// How many checks a sweep runs at once. Domains are DNS/HTTP-bound so they fan out wider; servers
// each hold an SSH session and run real commands, so they stay tighter.
export const DOMAIN_CONCURRENCY = 8;
export const SERVER_CONCURRENCY = 4;

// Run tasks with bounded concurrency. A sweep used to await each domain, then each server, strictly
// one at a time: every check is mostly waiting on DNS/SSH/HTTP, so on a real account that serialised
// into minutes of dead time ("Re-check all" spinning with nothing to show). The cap keeps us from
// opening an unbounded number of SSH sessions / API calls at once.
export async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<unknown>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch {
        /* one bad domain/server must not abort the sweep */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
