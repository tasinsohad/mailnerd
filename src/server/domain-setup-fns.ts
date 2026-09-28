// Server functions for setup runs and the job setup board: start a run for one domain or a whole job,
// answer the server-choice prompt, and read the board. Thin wrappers around domain-setup.ts, which does the
// real work and owns the locks.
//
// createServerFn exports only: this module (like provisioning.ts) statically imports domain-setup.ts, which
// pulls in SSH and the queue, so it must never be imported by browser code. Every handler is workspace-scoped
// by context.userId: a domain or batch that isn't in the caller's workspace is reported as not found, never
// as another account's data.

import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth";
import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import { domains, domainBatches } from "@/lib/db/schema";
import { enqueueDomainSetup, reconcileStuckSetupRuns } from "./domain-setup";
import { isActive, type SetupState } from "@/lib/setup-state";
import { retryStep } from "@/lib/setup-status";

const fromStepSchema = z.enum(["dns", "server", "mailboxes", "dkim"]);
const serverChoiceSchema = z.enum(["reuse", "reinstall"]);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const setupBoardColumns = {
  id: domains.id,
  name: domains.name,
  ipAddress: domains.ipAddress,
  status: domains.status,
  setupState: domains.setupState,
  mailboxProgress: domains.mailboxProgress,
};

// Start a setup run for one domain. Refused (ok: false) while a run for it is already queued, running or
// waiting for the user, or while its server is busy — enqueueDomainSetup's own message says which.
export const startDomainSetup = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        domainId: z.string().uuid(),
        fromStep: fromStepSchema.optional(),
        serverChoice: serverChoiceSchema.optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { db, userId } = (context as any) as { db: any; userId: string };

    const domain = await db.query.domains.findFirst({
      where: and(eq(domains.id, data.domainId), eq(domains.userId, userId)),
      columns: { id: true, userId: true },
    });
    if (!domain) return { ok: false as const, error: "Domain not found" };

    try {
      const { runId } = await enqueueDomainSetup({
        domainId: domain.id,
        userId: domain.userId,
        fromStep: data.fromStep,
        serverChoice: data.serverChoice,
      });
      return { ok: true as const, runId };
    } catch (err) {
      return { ok: false as const, error: errorMessage(err) };
    }
  });

// Start every domain in a job that isn't already finished or in flight. Domains are started one at a time,
// each error collected instead of stopping the rest.
export const startJobSetup = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => z.object({ batchId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { db, userId } = (context as any) as { db: any; userId: string };

    const batch = await db.query.domainBatches.findFirst({
      where: and(eq(domainBatches.id, data.batchId), eq(domainBatches.userId, userId)),
      columns: { id: true },
    });
    if (!batch) throw new Error("Job not found");

    const rows: { id: string; userId: string; name: string; status: string; setupState: unknown }[] =
      await db
        .select({
          id: domains.id,
          userId: domains.userId,
          name: domains.name,
          status: domains.status,
          setupState: domains.setupState,
        })
        .from(domains)
        .where(and(eq(domains.batchId, data.batchId), eq(domains.userId, userId)));

    let started = 0;
    let skipped = 0;
    const errors: { domain: string; error: string }[] = [];

    for (const row of rows) {
      const state = row.setupState as SetupState | null;
      const alreadyDone = state?.status === "done";
      const readyWithNoRun = row.status === "ready" && !state;
      if (isActive(state) || alreadyDone || readyWithNoRun) {
        skipped++;
        continue;
      }
      try {
        // A domain whose last run failed resumes at the step it failed on (keeping the server choice it
        // already made, if any), instead of starting the whole run over from DNS.
        if (state?.status === "failed") {
          await enqueueDomainSetup({
            domainId: row.id,
            userId: row.userId,
            fromStep: retryStep(state),
            serverChoice: state.serverChoice,
          });
        } else {
          await enqueueDomainSetup({ domainId: row.id, userId: row.userId });
        }
        started++;
      } catch (err) {
        errors.push({ domain: row.name, error: errorMessage(err) });
      }
    }

    return { ok: true as const, started, skipped, errors };
  });

// Answer the server-choice prompt a waiting run left behind, and queue the next pass from the server step.
export const decideServerChoice = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) =>
    z.object({ domainId: z.string().uuid(), choice: serverChoiceSchema }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { db, userId } = (context as any) as { db: any; userId: string };

    const domain = await db.query.domains.findFirst({
      where: and(eq(domains.id, data.domainId), eq(domains.userId, userId)),
      columns: { id: true, userId: true, setupState: true },
    });
    if (!domain) return { ok: false as const, error: "Domain not found" };

    const state = domain.setupState as SetupState | null;
    if (state?.status !== "waiting" || state.waiting?.kind !== "server-choice") {
      return { ok: false as const, error: "This domain isn't waiting for a server choice." };
    }

    try {
      // enqueueDomainSetup itself starts a fresh queued run from "server" (dns is left done, the server step
      // pending) with this choice: allowWaiting lets it proceed past the current "waiting" state instead of
      // treating it as busy.
      await enqueueDomainSetup({
        domainId: domain.id,
        userId: domain.userId,
        fromStep: "server",
        serverChoice: data.choice,
        allowWaiting: true,
      });
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: errorMessage(err) };
    }
  });

// Re-check the reverse-DNS (FCrDNS) gate a waiting run left behind, and queue the next pass from the
// mailboxes step. The gate runs again on that pass: if the PTR now passes, mailboxes are created;
// otherwise the run waits again with a fresh message.
export const recheckFcrdns = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => z.object({ domainId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { db, userId } = (context as any) as { db: any; userId: string };

    const domain = await db.query.domains.findFirst({
      where: and(eq(domains.id, data.domainId), eq(domains.userId, userId)),
      columns: { id: true, userId: true, setupState: true },
    });
    if (!domain) return { ok: false as const, error: "Domain not found" };

    const state = domain.setupState as SetupState | null;
    if (state?.status !== "waiting" || state.waiting?.kind !== "fcrdns") {
      return { ok: false as const, error: "This domain isn't waiting on a reverse-DNS check." };
    }

    try {
      // Re-enter from the mailboxes step (dns + server are already done); allowWaiting lets it proceed
      // past the current "waiting" state. The mailboxes step re-runs the FCrDNS gate first.
      await enqueueDomainSetup({
        domainId: domain.id,
        userId: domain.userId,
        fromStep: "mailboxes",
        serverChoice: state.serverChoice,
        allowWaiting: true,
      });
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: errorMessage(err) };
    }
  });

// The job setup board: every domain of one job, in name order, with its setup run and mailbox progress.
export const getJobSetupBoard = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => z.object({ batchId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { db, userId } = (context as any) as { db: any; userId: string };

    // Resume any run left stuck by a restart before the board is read (only on the production server,
    // SETUP_RECONCILE=1; elsewhere it only refreshes this process's own runs). Rate-limited to about once a
    // minute per process inside reconcileStuckSetupRuns itself; fired without waiting so a slow check never
    // delays the board.
    void reconcileStuckSetupRuns().catch((err) =>
      console.error("[getJobSetupBoard] reconcileStuckSetupRuns failed:", err),
    );

    const batch = await db.query.domainBatches.findFirst({
      where: and(eq(domainBatches.id, data.batchId), eq(domainBatches.userId, userId)),
      columns: { id: true, name: true },
    });
    if (!batch) throw new Error("Job not found");

    const rows = await db
      .select(setupBoardColumns)
      .from(domains)
      .where(and(eq(domains.batchId, data.batchId), eq(domains.userId, userId)))
      .orderBy(asc(domains.name));

    return { batch, domains: rows };
  });

// The same row getJobSetupBoard shows, for one domain, or null when it isn't in this workspace.
export const getDomainSetup = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => z.object({ domainId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { db, userId } = (context as any) as { db: any; userId: string };

    const rows = await db
      .select(setupBoardColumns)
      .from(domains)
      .where(and(eq(domains.id, data.domainId), eq(domains.userId, userId)))
      .limit(1);
    return rows[0] ?? null;
  });
