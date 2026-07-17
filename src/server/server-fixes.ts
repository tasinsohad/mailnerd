// SSH-based remediation for server-side problems, shared by BOTH troubleshooting flows:
// the system-created domain/job health cards (via runHealthFix -> the server fns below) and the
// external ad-hoc troubleshoot page (via quickFixServer).
//
// These implement the operator runbook: bring up / restart the Mailcow stack, restart Postfix so
// it binds the submission ports, open the mail ports on the host firewall, and flush the queue.

import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { domains } from "@/lib/db/schema";
import type { SSHAuth } from "@/types";
import {
  MAILCOW_SHELL_PRELUDE,
  FIREWALL_PORTS,
  parsePostfixQueue,
  dominantDeferral,
} from "./health-checks";
import { ConsoleLog } from "./console-bus";

export interface SshTarget {
  ipAddress: string;
  sshUser: string;
  sshPassword: string;
}

export interface SshFixResult {
  status: "fixed" | "noop" | "failed";
  detail: string;
}

// Run a script over one SSH session and return its combined output. When a ConsoleLog is passed,
// the script and its output stream to the user's live console as they happen.
async function sshRun(
  target: SshTarget,
  script: string,
  timeoutMs = 120000,
  log?: ConsoleLog,
): Promise<{ ok: boolean; out: string; error?: string }> {
  // Dynamic import, NOT a top-level one: this module mixes plain helpers with createServerFn
  // exports, so TanStack Start can't stub the whole module out of the client (health-fixes.ts
  // pulls it into the Domains/Jobs bundles). A static `import { SSHManager } from "@/lib/ssh"`
  // therefore dragged the native `ssh2` package into the browser and crashed those pages
  // ("The requested module '/node_modules/ssh2/…' does not provide an export named …").
  // Loading it here keeps ssh2 in the server chunk only.
  const { SSHManager } = await import("@/lib/ssh");
  const auth: SSHAuth = { type: "password", password: target.sshPassword };
  const mgr = new SSHManager(target.ipAddress, 22, target.sshUser, auth);
  try {
    log?.info(`Connecting to ${target.sshUser}@${target.ipAddress}…`);
    await mgr.connect({ timeoutMs: 15000, maxRetries: 1 });
    log?.cmd(script);
    const res = await mgr.executeCommand(script, {
      timeoutMs,
      onData: (chunk) => log?.out(chunk),
    });
    return { ok: true, out: `${res.stdout}\n${res.stderr}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log?.error(msg);
    return { ok: false, out: "", error: msg };
  } finally {
    await mgr.dispose().catch(() => {});
  }
}

// Step 3/4: bring stopped containers up, then restart if anything is still not running.
// `docker compose up -d` is the non-disruptive first move; a full restart only runs if needed.
export async function fixRestartMailcow(
  target: SshTarget,
  log?: ConsoleLog,
): Promise<SshFixResult> {
  const script =
    MAILCOW_SHELL_PRELUDE +
    `[ -f docker-compose.yml ] || { echo MAILCOW_DIR_NOT_FOUND; exit 0; }; ` +
    `$DC up -d 2>&1 | tail -5; ` +
    // Restart Postfix specifically so it re-binds 25/465/587 (runbook step 4).
    `$DC restart postfix-mailcow 2>&1 | tail -3; ` +
    `sleep 3; ` +
    `echo "---STATE---"; ` +
    `docker ps --format '{{.Names}}\t{{.State}}' 2>/dev/null | grep -E 'postfix|dovecot|nginx|rspamd|mysql|redis'; ` +
    `echo "---PORTS---"; ` +
    `ss -tlnp 2>/dev/null | grep -E ':(25|465|587)\\b' | wc -l`;
  const r = await sshRun(target, script, undefined, log);
  if (!r.ok) return { status: "failed", detail: `SSH failed: ${r.error}` };
  if (r.out.includes("MAILCOW_DIR_NOT_FOUND")) {
    return {
      status: "failed",
      detail: "Couldn't find the Mailcow directory (expected /opt/mailcow-dockerized).",
    };
  }
  const running = (r.out.match(/\trunning/g) || []).length;
  const portsLine = r.out.split("---PORTS---")[1]?.trim() ?? "";
  const portCount = Number(portsLine.split("\n")[0]?.trim() || 0);
  return {
    status: "fixed",
    detail: `Mailcow brought up and Postfix restarted — ${running} core containers running, ${portCount || 0} of 25/465/587 listening.`,
  };
}

// Step 5: allow every mail port on the host firewall, then reload.
export async function fixOpenFirewall(target: SshTarget, log?: ConsoleLog): Promise<SshFixResult> {
  const allow = FIREWALL_PORTS.map((p) => `ufw allow ${p}/tcp >/dev/null 2>&1`).join("; ");
  const script =
    `command -v ufw >/dev/null 2>&1 || { echo UFW_NOT_INSTALLED; exit 0; }; ` +
    `${allow}; ufw reload >/dev/null 2>&1; echo "---STATUS---"; ufw status 2>/dev/null`;
  const r = await sshRun(target, script, 60000, log);
  if (!r.ok) return { status: "failed", detail: `SSH failed: ${r.error}` };
  if (r.out.includes("UFW_NOT_INSTALLED")) {
    return {
      status: "noop",
      detail:
        "ufw isn't installed, so the host isn't blocking ports — check your VPS provider's firewall instead.",
    };
  }
  const status = r.out.split("---STATUS---")[1] ?? "";
  const allowed = FIREWALL_PORTS.filter((p) =>
    new RegExp(`^\\s*${p}(/tcp)?\\s+ALLOW`, "m").test(status),
  );
  return {
    status: "fixed",
    detail: `Opened mail ports on ufw (${allowed.length}/${FIREWALL_PORTS.length} confirmed ALLOW). Remember to allow the same ports in your VPS provider's firewall.`,
  };
}

// Create a Mailcow API key on a server that has none, so the API-only checks (API/UI reachability,
// DKIM key-match) can run. Uses Mailcow's own documented `API_KEY=` in mailcow.conf — the same
// mechanism our provisioning uses (queue.ts), so it's proven against real Mailcow servers.
//
// API_ALLOW_FROM is scoped to 127.0.0.1 + THIS APP's egress IP (as the server sees it over SSH,
// via $SSH_CLIENT) rather than 0.0.0.0/0 — opening a stranger's Mailcow API to the whole internet
// would be an unacceptable security downgrade. If a key already exists we reuse it and change
// nothing. NOTE: applying mailcow.conf changes recreates the affected containers.
export async function fixCreateApiKey(target: SshTarget, log?: ConsoleLog): Promise<SshFixResult> {
  // Plain (non-template) strings so ${VAR} reaches the shell instead of being interpolated by TS.
  const script = [
    MAILCOW_SHELL_PRELUDE,
    '[ -f mailcow.conf ] || { echo "NO_CONF"; exit 0; }',
    // Never clobber an existing key.
    'EXISTING=$(grep -m1 "^API_KEY=" mailcow.conf 2>/dev/null | cut -d= -f2 | tr -d "\\r")',
    'if [ -n "$EXISTING" ]; then echo "EXISTING_KEY=yes"; exit 0; fi',
    // Our egress IP, as the server sees this SSH connection.
    'SRCIP=$(echo "$SSH_CLIENT" | awk "{print \\$1}")',
    '[ -n "$SRCIP" ] || SRCIP=$(echo "$SSH_CONNECTION" | awk "{print \\$1}")',
    // 64 hex chars, matching what our provisioning generates.
    "KEY=$(openssl rand -hex 32 2>/dev/null)",
    '[ -n "$KEY" ] || KEY=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d " \\n")',
    '[ -n "$KEY" ] || { echo "NO_RANDOM"; exit 0; }',
    'echo "API_KEY=${KEY}" >> mailcow.conf',
    // Scope the allow-list: keep any existing entries, add ours if absent.
    'ALLOW="127.0.0.1"',
    '[ -n "$SRCIP" ] && ALLOW="127.0.0.1,${SRCIP}"',
    'CUR=$(grep -m1 "^API_ALLOW_FROM=" mailcow.conf 2>/dev/null | cut -d= -f2 | tr -d "\\r")',
    'if [ -z "$CUR" ]; then',
    '  echo "API_ALLOW_FROM=${ALLOW}" >> mailcow.conf',
    'elif [ -n "$SRCIP" ] && ! echo "$CUR" | grep -q "$SRCIP"; then',
    '  sed -i "s|^API_ALLOW_FROM=.*|API_ALLOW_FROM=${CUR},${SRCIP}|" mailcow.conf',
    '  ALLOW="${CUR},${SRCIP}"',
    "else",
    '  ALLOW="$CUR"',
    "fi",
    // mailcow.conf is read as container env — recreate so the new key takes effect.
    "$DC up -d 2>&1 | tail -3",
    'echo "CREATED=yes"',
    'echo "ALLOWED=${ALLOW}"',
    'echo "SRC=${SRCIP}"',
  ].join("\n");

  const r = await sshRun(target, script, 180000, log);
  if (!r.ok) return { status: "failed", detail: "SSH failed: " + r.error };
  if (r.out.includes("NO_CONF")) {
    return { status: "failed", detail: "No mailcow.conf found — is Mailcow installed here?" };
  }
  if (r.out.includes("EXISTING_KEY=yes")) {
    return {
      status: "noop",
      detail: "The server already has an API key in mailcow.conf — nothing to create.",
    };
  }
  if (r.out.includes("NO_RANDOM")) {
    return { status: "failed", detail: "Couldn't generate a key (no openssl or /dev/urandom)." };
  }
  if (!r.out.includes("CREATED=yes")) {
    return { status: "failed", detail: "Couldn't write the API key to mailcow.conf." };
  }
  const allowed = (r.out.match(/ALLOWED=(.*)/)?.[1] ?? "").trim();
  return {
    status: "fixed",
    detail:
      "Created a Mailcow API key and applied it" +
      (allowed ? ` (API access limited to ${allowed})` : "") +
      ". Container and DKIM checks will run on the next check.",
  };
}

// Step 10: restart just nginx so the Mailcow UI/API comes back.
export async function fixRestartNginx(target: SshTarget, log?: ConsoleLog): Promise<SshFixResult> {
  const script = MAILCOW_SHELL_PRELUDE + `$DC restart nginx-mailcow 2>&1 | tail -3; echo RESTARTED`;
  const r = await sshRun(target, script, 60000, log);
  if (!r.ok) return { status: "failed", detail: `SSH failed: ${r.error}` };
  return {
    status: "fixed",
    detail: "Restarted nginx-mailcow — the Mailcow UI should respond again.",
  };
}

// Stop Postfix stalling on IPv6 when the box has no working IPv6 route. Written to Mailcow's
// documented override file so it survives updates. inet_protocols needs a restart, not a reload.
export async function fixPostfixIpv4Only(
  target: SshTarget,
  log?: ConsoleLog,
): Promise<SshFixResult> {
  const script = [
    MAILCOW_SHELL_PRELUDE,
    '[ -f mailcow.conf ] || { echo "NO_CONF"; exit 0; }',
    "mkdir -p data/conf/postfix",
    "touch data/conf/postfix/extra.cf",
    // Idempotent: don't stack duplicate directives on repeated runs.
    'if grep -q "^inet_protocols" data/conf/postfix/extra.cf; then',
    '  sed -i "s|^inet_protocols.*|inet_protocols = ipv4|" data/conf/postfix/extra.cf',
    '  echo "UPDATED=yes"',
    "else",
    '  echo "inet_protocols = ipv4" >> data/conf/postfix/extra.cf',
    '  echo "ADDED=yes"',
    "fi",
    "$DC restart postfix-mailcow 2>&1 | tail -3",
    "sleep 3",
    // Retry the mail that was stuck behind the IPv6 stall.
    "docker exec $(docker ps -qf name=postfix-mailcow 2>/dev/null) postqueue -f 2>/dev/null || true",
    'echo "DONE=yes"',
  ].join("\n");
  const r = await sshRun(target, script, 120000, log);
  if (!r.ok) return { status: "failed", detail: "SSH failed: " + r.error };
  if (r.out.includes("NO_CONF")) {
    return { status: "failed", detail: "No mailcow.conf found — is Mailcow installed here?" };
  }
  if (!r.out.includes("DONE=yes")) {
    return { status: "failed", detail: "Couldn't apply inet_protocols = ipv4 to Postfix." };
  }
  return {
    status: "fixed",
    detail:
      "Set Postfix to IPv4-only (data/conf/postfix/extra.cf), restarted it and flushed the queue. Mail should now deliver over IPv4 instead of stalling on IPv6.",
  };
}

// Step 8: retry deferred mail now — and verify it actually drained, rather than claiming success
// just because the command ran. A flush only helps if the underlying cause is gone.
export async function fixFlushQueue(target: SshTarget, log?: ConsoleLog): Promise<SshFixResult> {
  const qcount =
    `docker exec $(docker ps -qf name=postfix-mailcow 2>/dev/null) postqueue -p 2>/dev/null ` +
    `|| postqueue -p 2>/dev/null || echo QUEUE_UNAVAILABLE`;
  const script = [
    'echo "---BEFORE---"',
    qcount,
    'echo "---FLUSH---"',
    `docker exec $(docker ps -qf name=postfix-mailcow 2>/dev/null) postqueue -f 2>/dev/null ` +
      `|| postqueue -f 2>/dev/null || echo FLUSH_UNAVAILABLE`,
    "sleep 6",
    'echo "---AFTER---"',
    qcount,
  ].join("\n");
  const r = await sshRun(target, script, 60000, log);
  if (!r.ok) return { status: "failed", detail: "SSH failed: " + r.error };
  if (r.out.includes("QUEUE_UNAVAILABLE") || r.out.includes("FLUSH_UNAVAILABLE")) {
    return { status: "failed", detail: "Couldn't reach the Postfix queue over SSH." };
  }
  const now = Date.now();
  const before = parsePostfixQueue(
    r.out.split("---BEFORE---")[1]?.split("---FLUSH---")[0] ?? "",
    now,
  );
  const after = parsePostfixQueue(r.out.split("---AFTER---")[1] ?? "", now);
  if (before.count === 0) {
    return { status: "noop", detail: "The queue was already empty — nothing to flush." };
  }
  if (after.count === 0) {
    return {
      status: "fixed",
      detail: `Flushed the queue — all ${before.count} message${before.count === 1 ? "" : "s"} delivered.`,
    };
  }
  if (after.count < before.count) {
    return {
      status: "fixed",
      detail: `Flushed the queue — ${before.count - after.count} of ${before.count} delivered, ${after.count} still deferred (retrying).`,
    };
  }
  // Nothing moved: the flush retried and hit the same wall, so be honest rather than claim a fix.
  const reason = dominantDeferral(after);
  const why =
    reason === "timeout"
      ? " Deliveries are still timing out — fix the underlying connectivity (outbound port 25 / IPv6) first."
      : reason === "rejected"
        ? " Recipients are still rejecting — fix reputation and SPF/DKIM/DMARC first."
        : " Check the mail log for the deferral reason.";
  return {
    status: "noop",
    detail: `Retried all ${before.count} message${before.count === 1 ? "" : "s"}, but none delivered.${why}`,
  };
}

// Pull raw logs off the server so they can be read, copied or shared without SSHing in. Postfix
// is where delivery failures are explained, but the Mailcow stack, the queue and the journal all
// matter too, so the source is selectable.
export type ServerLogSource = "postfix" | "mailcow" | "queue" | "journal";

const LOG_SOURCES: Record<ServerLogSource, (lines: number) => string> = {
  // Delivery attempts + deferral reasons — the one that explains a stuck queue.
  postfix: (n) =>
    MAILCOW_SHELL_PRELUDE +
    `$DC logs --tail=${n} postfix-mailcow 2>&1 || tail -n ${n} /var/log/mail.log 2>&1`,
  // Everything in the stack, for crashes/restarts.
  mailcow: (n) => MAILCOW_SHELL_PRELUDE + `$DC logs --tail=${n} 2>&1`,
  // The queue itself, with each message's deferral reason.
  queue: () =>
    `docker exec $(docker ps -qf name=postfix-mailcow 2>/dev/null) postqueue -p 2>&1 ` +
    `|| postqueue -p 2>&1 || mailq 2>&1`,
  // Host-level mail journal, for when Postfix runs outside Docker.
  journal: (n) =>
    `journalctl -u postfix --no-pager -n ${n} 2>&1 || tail -n ${n} /var/log/mail.log 2>&1`,
};

export async function fetchServerLog(
  target: SshTarget,
  source: ServerLogSource,
  lines: number,
  log?: ConsoleLog,
): Promise<{ ok: boolean; text: string; error?: string }> {
  const r = await sshRun(target, LOG_SOURCES[source](lines), 90000, log);
  if (!r.ok) return { ok: false, text: "", error: r.error };
  return { ok: true, text: r.out.trim() };
}

// ------------------------------------------------------------------------------------------------
// Server fns for system-created domains — look the SSH credentials up from the domain row so the
// health cards can run the same fixes with one click.
// ------------------------------------------------------------------------------------------------

// Resolve a domain the caller owns into an SSH target.
async function targetForDomain(
  db: any,
  userId: string,
  domainId: string,
): Promise<{ target?: SshTarget; error?: string }> {
  if (!db) return { error: "Database not connected" };
  const domain = await db.query.domains.findFirst({
    where: and(eq(domains.id, domainId), eq(domains.userId, userId)),
  });
  if (!domain) return { error: "Domain not found" };
  if (!domain.ipAddress) return { error: "This domain has no server IP yet." };
  if (!domain.sshPassword) return { error: "No SSH credentials stored for this server." };
  return {
    target: {
      ipAddress: domain.ipAddress,
      sshUser: domain.sshUser || "root",
      sshPassword: domain.sshPassword,
    },
  };
}

const domainInput = (d: unknown) => z.object({ domainId: z.string() }).parse(d);

export const restartMailcowForDomain = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator(domainInput)
  .handler(async ({ data, context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { db, userId } = context as any;
    const { target, error } = await targetForDomain(db, userId, data.domainId);
    if (error || !target) return { error };
    const r = await fixRestartMailcow(target);
    return r.status === "failed" ? { error: r.detail } : { success: true, detail: r.detail };
  });

export const openFirewallForDomain = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator(domainInput)
  .handler(async ({ data, context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { db, userId } = context as any;
    const { target, error } = await targetForDomain(db, userId, data.domainId);
    if (error || !target) return { error };
    const r = await fixOpenFirewall(target);
    return r.status === "failed" ? { error: r.detail } : { success: true, detail: r.detail };
  });
