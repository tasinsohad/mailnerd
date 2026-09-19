// Nitro plugin (registered in vite.config.ts): load the server-setup queue as soon as the production
// server starts. queue.ts creates the BullMQ worker as a side effect of being imported, but the production
// build only imported it when a provisioning function was first called, so after every restart or
// redeploy, queued and retrying setups sat idle until someone clicked "Provision". Loading it also starts
// the check for setup runs an earlier process left unfinished (30 s after boot, then about once a minute:
// domain-setup.ts reconcileStuckSetupRuns).
//
// Production only: in dev, server functions load queue.ts on demand inside Vite's own process, and the
// run locks and log events it shares (domain-locks.ts, events.ts) must live in that same process.
export default function startQueueWorker() {
  if (process.env.NODE_ENV !== "production") return;
  import("./queue").catch((err) => {
    console.error("[queue] Couldn't start the server-setup worker:", err);
  });
}
