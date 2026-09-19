// Nitro plugin (registered in vite.config.ts): keeps the Supabase project awake. A free Supabase project
// pauses after about a week without activity; pinging the database — and, when configured, the REST API —
// every 12 hours keeps that from happening, so nobody has to wait through a cold resume the next time they
// open the app.
//
// Production only: in dev the app already runs often enough on its own, and scheduling this under Vite's
// dev server would just add log noise on every restart.
//
// vite.config.ts loads some server modules at config time, so this file stays free of "@/..." imports
// (relative paths only) and imports the database lazily, inside the timer callback, so requiring this
// module never touches the DB. keep-alive-core.ts holds the actual ping bookkeeping and has no DB imports
// of its own, so it's safe to import statically here.
import { KEEP_ALIVE_INTERVAL_MS, pingDatabaseOnce, getKeepAliveState } from "./keep-alive-core";

const BOOT_DELAY_MS = 30_000;

async function ping(): Promise<void> {
  const [{ getDb }, { sql }] = await Promise.all([import("../lib/db"), import("drizzle-orm")]);

  // Trailing slash(es) would otherwise double up before /rest/v1/ (e.g. "https://x.supabase.co//rest/v1/").
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const rest =
    url && key
      ? async () => {
          const res = await fetch(`${url}/rest/v1/`, {
            headers: { apikey: key, Authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(15000),
          });
          // Never log the key itself, even on failure.
          if (!res.ok) throw new Error(`Supabase REST answered HTTP ${res.status}`);
        }
      : undefined;

  await pingDatabaseOnce({
    query: async () => {
      const db = getDb();
      await db.execute(sql`select 1`);
    },
    rest,
  });

  const state = getKeepAliveState();
  console.log(state.lastError ? `[keep-alive] failed: ${state.lastError}` : "[keep-alive] ok");
}

export default function keepAlive() {
  if (process.env.NODE_ENV !== "production") return;

  // globalThis-pinned like domain-setup.ts's reconcile timer, in case this module is ever loaded more than
  // once in the same process: a second load must not schedule a second set of timers.
  const globalForKeepAlive = globalThis as unknown as { __keepAliveTimer?: NodeJS.Timeout };
  if (globalForKeepAlive.__keepAliveTimer) return;

  globalForKeepAlive.__keepAliveTimer = setTimeout(() => {
    ping().catch((err) => console.error("[keep-alive] unexpected error:", err));
    setInterval(() => {
      ping().catch((err) => console.error("[keep-alive] unexpected error:", err));
    }, KEEP_ALIVE_INTERVAL_MS).unref();
  }, BOOT_DELAY_MS);
  globalForKeepAlive.__keepAliveTimer.unref();
}
