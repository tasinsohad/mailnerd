// The real work behind a domain's setup run: DNS → server → mailboxes → DKIM (the order and rules are in
// domain-setup-core.ts). The run's state lives in domains.setup_state, so any device sees the same board
// and a queued run survives an app restart.
//
// Plain server-only module (no createServerFn). Server-function modules such as provisioning.ts import it;
// browser code must not. It imports queue.ts statically (the install, the log, the queue). queue.ts loads
// this module only through a dynamic import inside its worker, so there is no static import cycle.

import { and, eq, ne, sql } from "drizzle-orm";
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
import { runDomainSetup, type SetupDeps } from "./domain-setup-core";
import { ServerBusyError, isServerBusyError } from "./setup-attempts";
import {
  claimDomain,
  releaseDomain,
  busyMessage,
  claimServer,
  releaseServer,
} from "./domain-locks";
import {
  checkedServerTarget,
  createDomainLogger,
  installMailcowOnServer,
  startDomainSetupJob,
  tryDecrypt,
  type LogFn,
} from "./queue";
import { resolveAndSaveCfZoneId } from "./cloudflare";
import { pushDns, unproxyDns, ensureMailDomains, createMailboxes, syncDkim } from "./pipeline";
import { readMailcowConfigOverSsh, ensureWorkingApiKey } from "./mailcow-key";
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

/** Merge `patch` into the domain's saved setup state and save it. */
export async function saveSetupState(
  db: Db,
  domainId: string,
  patch: Partial<SetupState>,
): Promise<SetupState> {
  const prev = await loadSetupState(db, domainId);
  if (!prev) throw new Error("This domain has no setup run to update.");
  const next = mergeSetupState(prev, patch, new Date().toISOString());
  await db.update(domains).set({ setupState: next }).where(eq(domains.id, domainId));
  return next;
}

/**
 * Start a setup run for a domain: on the queue, or in-process when Redis isn't answering.
 *
 * Refused while another run holds the domain (a setup, or a manual mailbox run), while a job for it is still
 * in the queue, and while the run waits for the user's server choice (unless `allowWaiting`: the answer to
 * that choice starts the next pass). A state still saying "queued" or "running" with none of those behind
 * it belonged to a run that died with an earlier app process (an in-process run, or a crash before the
 * run's final state was saved), so a new run replaces it instead of the domain staying blocked forever.
 */
export async function enqueueDomainSetup(opts: {
  domainId: string;
  userId: string;
  fromStep?: SetupStep;
  serverChoice?: ServerChoice | null;
  allowWaiting?: boolean;
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
    if (current?.status === "waiting" && !opts.allowWaiting)
      throw new Error(busyMessage("server setup"));

    await startDomainSetupJob({ domainId, runId, lockOwner: claim.owner }, async () => {
      const state = newSetupState(runId, new Date().toISOString(), {
        fromStep: opts.fromStep,
        serverChoice: opts.serverChoice ?? null,
      });
      await db.update(domains).set({ setupState: state }).where(eq(domains.id, domainId));
      stateSaved = true;
    });
    return { runId };
  } catch (err) {
    releaseDomain(domainId, claim.owner);
    // Queueing failed after the state was saved: show why on the board instead of a run stuck at "queued".
    if (stateSaved) {
      await saveSetupState(db, domainId, {
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

/**
 * One attempt of a domain's setup run, called by the queue's worker or its in-process fallback, which hold the
 * domain's claim. Returns "done", "waiting" (for the user's server choice) or "superseded" (a newer run
 * replaced this one, so nothing was done). Throws when a step fails: the step is marked failed with the error,
 * and on the final attempt the run is marked failed. Throws ServerBusyError when another setup is using the
 * server: the run goes back to "queued" and the caller tries again later without counting an attempt.
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
      latest = await saveSetupState(db, domainId, patch);
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
      holdServer(target.ipAddress);
      log(`Checking whether ${target.ipAddress} already runs Mailcow...`);
      const { hasMailcow, hostname } = await readServerMailcow(target);

      // Other app domains on the same IP, across all accounts. Names only for this domain's owner.
      const others: { name: string; userId: string }[] = await db
        .select({ name: domains.name, userId: domains.userId })
        .from(domains)
        .where(and(eq(domains.ipAddress, target.ipAddress), ne(domains.id, domainId)));
      const otherDomainsOnServer = others
        .filter((o) => o.userId === domain.userId)
        .map((o) => o.name);
      if (others.some((o) => o.userId !== domain.userId))
        otherDomainsOnServer.push("another account's domain");

      const host = hostname?.toLowerCase() ?? null;
      const savedHost = domain.mailcowHostname
        ? String(domain.mailcowHostname).toLowerCase()
        : null;
      const ready = domain.status === "ready";
      const inspection = {
        ip: target.ipAddress,
        hasMailcow,
        hostname,
        otherDomainsOnServer,
        ownInstallComplete: ready && !!host && host === savedHost,
        ownUnfinishedInstall:
          !ready && !!host && (host === `mail.${domain.name}`.toLowerCase() || host === savedHost),
      };
      log(
        hasMailcow
          ? `Mailcow is installed there (host name ${hostname ?? "unknown"}).`
          : "No Mailcow on the server yet.",
      );
      if (otherDomainsOnServer.length)
        log(`Other domains on this server: ${otherDomainsOnServer.join(", ")}.`);
      return inspection;
    },

    install: async () => {
      const domain = await loadDomain(db, domainId);
      const raw = serverTarget(domain);
      const target = checkedServerTarget(raw.ipAddress, raw.sshUser, domain.name);
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
      log(
        `Mailboxes: ${summary.created}/${summary.total} created${summary.failed ? `, ${summary.failed} failed` : ""}.`,
      );
      return { created: summary.created, failed: summary.failed, total: summary.total };
    },

    dkim: async () => {
      const domain = await loadDomain(db, domainId);
      const { results } = await syncDkim(db, domain, domain.userId);
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
    const message = errorMessage(err);
    if (isServerBusyError(err)) {
      log(message, "Queued");
      await saveSetupState(db, domainId, {
        status: "queued",
        error: null,
        steps: { ...latest.steps, server: "pending" },
      }).catch((saveErr) =>
        console.error(`[domain-setup] couldn't save the wait for ${domainId}:`, saveErr),
      );
    } else if (opts.finalAttempt) {
      log(`Setup failed: ${message}`, "Failed");
      await saveSetupState(db, domainId, {
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
