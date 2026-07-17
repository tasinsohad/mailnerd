import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { userSecrets } from "@/lib/db/schema";
import { checkServerHealth, deriveSendingDomain } from "./health-server";
import { readMailcowConfigOverSsh } from "./mailcow-key";
import { ConsoleLog, redact } from "./console-bus";
import { fetchServerLog } from "./server-fixes";
import { buildRemediationPlan } from "./remediation-planner";
import { executeStep } from "./remediation";
import type { DomainHealth, Indicator } from "./health-types";

// Ad-hoc troubleshooting for an EXTERNAL VPS that this system did not provision (mailboxes were
// created elsewhere). The user supplies just the IP + SSH login; we reuse the same deliverability
// engine as owned servers, so FCrDNS, outbound port 25, the Postfix queue and IP reputation all
// run from the SSH session alone. Nothing is persisted — this is a stateless diagnostic.

// The mail host and API key are both read off the server in ONE SSH session — see
// readMailcowConfigOverSsh in mailcow-key.ts.

export const troubleshootServer = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        ipAddress: z.string().trim().min(1, "IP address is required"),
        sshUser: z.string().trim().min(1).default("root"),
        sshPassword: z.string().min(1, "SSH password is required"),
        // Optional: skip auto-detection and enable Mailcow container checks.
        mailcowHostname: z.string().trim().optional(),
        mailcowApiKey: z.string().trim().optional(),
        // Optional: the domain you send from. Blank = derived from the mail host.
        sendingDomain: z.string().trim().optional(),
        // Read the Mailcow API key off the server over SSH when one wasn't supplied.
        fetchApiKey: z.boolean().default(true),
        // Client-generated id for the live console stream (see console-bus.ts).
        runId: z.string().trim().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const log = new ConsoleLog(data.runId);
    try {
      log.info(`Running diagnostics against ${data.ipAddress}…`);
      const target = {
        ipAddress: data.ipAddress,
        sshUser: data.sshUser,
        sshPassword: data.sshPassword,
      };
      // One SSH session gets us both the mail host and (optionally) the API key, so the
      // API-only checks — container health and DKIM key-match — can run without the user
      // hunting the key down themselves.
      const needHost = !data.mailcowHostname;
      const wantApiKey = !data.mailcowApiKey && data.fetchApiKey;
      const cfg =
        needHost || wantApiKey
          ? await readMailcowConfigOverSsh(target, { wantApiKey, log })
          : {
              hostname: null,
              apiKey: null,
              apiKeySource: null,
              apiAllowFrom: null,
              apiKeyRestricted: false,
            };

      const mailHost = data.mailcowHostname || cfg.hostname;
      const apiKey = data.mailcowApiKey || cfg.apiKey;

      const health = await checkServerHealth({
        ipAddress: data.ipAddress,
        mailcowHostname: mailHost,
        mailcowApiKey: apiKey || null,
        sshUser: data.sshUser,
        sshPassword: data.sshPassword,
        // Also check the sending-authentication DNS records (MX/SPF/DKIM/DMARC).
        includeSendingDns: true,
        sendingDomain: data.sendingDomain || null,
        log,
      });

      const sendingDomain =
        data.sendingDomain?.trim() || (mailHost ? deriveSendingDomain(mailHost) : null);
      log.info(`Diagnostics complete — ${health.status} (${health.score}%).`);
      // The key itself is deliberately NOT returned to the browser — only where it came from.
      return {
        transcript: log.transcript(),
        health,
        mailcowHostname: mailHost,
        hostnameAutodetected: needHost && !!cfg.hostname,
        sendingDomain,
        apiKeyAutodetected: !data.mailcowApiKey && !!cfg.apiKey,
        apiKeySource: data.mailcowApiKey ? "provided" : cfg.apiKeySource,
        apiKeyRestricted: !data.mailcowApiKey && cfg.apiKeyRestricted,
        apiAllowFrom: !data.mailcowApiKey ? cfg.apiAllowFrom : null,
        apiKeyWanted: wantApiKey,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(msg);
      return { error: msg, transcript: log.transcript() };
    }
  });

// Fetch raw logs off the server for reading / copying / sharing, so diagnosing a stuck queue
// doesn't require SSHing in by hand. Redacted before it leaves the server (these outputs can
// include mailcow.conf values and DB passwords). Nothing is persisted.
export const getServerLog = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        ipAddress: z.string().trim().min(1),
        sshUser: z.string().trim().min(1).default("root"),
        sshPassword: z.string().min(1),
        source: z.enum(["postfix", "mailcow", "queue", "journal"]).default("postfix"),
        lines: z.number().int().min(50).max(5000).default(500),
        runId: z.string().trim().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const log = new ConsoleLog(data.runId);
    log.info(`Fetching ${data.source} log (last ${data.lines} lines) from ${data.ipAddress}…`);
    const r = await fetchServerLog(
      { ipAddress: data.ipAddress, sshUser: data.sshUser, sshPassword: data.sshPassword },
      data.source,
      data.lines,
      // The console echoes the command, but not the whole log — that would duplicate every line
      // into the transcript. The text comes back in the response instead.
      undefined,
    );
    if (!r.ok) {
      log.error(r.error ?? "Could not read the log.");
      return { error: r.error ?? "Could not read the log.", transcript: log.transcript() };
    }
    const text = redact(r.text);
    const count = text ? text.split("\n").length : 0;
    log.info(`Fetched ${count} line${count === 1 ? "" : "s"} of ${data.source} log.`);
    return { text, lines: count, source: data.source, transcript: log.transcript() };
  });

// ------------------------------------------------------------------------------------------------
// Quick fix
// ------------------------------------------------------------------------------------------------
// The only issues we can safely auto-remediate on a server we don't manage are: un-proxying the
// mail host in Cloudflare (fixes the mail-host DNS / FCrDNS / submission-port cascade in one shot)
// and flushing a backed-up Postfix queue over SSH. Everything else (port-25 provider blocks, IP
// blacklists, missing PTR) needs action outside our reach, so we surface guidance instead.

export type QuickFixOutcome = "fixed" | "noop" | "skipped" | "failed";
export interface QuickFixResult {
  id: string;
  label: string;
  status: QuickFixOutcome;
  detail: string;
}

// Indicator ids the Cloudflare un-proxy fix resolves.
const DNS_CASCADE_IDS = ["mailhost", "fcrdns", "submission"];

function cfHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

// Does this domain exist in the user's Cloudflare account? Checks the account-scoped endpoint first
// (needed for account-scoped tokens) and falls back to the global zones list — mirrors the proven
// resolveAndSaveCfZoneId lookup. Returns the zone, or null if the domain isn't in this account.
async function cfLookupZone(
  token: string,
  accountId: string | null,
  name: string,
): Promise<{ id: string; name: string } | null> {
  const urls = [
    accountId
      ? `https://api.cloudflare.com/client/v4/accounts/${accountId}/zones?name=${encodeURIComponent(name)}`
      : null,
    `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(name)}`,
  ].filter(Boolean) as string[];
  for (const url of urls) {
    const j: any = await fetch(url, { headers: cfHeaders(token) })
      .then((r) => r.json())
      .catch(() => null);
    if (j?.success && Array.isArray(j.result) && j.result.length > 0) {
      return { id: j.result[0].id, name: j.result[0].name };
    }
  }
  return null;
}

// Find the zone that owns a host by walking up its labels (mail.a.com → a.com → …), so a mail host
// on any subdomain still resolves to its registrable zone.
async function cfResolveZoneForHost(
  token: string,
  accountId: string | null,
  host: string,
): Promise<{ id: string; name: string } | null> {
  const labels = host.split(".").filter(Boolean);
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join(".");
    if (candidate.split(".").length < 2) break;
    const zone = await cfLookupZone(token, accountId, candidate);
    if (zone) return zone;
  }
  return null;
}

// Un-proxy ONLY the mail host's records in Cloudflare — never the whole zone, since an external
// domain's other records (website origin, etc.) are none of our business and un-proxying them would
// expose the user's real IPs. First confirms the domain actually exists in the user's Cloudflare
// account; if it doesn't, we can't fix it and say so plainly.
async function cloudflareUnproxyMailHost(
  token: string,
  accountId: string | null,
  mailHost: string,
  serverIp: string | null,
): Promise<{ status: QuickFixOutcome; detail: string }> {
  const zone = await cfResolveZoneForHost(token, accountId, mailHost).catch(() => null);
  if (!zone) {
    return {
      status: "skipped",
      detail: `${mailHost} isn't in the Cloudflare account for your saved token (the domain may use a different DNS provider or a different Cloudflare account). Un-proxy it manually there: set the mail host to DNS-only (grey cloud).`,
    };
  }

  const auth = cfHeaders(token);
  const base = `https://api.cloudflare.com/client/v4/zones/${zone.id}/dns_records`;
  const listJson: any = await fetch(`${base}?name=${encodeURIComponent(mailHost)}&per_page=100`, {
    headers: auth,
  })
    .then((r) => r.json())
    .catch(() => null);
  if (!listJson?.success) {
    return {
      status: "failed",
      detail: `Found ${zone.name} in Cloudflare but couldn't read its records.`,
    };
  }

  const recs = listJson.result as any[];
  let changed = 0;
  for (const rec of recs) {
    // A record → un-proxy and point at the server. CNAME → un-proxy (proxying is what masks the IP).
    if (rec.type === "A") {
      const needsUnproxy = rec.proxied === true;
      const needsIpFix = !!serverIp && rec.content !== serverIp;
      if (!needsUnproxy && !needsIpFix) continue;
      const body: any = { proxied: false };
      if (needsIpFix) body.content = serverIp;
      const ok = await fetch(`${base}/${rec.id}`, {
        method: "PATCH",
        headers: auth,
        body: JSON.stringify(body),
      })
        .then((r) => r.json())
        .then((j: any) => j?.success)
        .catch(() => false);
      if (ok) changed++;
    } else if (rec.type === "CNAME" && rec.proxied === true) {
      const ok = await fetch(`${base}/${rec.id}`, {
        method: "PATCH",
        headers: auth,
        body: JSON.stringify({ proxied: false }),
      })
        .then((r) => r.json())
        .then((j: any) => j?.success)
        .catch(() => false);
      if (ok) changed++;
    }
  }
  // No record at all for the mail host — create a DNS-only A record if we know the server IP.
  if (recs.length === 0 && serverIp) {
    const ok = await fetch(base, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        type: "A",
        name: mailHost,
        content: serverIp,
        ttl: 1,
        proxied: false,
      }),
    })
      .then((r) => r.json())
      .then((j: any) => j?.success)
      .catch(() => false);
    if (ok) changed++;
  }

  if (changed === 0) {
    return {
      status: "noop",
      detail: `${mailHost} is already DNS-only in Cloudflare (${zone.name}) — nothing to change.`,
    };
  }
  return {
    status: "fixed",
    detail: `Un-proxied ${mailHost} in Cloudflare (${zone.name}). DNS may take a minute to propagate; re-check after.`,
  };
}

// Queue flush, container restart and firewall fixes are shared with the system-created flow — see
// server-fixes.ts. Nothing SSH-remediation-related is duplicated here.

export const quickFixServer = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        ipAddress: z.string().trim().min(1),
        sshUser: z.string().trim().min(1).default("root"),
        sshPassword: z.string().min(1),
        mailcowHostname: z.string().trim().optional(),
        // Indicator ids currently failing/warning — the caller-targeted subset to attempt this
        // round (respects the per-row "fix just this" and the retry loop's narrowing).
        issues: z.array(z.string()).default([]),
        // The full health snapshot (id + status per indicator) driving the shared planner, so the
        // fix ordering and smart ipv6/queue gating match the system flow instead of being
        // hand-rolled here. Passed fresh each round so box-down → restart-then-rest converges.
        indicators: z
          .array(z.object({ id: z.string(), status: z.enum(["ok", "warn", "fail", "skip"]) }))
          .default([]),
        // Client-generated id for the live console stream (see console-bus.ts).
        runId: z.string().trim().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { db, userId } = context as any;
    const results: QuickFixResult[] = [];
    const log = new ConsoleLog(data.runId);
    log.info(`Quick fix starting for ${data.ipAddress} — ${data.issues.length} issue(s).`);

    const secrets = db
      ? await db.query.userSecrets.findFirst({ where: eq(userSecrets.userId, userId) })
      : null;

    // 1. Un-proxy the mail host in Cloudflare. This is the ONE fix that can't route through the
    // shared executeStep: that path (fixDns) un-proxies via a persisted domain row, and the
    // external flow has no such row — so keep the direct Cloudflare call, gated on the DNS cascade.
    if (DNS_CASCADE_IDS.some((id) => data.issues.includes(id))) {
      if (!data.mailcowHostname) {
        results.push({
          id: "mailhost",
          label: "Un-proxy mail host",
          status: "skipped",
          detail: "No mail host known — add it under Advanced, then re-run.",
        });
      } else if (!secrets?.cfApiToken) {
        results.push({
          id: "mailhost",
          label: "Un-proxy mail host",
          status: "skipped",
          detail: `No Cloudflare token in Settings, so I can't change DNS. Un-proxy ${data.mailcowHostname} manually (set it DNS-only / grey cloud).`,
        });
      } else {
        const r = await cloudflareUnproxyMailHost(
          secrets.cfApiToken,
          secrets.cfAccountId ?? null,
          data.mailcowHostname,
          data.ipAddress,
        ).catch((e) => ({
          status: "failed" as QuickFixOutcome,
          detail: e instanceof Error ? e.message : String(e),
        }));
        results.push({ id: "mailhost", label: "Un-proxy mail host", ...r });
      }
    }

    const target = {
      ipAddress: data.ipAddress,
      sshUser: data.sshUser,
      sshPassword: data.sshPassword,
    };

    // 2. Every server fix now flows through the shared remediation planner + executeStep, so the
    // ordering (restart → api key → firewall → force-IPv4 → flush LAST) and the smart gating
    // (IPv4 before flush; no flush when the queue is stuck on a port-25 block or reputation) are
    // the SAME logic the system-created flow uses — no longer hand-rolled here.
    //
    // Two adaptations bridge the external vocabulary to the planner's inputs:
    //   • a mail-log error is a queue problem to the planner (it only models "queue")
    //   • the "apikey" pseudo-issue (server has no usable key) is the planner's mailcow="warn"
    const indicators: Indicator[] = data.indicators.map((i) => ({
      id: i.id,
      status: i.status,
      label: "",
      detail: "",
    }));
    const elevate = (id: string, status: "warn" | "fail") => {
      const ind = indicators.find((x) => x.id === id);
      if (!ind) indicators.push({ id, status, label: "", detail: "" });
      else if (ind.status === "ok" || ind.status === "skip") ind.status = status;
    };
    if (data.issues.includes("maillog")) elevate("queue", "fail");
    if (data.issues.includes("apikey")) elevate("mailcow", "warn");

    const health: DomainHealth = { status: "unknown", score: 0, checkedAt: "", indicators };
    const plan = buildRemediationPlan(health, health, {
      hasCloudflareToken: !!secrets?.cfApiToken,
    });

    // Which caller-targeted issues each server step resolves — run a step only if the caller asked
    // for one of them, so the per-row "fix just this" and the retry loop's narrowing still hold.
    const STEP_ISSUES: Record<string, string[]> = {
      // "mailcow" maps to BOTH: a failed/unreachable stack restarts, a missing key creates one —
      // the planner picks which by status (fail → restart, warn → createApiKey), so listing it on
      // both is safe (only one step is ever emitted for a given mailcow status).
      restartMailcow: ["containers", "listeners", "mailcow"],
      createApiKey: ["mailcow", "apikey"],
      openFirewall: ["firewall"],
      forcePostfixIPv4: ["ipv6"],
      flushQueue: ["queue", "maillog"],
    };
    for (const step of plan.steps) {
      // Domain-target steps (fixDns/pushDns/syncDkim) need a persisted domain row — not available
      // for a server we don't manage. fixDns is handled above; the rest don't apply externally.
      if (step.target !== "server") continue;
      const sources = STEP_ISSUES[step.action] ?? [];
      if (!sources.some((id) => data.issues.includes(id))) continue;
      log.cmd(step.label);
      const r = await executeStep(step, { db, userId, domain: null, target }, log);
      results.push({ id: step.id, label: step.label, status: r.status, detail: r.detail });
    }

    log.info("Quick fix finished.");
    return { results, transcript: log.transcript() };
  });
