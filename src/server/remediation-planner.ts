// Deterministic remediation planner. Pure — no I/O, like health-checks.ts. Given a domain + server
// health snapshot, produce an ordered plan of fixes plus the items it deliberately won't auto-run.
// Canonical order (cause before symptom): restart → createApiKey → un-proxy → firewall →
// auth (pushDns/syncDkim) → forcePostfixIPv4 → flushQueue (last). If the box is down, the plan is
// ONLY restartMailcow and everything else waits for the post-restart re-check.

import type { DomainHealth, HealthAction, HealthStatus } from "./health-types";

export type RemediationTarget = "server" | "domain";

export interface RemediationStep {
  id: string;
  action: HealthAction;
  target: RemediationTarget;
  label: string;
  why: string;
  disruptive: boolean;
}
export interface ManualItem {
  id: string;
  label: string;
  why: string;
}
export interface RemediationPlan {
  steps: RemediationStep[];
  manual: ManualItem[];
  summary: string;
}
export interface PlannerContext {
  hasCloudflareToken?: boolean;
}

function statusOf(health: DomainHealth | null, id: string): HealthStatus | "absent" {
  const ind = health?.indicators.find((i) => i.id === id);
  return ind ? ind.status : "absent";
}
const bad = (s: HealthStatus | "absent") => s === "fail" || s === "warn";

// One-line summary of a plan ("2 fixes, 1 manual"). Exported so the UI can label a focused
// single-issue plan the same way the full plan is labelled, without duplicating the wording.
export function summarizePlan(steps: RemediationStep[], manual: ManualItem[]): string {
  return (
    `${steps.length} fix${steps.length === 1 ? "" : "es"}` +
    (manual.length ? `, ${manual.length} manual` : "")
  );
}

export function buildRemediationPlan(
  domainHealth: DomainHealth | null,
  serverHealth: DomainHealth | null,
  ctx: PlannerContext = {},
): RemediationPlan {
  const steps: RemediationStep[] = [];
  const manual: ManualItem[] = [];
  const sv = (id: string) => statusOf(serverHealth, id);
  const dm = (id: string) => statusOf(domainHealth, id);

  const boxDown = sv("containers") === "fail" || sv("listeners") === "fail";

  if (boxDown) {
    steps.push({
      id: "restartMailcow",
      action: "restartMailcow",
      target: "server",
      label: "Restart Mailcow",
      why: "Core mail containers are down or not listening — bring the stack up before anything else, then re-check.",
      disruptive: true,
    });
  } else {
    // Restart when containers are unhealthy, OR when the Mailcow API itself reports the stack as
    // failed / unreachable (mailcow="fail"). A missing/unusable API KEY is a different problem
    // (mailcow="warn" → create a key below), so only "fail" — not "warn" — restarts here.
    if (sv("containers") === "warn" || sv("mailcow") === "fail") {
      steps.push({
        id: "restartMailcow",
        action: "restartMailcow",
        target: "server",
        label: "Restart Mailcow",
        why: "One or more Mailcow containers are unhealthy or the API is unreachable; restart the stack.",
        disruptive: true,
      });
    }
    // Foundation
    if (sv("mailcow") === "warn") {
      steps.push({
        id: "createApiKey",
        action: "createApiKey",
        target: "server",
        label: "Create Mailcow API key",
        why: "The Mailcow API isn't usable; create a key scoped to this app so container and DKIM checks can run.",
        disruptive: true,
      });
    }
    // Reachability
    if (sv("mailhost") === "fail" || sv("fcrdns") === "warn") {
      if (ctx.hasCloudflareToken) {
        steps.push({
          id: "fixDns",
          action: "fixDns",
          target: "domain",
          label: "Un-proxy mail host",
          why: "Make the mail host resolve DNS-only to the server — fixes a Cloudflare-proxied, wrong, or missing A record.",
          disruptive: false,
        });
      } else {
        manual.push({
          id: "fixDns",
          label: "Un-proxy mail host",
          why: "The mail host is proxied, wrong, or missing and no Cloudflare token is configured. Point it DNS-only at the server manually.",
        });
      }
    }
    // Mail-port TLS: Dovecot/Postfix can still be serving Mailcow's self-signed cert after ACME
    // issued the real one, which breaks EVERY IMAP/SMTP client while port 443 looks healthy.
    // Reloading those services picks up the cert already on disk — cheap and non-destructive.
    if (sv("mailtls") === "fail") {
      steps.push({
        id: "reloadCerts",
        action: "reloadCerts",
        target: "server",
        label: "Reload mail certs",
        why: "IMAP/SMTP are serving an untrusted (self-signed) certificate, so mail clients can't connect. Restart Dovecot/Postfix to load the real certificate already on disk.",
        disruptive: true,
      });
    }
    if (sv("firewall") === "fail") {
      steps.push({
        id: "openFirewall",
        action: "openFirewall",
        target: "server",
        label: "Open mail ports",
        why: "The host firewall is blocking mail ports; allow 25/465/587/993/995/80/443.",
        disruptive: false,
      });
    }
    // Authentication (before any flush — retried mail must pass auth)
    if (bad(dm("mx")) || bad(dm("spf")) || bad(dm("dmarc"))) {
      steps.push({
        id: "pushDns",
        action: "pushDns",
        target: "domain",
        label: "Push DNS records",
        why: "MX / SPF / DMARC are missing or incomplete; publish them to Cloudflare.",
        disruptive: false,
      });
    }
    if (bad(dm("dkim"))) {
      steps.push({
        id: "syncDkim",
        action: "syncDkim",
        target: "domain",
        label: "Sync DKIM",
        why: "The DKIM key is missing or doesn't match Mailcow; publish the current key.",
        disruptive: false,
      });
    }
    // Delivery connectivity
    const ipv6Stall = sv("ipv6") === "fail";
    if (ipv6Stall) {
      steps.push({
        id: "forcePostfixIPv4",
        action: "forcePostfixIPv4",
        target: "server",
        label: "Force Postfix to IPv4",
        why: "Mail is stalling on broken IPv6 while IPv4 works; switch Postfix to IPv4 and retry the queue.",
        disruptive: true,
      });
    }
    // Queue (last) — smart branch. Identify an upstream blocker that makes a flush pointless, but
    // NEVER silently withhold the flush at fail-level: a fail-level queue is 24h+ old (mail is about
    // to bounce past Postfix's ~5-day limit), so a retry is worth attempting even if a blocker might
    // re-defer it — we just annotate the caveat. Only a warn-level queue defers to a manual note
    // when a blocker is present.
    if (bad(sv("queue"))) {
      const failing = sv("queue") === "fail";
      const blocker: "port25" | "reputation" | null =
        sv("port25") === "fail"
          ? "port25"
          : sv("blacklist") === "fail" || bad(dm("dkim")) || bad(dm("spf")) || bad(dm("dmarc"))
            ? "reputation"
            : null;
      const queuePort25 = {
        id: "queue-port25",
        label: "Mail queue (port 25 blocked)",
        why: "The queue is stuck on outbound-25 blocks. A flush won't clear it — unblock port 25 with the provider or set a relayhost.",
      };
      const queueReputation = {
        id: "queue-reputation",
        label: "Mail queue (rejections)",
        why: "The queue is stuck on remote rejections. A flush won't clear it — fix IP reputation and SPF/DKIM/DMARC first.",
      };

      if (ipv6Stall) {
        // forcePostfixIPv4 already retries the queue on its way out — no separate flush.
      } else if (!blocker || failing) {
        // No blocker, OR a fail-level queue we always try to flush. Warn when a blocker is present.
        const caveat =
          blocker === "port25"
            ? " Outbound port 25 looks blocked, so this may re-defer until you unblock it."
            : blocker === "reputation"
              ? " Reputation or SPF/DKIM/DMARC looks off, so some may re-defer until that's fixed."
              : "";
        steps.push({
          id: "flushQueue",
          action: "flushQueue",
          target: "server",
          label: "Flush mail queue",
          why: `Retry the deferred mail now.${caveat}`,
          disruptive: false,
        });
        // Still surface the root cause (so the user fixes it, not just the symptom) when we flushed
        // into a known blocker.
        if (blocker === "port25") manual.push(queuePort25);
        else if (blocker === "reputation") manual.push(queueReputation);
      } else if (blocker === "port25") {
        manual.push(queuePort25);
      } else {
        manual.push(queueReputation);
      }
    }
  }

  // Always-manual items (independent of box state), de-duped against the queue-reputation note.
  if (sv("blacklist") === "fail" && !manual.some((m) => m.id === "queue-reputation")) {
    manual.push({
      id: "blacklist",
      label: "IP blacklisted",
      why: "The IP is on a blacklist. Request delisting at the provider — this can't be auto-fixed.",
    });
  }
  if (sv("fcrdns") === "fail") {
    manual.push({
      id: "ptr",
      label: "Reverse DNS (PTR)",
      why: "PTR is missing or wrong. Set it in your VPS panel (deferred to the deliverability-foundation work).",
    });
  }

  return { steps, manual, summary: summarizePlan(steps, manual) };
}
