import { Queue, Worker, Job } from "bullmq";
import Redis from "ioredis";
import { getDb } from "../lib/db";
import { domains } from "../lib/db/schema";
import { eq } from "drizzle-orm";
import { SSHManager } from "../lib/ssh";
import { decrypt } from "../lib/encryption";
import { jobEvents } from "./events";
import { ensureMailDomains, createMailboxes, syncDkim } from "./pipeline";
import crypto from "crypto";

// Try to decrypt credentials, falling back to plain text if not encrypted
function tryDecrypt(value: string | null | undefined): string | null {
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

if (process.env.REDIS_URL) {
  try {
    const connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
    serverSetupQueue = new Queue("server-setup", {
      connection: connection as any,
      defaultJobOptions: {
        // Retry each domain up to 3 times with exponential backoff, then leave it failed
        // (executeProvisionJob records the error in terminalLogs + status on each attempt).
        attempts: 3,
        backoff: { type: "exponential", delay: 30000 },
        removeOnComplete: 100,
        removeOnFail: false,
      },
    });

    const globalForWorker = global as unknown as { worker: Worker | undefined };
    if (!globalForWorker.worker) {
      globalForWorker.worker = new Worker(
        "server-setup",
        async (job: Job) => {
          const { domainId, ipAddress, sshUser, sshPassword, domainName } = job.data;
          const channel = `server-log:${domainId}`;
          const pub = connection.duplicate();

          const logFn = (msg: string, status?: string) => {
            const payload = JSON.stringify({ msg, status });
            pub.publish(channel, payload);
            jobEvents.emit(channel, { msg, status, chunk: msg });
          };

          try {
            await executeProvisionJob(domainId, ipAddress, sshUser, sshPassword, domainName, logFn);
          } finally {
            pub.disconnect();
          }
        },
        // Process 3 domains at a time; the rest stay queued and start as slots free.
        { connection: connection as any, concurrency: Number(process.env.PROVISION_CONCURRENCY ?? 3) }
      );
      worker = globalForWorker.worker;
    } else {
      worker = globalForWorker.worker;
    }
  } catch (err) {
    console.error("Failed to initialize Redis setup queue:", err);
  }
}

export async function addServerSetupJob(
  domainId: string,
  ipAddress: string,
  sshUser: string,
  sshPassword?: string | null,
  domainName?: string,
) {
  if (!isValidHost(ipAddress)) {
    throw new Error("Invalid IP address or hostname");
  }
  if (sshUser && !/^[a-zA-Z0-9_-]+$/.test(sshUser)) {
    throw new Error("Invalid SSH username");
  }
  if (domainName && !isValidDomainName(domainName)) {
    throw new Error("Invalid domain name");
  }

  const sanitizedIp = sanitizeShellInput(ipAddress);
  const sanitizedUser = sanitizeShellInput(sshUser);
  const sanitizedDomain = sanitizeShellInput(domainName);

  if (serverSetupQueue) {
    console.log(`[addServerSetupJob] Using BullMQ`);
    const job = await serverSetupQueue.add("setup", {
      domainId,
      ipAddress: sanitizedIp,
      sshUser: sanitizedUser,
      sshPassword,
      domainName: sanitizedDomain,
    });
    return { jobId: job.id };
  } else {
    console.log(`[addServerSetupJob] Using in-memory fallback`);
    // In-memory queue fallback
    const jobId = crypto.randomUUID();
    const db = getDb();
    
    console.log(`[addServerSetupJob] Updating DB status to configuring`);
    await db
      .update(domains)
      .set({ status: "configuring" })
      .where(eq(domains.id, domainId));

    console.log(`[addServerSetupJob] Setting 2000ms timeout`);
    // Delay by 2s so the browser has time to open the SSE connection before logs start firing
    setTimeout(async () => {
      console.log(`[addServerSetupJob] Inside setTimeout, calling executeProvisionJob`);
      const channel = `server-log:${domainId}`;
      const logFn = (msg: string, status?: string) => {
        jobEvents.emit(channel, { msg, status, chunk: msg });
      };

      try {
        await executeProvisionJob(domainId, sanitizedIp, sanitizedUser, sshPassword, sanitizedDomain, logFn);
        console.log(`[addServerSetupJob] executeProvisionJob completed successfully`);
      } catch (err) {
        console.error(`In-memory setup error for domain ${domainId}:`, err);
      }
    }, 2000);

    console.log(`[addServerSetupJob] Returning jobId: ${jobId}`);
    return { jobId };
  }
}

async function executeProvisionJob(
  domainId: string,
  ipAddress: string,
  sshUser: string,
  sshPassword?: string | null,
  domainName?: string,
  logFn?: (msg: string, status?: string) => void
) {
  const db = getDb();
  let accumulatedLogs = "";

  // Persist the full log to DB so SSE reconnects always have history. Steps like
  // `docker compose pull` emit hundreds of progress chunks per second; writing the
  // entire (growing) log on every chunk floods the DB and stalls the job. So throttle
  // DB writes to at most once every 2s, with a trailing write so the last chunk lands.
  const FLUSH_INTERVAL_MS = 2000;
  let lastFlush = 0;
  let pendingFlush: NodeJS.Timeout | null = null;

  const flushLogsToDB = () => {
    lastFlush = Date.now();
    if (pendingFlush) {
      clearTimeout(pendingFlush);
      pendingFlush = null;
    }
    db.update(domains)
      .set({ terminalLogs: accumulatedLogs })
      .where(eq(domains.id, domainId))
      .catch((err: any) => console.error("Failed to flush logs to DB:", err));
  };

  const scheduleFlush = () => {
    const sinceLast = Date.now() - lastFlush;
    if (sinceLast >= FLUSH_INTERVAL_MS) {
      flushLogsToDB();
    } else if (!pendingFlush) {
      pendingFlush = setTimeout(flushLogsToDB, FLUSH_INTERVAL_MS - sinceLast);
    }
  };

  const log = (msg: string, status?: string) => {
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

    const mailcowHostname = `mail.${domainName}`;

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
      'apt-get install -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" curl wget git jq gnupg lsb-release ca-certificates lsof',
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
    const API_KEY_MARKER = /(?:GENERATED_API_KEY|MAILCOW_API_KEY)=([a-f0-9]{64})/;

    await ssh.executeCommand(deployScript, {
      // Mailcow's image set is several GB. The pull alone can take 10-20 min on a
      // typical server, and the container start + health-check loop adds ~10 more.
      // 15 min was too short and killed the job mid-pull; allow 45 min.
      timeoutMs: 2_700_000,
      onData: (chunk) => {
        const m = chunk.match(API_KEY_MARKER);
        if (m && !capturedApiKey) {
          capturedApiKey = m[1];
          // Persist right away (best-effort) so the key survives any later failure.
          db.update(domains)
            .set({ mailcowHostname, mailcowApiKey: capturedApiKey })
            .where(eq(domains.id, domainId))
            .catch((err: any) => console.error("Failed to persist API key early:", err));
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
        terminalLogs: accumulatedLogs,
      })
      .where(eq(domains.id, domainId));

    log("Mailcow setup completed successfully!", "Ready");

    // End-to-end: now that the server is provisioned and the API key is saved, create the
    // mailboxes too, reusing the proven idempotent pipeline. GUARDED: a mailbox hiccup must
    // never undo the successful provision - the domain stays "ready" and the manual
    // "Setup Mailcow" / "Recreate Mailboxes" buttons remain available to re-run.
    try {
      const freshDomain = await db.query.domains.findFirst({ where: eq(domains.id, domainId) });
      if (freshDomain?.mailcowHostname && freshDomain?.mailcowApiKey) {
        log("Creating mailboxes...", "Ready");
        const { existingDomains } = await ensureMailDomains(db, freshDomain);
        const { summary } = await createMailboxes(db, freshDomain, existingDomains);
        log(`Mailboxes: ${summary.created}/${summary.total} created.`, "Ready");
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
  } catch (err: any) {
    log(`Setup failed: ${err.message}`, "Failed");
    try {
      await db
        .update(domains)
        .set({ 
          status: "failed",
          terminalLogs: accumulatedLogs,
        })
        .where(eq(domains.id, domainId));
    } catch (dbErr) {
      console.error("Failed to update domain status to failed:", dbErr);
    }
    throw err;
  } finally {
    // Cancel any pending throttled log write; the success/failure branches above
    // already persisted the final log + status.
    if (pendingFlush) {
      clearTimeout(pendingFlush);
      pendingFlush = null;
    }
    await ssh.dispose().catch(() => {});
  }
}
