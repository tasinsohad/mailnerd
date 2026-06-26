import { Queue, Worker, Job } from "bullmq";
import Redis from "ioredis";
import { getDb } from "../lib/db";
import { domains } from "../lib/db/schema";
import { eq } from "drizzle-orm";
import { SSHManager } from "../lib/ssh";
import { decrypt } from "../lib/encryption";
import { jobEvents } from "./events";
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
    const connection = new Redis(process.env.REDIS_URL);
    serverSetupQueue = new Queue("server-setup", { connection: connection as any });

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
        { connection: connection as any, concurrency: 5 }
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
    const job = await serverSetupQueue.add("setup", {
      domainId,
      ipAddress: sanitizedIp,
      sshUser: sanitizedUser,
      sshPassword,
      domainName: sanitizedDomain,
    });
    return { jobId: job.id };
  } else {
    // In-memory queue fallback
    const jobId = crypto.randomUUID();
    const db = getDb();
    
    await db
      .update(domains)
      .set({ status: "configuring" })
      .where(eq(domains.id, domainId));

    // Delay by 2s so the browser has time to open the SSE connection before logs start firing
    setTimeout(async () => {
      const channel = `server-log:${domainId}`;
      const logFn = (msg: string, status?: string) => {
        jobEvents.emit(channel, { msg, status, chunk: msg });
      };

      try {
        await executeProvisionJob(domainId, sanitizedIp, sanitizedUser, sshPassword, sanitizedDomain, logFn);
      } catch (err) {
        console.error(`In-memory setup error for domain ${domainId}:`, err);
      }
    }, 2000);

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

  // Flush ALL logs to DB on every write so SSE reconnects always have full history
  const flushLogsToDB = () => {
    db.update(domains)
      .set({ terminalLogs: accumulatedLogs })
      .where(eq(domains.id, domainId))
      .catch((err: any) => console.error("Failed to flush logs to DB:", err));
  };

  const log = (msg: string, status?: string) => {
    accumulatedLogs += msg;
    if (logFn) logFn(msg, status);
    // Write every log line to DB immediately so SSE clients that connect mid-run see all output
    flushLogsToDB();
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
      '# Kill any stale apt locks from previous runs',
      'rm -f /var/lib/apt/lists/lock /var/cache/apt/archives/lock /var/lib/dpkg/lock /var/lib/dpkg/lock-frontend 2>/dev/null || true',
      'dpkg --configure -a 2>/dev/null || true',
      '',
      'echo "=== Updating system ==="',
      'apt-get update -y',
      'apt-get install -y curl wget git jq gnupg lsb-release ca-certificates',
      '',
      'echo "=== Installing Docker ==="',
      'if ! command -v docker >/dev/null 2>&1; then',
      '  if command -v curl >/dev/null 2>&1; then',
      '    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh',
      '  elif command -v wget >/dev/null 2>&1; then',
      '    wget -qO /tmp/get-docker.sh https://get.docker.com',
      '  elif [ -x /usr/bin/curl ]; then',
      '    /usr/bin/curl -fsSL https://get.docker.com -o /tmp/get-docker.sh',
      '  elif [ -x /usr/bin/wget ]; then',
      '    /usr/bin/wget -qO /tmp/get-docker.sh https://get.docker.com',
      '  else',
      '    echo "FATAL: curl and wget both unavailable, cannot install Docker."',
      '    exit 1',
      '  fi',
      '  sh /tmp/get-docker.sh',
      '  rm -f /tmp/get-docker.sh',
      '  systemctl enable --now docker || true',
      'else',
      '  echo "Docker is already installed, skipping."',
      'fi',
      '',
      'echo "=== Cloning Mailcow ==="',
      'cd /opt',
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
      'sed -i "s/HTTP_PORT=.*/HTTP_PORT=8080/" mailcow.conf',
      'sed -i "s/HTTPS_PORT=.*/HTTPS_PORT=8443/" mailcow.conf',
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
      '',
      'echo "=== Pulling Mailcow images ==="',
      'docker compose pull',
      '',
      'echo "=== Starting Mailcow ==="',
      'docker compose up -d',
      '',
      'echo "=== Waiting for Mailcow API ==="',
      'for i in $(seq 1 60); do',
      '  sleep 10',
      '  if curl -sf http://localhost:8080/api/v1/get/status/containers -H "X-API-Key: ${apiKey}" > /dev/null 2>&1; then',
      '    echo "MAILCOW_HEALTH=ok"',
      '    echo "MAILCOW_API_KEY=${apiKey}"',
      '    exit 0',
      '  fi',
      'done',
      '',
      'echo "MAILCOW_HEALTH=timeout"',
      'exit 1',
    ].join('\n');

    await ssh.executeCommand(deployScript, {
      timeoutMs: 900000,
      onData: (chunk) => {
        log(chunk, "Configuring");
      }
    });

    // Retrieve generated API key from configuration file on the server
    const getApiKeyCmd = await ssh.executeCommand('grep "^API_KEY=" /opt/mailcow-dockerized/mailcow.conf | cut -d= -f2', {
      timeoutMs: 15000
    });
    const apiKey = getApiKeyCmd.stdout.trim();

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
    await ssh.dispose().catch(() => {});
  }
}
