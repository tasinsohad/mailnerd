// The real work behind a domain's setup run: DNS → server → mailboxes → DKIM (the order and rules are in
// domain-setup-core.ts). The run's state lives in domains.setup_state, so any device sees the same board
// and a queued run survives an app restart.
//
// Plain server-only module (no createServerFn). Server-function modules such as provisioning.ts import it;
// browser code must not. It imports queue.ts statically (the install, the log, the queue). queue.ts loads
// this module only through dynamic imports (in its worker, its failed-job handler and its stuck-run timer),
// so there is no static import cycle.

import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { getDb } from "../lib/db";
import { domains, plannedInboxes } from "../lib/db/schema";
import { SSHManager } from "../lib/ssh";
import {
  newSetupState,
  mergeSetupState,
  STEP_LABELS,
  type ServerChoice,
  type SetupState,
  type SetupStep,
} from "../lib/setup-state";
import {
  isOwnUnfinishedInstall,
  otherDomainsOnServer,
  runDomainSetup,
  type SetupDeps,
} from "./domain-setup-core";
import {
  DomainBusyError,
  RunSupersededError,
  ServerBusyError,
  isServerBusyError,
  isRunSupersededError,
} from "./setup-attempts";
import {
  activeRun,
  claimDomain,
  releaseDomain,
  busyMessage,
  claimServer,
  releaseServer,
  serverIpKey,
  WAITING_FOR_CHOICE_MESSAGE,
} from "./domain-locks";
import {
  interruptedRunPatch,
  isInFlight,
  isStuckSetupRun,
  reconcileDue,
  resumeStep,
  reuseMustWait,
  takesOverStuckRuns,
} from "./setup-recovery";
import {
  checkedServerTarget,
  createDomainLogger,
  domainIdsInSetupQueue,
  installMailcowOnServer,
  startDomainSetupJob,
  tryDecrypt,
  type LogFn,
} from "./queue";
import { resolveAndSaveCfZoneId } from "./cloudflare";
import { pushDns, unproxyDns, ensureMailDomains, createMailboxes, syncDkim } from "./pipeline";
import { readMailcowConfigOverSsh, ensureWorkingApiKey } from "./mailcow-key";
import { mailcowListAll } from "./mailcow-helpers";
import { doh, isCloudflareIp } from "./health-net";
import { fcrdnsVerdict } from "./health-checks";
import { assertServerNotProtected } from "./protected-servers";
import { createMailboxProgressWriter } from "./mailbox-progress-store";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Domain = any;

const MAILCOW_CONF = "/opt/mailcow-dockerized/mailcow.conf";

export async function loadSetupState(db: Db, domainId: string): Promise<SetupState | null> {
  const row = await db.query.domains.findFirst({
    where: eq(domains.id, domainId),
    columns: { setupState: true },
  });
  return (row?.setupState as SetupState | null | undefined) ?? null;
}

/**
 * Merge `patch` into run `runId`'s saved setup state and save it. Writes only while the domain's
 * setup_state still belongs to that run (the UPDATE is conditional on its runId), so a run that was replaced
 * can never overwrite its successor. Then it writes nothing, doesn't throw, and returns the state as it is
 * now (null if there is none): callers compare its runId with their own to learn they were superseded.
 */
export async function saveSetupState(
  db: Db,
  domainId: string,
  runId: string,
  patch: Partial<SetupState>,
): Promise<SetupState | null> {
  const prev = await loadSetupState(db, domainId);
  if (prev?.runId !== runId) return prev;
  const next = mergeSetupState(prev, patch, new Date().toISOString());
  const written: unknown[] = await db
    .update(domains)
    .set({ setupState: next })
    .where(and(eq(domains.id, domainId), sql`${domains.setupState}->>'runId' = ${runId}`))
    .returning({ id: domains.id });
  // Replaced between the read and the write: report the state that replaced it.
  return written.length ? next : loadSetupState(db, domainId);
}

/**
 * Start a setup run for a domain: on the queue, or in-process when Redis isn't answering.
 *
 * Refused while another run holds the domain (a setup, or a manual mailbox run), while a job for it is still
 * in the queue, while its last run is still queued or running, and while that run waits for the user's server
 * choice (unless `allowWaiting`: the answer to that choice starts the next pass).
 *
 * `replaceStaleRunId` is for reconcileStuckSetupRuns only: it lets a new run replace that run's state, which
 * still says queued or running although nothing is behind it any more.
 */
export async function enqueueDomainSetup(opts: {
  domainId: string;
  userId: string;
  fromStep?: SetupStep;
  serverChoice?: ServerChoice | null;
  allowWaiting?: boolean;
  replaceStaleRunId?: string;
}): Promise<{ runId: string }> {
  const { domainId } = opts;
  const db = getDb();

  // Held from now until the run finishes, fails for good or waits for the user (the job carries the owner).
  const claim = claimDomain(domainId, "server setup");
  if (!claim.ok) throw new Error(busyMessage(claim.running));

  const runId = globalThis.crypto.randomUUID();
  let stateSaved = false;
  try {
    const domain = await db.query.domains.findFirst({
      where: and(eq(domains.id, domainId), eq(domains.userId, opts.userId)),
      columns: { id: true, setupState: true },
    });
    if (!domain) throw new Error("Domain not found");
    const current = domain.setupState as SetupState | null;
    if (opts.replaceStaleRunId) {
      if (current?.runId !== opts.replaceStaleRunId || !isInFlight(current))
        throw new Error("The setup run changed since it was found stuck, so it wasn't resumed.");
    } else if (current?.status === "waiting") {
      if (!opts.allowWaiting) throw new Error(WAITING_FOR_CHOICE_MESSAGE);
    } else if (isInFlight(current)) {
      throw new Error(busyMessage("server setup"));
    }

    await startDomainSetupJob({ domainId, runId, lockOwner: claim.owner }, async () => {
      const state = newSetupState(runId, new Date().toISOString(), {
        fromStep: opts.fromStep,
        serverChoice: opts.serverChoice ?? null,
      });
      // Only over the state checked above: if another process started a run in between, this one stops.
      const unchanged = sql`coalesce(${domains.setupState}->>'runId', '') = ${current?.runId ?? ""}`;
      const written: unknown[] = await db
        .update(domains)
        .set({ setupState: state })
        .where(and(eq(domains.id, domainId), unchanged))
        .returning({ id: domains.id });
      if (!written.length) throw new Error(busyMessage("server setup"));
      stateSaved = true;
    });
    return { runId };
  } catch (err) {
    releaseDomain(domainId, claim.owner);
    // Queueing failed after the state was saved: show why on the board instead of a run stuck at "queued".
    if (stateSaved) {
      await saveSetupState(db, domainId, runId, {
        status: "failed",
        error: errorMessage(err),
        finishedAt: new Date().toISOString(),
      }).catch((saveErr) =>
        console.error(`[enqueueDomainSetup] couldn't save the failure for ${domainId}:`, saveErr),
      );
    }
    throw err;
  }
}

export interface ReconcileResult {
  /** False when skipped: another check ran less than a minute ago, or one is still running. */
  ran: boolean;
  /** Runs this process holds, whose updatedAt it refreshed. */
  refreshed: number;
  /** Domains whose stuck run was queued again. */
  resumed: string[];
}

/**
 * Find setup runs left "queued" or "running" with nothing behind them (see setup-recovery.ts isStuckSetupRun)
 * and queue each again from its first unfinished step, keeping its server choice. Also refreshes the runs
 * this process holds, which is how other processes on the same database know they're alive.
 *
 * Only the production server takes runs over (SETUP_RECONCILE=1, set in docker-compose.yml): any other
 * process on the same database can't see the production queue, so it would resume runs still going there.
 * Without the flag a process only refreshes the runs it holds, so the production server doesn't take those
 * over either.
 *
 * Runs 30 s after the app starts and then about once a minute (queue.ts), and the job board may call it too:
 * at most one check per minute per process, whoever asks. Cheap when nothing is in flight (one query).
 * Never throws.
 */
export async function reconcileStuckSetupRuns(): Promise<ReconcileResult> {
  const g = globalThis as unknown as {
    __setupReconcile?: { lastStartedMs: number | null; running: boolean };
  };
  const r = g.__setupReconcile ?? (g.__setupReconcile = { lastStartedMs: null, running: false });
  const now = Date.now();
  if (r.running || !reconcileDue(r.lastStartedMs, now))
    return { ran: false, refreshed: 0, resumed: [] };
  r.lastStartedMs = now;
  r.running = true;
  try {
    return await reconcileNow(now, takesOverStuckRuns(process.env));
  } catch (err) {
    console.error("[setup] Checking for interrupted setup runs failed:", err);
    return { ran: true, refreshed: 0, resumed: [] };
  } finally {
    r.running = false;
  }
}

async function reconcileNow(now: number, takeOver: boolean): Promise<ReconcileResult> {
  const result: ReconcileResult = { ran: true, refreshed: 0, resumed: [] };
  const db = getDb();
  const rows: { id: string; userId: string; setupState: SetupState | null }[] = await db
    .select({ id: domains.id, userId: domains.userId, setupState: domains.setupState })
    .from(domains)
    .where(sql`${domains.setupState}->>'status' in ('queued', 'running')`);
  if (!rows.length) return result;

  // Which of them this process holds: a domain claim, or a job in its queue. Redis not answering: no job can
  // be seen, so only the claims count. Redis failing mid-lookup: nothing is taken over this time.
  let queued: Set<string> | null = null;
  let queueKnown = true;
  try {
    queued = await domainIdsInSetupQueue();
  } catch (err) {
    queueKnown = false;
    console.error(
      "[setup] Couldn't read the setup queue while checking for interrupted runs:",
      err,
    );
  }
  const live = (id: string) => ({
    claimed: activeRun(id) !== undefined,
    queued: queued?.has(id) ?? false,
  });

  // Show other processes on this database that these runs are alive.
  const held = rows
    .filter((row) => {
      const l = live(row.id);
      return l.claimed || l.queued;
    })
    .map((row) => row.id);
  if (held.length) {
    await db
      .update(domains)
      .set({
        setupState: sql`jsonb_set(${domains.setupState}, '{updatedAt}', to_jsonb(${new Date(now).toISOString()}::text))`,
      })
      .where(
        and(
          inArray(domains.id, held),
          sql`${domains.setupState}->>'status' in ('queued', 'running')`,
        ),
      );
    result.refreshed = held.length;
  }
  if (!takeOver || !queueKnown) return result;

  // Each row on its own: one malformed setup_state must not stop the others from resuming.
  for (const row of rows) {
    try {
      const state = row.setupState;
      if (!isStuckSetupRun(state, live(row.id), now)) continue;
      const from = resumeStep(state);
      if (!from) {
        // Every step finished: only the run's final save was lost.
        await saveSetupState(db, row.id, state.runId, {
          status: "done",
          step: null,
          error: null,
          finishedAt: new Date().toISOString(),
        });
        continue;
      }
      await enqueueDomainSetup({
        domainId: row.id,
        userId: row.userId,
        fromStep: from,
        serverChoice: state.serverChoice,
        replaceStaleRunId: state.runId,
      });
      result.resumed.push(row.id);
      console.log(
        `[setup] Resumed the interrupted setup run of domain ${row.id} from its ${from} step.`,
      );
    } catch (err) {
      console.error(`[setup] Couldn't resume the interrupted setup run of domain ${row.id}:`, err);
    }
  }
  return result;
}

/**
 * End run `runId` as failed with `error`, if its state still belongs to it and says queued or running: the
 * queue failed its job for good without the run recording it (queue.ts endFailedDomainSetupJob). Returns
 * whether it was ended.
 */
export async function endInterruptedSetupRun(
  domainId: string,
  runId: string,
  error: string,
): Promise<boolean> {
  const db = getDb();
  const patch = interruptedRunPatch(
    await loadSetupState(db, domainId),
    runId,
    error,
    new Date().toISOString(),
  );
  if (!patch) return false;
  const saved = await saveSetupState(db, domainId, runId, patch);
  return saved?.runId === runId && saved.status === "failed";
}

/**
 * One attempt of a domain's setup run, called by the queue's worker or its in-process fallback. It first
 * (re)claims the domain with the run's lock owner, which also refreshes the claim during a long run.
 * Returns "done", "waiting" (for the user's server choice) or "superseded" (a newer run replaced this one:
 * it stops at its next state write, and writes nothing). Throws when a step fails: the step is marked failed
 * with the error, and on the final attempt the run is marked failed. Throws ServerBusyError when another
 * setup is using the server (the run goes back to "queued"), or DomainBusyError when another run holds the
 * domain (nothing is written): the caller tries again later without counting an attempt.
 */
export async function executeDomainSetupJob(
  domainId: string,
  runId: string,
  logFn: LogFn,
  opts: { lockOwner: string; attempt: number; finalAttempt: boolean; notice?: string },
): Promise<"done" | "waiting" | "superseded"> {
  const db = getDb();
  const current = await loadSetupState(db, domainId);
  if (current?.runId !== runId) {
    logFn(`Skipped an older setup run for this domain: a newer run replaced it.\n`);
    return "superseded";
  }

  // Held for the whole run. The enqueuer took it, but an attempt after an app restart (or a long wait) may
  // find it gone or stale, so each attempt claims it again. Refused: wait, as for a busy server.
  const claim = claimDomain(domainId, "server setup", opts.lockOwner);
  if (!claim.ok) {
    logFn(`Waiting for the ${claim.running} on this domain to finish before continuing...\n`);
    throw new DomainBusyError(claim.running);
  }

  // The last pass found the server busy (it left the run queued at the server step). While it still is, check
  // again later without a new log section and state writes every minute.
  // (If the domain can't be read here, the normal pass below reports it.)
  if (current.status === "queued" && current.step === "server") {
    const ipAddress = await loadDomain(db, domainId)
      .then((domain) => serverTarget(domain).ipAddress)
      .catch(() => null);
    if (ipAddress && !claimServer(ipAddress, opts.lockOwner).ok) {
      logFn(`Still waiting for the other setup on server ${ipAddress} to finish...\n`);
      throw new ServerBusyError(ipAddress);
    }
    // Free now: let go until the server step claims it again (a new run may take it in between; the step
    // then finds it busy and waits as usual).
    if (ipAddress) releaseServer(ipAddress, opts.lockOwner);
  }

  const logger = await createDomainLogger(domainId, logFn, opts.notice);
  let label = "Setup";
  const log = (line: string, status: string = label) =>
    logger.log(line.endsWith("\n") ? line : `${line}\n`, status);

  let latest: SetupState = current;
  let currentStep: SetupStep | null = null;
  let heldIp: string | null = null;
  let serverBusy = false;

  // One setup per server IP at a time. Held from the inspection through the install or reuse, so a run never
  // judges a server another run is in the middle of installing.
  const holdServer = (ip: string) => {
    if (!claimServer(ip, opts.lockOwner).ok) {
      serverBusy = true;
      throw new ServerBusyError(ip);
    }
    heldIp = ip;
  };
  const letGoOfServer = () => {
    if (heldIp) releaseServer(heldIp, opts.lockOwner);
    heldIp = null;
  };

  const deps: SetupDeps = {
    // The attempt number comes from the queue (runDomainSetup adds one), so a stalled job handed out again, or
    // a wait for a busy server, doesn't count as another attempt.
    load: async () => ({ ...latest, attempt: opts.attempt - 1 }),

    save: async (patch) => {
      const saved = await saveSetupState(db, domainId, runId, patch);
      // Replaced by a newer run: stop here (runDomainSetup's own failure save stops the same way).
      if (saved?.runId !== runId) throw new RunSupersededError();
      latest = saved;
      // Narrate the run in the terminal log: a header when a step starts, and how it ended.
      if (patch.step && patch.step !== currentStep) {
        currentStep = patch.step;
        label = STEP_LABELS[patch.step];
        log(`\n== ${label} ==`);
      }
      const stepStatus = currentStep ? patch.steps?.[currentStep] : undefined;
      if (stepStatus === "done") log(`${label}: done.`);
      else if (stepStatus === "failed" && !serverBusy)
        log(`${label} failed: ${patch.error ?? "unknown error"}`);
      if (patch.status === "done")
        log("Setup complete: DNS, server, mailboxes and DKIM are done.", "Ready");
      return latest;
    },

    log: (line) => log(line),

    dns: async () => {
      const domain = await loadDomain(db, domainId);
      const zoneId = await resolveAndSaveCfZoneId(db, domain, domain.userId);
      if (!zoneId) {
        throw new Error(
          `No Cloudflare zone found for ${domain.name}: add the domain to the Cloudflare account in Settings`,
        );
      }
      const withZone = { ...domain, cfZoneId: zoneId };
      const pushed = await pushDns(db, withZone, domain.userId);
      if (pushed.failed > 0) {
        const first = pushed.results.find((r) => !r.success);
        const more = pushed.failed > 1 ? ` (${pushed.failed} records failed)` : "";
        throw new Error(
          `DNS record ${first?.name ?? "?"} couldn't be created in Cloudflare: ${first?.error ?? "unknown error"}${more}`,
        );
      }
      log(`Pushed or adopted ${pushed.pushed} DNS record(s).`);
      // The mail host must be DNS-only: a proxied one breaks the Mailcow API and mail delivery.
      const fixed = await unproxyDns(db, withZone, domain.userId);
      log(`Un-proxied ${fixed.unproxied} record(s), removed ${fixed.removed} bad mail record(s).`);
    },

    inspectServer: async () => {
      const domain = await loadDomain(db, domainId);
      const target = serverTarget(domain);
      // A protected server can be neither installed nor reused: say so now rather than after a choice.
      assertServerNotProtected(target.ipAddress);
      holdServer(target.ipAddress);
      log(`Checking whether ${target.ipAddress} already runs Mailcow...`);
      const { hasMailcow, hostname } = await readServerMailcow(target);
      // Read-only, and optional: when they can't be read the check is skipped, the step goes on.
      const mailDomains = hasMailcow ? await readServerMailDomains(target) : null;

      // Other app domains on the same IP, across all accounts. Names only for this domain's owner. The IP
      // is compared the way the server lock compares it, so " 1.2.3.4" or a differently-cased host matches.
      // Only installed ones (with a Mailcow host name) count as sharing the server.
      const otherRows: { name: string; userId: string; mailcowHostname: string | null }[] = await db
        .select({
          name: domains.name,
          userId: domains.userId,
          mailcowHostname: domains.mailcowHostname,
        })
        .from(domains)
        .where(
          and(
            sql`lower(trim(${domains.ipAddress})) = ${serverIpKey(target.ipAddress)}`,
            ne(domains.id, domainId),
          ),
        );
      const sharing = otherDomainsOnServer({
        userId: domain.userId,
        domainName: domain.name,
        others: otherRows.map((o) => ({
          name: o.name,
          userId: o.userId,
          installed: !!o.mailcowHostname?.trim(),
        })),
        mailDomains,
      });

      // Live mailboxes: a domain marked failed, error or provisioning can still have a working Mailcow with
      // mailboxes in use, and those must never be wiped without asking.
      const [{ n: activeMailboxes }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(plannedInboxes)
        .where(and(eq(plannedInboxes.domainId, domainId), eq(plannedInboxes.status, "active")));

      const host = hostname?.toLowerCase() ?? null;
      const savedHost = domain.mailcowHostname
        ? String(domain.mailcowHostname).toLowerCase()
        : null;
      const ready = domain.status === "ready";
      const hostMatches =
        !!host && (host === `mail.${domain.name}`.toLowerCase() || host === savedHost);
      const inspection = {
        ip: target.ipAddress,
        hasMailcow,
        hostname,
        otherDomainsOnServer: sharing,
        ownInstallComplete: ready && !!host && host === savedHost,
        ownUnfinishedInstall: isOwnUnfinishedInstall({
          domainReady: ready,
          hostMatches,
          activeMailboxes,
        }),
        activeMailboxes,
        mailDomains,
      };
      log(
        hasMailcow
          ? `Mailcow is installed there (host name ${hostname ?? "unknown"}).`
          : "No Mailcow on the server yet.",
      );
      if (hasMailcow && !mailDomains)
        log("Couldn't list the mail domains on that Mailcow, so that check was skipped.");
      if (sharing.length) log(`Other domains on this server: ${sharing.join(", ")}.`);
      if (hasMailcow && !ready && hostMatches && activeMailboxes > 0)
        log(
          `${domain.name} has ${activeMailboxes} live mailbox(es) there, so the server isn't reinstalled without asking.`,
        );
      return inspection;
    },

    install: async () => {
      const domain = await loadDomain(db, domainId);
      const raw = serverTarget(domain);
      const target = checkedServerTarget(raw.ipAddress, raw.sshUser, domain.name);
      // Before the domain is marked provisioning (installMailcowOnServer checks again).
      assertServerNotProtected(raw.ipAddress);
      holdServer(raw.ipAddress);
      try {
        log("Installing Mailcow. This takes 20–40 minutes.");
        await db.update(domains).set({ status: "provisioning" }).where(eq(domains.id, domainId));
        // Marks the domain "ready" with its Mailcow host and API key, or "failed" and throws.
        await installMailcowOnServer({
          domainId,
          ipAddress: target.ipAddress,
          sshUser: target.sshUser,
          sshPassword: raw.sshPassword,
          domainName: target.domainName,
          log: logger.log,
        });
      } finally {
        letGoOfServer();
      }
    },

    reuse: async () => {
      const domain = await loadDomain(db, domainId);
      const target = serverTarget(domain);
      assertServerNotProtected(target.ipAddress);
      const reinstalling = await pendingReinstallOwner(db, domain, target.ipAddress);
      if (reinstalling) {
        // Same "busy, wait and re-check later without using an attempt" path as a claimed server lock
        // (holdServer below): don't log it as a failed step too.
        serverBusy = true;
        log(
          `Waiting for the reinstall of server ${target.ipAddress} (started for ${reinstalling}) to finish before reusing it.\n`,
        );
        throw new ServerBusyError(target.ipAddress);
      }
      holdServer(target.ipAddress);
      try {
        log(
          `Adding ${domain.name} to the Mailcow already on ${target.ipAddress}. Nothing is reinstalled.`,
        );
        const config = await readMailcowConfigOverSsh(
          {
            ipAddress: target.ipAddress,
            sshUser: target.sshUser,
            sshPassword: tryDecrypt(target.sshPassword) ?? "",
          },
          { wantApiKey: true },
        );
        if (!config.hostname || !config.apiKey) {
          throw new Error(
            `Couldn't read the Mailcow host name and API key on ${target.ipAddress}` +
              (config.hostname ? ` (host name ${config.hostname}, no API key found)` : "") +
              ". Check the SSH login, or choose Wipe & reinstall.",
          );
        }
        await db
          .update(domains)
          .set({ mailcowHostname: config.hostname, mailcowApiKey: config.apiKey, status: "ready" })
          .where(eq(domains.id, domainId));
        log(`Using the Mailcow at ${config.hostname}.`);
      } finally {
        letGoOfServer();
      }
    },

    fcrdns: async () => {
      const domain = await loadDomain(db, domainId);
      const ip = serverTarget(domain).ipAddress;
      const expected = domain.mailcowHostname || `mail.${domain.name}`;
      try {
        const revName = ip.split(".").reverse().join(".") + ".in-addr.arpa";
        const ptr = (await doh(revName, "PTR")).map((h) => h.replace(/\.$/, ""));
        const forwardIps: string[] = [];
        for (const host of ptr) {
          try {
            forwardIps.push(...(await doh(host, "A")));
          } catch {
            /* ignore per-host resolution failure */
          }
        }
        const forwardProxied = forwardIps.length > 0 && forwardIps.every((x) => isCloudflareIp(x));
        const verdict = fcrdnsVerdict(ip, ptr, forwardIps, forwardProxied);
        if (verdict === "confirmed") {
          log(`Reverse DNS (FCrDNS) passes: ${ip} → ${ptr[0]} → ${ip}.`);
          return { ok: true as const };
        }
        const ptrHost = ptr[0] ?? null;
        return {
          ok: false as const,
          ip,
          ptrHost,
          expected,
          message: fcrdnsWaitMessage(verdict, ip, expected, ptrHost, forwardIps),
        };
      } catch {
        // Reverse DNS couldn't be queried (transient resolver hiccup) — this is "unknown", not
        // "fails". Don't deadlock the run: proceed, and let the health engine flag any PTR problem.
        log(`Couldn't query reverse DNS for ${ip}, so the FCrDNS gate was skipped this pass.`);
        return { ok: true as const };
      }
    },

    mailboxes: async () => {
      const loaded = await loadDomain(db, domainId);
      // A re-provision regenerates the key: re-read it from the server if the saved one stopped working.
      const { domain } = await ensureWorkingApiKey(db, loaded);
      if (!domain.mailcowHostname || !domain.mailcowApiKey) {
        throw new Error(
          "The domain has no Mailcow host name or API key yet: the server step hasn't finished.",
        );
      }
      const { existingDomains, ssh } = await ensureMailDomains(db, domain);
      const [{ n: total }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(plannedInboxes)
        .where(eq(plannedInboxes.domainId, domainId));
      const progress = createMailboxProgressWriter(db, domainId, total);
      log(`Creating ${total} mailbox(es)...`);
      const { summary } = await createMailboxes(db, domain, existingDomains, {
        ssh,
        onProgress: (done, failed, _total, finished) =>
          finished ? void progress.finish(done, failed) : progress.update(done),
      });
      // createMailboxes reports the finish before it returns: let that last write land first.
      await progress.settled();
      log(
        `Mailboxes: ${summary.created}/${summary.total} created${summary.failed ? `, ${summary.failed} failed` : ""}.`,
      );
      return { created: summary.created, failed: summary.failed, total: summary.total };
    },

    dkim: async () => {
      const domain = await loadDomain(db, domainId);
      const { results } = await syncDkim(db, domain, domain.userId, { log: (line) => log(line) });
      const bad = results.find((r) => !r.success);
      if (bad)
        throw new Error(
          `DKIM for ${bad.name} couldn't be synced to Cloudflare: ${bad.error ?? "unknown error"}`,
        );
      log(`DKIM synced to Cloudflare for ${results.length} domain(s).`);
    },
  };

  try {
    log(`Setup attempt ${opts.attempt}${opts.finalAttempt ? " (last)" : ""}.`);
    return await runDomainSetup(deps);
  } catch (err) {
    if (isRunSupersededError(err)) {
      log("A newer setup run replaced this one, so this one stops here.");
      return "superseded";
    }
    const message = errorMessage(err);
    if (isServerBusyError(err)) {
      log(message, "Queued");
      await saveSetupState(db, domainId, runId, {
        status: "queued",
        error: null,
        steps: { ...latest.steps, server: "pending" },
      }).catch((saveErr) =>
        console.error(`[domain-setup] couldn't save the wait for ${domainId}:`, saveErr),
      );
    } else if (opts.finalAttempt) {
      log(`Setup failed: ${message}`, "Failed");
      await saveSetupState(db, domainId, runId, {
        status: "failed",
        error: message,
        finishedAt: new Date().toISOString(),
      }).catch((saveErr) =>
        console.error(`[domain-setup] couldn't save the failure for ${domainId}:`, saveErr),
      );
    } else {
      log(`Attempt ${opts.attempt} failed: ${message}. It will be retried.`);
    }
    throw err;
  } finally {
    letGoOfServer();
    await logger.flush();
  }
}

/**
 * Before a "reuse" server step runs (whichever decided it: the user's explicit choice, or serverDecision
 * finding this domain's own finished install), check for another domain on the same server IP that's mid
 * "Wipe & re-provision ALL": one whose setup run chose "reinstall", is still queued or running, and hasn't
 * finished its server step yet (reuseMustWait). If that run reinstalls after this one reuses, it wipes the
 * mailboxes this run just added, so the caller must wait for it instead. Returns who to blame in the log line
 * (the other domain's name when it's this domain's own owner, "another domain" otherwise), or null when
 * reusing is safe.
 */
async function pendingReinstallOwner(
  db: Db,
  domain: Domain,
  ipAddress: string,
): Promise<string | null> {
  const others: { id: string; name: string; userId: string; setupState: SetupState | null }[] = await db
    .select({
      id: domains.id,
      name: domains.name,
      userId: domains.userId,
      setupState: domains.setupState,
    })
    .from(domains)
    .where(
      and(
        sql`lower(trim(${domains.ipAddress})) = ${serverIpKey(ipAddress)}`,
        ne(domains.id, domain.id),
      ),
    );
  const shaped = others.map((o) => ({
    name: o.name,
    userId: o.userId,
    serverChoice: o.setupState?.serverChoice,
    status: o.setupState?.status,
    serverStepDone: o.setupState?.steps?.server === "done",
  }));
  const blocker = shaped.find((o) => reuseMustWait([o]));
  if (!blocker) return null;
  return blocker.userId === domain.userId ? blocker.name : "another domain";
}

async function loadDomain(db: Db, domainId: string): Promise<Domain> {
  const domain = await db.query.domains.findFirst({
    where: eq(domains.id, domainId),
    with: { server: true },
  });
  if (!domain) throw new Error("Domain not found");
  return domain;
}

// The same credentials provisionServer checks: the domain's own, else its server's.
function serverTarget(domain: Domain): {
  ipAddress: string;
  sshUser: string;
  sshPassword: string | null;
} {
  const ipAddress = domain.ipAddress || domain.server?.ipAddress;
  const sshUser = domain.sshUser || domain.server?.sshUser;
  const sshPassword = domain.sshPassword || domain.server?.sshPassword || null;
  if (!ipAddress || !sshUser) throw new Error("Server credentials not configured for this domain");
  return { ipAddress, sshUser, sshPassword };
}

// Does the server have Mailcow's config, and which host name does it serve? Strict on purpose: an unclear
// answer must fail the step, never read as "no Mailcow" (which would install over it).
async function readServerMailcow(target: {
  ipAddress: string;
  sshUser: string;
  sshPassword: string | null;
}): Promise<{ hasMailcow: boolean; hostname: string | null }> {
  const ssh = new SSHManager(target.ipAddress, 22, target.sshUser, {
    type: "password",
    password: tryDecrypt(target.sshPassword) || "",
  });
  try {
    await ssh.connect({ timeoutMs: 30000, maxRetries: 3 });
    const res = await ssh.executeCommand(
      `if [ -f ${MAILCOW_CONF} ]; then echo MAILCOW_CONF=yes; ` +
        `grep -m1 '^MAILCOW_HOSTNAME=' ${MAILCOW_CONF} | cut -d= -f2- | tr -d '\\r'; ` +
        `else echo MAILCOW_CONF=no; fi; true`,
      { timeoutMs: 20000 },
    );
    const lines = res.stdout.split("\n").map((l) => l.trim());
    if (lines.includes("MAILCOW_CONF=no")) return { hasMailcow: false, hostname: null };
    const at = lines.indexOf("MAILCOW_CONF=yes");
    if (at < 0)
      throw new Error(
        `Couldn't tell whether ${target.ipAddress} already runs Mailcow (no answer from the server).`,
      );
    const host = lines[at + 1] ?? "";
    return { hasMailcow: true, hostname: /\./.test(host) ? host : null };
  } finally {
    await ssh.dispose().catch(() => {});
  }
}

// The mail domains the server's Mailcow serves, read through its API over SSH (get/domain/all, read-only).
// Null when they can't be read (no host name or API key found, the API not answering): the caller then skips
// the check instead of failing the step.
async function readServerMailDomains(target: {
  ipAddress: string;
  sshUser: string;
  sshPassword: string | null;
}): Promise<string[] | null> {
  try {
    const ssh = {
      ipAddress: target.ipAddress,
      sshUser: target.sshUser,
      sshPassword: tryDecrypt(target.sshPassword) ?? "",
    };
    const config = await readMailcowConfigOverSsh(ssh, { wantApiKey: true });
    if (!config.hostname || !config.apiKey) return null;
    const rows = await mailcowListAll(config.hostname, config.apiKey, "get/domain/all", {
      attempts: 1,
      timeoutMs: 20000,
      ssh,
    });
    if (!rows) return null;
    return rows
      .map((row) => (row && typeof row === "object" ? row.domain_name : undefined))
      .filter((name): name is string => typeof name === "string" && name.trim() !== "");
  } catch {
    return null;
  }
}

// The waiting message shown when the FCrDNS gate blocks mailboxes: exactly what PTR to set and where.
function fcrdnsWaitMessage(
  verdict: "proxied" | "mismatch" | "missing",
  ip: string,
  expected: string,
  ptrHost: string | null,
  forwardIps: string[],
): string {
  const panel = "in your VPS provider's control panel (the reverse DNS / PTR setting)";
  if (verdict === "missing")
    return `No reverse DNS (PTR) record exists for ${ip}. Set the PTR for ${ip} to ${expected} ${panel}, then re-check and continue. Mailboxes won't go live until FCrDNS passes.`;
  if (verdict === "mismatch")
    return (
      `The PTR for ${ip}${ptrHost ? ` points to ${ptrHost}` : ""}, which doesn't forward-resolve back to ${ip}` +
      `${forwardIps.length ? ` (it resolves to ${forwardIps.join(", ")})` : ""}. Set the PTR for ${ip} to ${expected} ${panel}, ` +
      `and make sure ${expected} A-records to ${ip}. Then re-check and continue.`
    );
  return (
    `The PTR for ${ip} is correct${ptrHost ? ` (${ptrHost})` : ""}, but ${ptrHost ?? expected} is Cloudflare-proxied, ` +
    `so it can't forward-confirm to ${ip}. Un-proxy ${expected} (set it DNS-only in Cloudflare) so it resolves to ${ip}, ` +
    `then re-check and continue.`
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
