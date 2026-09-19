import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "@/lib/auth";

// Ops status for the admin: right now just the Supabase keep-alive ping (keep-alive.ts / keep-alive-core.ts).
//
// Only createServerFn exports here (and types): see the note in session.ts.

export const getKeepAliveStatus = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(async () => {
    const { getKeepAliveState, KEEP_ALIVE_INTERVAL_MS } = await import("./keep-alive-core");
    return { ...getKeepAliveState(), intervalHours: KEEP_ALIVE_INTERVAL_MS / (60 * 60 * 1000) };
  });
