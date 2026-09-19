import { Queue, Worker, Job, DelayedError } from "bullmq";
import type Redis from "ioredis";
import { getDb } from "../lib/db";
import { domains } from "../lib/db/schema";
import { eq } from "drizzle-orm";
import { SSHManager } from "../lib/ssh";
import { decrypt } from "../lib/encryption";
import { jobEvents, inProcessProvisions } from "./events";
import { createRedis, waitForRedis } from "./redis";
import { createSlotLimiter } from "./slot-limiter";
import { claimDomain, releaseDomain, busyMessage } from "./domain-locks";
import { ensureMailDomains, createMailboxes, syncDkim, unproxyDns } from "./pipeline";
import { ensureWorkingApiKey } from "./mailcow-key";
import {
  isFinalAttempt,
  isBusyWait,
  runAttempts,
  SETUP_ATTEMPTS,
  RETRY_BASE_MS,
  SERVER_BUSY_RECHECK_MS,
} from "./setup-attempts";
import crypto from "crypto";

// Try to decrypt credentials, falling back to plain text if not encrypted
export function tryDecrypt(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return decrypt(value);
  } catch {
    return value;
  }
}

// Sanitize input for shell commands - escape special characters
function sanitizeShellInput(input: string | undefined): string {
  if (!input) return "";
  return input.replace(/[;`$|&\n\r]/g, "").trim();
}

// Validate domain name format
function isValidDomainName(domain: string): boolean {
  const domainRegex = /^(?!:\/\/)([a-zA-Z0-9-_]+\.)*[a-zA-Z0-9][a-zA-Z0-9-_]+\.[a-zA-Z]{2,}$/;
  return domainRegex.test(domain);
}

// Validate IP address or hostname
function isValidHost(input: string): boolean {
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  const hostnameRegex = /^([a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+$/;
  return ipv4Regex.test(input) || hostnameRegex.test(input);
}

// Global references for queue & worker
export let serverSetupQueue: any = null;
let worker: any = null;
// The queue's Redis client, so addServerSetupJob can check Redis is answering before using BullMQ.
let redisConnection: Redis | null = null;

// Setups that run at once (PROVISION_CONCURRENCY), kept to a sane whole number: NaN or 0 would stall the queue.
const PROVISION_CONCURRENCY = clampConcurrency(process.env.PROVISION_CONCURRENCY);
// In-process setups get the same cap the BullMQ worker enforces.
const inProcessSlots = createSlotLimiter(PROVISION_CONCURRENCY);
// A Redis call still unanswered after this counts as failed: Redis can die right after the reachability check.
const REDIS_CALL_TIMEOUT_MS = 10_000;
// How long a queued setup waits before checking again when another run holds its domain.
const BUSY_RECHECK_MS = 60_000;

// Setup passes this process is running, by job id. If BullMQ decides a long setup stalled (a lock renewal
// missed during a Redis hiccup) it hands the same job out again; that second pass waits for the first
// instead of starting a second Mailcow install on the same server. Pinned to globalThis like the worker.
const globalForPasses = globalThis as unknown as { __setupPasses?: Map<string, Promise<void>> };
const setupPasses: Map<string, Promise<void>> =
  globalForPasses.__setupPasses ?? (globalForPasses.__setupPasses = new Map());

function clampConcurrency(raw: string | undefined): number {
  const n = Math.floor(Number(raw ?? 3));
  return Number.isFinite(n) ? Math.min(20, Math.max(1, n)) : 3;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

if (process.env.REDIS_URL) {
  try {
    const redis = createRedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
    const connection = redis.client;
    redisConnection = connection;
    serverSetupQueue = new Queue("server-setup", {
      connection: connection as any,
      defaultJobOptions: {
        // Retry each domain up to 3 times with exponential backoff, then leave it failed
        // (each attempt records its error in terminalLogs; a setup run also in setup_state).
        // setup-attempts.ts mirrors this for the in-process fallback.
        attempts: SETUP_ATTEMPTS,
        backoff: { type: "exponential", delay: RETRY_BASE_MS },
        removeOnComplete: 100,
        // Kept a week for troubleshooting, then dropped: Redis writes job data to disk.
        removeOnFail: { age: 7 * 24 * 60 * 60, count: 200 },
      },
    });
    serverSetupQueue.on("error", redis.report);

    const globalForWorker = global as unknown as { worker: Worker | undefined };
    if (!globalForWorker.worker) {
      globalForWorker.worker = new Worker(
        "server-setup",
        async (job: Job, token?: string) => {
          const key = String(job.id);
          const inFlight = setupPasses.get(key);
          if (inFlight) return inFlight;
          // "domain-setup": a setup run (domain-setup.ts). "setup": the older provisioning job, still
          // run for jobs queued before setup runs existed.
          const pass =
            job.name === "domain-setup"
              ? runQueuedDomainSetup(connection, job, token)
              : runQueuedSetup(connection, job, token);
          setupPasses.set(key, pass);
          try {
            await pass;
          } finally {
            if (setupPasses.get(key) === pass) setupPasses.delete(key);
          }
        },
        // Process 3 domains at a time; the rest stay queued and start as slots free.
        { connection: connection as any, concurrency: PROVISION_CONCURRENCY }
      );
      globalForWorker.worker.on("error", redis.report);
      worker = globalForWorker.worker;
    } else {
      worker = globalForWorker.worker;
    }
  } catch (err) {
    console.error("Failed to initialize Redis setup queue:", err);
  }
}

// The IP, SSH user and domain name end up in the deploy script's shell: validate and sanitize them first.
export function checkedServerTarget(ipAddress: string, sshUser: string, domainName?: string) {
  if (!isValidHost(ipAddress)) {
    throw new Error("Invalid IP address or hostname");
  }
  if (sshUser && !/^[a-zA-Z0-9_-]+$/.test(sshUser)) {
    throw new Error("Invalid SSH username");
  }
  if (domainName && !isValidDomainName(domainName)) {
    throw new Error("Invalid domain name");
  }
  return {
    ipAddress: sanitizeShellInput(ipAddress),
    sshUser: sanitizeShellInput(sshUser),
    domainName: sanitizeShellInput(domainName),
  };
}

export async function addServerSetupJob(
  domainId: string,
  ipAddress: string,
  sshUser: string,
  sshPassword?: string | null,
  domainName?: string,
) {
  const { ipAddress: sanitizedIp, sshUser: sanitizedUser, domainName: sanitizedDomain } = checkedServerTarget(
    ipAddress,
    sshUser,
    domainName,
  );

  // One server setup per domain at a time: a second one re-installs Mailcow under the first.
  const claim = claimDomain(domainId, "server setup");
  if (!claim.ok) throw new Error(busyMessage(claim.running));
  try {
    return await startServerSetup(domainId, sanitizedIp, sanitizedUser, sshPassword, sanitizedDomain, claim.owner);
  } catch (err) {
    releaseDomain(domainId, claim.owner);
    throw err;
  }
}

// Queue the setup on BullMQ or start it in-process. The caller holds the domain's "server setup" claim as
// `lockOwner`; whatever runs the job keeps it until the job is finished for good, then releases it.
async function startServerSetup(
  domainId: string,
  sanitizedIp: string,
  sanitizedUser: string,
  sshPassword: string | null | undefined,
  sanitizedDomain: string,
  lockOwner: string,
): Promise<{ jobId: string | undefined }> {
  // Use the durable BullMQ queue only when Redis is actually answering. Queue.add() against an
  // unreachable Redis never settles (BullMQ waits for a "ready" a dead host never sends), which is
  // how a deleted Upstash database made server setup hang with no error.
  if (serverSetupQueue && redisConnection && (await waitForRedis(redisConnection))) {
    console.log(`[addServerSetupJob] Using BullMQ`);
    // After an app restart the in-process claim is gone, but a queued or running job for this domain
    // can still be sitting in Redis.
    const queued = await withTimeout<Job[]>(
      serverSetupQueue.getJobs(["active", "waiting", "delayed", "prioritized", "paused"]),
      REDIS_CALL_TIMEOUT_MS,
      "Redis stopped answering while checking the setup queue. Try again in a minute.",
    );
    if (queued.some((j: any) => j?.data?.domainId === domainId)) throw new Error(busyMessage("server setup"));
    // No SSH password in the job: Redis writes job data to disk. The worker reads it from the database.
    const job = await withTimeout<Job>(
      serverSetupQueue.add("setup", {
        domainId,
        ipAddress: sanitizedIp,
        sshUser: sanitizedUser,
        domainName: sanitizedDomain,
        lockOwner,
      }),
      REDIS_CALL_TIMEOUT_MS,
      "Redis stopped answering while queueing the setup. Check the Jobs page before starting it again.",
    );
    return { jobId: job.id };
  } else {
    // REDIS_URL is set but Redis isn't answering: say so in the domain's own terminal log, not just
    // the server console, since this run won't survive an app restart.
    const notice = serverSetupQueue
      ? "[Queue] Redis (REDIS_URL) is unreachable, so this setup is running inside the app process and will not survive an app restart. The server console says why Redis failed.\n"
      : undefined;
    console.log(`[addServerSetupJob] Using in-memory fallback${notice ? " (Redis unreachable)" : ""}`);
    // In-memory queue fallback
    const jobId = crypto.randomUUID();
    const db = getDb();
    
    console.log(`[addServerSetupJob] Updating DB status to configuring`);
    await db
      .update(domains)
      .set({ status: "configuring" })
      .where(eq(domains.id, domainId));

    // Mark before returning: the browser opens the log stream as soon as this resolves, and the SSE
    // handler checks this to listen on jobEvents instead of Redis.
    inProcessProvisions.add(domainId);

    console.log(`[addServerSetupJob] Setting 2000ms timeout`);
    // Delay by 2s so the browser has time to open the SSE connection before logs start firing
    setTimeout(async () => {
      console.log(`[addServerSetupJob] Inside setTimeout, calling executeProvisionJob`);
      const channel = `server-log:${domainId}`;
      const logFn = (msg: string, status?: string) => {
        jobEvents.emit(channel, { msg, status, chunk: msg });
      };

      try {
        if (inProcessSlots.isFull()) {
          logFn(`Waiting for a free setup slot (${PROVISION_CONCURRENCY} setups already running)...\n`);
        }
        await inProcessSlots.run(() =>
          executeProvisionJob(domainId, sanitizedIp, sanitizedUser, sshPassword, sanitizedDomain, logFn, notice),
        );
        console.log(`[addServerSetupJob] executeProvisionJob completed successfully`);
      } catch (err) {
        console.error(`In-memory setup error for domain ${domainId}:`, err);
      } finally {
        inProcessProvisions.delete(domainId);
        releaseDomain(domainId, lockOwner);
      }
    }, 2000);

    console.log(`[addServerSetupJob] Returning jobId: ${jobId}`);
    return { jobId };
  }
}

// One pass of a queued setup. The job keeps its domain claim across retries and app restarts (the owner id
// is in the job data). If another run holds the domain, the job goes back to waiting and checks again later.
async function runQueuedSetup(connection: Redis, job: Job, token: string | undefined): Promise<void> {
  const { domainId, ipAddress, sshUser, domainName } = job.data;
  const owner: string = job.data.lockOwner ?? `job:${job.id}`;
  const { logFn, close } = queuedLogFn(connection, domainId);

  try {
    const claim = claimDomain(domainId, "server setup", owner);
    if (!claim.ok) {
      logFn(`Waiting for the ${claim.running} on this domain to finish before starting...\n`);
      await job.moveToDelayed(Date.now() + BUSY_RECHECK_MS, token);
      throw new DelayedError();
    }
    let succeeded = false;
    try {
      // Jobs queued before the password was kept out of Redis still carry it.
      const sshPassword = job.data.sshPassword ?? (await loadSshPassword(domainId));
      await executeProvisionJob(domainId, ipAddress, sshUser, sshPassword, domainName, logFn);
      succeeded = true;
    } finally {
      if (succeeded || isFinalAttempt(job.attemptsMade, job.opts.attempts)) {
        releaseDomain(domainId, owner);
      }
    }
  } finally {
    await close();
  }
}

// A queued job's log line goes to the domain's log channel: over Redis pub/sub for the SSE handler, and on
// jobEvents for listeners in this process.
function queuedLogFn(connection: Redis, domainId: string): { logFn: LogFn; close: () => Promise<void> } {
  const channel = `server-log:${domainId}`;
  const pub = connection.duplicate();
  const logFn: LogFn = (msg, status) => {
    pub.publish(channel, JSON.stringify({ msg, status }));
    jobEvents.emit(channel, { msg, status, chunk: msg });
  };
  return { logFn, close: () => pub.quit().then(() => undefined, () => pub.disconnect()) };
}

export interface DomainSetupJobData {
  domainId: string;
  runId: string;
  /** Owner of the domain's "server setup" claim: the enqueuer took it, the job keeps it until it finishes. */
  lockOwner: string;
}

// Queue a setup run (domain-setup.ts enqueueDomainSetup), or run it in-process when Redis isn't answering,
// with the same checks and timeouts as startServerSetup. `prepare` saves the run's state: it runs after the
// duplicate check (so a refused start never touches the state of the run already going) and before the job
// can start.
export async function startDomainSetupJob(
  data: DomainSetupJobData,
  prepare: () => Promise<void>,
): Promise<{ jobId: string }> {
  if (serverSetupQueue && redisConnection && (await waitForRedis(redisConnection))) {
    // After an app restart the in-process claim is gone, but a job for this domain (either kind) can still
    // be sitting in Redis.
    const queued = await withTimeout<Job[]>(
      serverSetupQueue.getJobs(["active", "waiting", "delayed", "prioritized", "paused"]),
      REDIS_CALL_TIMEOUT_MS,
      "Redis stopped answering while checking the setup queue. Try again in a minute.",
    );
    if (queued.some((j: any) => j?.data?.domainId === data.domainId)) throw new Error(busyMessage("server setup"));
    await prepare();
    // Only ids in the job: the worker reads credentials from the database (Redis writes job data to disk).
    const job = await withTimeout<Job>(
      serverSetupQueue.add("domain-setup", data),
      REDIS_CALL_TIMEOUT_MS,
      "Redis stopped answering while queueing the setup. Check the job page before starting it again.",
    );
    return { jobId: String(job.id) };
  }

  const notice = serverSetupQueue
    ? "[Queue] Redis (REDIS_URL) is unreachable, so this setup is running inside the app process and will not survive an app restart. The server console says why Redis failed.\n"
    : undefined;
  console.log(`[startDomainSetupJob] Running in-process${notice ? " (Redis unreachable)" : ""}`);
  await prepare();
  // Mark before returning: the SSE handler checks this to listen on jobEvents instead of Redis.
  inProcessProvisions.add(data.domainId);
  // Start after 2 s so the browser can open the log stream first.
  setTimeout(() => void runDomainSetupInProcess(data, notice), 2000);
  return { jobId: data.runId };
}

// One pass of a queued setup run. Holds the domain's "server setup" claim for the whole run: across retries
// and app restarts (the owner id is in the job data). Released when the run finishes, waits for the user,
// or fails for good.
async function runQueuedDomainSetup(connection: Redis, job: Job, token: string | undefined): Promise<void> {
  const { domainId, runId } = job.data as DomainSetupJobData;
  const owner: string = job.data.lockOwner ?? `job:${job.id}`;
  const { logFn, close } = queuedLogFn(connection, domainId);

  try {
    const claim = claimDomain(domainId, "server setup", owner);
    if (!claim.ok) {
      logFn(`Waiting for the ${claim.running} on this domain to finish before starting...\n`);
      await job.moveToDelayed(Date.now() + BUSY_RECHECK_MS, token);
      throw new DelayedError();
    }
    const finalAttempt = isFinalAttempt(job.attemptsMade, job.opts.attempts);
    let finished = false;
    try {
      // Loaded here, not at the top: domain-setup.ts imports this module (see its header).
      const { executeDomainSetupJob } = await import("./domain-setup");
      await executeDomainSetupJob(domainId, runId, logFn, {
        lockOwner: owner,
        attempt: job.attemptsMade + 1,
        finalAttempt,
      });
      finished = true;
    } catch (err) {
      // Another setup is using the server, or another run holds the domain: check again later without
      // using up an attempt.
      if (isBusyWait(err)) {
        await job.moveToDelayed(Date.now() + SERVER_BUSY_RECHECK_MS, token);
        throw new DelayedError();
      }
      // With attempts left the run stays "running" (its failed step and error are saved) and BullMQ retries it.
      finished = finalAttempt;
      throw err;
    } finally {
      if (finished) releaseDomain(domainId, owner);
    }
  } finally {
    await close();
  }
}

// A setup run without Redis: the same attempts and waits as the queue, in one of the in-process slots.
async function runDomainSetupInProcess(data: DomainSetupJobData, notice?: string): Promise<void> {
  const { domainId, runId, lockOwner } = data;
  const channel = `server-log:${domainId}`;
  const logFn: LogFn = (msg, status) => {
    jobEvents.emit(channel, { msg, status, chunk: msg });
  };
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  try {
    const { executeDomainSetupJob } = await import("./domain-setup");
    await runAttempts({
      attempts: SETUP_ATTEMPTS,
      run: (attempt, finalAttempt) => {
        if (inProcessSlots.isFull()) {
          logFn(`Waiting for a free setup slot (${PROVISION_CONCURRENCY} setups already running)...\n`);
        }
        return inProcessSlots.run(() =>
          executeDomainSetupJob(domainId, runId, logFn, { lockOwner, attempt, finalAttempt, notice }),
        );
      },
      sleep,
      onRetry: (failed, delayMs) =>
        logFn(`Attempt ${failed} failed. Trying again in ${Math.round(delayMs / 1000)} s...\n`),
      onBusy: (_err, waitMs) => logFn(`Checking again in ${Math.round(waitMs / 1000)} s...\n`),
    });
  } catch (err) {
    console.error(`In-process setup run failed for domain ${domainId}:`, err);
  } finally {
    inProcessProvisions.delete(domainId);
    releaseDomain(domainId, lockOwner);
  }
}

// The same credentials provisionServer passes: the domain's own SSH password, else its server's.
async function loadSshPassword(domainId: string): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const domain: any = await getDb().query.domains.findFirst({
    where: eq(domains.id, domainId),
    with: { server: true },
  });
  return domain?.sshPassword || domain?.server?.sshPassword || null;
}

export type LogFn = (msg: string, status?: string) => void;

export interface DomainLogger {
  /** Append to the domain's terminal log and send it to live viewers. */
  log: LogFn;
  /** Persist the whole log now, after any write already in flight. Never rejects. */
  flush: () => Promise<void>;
}

// One run's terminal log for a domain. Every chunk goes to live SSE clients at once, and the whole log is
// persisted to domains.terminal_logs so a reconnect always has history. A run appends to the previous log
// behind a separator, so earlier runs stay readable during a retry.
export async function createDomainLogger(domainId: string, logFn?: LogFn, notice?: string): Promise<DomainLogger> {
  const db = getDb();
  let accumulatedLogs = "";

  // Steps like `docker compose pull` emit hundreds of progress chunks per second; writing the entire
  // (growing) log on every chunk floods the DB and stalls the job. So throttle DB writes to at most once
  // every 2s, with a trailing write so the last chunk lands.
  const FLUSH_INTERVAL_MS = 2000;
  let lastFlush = 0;
  let pendingFlush: NodeJS.Timeout | null = null;
  // Writes run one after another, so an older (shorter) log can never land after a newer one.
  let lastWrite: Promise<void> = Promise.resolve();

  const flushLogsToDB = (): Promise<void> => {
    lastFlush = Date.now();
    if (pendingFlush) {
      clearTimeout(pendingFlush);
      pendingFlush = null;
    }
    const snapshot = accumulatedLogs;
    lastWrite = lastWrite.then(async () => {
      try {
        await db.update(domains).set({ terminalLogs: snapshot }).where(eq(domains.id, domainId));
      } catch (err) {
        console.error("Failed to flush logs to DB:", err);
      }
    });
    return lastWrite;
  };

  const scheduleFlush = () => {
    const sinceLast = Date.now() - lastFlush;
    if (sinceLast >= FLUSH_INTERVAL_MS) {
      void flushLogsToDB();
    } else if (!pendingFlush) {
      pendingFlush = setTimeout(flushLogsToDB, FLUSH_INTERVAL_MS - sinceLast);
    }
  };

  const log: LogFn = (msg, status) => {
    accumulatedLogs += msg;
    // Emit every chunk to live SSE clients in real time...
    if (logFn) logFn(msg, status);
    // ...but throttle the heavier full-log DB write.
    scheduleFlush();
  };

  // Append a run separator so previous logs are preserved during retry
  const separator = `\n\n=== New run started at ${new Date().toISOString()} ===\n\n`;
  try {
    const existing = await db.query.domains.findFirst({ where: eq(domains.id, domainId) });
    accumulatedLogs = (existing?.terminalLogs || "") + separator;
  } catch {
    accumulatedLogs = separator;
  }

  if (notice) log(notice, "Connecting");
  return { log, flush: flushLogsToDB };
}

// The server part of a setup: SSH in, un-proxy the mail host in Cloudflare, keep an existing Mailcow's
// hostname, then run the deploy script, which WIPES and reinstalls Mailcow on the server. Saves the API key
// the moment the script prints it, then marks the domain "ready". On failure it marks the domain "failed"
// and rethrows. The caller owns the log (createDomainLogger) and persists it when the run ends.
export async function installMailcowOnServer({
  domainId,
  ipAddress,
  sshUser,
  sshPassword,
  domainName,
  log,
}: {
  domainId: string;
  ipAddress: string;
  sshUser: string;
  sshPassword?: string | null;
  domainName?: string;
  log: LogFn;
}): Promise<void> {
  const db = getDb();
  log(`Connecting to ${ipAddress} via SSH...`, "Connecting");

  const decryptedPassword = tryDecrypt(sshPassword);
  const ssh = new SSHManager(
    ipAddress,
    22,
    sshUser,
    { type: "password", password: decryptedPassword || "" }
  );

  try {
    await ssh.connect({ timeoutMs: 30000, maxRetries: 5 });
    log("Connected successfully. Preparing environment and system packages...\n", "Updating System");

    // Self-heal Cloudflare DNS early (guarded) so it has time to propagate during the long
    // provision: remove any proxied/duplicate `mail` A record and un-proxy the rest, so the
    // Mailcow API at mail.<domain> is reachable (a proxied mail host breaks it).
    try {
      const dnsDomain = await db.query.domains.findFirst({ where: eq(domains.id, domainId) });
      if (dnsDomain?.userId) {
        const r = await unproxyDns(db, dnsDomain, dnsDomain.userId);
        log(`DNS check: un-proxied ${r.unproxied} record(s), removed ${r.removed} bad mail record(s).\n`, "Updating System");
      }
    } catch (dnsErr: any) {
      log(`DNS un-proxy step skipped: ${dnsErr.message}\n`, "Updating System");
    }

    // Mailcow serves its UI/API on exactly ONE hostname per server (MAILCOW_HOSTNAME). If this box
    // ALREADY runs Mailcow (a shared server hosting several domains), we must REUSE that hostname —
    // overwriting it with mail.<this domain> silently breaks every domain already provisioned here
    // (their API calls hit a vhost Mailcow no longer serves and get HTTP 200 `{}`).
    let mailcowHostname = `mail.${domainName}`;
    try {
      const existingHost = (
        await ssh.executeCommand(
          `grep -m1 '^MAILCOW_HOSTNAME=' /opt/mailcow-dockerized/mailcow.conf 2>/dev/null | cut -d= -f2- | tr -d '\\r'`,
          { timeoutMs: 20000 },
        )
      ).stdout.trim();
      if (existingHost && /\./.test(existingHost)) {
        if (existingHost.toLowerCase() !== mailcowHostname.toLowerCase()) {
          log(
            `This server already runs Mailcow as ${existingHost} — reusing it (not overwriting) so existing domains keep working.\n`,
            "Updating System",
          );
        }
        mailcowHostname = existingHost;
      }
    } catch {
      /* fresh box — keep mail.<domain> */
    }

    // Non-interactive Docker & Mailcow automated provisioning script
    const deployScript = [
      'set -euo pipefail',
      'export DEBIAN_FRONTEND=noninteractive',
      'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
      '',
      'echo "=== Repairing interrupted package state (if any) ==="',
      '# Stop Ubuntu background apt jobs that race for the dpkg lock and leave packages',
      '# half-configured (the root cause of "dpkg was interrupted" on fresh VPSes).',
      'systemctl stop unattended-upgrades apt-daily.service apt-daily-upgrade.service apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true',
      'systemctl kill --kill-who=all apt-daily.service apt-daily-upgrade.service 2>/dev/null || true',
      '# Wait for any apt/dpkg process still holding the lock to finish.',
      'for _i in $(seq 1 60); do if fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock >/dev/null 2>&1; then echo "apt/dpkg busy, waiting..."; sleep 5; else break; fi; done',
      '# Now clear any stale lock files left by a killed run.',
      'rm -f /var/lib/apt/lists/lock /var/cache/apt/archives/lock /var/lib/dpkg/lock /var/lib/dpkg/lock-frontend 2>/dev/null || true',
      '# Finish any half-configured packages. force-conf* avoids interactive config',
      '# prompts; stderr is shown (not hidden) so a real failure is visible in logs.',
      'dpkg --configure -a --force-confdef --force-confold || true',
      'apt-get install -f -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" || true',
      'dpkg --configure -a --force-confdef --force-confold || true',
      '# If a package is STILL broken, surface exactly which one (instead of failing blind).',
      'if ! apt-get check >/dev/null 2>&1; then echo "PREFLIGHT_WARNING: package system still inconsistent after repair:"; dpkg --audit || true; fi',
      '',
      'echo "=== Updating system ==="',
      'apt-get update -y || (sleep 5 && apt-get update -y)',
      'DEPS="curl wget git jq gnupg lsb-release ca-certificates lsof openssl"',
      '# Retry once on failure (transient mirror/lock issues are common on fresh VPSes).',
      'apt-get install -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" $DEPS || (sleep 5 && apt-get update -y && apt-get install -y $DEPS)',
      '',
      'echo "=== Preflight checks ==="',
      '# OS + RAM. Mailcow needs ~6GB (or ~2.5GB with ClamAV disabled, which we do).',
      'echo "OS: $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -a)"',
      'MEM_MB=$(awk "/MemTotal/ {printf \\"%d\\", \\$2/1024}" /proc/meminfo 2>/dev/null || echo 0)',
      'echo "RAM: ${MEM_MB} MB"',
      'if [ "${MEM_MB}" -lt 2300 ]; then echo "PREFLIGHT_WARNING: RAM below ~2.5GB; Mailcow may be unstable even with ClamAV disabled."; fi',
      '',
      '# Outbound port 25 — the deliverability dealbreaker. Many hosts block it.',
      'echo "Testing outbound SMTP (port 25)..."',
      'if timeout 8 bash -c "exec 3<>/dev/tcp/aspmx.l.google.com/25 && head -c 64 <&3" >/dev/null 2>&1; then',
      '  echo "PORT25_OUTBOUND=open"',
      'else',
      '  echo "PORT25_OUTBOUND=blocked"',
      '  echo "PREFLIGHT_WARNING: Outbound port 25 appears BLOCKED. This server will NOT be able to deliver mail until your VPS provider opens port 25 (often a support ticket). Setup will continue, but mail sending will fail."',
      'fi',
      '',
      'echo "=== Installing Docker ==="',
      'if ! command -v docker >/dev/null 2>&1; then',
      '  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh || wget -qO /tmp/get-docker.sh https://get.docker.com || { echo "FATAL: curl and wget failed"; exit 1; }',
      '  sh /tmp/get-docker.sh',
      '  rm -f /tmp/get-docker.sh',
      '  systemctl enable --now docker || true',
      'else',
      '  echo "Docker is already installed, skipping."',
      'fi',
      '',
      'echo "=== Freeing up required ports (stopping default MTAs and web servers) ==="',
      'systemctl stop postfix exim4 sendmail apache2 nginx || true',
      'systemctl disable postfix exim4 sendmail apache2 nginx || true',
      'apt-get remove -y postfix exim4 exim4-base sendmail apache2 nginx || true',
      'kill -9 $(lsof -t -i:25 -i:80 -i:443) 2>/dev/null || true',
      '',
      'echo "=== Cloning Mailcow ==="',
      'cd /opt',
      'rm -rf /root/mailcow-acme-backup',
      'if [ -d "mailcow-dockerized" ]; then',
      '  cd mailcow-dockerized',
      '  # Preserve the existing Lets Encrypt cert across the wipe so re-provisioning',
      '  # does not request a fresh cert every time and hit LE rate limits (5/week).',
      '  echo "=== Backing up existing ACME cert ==="',
      '  mkdir -p /root/mailcow-acme-backup',
      '  docker compose cp acme-mailcow:/var/lib/acme/. /root/mailcow-acme-backup/ 2>/dev/null || true',
      '  docker compose down -v 2>/dev/null || true',
      '  cd ..',
      'fi',
      'rm -rf mailcow-dockerized',
      'git clone https://github.com/mailcow/mailcow-dockerized',
      'cd mailcow-dockerized',
      '',
      'echo "=== Verifying Mailcow dependencies ==="',
      '# Mailcow generate_config.sh hard-requires curl (it exits "Cannot find command curl").',
      '# Some fresh VPS images leave it missing even after the bulk install above, so ensure it',
      "# here explicitly and fail loudly if it truly can't be installed.",
      'if ! command -v curl >/dev/null 2>&1; then',
      '  echo "curl missing - installing explicitly..."',
      '  apt-get update -y || true',
      '  # --reinstall first: if dpkg already thinks curl is installed but the binary is gone',
      '  # (a broken state on some images), a plain install no-ops and the binary stays missing.',
      '  apt-get install -y --reinstall curl || apt-get install -y curl || true',
      'fi',
      'if ! command -v curl >/dev/null 2>&1; then echo "FATAL: curl is required by Mailcow but could not be installed."; exit 1; fi',
      'echo "curl: $(command -v curl)"',
      '',
      'echo "=== Generating config ==="',
      `export MAILCOW_HOSTNAME="${mailcowHostname}"`,
      'export MAILCOW_TZ="UTC"',
      'export MAILCOW_BRANCH="master"',
      'export SKIP_CLAMD=y',
      'export FORCE=y',
      './generate_config.sh',
      '',
      'echo "=== Applying custom config ==="',
      'sed -i "s/SKIP_CLAMD=.*/SKIP_CLAMD=y/" mailcow.conf',
      'sed -i "s/SKIP_SOLR=.*/SKIP_SOLR=y/" mailcow.conf',
      '',
      'echo "=== Generating API key ==="',
      'apiKey=$(openssl rand -hex 32)',
      'if grep -q "^API_KEY=" mailcow.conf; then',
      '  sed -i "s/^API_KEY=.*/API_KEY=${apiKey}/" mailcow.conf',
      'else',
      '  echo "API_KEY=${apiKey}" >> mailcow.conf',
      'fi',
      'if grep -q "^API_ALLOW_FROM=" mailcow.conf; then',
      '  sed -i "s/^API_ALLOW_FROM=.*/API_ALLOW_FROM=127.0.0.1,auto,0.0.0.0\\/0,::\\/0/" mailcow.conf',
      'else',
      '  echo "API_ALLOW_FROM=127.0.0.1,auto,0.0.0.0/0,::/0" >> mailcow.conf',
      'fi',
      '# Emit the key NOW so the app persists it immediately — if a later step fails',
      '# (image pull, health timeout), the DB still has the correct key (avoids the',
      '# stale-key catch-22). The app redacts this line from stored logs.',
      'echo "GENERATED_API_KEY=${apiKey}"',
      '',
      'echo "=== Pulling Mailcow images ==="',
      'docker compose pull',
      '',
      'echo "=== Starting Mailcow ==="',
      'docker compose up -d',
      '',
      'echo "=== Restoring ACME cert (if one was backed up) ==="',
      'if [ -d /root/mailcow-acme-backup ] && [ -n "$(ls -A /root/mailcow-acme-backup 2>/dev/null)" ]; then',
      '  sleep 15', // give the acme-mailcow container a moment to come up
      '  docker compose cp /root/mailcow-acme-backup/. acme-mailcow:/var/lib/acme/ 2>/dev/null || true',
      '  docker compose restart acme-mailcow 2>/dev/null || true',
      '  echo "Restored preserved ACME cert; Mailcow will reuse it instead of requesting a new one."',
      'else',
      '  echo "No previous ACME cert to restore (first install)."',
      'fi',
      '',
      'echo "=== Waiting for Mailcow API ==="',
      'for i in $(seq 1 60); do',
      '  sleep 10',
      '  API_OUTPUT=$(curl -sSk --resolve "${MAILCOW_HOSTNAME}:443:127.0.0.1" "https://${MAILCOW_HOSTNAME}/api/v1/get/status/containers" -H "X-API-Key: ${apiKey}" 2>&1 || true)',
      '  # API is healthy once it returns the container status list with a running container.',
      '  # (Container names are "*-mailcow"; the old "mailcowdockerized" compose-prefix no longer appears.)',
      '  if echo "$API_OUTPUT" | grep -q "php-fpm-mailcow" && echo "$API_OUTPUT" | grep -q "\\"state\\":\\"running\\""; then',
      '    # Report whether a real (Lets Encrypt) cert is being served yet, or the',
      '    # self-signed fallback. The app tolerates self-signed, so this is informational.',
      '    CERT_ISSUER=$(echo | openssl s_client -connect 127.0.0.1:443 -servername "${MAILCOW_HOSTNAME}" 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null || echo "unknown")',
      '    echo "TLS cert issuer: ${CERT_ISSUER}"',
      '    case "$CERT_ISSUER" in *mailcow*) echo "NOTE: self-signed cert in use; Lets Encrypt will obtain a trusted cert shortly (ACME retries every 30 min).";; esac',
      '    # Restart SOGo + memcached now that the full stack (DB/php) is healthy, so',
      '    # webmail auth always works on a clean install. SOGo started before the DB was',
      '    # ready can cache a broken auth state ("password policy 65535" while IMAP works).',
      '    echo "Restarting SOGo so webmail auth is clean..."',
      '    docker compose restart sogo-mailcow memcached-mailcow >/dev/null 2>&1 || true',
      '    echo "MAILCOW_HEALTH=ok"',
      '    echo "MAILCOW_API_KEY=${apiKey}"',
      '    exit 0',
      '  else',
      '    echo "Health check attempt $i failed. Output: $API_OUTPUT"',
      '  fi',
      'done',
      '',
      'echo "MAILCOW_HEALTH=timeout"',
      'exit 1',
    ].join('\n');

    // Capture the generated API key from the stream the moment it appears and persist
    // it immediately, so a later failure can't leave the DB with a stale key.
    let capturedApiKey: string | null = null;
    // Match on a rolling buffer, not per-chunk: the SSH stream can split the 64-hex key across
    // two data chunks, which would make a per-chunk regex miss it and leave the DB with a stale
    // key (-> later 401s and a "ready but no mailboxes" domain).
    let keyScanBuffer = "";
    const API_KEY_MARKER = /(?:GENERATED_API_KEY|MAILCOW_API_KEY)=([a-f0-9]{64})/;

    await ssh.executeCommand(deployScript, {
      // Mailcow's image set is several GB. The pull alone can take 10-20 min on a
      // typical server, and the container start + health-check loop adds ~10 more.
      // 15 min was too short and killed the job mid-pull; allow 45 min.
      timeoutMs: 2_700_000,
      onData: (chunk) => {
        if (!capturedApiKey) {
          keyScanBuffer = (keyScanBuffer + chunk).slice(-512); // keep tail across chunk boundaries
          const m = keyScanBuffer.match(API_KEY_MARKER);
          if (m) {
            capturedApiKey = m[1];
            // Persist right away (best-effort) so the key survives any later failure.
            db.update(domains)
              .set({ mailcowHostname, mailcowApiKey: capturedApiKey })
              .where(eq(domains.id, domainId))
              .catch((err: any) => console.error("Failed to persist API key early:", err));
          }
        }
        // Redact the key from logs stored/shown to the user.
        log(chunk.replace(/([a-f0-9]{64})/g, "[redacted-api-key]"), "Configuring");
      }
    });

    // Retrieve generated API key from configuration file on the server (authoritative),
    // falling back to the one captured from the stream if the read fails.
    const getApiKeyCmd = await ssh.executeCommand('grep "^API_KEY=" /opt/mailcow-dockerized/mailcow.conf | cut -d= -f2', {
      timeoutMs: 15000
    });
    const apiKey = getApiKeyCmd.stdout.trim() || capturedApiKey;

    if (!apiKey) {
      throw new Error("Failed to retrieve generated Mailcow API key from server config.");
    }

    log("Mailcow is healthy and responding. Saving configurations to database...", "Ready");

    await db
      .update(domains)
      .set({
        status: "ready",
        mailcowHostname,
        mailcowApiKey: apiKey,
      })
      .where(eq(domains.id, domainId));

    log("Mailcow setup completed successfully!", "Ready");
  } catch (err: any) {
    log(`Setup failed: ${err.message}`, "Failed");
    try {
      await db
        .update(domains)
        .set({ status: "failed" })
        .where(eq(domains.id, domainId));
    } catch (dbErr) {
      console.error("Failed to update domain status to failed:", dbErr);
    }
    throw err;
  } finally {
    await ssh.dispose().catch(() => {});
  }
}

// A "setup" job (the provisioning flow before setup runs, still used by jobs already queued in Redis):
// install Mailcow, then create the mailboxes and sync DKIM as a guarded best-effort tail.
async function executeProvisionJob(
  domainId: string,
  ipAddress: string,
  sshUser: string,
  sshPassword?: string | null,
  domainName?: string,
  logFn?: (msg: string, status?: string) => void,
  notice?: string,
) {
  const db = getDb();
  const { log, flush } = await createDomainLogger(domainId, logFn, notice);

  try {
    await installMailcowOnServer({ domainId, ipAddress, sshUser, sshPassword, domainName, log });

    // End-to-end: now that the server is provisioned and the API key is saved, create the
    // mailboxes too, reusing the proven idempotent pipeline. GUARDED: a mailbox hiccup must
    // never undo the successful provision - the domain stays "ready" and the manual
    // "Setup Mailcow" / "Recreate Mailboxes" buttons remain available to re-run.
    try {
      const loadedDomain = await db.query.domains.findFirst({
        where: eq(domains.id, domainId),
        with: { server: true },
      });
      // Make sure the key we use actually works (re-read from the server if it drifted) before
      // creating mailboxes — otherwise the probe 401s and we'd report "ready" with no mailboxes.
      const { domain: freshDomain } = loadedDomain
        ? await ensureWorkingApiKey(db, loadedDomain)
        : { domain: loadedDomain };
      if (freshDomain?.mailcowHostname && freshDomain?.mailcowApiKey) {
        log("Creating mailboxes...", "Ready");
        // Same API transport ensureMailDomains found working (direct, or over SSH when the app's IP is blocked).
        const { existingDomains, ssh: mailcowSsh } = await ensureMailDomains(db, freshDomain);
        const { summary } = await createMailboxes(db, freshDomain, existingDomains, { ssh: mailcowSsh });
        log(`Mailboxes: ${summary.created}/${summary.total} created.`, "Ready");
        if (summary.created < summary.total) {
          log(
            `WARNING: ${summary.total - summary.created} of ${summary.total} mailboxes weren't created after 3 retries. ` +
              `Open the domain page to see why and retry them.`,
            "Ready",
          );
        }
        if (freshDomain.userId) {
          try {
            await syncDkim(db, freshDomain, freshDomain.userId);
            log("DKIM synced to Cloudflare.", "Ready");
          } catch (dkimErr: any) {
            log(`DKIM sync skipped (re-run from the domain page): ${dkimErr.message}`, "Ready");
          }
        }
      }
    } catch (mbErr: any) {
      log(
        `Mailbox creation step failed - server is provisioned, retry mailboxes from the domain page: ${mbErr.message}`,
        "Ready",
      );
    }
  } finally {
    // Persist the final lines. (This used to cancel the pending throttled write instead, which dropped
    // whatever was logged in the last 2 s, e.g. the mailbox and DKIM results.)
    await flush();
  }
}
