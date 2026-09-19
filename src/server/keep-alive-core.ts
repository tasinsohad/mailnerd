// Pure-ish leaf for the Supabase keep-alive ping: the shared status record and the ping logic itself, with
// no DB import so it stays cheap to load and easy to unit-test. keep-alive.ts (the Nitro plugin) supplies
// the actual `query`/`rest` calls; system-status.ts reads the status back out for the settings page.

export const KEEP_ALIVE_INTERVAL_MS = 12 * 60 * 60 * 1000;

export interface KeepAliveState {
  lastOkAt: string | null;
  lastError: string | null;
  lastAttemptAt: string | null;
}

// globalThis-pinned like domain-setup.ts's reconcile timer: production loads server modules more than
// once, and a fresh module instance must not forget an earlier ping's outcome.
const globalForKeepAlive = globalThis as unknown as { __keepAliveState?: KeepAliveState };
if (!globalForKeepAlive.__keepAliveState) {
  globalForKeepAlive.__keepAliveState = { lastOkAt: null, lastError: null, lastAttemptAt: null };
}
const state = globalForKeepAlive.__keepAliveState;

function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 300);
}

/**
 * Runs one keep-alive ping: the DB query, then (if given) the REST check. Never throws — the outcome is
 * recorded on the shared state instead. Ok only when the query succeeds and, when `rest` is provided, it
 * also succeeds; `lastError` is the message of whichever check failed first, trimmed to 300 characters.
 */
export async function pingDatabaseOnce(deps: { query(): Promise<void>; rest?: () => Promise<void> }): Promise<void> {
  state.lastAttemptAt = new Date().toISOString();
  try {
    await deps.query();
    if (deps.rest) await deps.rest();
    state.lastOkAt = new Date().toISOString();
    state.lastError = null;
  } catch (err) {
    state.lastError = errorMessage(err);
  }
}

export function getKeepAliveState(): KeepAliveState {
  return { ...state };
}
