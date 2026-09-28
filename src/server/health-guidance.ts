// Remediation guidance for each deliverability check. Pure and dependency-free (no network / SSH /
// DB) so it's unit-testable; the server engine attaches the output to each indicator. The goal is
// that a user can resolve an issue from the panel alone, without hunting through external docs.

import type { FixSeverity, FixGuidance } from "./health-types";
import { EXPECTED_LISTEN_PORTS, FIREWALL_PORTS } from "./health-checks";

export interface GuidanceContext {
  ipAddress?: string | null;
  mailHost?: string | null;
  ptrHost?: string | null;
  forwardIps?: string[];
  blacklists?: string[];
  domain?: string | null; // the sending domain (e.g. example.com), for DNS-auth records
  dkimSelector?: string | null; // DKIM selector (Mailcow default: "dkim")
}

// The full set of mail ports a Mailcow host needs open (SMTP, submission, IMAP(S), POP3(S), HTTP(S)).
export const MAIL_PORTS = [25, 465, 587, 993, 995, 143, 110, 80, 443];

const IP = (ctx: GuidanceContext) => ctx.ipAddress || "<server-ip>";
const HOST = (ctx: GuidanceContext) => ctx.mailHost || "mail.example.com";
const SELECTOR = (ctx: GuidanceContext) => ctx.dkimSelector || "dkim";

// Best-effort registrable domain from a mail host, for DNS examples (mail.a.com -> a.com).
function registrable(host: string): string {
  const labels = host.split(".").filter(Boolean);
  return labels.length >= 2 ? labels.slice(-2).join(".") : host;
}

// The sending domain: explicit if given, else derived from the mail host (mail.a.com -> a.com).
const DOMAIN = (ctx: GuidanceContext) => ctx.domain || registrable(HOST(ctx));

// A correct, DNS-only mail zone example for the given host/IP.
function dnsExample(ctx: GuidanceContext): string[] {
  const host = HOST(ctx);
  const zone = registrable(host);
  const ip = IP(ctx);
  return [
    "; Mail records must be DNS Only (grey cloud) — never proxied",
    `${host}.        A      ${ip}      ; DNS Only`,
    `${zone}.        MX 10  ${host}.`,
    `; Reverse DNS (set in your VPS panel):`,
    `${ip}  ->  ${host}`,
  ];
}

// Commands to inspect what's listening / running on the box.
const INSPECT_LISTENERS = [
  "docker ps",
  "docker compose ps            # in /opt/mailcow-dockerized",
  "ss -tlnp                     # sockets that are listening",
  "netstat -tlnp                # (if ss is unavailable)",
];

const INSPECT_FIREWALL = ["ufw status verbose", "iptables -L -n -v"];

const RESTART_MAILCOW = [
  "cd /opt/mailcow-dockerized",
  "docker compose up -d         # bring any stopped containers up",
  "docker compose restart       # or restart everything",
];

const UFW_OPEN_MAIL_PORTS = MAIL_PORTS.map((p) => `ufw allow ${p}/tcp`);

// ------------------------------------------------------------------------------------------------
// Reverse DNS (FCrDNS)
// ------------------------------------------------------------------------------------------------
export function fcrdnsGuidance(
  verdict: "confirmed" | "proxied" | "mismatch" | "missing" | "skip",
  ctx: GuidanceContext,
): FixGuidance {
  const host = ctx.ptrHost || HOST(ctx);
  const ip = IP(ctx);
  if (verdict === "confirmed") {
    return {
      severity: "info",
      explanation:
        "Forward-Confirmed Reverse DNS passes: the IP's PTR resolves to your mail host, and that host resolves back to the IP. Receiving servers trust this. No action required.",
      verification: [`FCrDNS passes: ${ip} → ${host} → ${ip}.`],
    };
  }
  if (verdict === "proxied") {
    return {
      severity: "high",
      explanation:
        "The PTR (reverse DNS) is set correctly, but the mail host is behind Cloudflare's HTTP proxy, so it forward-resolves to Cloudflare IPs instead of your server. FCrDNS is therefore incomplete — the reverse and forward lookups don't agree on the IP, and strict receivers (Gmail, Outlook) may reject or spam-folder your mail.",
      causes: [
        `${host} has the orange cloud enabled in Cloudflare (proxied), so its A record resolves to Cloudflare's edge, not ${ip}.`,
        "Mail hosts must never be proxied — Cloudflare's proxy only forwards HTTP/S, not SMTP/IMAP.",
      ],
      steps: [
        `In Cloudflare, open the DNS tab for ${registrable(host)}.`,
        `Find the A record for ${host} and click the orange cloud to turn it grey (DNS Only).`,
        `Confirm the record points to your server IP ${ip}.`,
        "Leave reverse DNS as-is — the PTR is already correct; only the proxy needs disabling.",
      ],
      commands: [
        `dig +short ${host}          # must return ${ip}, not a 104.x / 172.6x Cloudflare IP`,
        `dig +short -x ${ip}         # PTR — should return ${host}`,
      ],
      dns: dnsExample(ctx),
      verification: [
        `dig ${host} returns ${ip} (not a Cloudflare IP).`,
        `FCrDNS passes: ${ip} → ${host} → ${ip}.`,
        "A test email to Gmail lands in the inbox with no rDNS warning in the headers.",
      ],
    };
  }
  if (verdict === "mismatch") {
    return {
      severity: "high",
      explanation:
        "The PTR record exists, but the host it names does not forward-resolve back to this IP. FCrDNS fails, which many mail servers treat as a strong spam signal — mail may be rejected or filtered.",
      causes: [
        `The mail host's A record points somewhere other than ${ip} (moved server, stale record, or a proxy/CDN in front).`,
        "The PTR names a hostname you don't control or that has no matching A record.",
      ],
      steps: [
        `Decide the canonical mail host (usually ${host}).`,
        `Set that host's A record to ${ip} (DNS Only if the DNS is on Cloudflare).`,
        `Set the PTR for ${ip} to that same host in your VPS provider's panel.`,
        "Both directions must name the same hostname and the same IP.",
      ],
      commands: [
        `dig +short ${host}          # should be ${ip}`,
        `dig +short -x ${ip}         # should be ${host}`,
      ],
      dns: dnsExample(ctx),
      verification: [`FCrDNS passes: ${ip} → ${host} → ${ip}.`],
    };
  }
  if (verdict === "missing") {
    return {
      severity: "high",
      explanation:
        "No PTR (reverse DNS) record exists for this IP. Reverse DNS is mandatory for reliable delivery — Gmail, Outlook and many others reject or heavily filter mail from IPs with no rDNS.",
      causes: [
        "Reverse DNS was never configured for this VPS.",
        "The PTR is managed by the VPS provider (not your DNS host) and hasn't been set.",
      ],
      steps: [
        `In your VPS provider's control panel, find the reverse DNS / PTR setting for ${ip}.`,
        `Set the PTR to your mail host, e.g. ${host}.`,
        `Ensure ${host} also has a forward A record → ${ip} (DNS Only).`,
        "PTR changes can take up to a few hours to propagate.",
      ],
      commands: [`dig +short -x ${ip}         # currently empty; should return ${host}`],
      dns: dnsExample(ctx),
      verification: [`dig -x ${ip} returns ${host}, and FCrDNS passes.`],
    };
  }
  return {
    severity: "warning",
    explanation:
      "Reverse DNS couldn't be queried, so FCrDNS status is unknown. This is usually a transient resolver hiccup.",
    nextStep: `Re-run the check, or query manually: dig +short -x ${ip}`,
  };
}

// ------------------------------------------------------------------------------------------------
// Mail host DNS
// ------------------------------------------------------------------------------------------------
export function mailhostGuidance(
  verdict: "ok" | "proxied" | "wrongip" | "missing",
  ctx: GuidanceContext,
): FixGuidance {
  const host = HOST(ctx);
  const ip = IP(ctx);
  if (verdict === "ok") {
    return {
      severity: "info",
      explanation: `${host} resolves directly to the server. SMTP, IMAP, POP3 and the Mailcow API can be reached. No action required.`,
      verification: [`dig ${host} → ${ip}.`],
    };
  }
  if (verdict === "proxied") {
    return {
      severity: "critical",
      explanation: `${host} resolves to Cloudflare instead of the SMTP server. SMTP, IMAP, POP3 and the Mailcow API need direct TCP access to the server — Cloudflare's standard proxy only forwards HTTP/S, so mail delivery, mail clients and the Mailcow API are all broken while the proxy is on.`,
      causes: [
        `The A record for ${host} has the Cloudflare proxy (orange cloud) enabled.`,
        "A CNAME for the mail host points at a proxied record.",
      ],
      steps: [
        `In Cloudflare → DNS for ${registrable(host)}, set the ${host} A record to DNS Only (grey cloud).`,
        `Verify the A record's value is the server IP ${ip}.`,
        `Verify the MX record for ${registrable(host)} points to ${host}.`,
        "Never proxy a mail hostname — keep it grey-clouded permanently.",
      ],
      commands: [`dig ${host}`, `nslookup ${host}`],
      dns: dnsExample(ctx),
      verification: [
        `dig ${host} returns ${ip} (not 104.x / 172.6x).`,
        "The Mailcow UI/API responds again.",
        "Ports 25/465/587 are reachable on the host.",
      ],
    };
  }
  if (verdict === "wrongip") {
    return {
      severity: "high",
      explanation: `${host} resolves, but not to this server. Mail addressed to the domain (and the Mailcow API) will hit the wrong machine.`,
      causes: [
        "The A record still points at an old server after a migration.",
        "A typo in the A record value.",
      ],
      steps: [
        `Update the A record for ${host} to ${ip} (DNS Only).`,
        `Confirm the MX for ${registrable(host)} points to ${host}.`,
      ],
      commands: [`dig +short ${host}          # should be ${ip}`, `nslookup ${host}`],
      dns: dnsExample(ctx),
      verification: [`dig ${host} → ${ip}.`],
    };
  }
  return {
    severity: "high",
    explanation: `${host} does not resolve at all, so no mail can be delivered to it and the Mailcow API is unreachable.`,
    causes: ["The A record was never created.", "The record exists in the wrong zone."],
    steps: [
      `Create an A record: ${host} → ${ip} (DNS Only).`,
      `Ensure an MX record for ${registrable(host)} points to ${host}.`,
    ],
    commands: [`dig ${host}`, `nslookup ${host}`],
    dns: dnsExample(ctx),
    verification: [`dig ${host} → ${ip}, and the MX resolves.`],
  };
}

// ------------------------------------------------------------------------------------------------
// Submission ports (465 / 587)
// ------------------------------------------------------------------------------------------------
export function submissionGuidance(
  state: "ok" | "partial" | "down",
  ctx: GuidanceContext,
): FixGuidance {
  if (state === "ok") {
    return {
      severity: "info",
      explanation:
        "Submission ports 465 (implicit TLS) and 587 (STARTTLS) are reachable, so mail clients can authenticate and send. No action required.",
      verification: ["Ports 465 and 587 accept TLS from an external client."],
    };
  }
  const severity: FixSeverity = state === "down" ? "high" : "warning";
  return {
    severity,
    explanation:
      "One or both submission ports (465/587) are timing out. Mail clients (and any app relaying through this server) can't submit mail for sending until these respond.",
    causes: [
      "The Postfix container isn't running (Mailcow down or crashed).",
      "The host or VPS-provider firewall is blocking 465/587.",
      "A cloud security group / network ACL hasn't allowed the ports.",
      "The mail host is Cloudflare-proxied, so the ports hit Cloudflare (which doesn't forward them) — fix the Mail host DNS first.",
      "Port-forwarding/NAT in front of the server isn't mapping the ports.",
      "The ISP/provider restricts these ports inbound.",
    ],
    steps: [
      "Confirm the mail host is DNS Only (not Cloudflare-proxied) — proxying alone causes 465/587 to time out.",
      "Check the Postfix container and host listeners (commands below).",
      "Open the ports on the host firewall, then the VPS-provider firewall / cloud security group.",
      "If Postfix is down, restart Mailcow.",
    ],
    commands: [
      ...INSPECT_LISTENERS,
      "# expect postfix-mailcow listening on 25, 465, 587:",
      "ss -tlnp | grep -E ':(25|465|587)\\b'",
      ...INSPECT_FIREWALL,
      "# open every mail port a Mailcow host needs (SMTP, submission, IMAP(S), POP3(S), HTTP(S)):",
      ...UFW_OPEN_MAIL_PORTS,
      "# remember to also allow these in the VPS-provider firewall / cloud security group.",
      ...RESTART_MAILCOW,
    ],
    verification: [
      "ss -tlnp shows postfix listening on 465 and 587.",
      "From another host: nc -zv <host> 587 and nc -zv <host> 465 both connect.",
      "A mail client can send through the server.",
    ],
    nextStep: `From your machine: nc -zv ${HOST(ctx)} 587  (and 465). A timeout points to a firewall/proxy; "open" points to Postfix.`,
  };
}

// ------------------------------------------------------------------------------------------------
// Outbound SMTP port 25
// ------------------------------------------------------------------------------------------------
export function port25Guidance(
  verdict: "open" | "partial" | "blocked",
  ctx: GuidanceContext,
): FixGuidance {
  if (verdict === "open") {
    return {
      severity: "info",
      explanation:
        "Outbound port 25 is open — the server can reach recipient mail servers directly to deliver mail. No action required.",
      verification: ["nc -zv gmail-smtp-in.l.google.com 25 connects from the server."],
    };
  }
  const severity: FixSeverity = verdict === "blocked" ? "critical" : "high";
  return {
    severity,
    explanation:
      "Outbound port 25 is blocked, so this server cannot open SMTP connections to recipient mail servers — mail piles up in the queue and never leaves. (Port 25 is outbound-to-recipients; submission from clients uses 465/587.) Most commonly the VPS provider blocks 25 by default.",
    causes: [
      "The VPS/cloud provider blocks outbound port 25 by default (very common — AWS, GCP, Azure, Contabo, etc.).",
      "The host firewall (ufw/iptables) blocks outbound 25.",
      "Upstream routing / network ACLs drop the traffic.",
    ],
    steps: [
      "Test connectivity to a public MX from the server (commands below).",
      "If blocked, open a support ticket with the VPS provider to unblock outbound port 25 (state you run a legitimate mail server).",
      "If the provider won't unblock it, configure a smarthost/relayhost in Mailcow → Configuration → Routing → Sender-dependent transports.",
      "Also confirm the host firewall isn't blocking outbound 25.",
    ],
    commands: [
      "telnet gmail-smtp-in.l.google.com 25",
      "nc -zv gmail-smtp-in.l.google.com 25",
      "nc -zv aspmx.l.google.com 25",
      ...INSPECT_FIREWALL,
    ],
    verification: [
      "nc -zv gmail-smtp-in.l.google.com 25 connects (not 'timed out').",
      "The mail queue drains (postqueue -p shrinks).",
      "A test message to Gmail is delivered.",
    ],
    nextStep: `On the server: nc -zv gmail-smtp-in.l.google.com 25. "open" = fixed; "timed out" = still blocked upstream (provider ticket or relayhost).`,
  };
}

// ------------------------------------------------------------------------------------------------
// Mail queue
// ------------------------------------------------------------------------------------------------
export function queueGuidance(
  verdict: "ok" | "warn" | "fail",
  ctx: GuidanceContext,
  reason?: "timeout" | "rejected" | "other" | null,
): FixGuidance {
  if (verdict === "ok") {
    return {
      severity: "info",
      explanation: "The Postfix queue is empty or small — mail is flowing. No action required.",
      verification: ["postqueue -p reports the queue is empty."],
    };
  }
  const severity: FixSeverity = verdict === "fail" ? "high" : "warning";
  const reasonLine =
    reason === "timeout"
      ? "Most deferrals are connection timeouts — the server can't reach recipient MXes. Check outbound port 25 and DNS first."
      : reason === "rejected"
        ? "Most deferrals are remote rejections — recipients are refusing the mail (reputation, blacklisting, or SPF/DKIM/DMARC failures)."
        : "Inspect the deferral reasons in the queue and logs to classify them.";
  return {
    severity,
    explanation: `Messages are stuck (deferred) in the Postfix queue. Deferred mail is retried on a schedule, but a growing queue means delivery is failing repeatedly and mail is delayed or will eventually bounce. ${reasonLine}`,
    causes: [
      "Outbound port 25 blocked or DNS failures (connection timeouts).",
      "Recipient rejections: poor IP/domain reputation or blacklisting.",
      "SPF/DKIM/DMARC authentication failures.",
      "Greylisting (temporary 4xx — usually clears on retry).",
      "Invalid or unreachable recipient MX.",
      "General network issues.",
    ],
    steps: [
      "List the queue and read the deferral reasons (commands below).",
      "If reasons are timeouts → fix outbound port 25 / DNS.",
      "If reasons are 5xx rejections → check IP reputation and SPF/DKIM/DMARC.",
      "Tail the Postfix logs to see live delivery attempts.",
      "Once the root cause is fixed, flush the queue to retry immediately: postqueue -f.",
    ],
    commands: [
      "mailq",
      "postqueue -p",
      "# inside Mailcow, target the postfix container:",
      "docker compose logs --tail=200 postfix-mailcow",
      "tail -f /var/log/mail.log",
      "postqueue -f                 # retry all deferred mail now",
    ],
    verification: [
      "postqueue -p shows the queue empty (or steadily shrinking).",
      "No repeating deferral reason in the logs.",
      "A fresh test message is delivered promptly.",
    ],
    nextStep:
      "Run postqueue -p and read the parenthesised reason on each entry — 'Connection timed out' = port 25/DNS; 'said: 550 …' = recipient rejection.",
  };
}

// ------------------------------------------------------------------------------------------------
// Mailcow services (containers)
// ------------------------------------------------------------------------------------------------
export function mailcowGuidance(
  state: "ok" | "down" | "notprovisioned" | "apiRejected",
  ctx: GuidanceContext & { apiError?: string },
): FixGuidance {
  if (state === "apiRejected") {
    return {
      severity: "warning",
      explanation: `The Mailcow API refused our request${ctx.apiError ? ` ("${ctx.apiError}")` : ""}. This only means we can't use the API — it does NOT mean your containers are down. The "Mailcow containers" check reads them directly over SSH and is authoritative for that. The API is only needed for DKIM key-match and UI/API reachability.`,
      causes: [
        "API_ALLOW_FROM (or the key's allow_from) doesn't include this app's IP, so Mailcow rejects us no matter how valid the key is.",
        "The API key is wrong or has been rotated.",
        "The API is disabled in Mailcow → Configuration → API.",
        "The mail host is proxied, so the request never reaches Mailcow.",
      ],
      steps: [
        "Check the allow-list: grep '^API_ALLOW_FROM=' /opt/mailcow-dockerized/mailcow.conf — it must include this app's public IP.",
        "Add this app's IP to API_ALLOW_FROM, then apply with: docker compose up -d",
        "Or paste a known-good key under Advanced.",
      ],
      commands: [
        "grep -E '^(API_KEY|API_ALLOW_FROM)=' /opt/mailcow-dockerized/mailcow.conf",
        "# after editing mailcow.conf, apply it:",
        "cd /opt/mailcow-dockerized && docker compose up -d",
      ],
      verification: [
        "The Mailcow services row shows a real container count.",
        "DKIM key-match runs instead of being skipped.",
      ],
      nextStep:
        "This is usually API_ALLOW_FROM not listing this app's IP — check that before regenerating any keys.",
    };
  }
  if (state === "ok") {
    return {
      severity: "info",
      explanation: "All Mailcow containers are running. No action required.",
      verification: ["docker compose ps shows every container 'Up' / healthy."],
    };
  }
  if (state === "notprovisioned") {
    return {
      severity: "info",
      explanation:
        "No Mailcow API key was available, so the API-only checks (API/UI reachability and DKIM key-match) were skipped. This doesn't mean anything is wrong — container health is still checked directly over SSH.",
      steps: [
        "Quick fix can create an API key on the server for you (it writes API_KEY to mailcow.conf and scopes API_ALLOW_FROM to this app's IP).",
        "Or create one yourself in Mailcow → Configuration → API and paste it under Advanced.",
      ],
      commands: [
        "grep '^API_KEY=' /opt/mailcow-dockerized/mailcow.conf",
        "cd /opt/mailcow-dockerized && docker compose ps",
      ],
      nextStep:
        "Use Quick fix to create an API key, or paste an existing one under Advanced, to enable the API checks.",
    };
  }
  return {
    severity: "critical",
    explanation:
      "Mailcow is unreachable or some containers are down. Postfix (SMTP), Dovecot (IMAP/POP3), Nginx (UI/API), Rspamd (filtering), MySQL and Redis must all be running — if any are down, mail delivery and/or the admin UI break.",
    causes: [
      "The Docker daemon isn't running.",
      "One or more containers crashed or are restarting.",
      "The mail host is Cloudflare-proxied, so the API is unreachable (fix Mail host DNS first).",
      "A reverse proxy in front of Mailcow is misconfigured.",
      "The Mailcow API is disabled or the key/allow-list is wrong.",
    ],
    steps: [
      "SSH into the server and check Docker + the containers (commands below).",
      "Confirm these are Up: postfix, dovecot, nginx, rspamd, mysql (mariadb), redis.",
      "Bring any stopped containers up, or restart the stack.",
      "If the API specifically is unreachable, verify the mail host is DNS Only and the API is enabled in Mailcow → Configuration → API.",
    ],
    commands: [
      "systemctl status docker      # is the daemon up?",
      "docker ps",
      "cd /opt/mailcow-dockerized && docker compose ps",
      "# inspect a crashed container, e.g. postfix:",
      "docker compose logs --tail=200 postfix-mailcow",
      ...RESTART_MAILCOW,
    ],
    verification: [
      "docker compose ps shows all containers Up/healthy.",
      "The Mailcow UI loads and the API responds.",
      "Ports 25/465/587/993 are listening again.",
    ],
  };
}

// ------------------------------------------------------------------------------------------------
// TLS certificate
// ------------------------------------------------------------------------------------------------
export function tlsGuidance(
  state: "ok" | "selfsigned" | "expired" | "unreachable",
  ctx: GuidanceContext,
): FixGuidance {
  const host = HOST(ctx);
  if (state === "ok") {
    return {
      severity: "info",
      explanation:
        "A valid TLS certificate is in use, so STARTTLS/implicit-TLS connections are trusted. No action required.",
      verification: [`openssl s_client -connect ${host}:443 shows a valid, unexpired cert.`],
    };
  }
  if (state === "selfsigned") {
    return {
      severity: "warning",
      explanation:
        "A self-signed certificate is in use — Let's Encrypt hasn't issued yet. Mail still flows (opportunistic TLS), but some clients warn and strict TLS policies (MTA-STS) may fail.",
      causes: [
        "ACME can't validate because the mail host doesn't resolve to the server (or is Cloudflare-proxied).",
        "Port 80 is closed, so the HTTP-01 challenge fails.",
        "The certificate was just requested and hasn't completed yet.",
      ],
      steps: [
        `Ensure ${host} resolves directly to the server (DNS Only).`,
        "Open ports 80 and 443.",
        "Mailcow's ACME container retries roughly every 30 minutes; wait or restart it.",
      ],
      commands: [
        "docker compose logs --tail=100 acme-mailcow",
        "ss -tlnp | grep -E ':(80|443)\\b'",
        "ufw allow 80/tcp",
        "ufw allow 443/tcp",
      ],
      verification: [`The cert issuer is Let's Encrypt (not self-signed) and ${host} is trusted.`],
    };
  }
  const severity: FixSeverity = "high";
  return {
    severity,
    explanation:
      state === "expired"
        ? "The TLS certificate has expired. Clients that enforce TLS will refuse to connect, and mail using strict TLS policies will fail."
        : `The TLS endpoint on ${host}:443 couldn't be reached, so the certificate can't be validated. Renewal likely can't run either.`,
    causes: [
      "ACME renewal has been failing (DNS moved, port 80 closed, or the host is proxied).",
      "Nginx/acme container is down.",
      "The mail host doesn't resolve to the server.",
    ],
    steps: [
      `Verify ${host} resolves to the server (DNS Only) and ports 80 + 443 are open.`,
      "Renew the Let's Encrypt certificate (restart Mailcow's acme container).",
      "Restart nginx so it picks up the new cert.",
    ],
    commands: [
      "cd /opt/mailcow-dockerized",
      "docker compose logs --tail=100 acme-mailcow",
      "docker compose restart acme-mailcow nginx-mailcow",
      "ss -tlnp | grep -E ':(80|443)\\b'",
    ],
    verification: [
      `openssl s_client -connect ${host}:443 shows a fresh, unexpired Let's Encrypt cert.`,
      "Ports 80 and 443 are reachable.",
    ],
  };
}

// ------------------------------------------------------------------------------------------------
// IP reputation / blacklist
// ------------------------------------------------------------------------------------------------
export function blacklistGuidance(listed: boolean, ctx: GuidanceContext): FixGuidance {
  const ip = IP(ctx);
  if (!listed) {
    return {
      severity: "info",
      explanation:
        "The server IP is not on the major DNS blacklists (Spamhaus, Barracuda, SpamCop). No action required.",
      verification: [`${ip} stays off the blacklists on the next check.`],
    };
  }
  return {
    severity: "critical",
    explanation: `${ip} is listed on one or more DNS blacklists${
      ctx.blacklists?.length ? ` (${ctx.blacklists.join(", ")})` : ""
    }. Listed IPs get mail rejected or spam-foldered by most providers — deliverability is severely degraded until you're delisted.`,
    causes: [
      "Spam or a burst of mail was sent from the IP (compromised account, misconfigured app, or a forwarded spam load).",
      "The IP has poor history from a previous owner.",
      "SPF/DKIM/DMARC misconfiguration let spoofed mail out.",
      "An open relay or compromised mailbox.",
    ],
    steps: [
      "Stop sending immediately — continuing to send while listed deepens the damage.",
      "Find the source: investigate spam complaints and check for a compromised mailbox or app.",
      "Clean the mail queue of any spam backlog: postqueue -p, then delete offending mail (postsuper -d).",
      "Verify authentication is correct: SPF, DKIM and DMARC all pass.",
      "Once the source is fixed, request delisting at each blacklist's website.",
      "Warm the IP back up: resume sending gently and monitor reputation.",
    ],
    commands: [
      `dig +short ${ip.split(".").reverse().join(".")}.zen.spamhaus.org   # 127.0.0.x = listed`,
      "postqueue -p                 # inspect the queue for a spam backlog",
      "postsuper -d ALL             # (only if the queue is confirmed spam) purge it",
    ],
    verification: [
      "Re-check shows the IP removed from the blacklist(s).",
      "SPF, DKIM and DMARC all pass on a test message.",
      "Delivery to Gmail/Outlook recovers.",
    ],
    nextStep: ctx.blacklists?.length
      ? `Visit the delisting page for: ${ctx.blacklists.join(", ")}, after fixing the root cause.`
      : "Identify which list flagged the IP, then visit that provider's delisting page.",
  };
}

// ------------------------------------------------------------------------------------------------
// Mailcow containers (via SSH `docker ps`)
// ------------------------------------------------------------------------------------------------
export function containersGuidance(
  state: "ok" | "unhealthy" | "down",
  ctx: GuidanceContext & { missing?: string[]; stopped?: string[]; unhealthy?: string[] },
): FixGuidance {
  if (state === "ok") {
    return {
      severity: "info",
      explanation:
        "All core Mailcow containers (postfix, dovecot, nginx, rspamd, mysql, redis) are running. No action required.",
      verification: ["docker ps lists every core container as Up."],
    };
  }
  const affected = [...(ctx.missing ?? []), ...(ctx.stopped ?? []), ...(ctx.unhealthy ?? [])];
  const isUnhealthy = state === "unhealthy";
  return {
    severity: isUnhealthy ? "warning" : "critical",
    explanation: isUnhealthy
      ? `Some Mailcow containers are running but report unhealthy (${affected.join(", ")}). They may be failing health checks and dropping mail intermittently.`
      : `Core Mailcow containers are missing or stopped (${affected.join(", ")}). Mail delivery, mailbox access and/or the admin UI are down until they're running. Postfix = SMTP, dovecot = IMAP/POP3, nginx = UI/API, rspamd = filtering, mysql/redis = data.`,
    causes: [
      "The Docker daemon isn't running.",
      "Containers crashed or exited (out of memory, disk full, bad config).",
      "The stack was never brought up after a reboot.",
      "A failed update left containers stopped.",
    ],
    steps: [
      "SSH into the server and change to the Mailcow directory: cd /opt/mailcow-dockerized",
      "Run docker ps and confirm which of the six core containers are missing/stopped/unhealthy.",
      isUnhealthy
        ? "They're present but unhealthy — restart the stack: docker compose restart"
        : "Bring the stopped containers up: docker compose up -d",
      "If a container keeps dying, read its logs to find the cause (see below).",
      "Check disk space — a full disk stops containers: df -h",
    ],
    commands: [
      "cd /opt/mailcow-dockerized",
      "docker ps",
      "docker compose ps",
      isUnhealthy ? "docker compose restart" : "docker compose up -d",
      "docker compose logs --tail=200 postfix-mailcow",
      "systemctl status docker",
      "df -h                        # a full disk stops containers",
    ],
    verification: [
      "docker ps shows postfix, dovecot, nginx, rspamd, mysql and redis all Up.",
      "Ports 25, 465 and 587 are listening again (ss -tlnp).",
      "The Mailcow UI loads.",
    ],
    nextStep: `Run "docker compose logs --tail=200 <container>-mailcow" on the affected container to see why it stopped.`,
  };
}

// ------------------------------------------------------------------------------------------------
// Local SMTP listeners (via SSH `ss -tlnp`)
// ------------------------------------------------------------------------------------------------
export function listenersGuidance(
  state: "ok" | "missing",
  ctx: GuidanceContext & { missing?: number[] },
): FixGuidance {
  if (state === "ok") {
    return {
      severity: "info",
      explanation:
        "Postfix is listening locally on 25, 465 and 587, so the mail server itself is accepting connections. No action required.",
      verification: ["ss -tlnp shows LISTEN on *:25, *:465 and *:587."],
    };
  }
  const missing = ctx.missing ?? [];
  return {
    severity: "critical",
    explanation: `Postfix is not listening on ${missing.join(", ")} on the server itself. This is upstream of any firewall — the service isn't accepting connections at all, so mail clients can't submit and/or inbound SMTP fails. (If the port IS listening but unreachable from outside, the problem is a firewall instead.)`,
    causes: [
      "The postfix-mailcow container is stopped or crashed.",
      "Mailcow was never fully started after a reboot.",
      "A port conflict — another process already holds the port.",
      "Postfix master.cf has the submission service disabled.",
    ],
    steps: [
      "Confirm what's listening: ss -tlnp (expect LISTEN on *:25, *:465, *:587).",
      "If 465/587 are missing, restart Postfix: docker compose restart postfix-mailcow",
      "If that doesn't help, restart the whole stack: docker compose restart",
      "Check for a port conflict if it still won't bind (see command below).",
      "Read the Postfix logs for bind errors.",
    ],
    commands: [
      "ss -tlnp",
      "netstat -tlnp                # if ss is unavailable",
      "cd /opt/mailcow-dockerized",
      "docker compose restart postfix-mailcow",
      "docker compose restart       # if the above doesn't help",
      `ss -tlnp | grep -E ':(${EXPECTED_LISTEN_PORTS.join("|")})\\b'`,
      "docker compose logs --tail=100 postfix-mailcow",
    ],
    verification: [
      "ss -tlnp shows LISTEN on *:25, *:465 and *:587.",
      "From another machine: nc -zv <mail-host> 587 and 465 both connect.",
    ],
    nextStep:
      "If the port listens locally but times out externally, the problem is the host or VPS-provider firewall, not Postfix.",
  };
}

// ------------------------------------------------------------------------------------------------
// Host firewall (via SSH `ufw status`)
// ------------------------------------------------------------------------------------------------
export function firewallGuidance(
  state: "ok" | "blocked",
  ctx: GuidanceContext & { blocked?: number[] },
): FixGuidance {
  if (state === "ok") {
    return {
      severity: "info",
      explanation:
        "The host firewall allows every mail port (or is inactive, so it isn't blocking anything). No action required — remember the VPS-provider firewall is separate.",
      verification: ["ufw status shows ALLOW for 25, 465, 587, 80, 443, 993 and 995."],
    };
  }
  const blocked = ctx.blocked ?? [];
  return {
    severity: "high",
    explanation: `The host firewall (ufw) is active but doesn't allow ${blocked.join(", ")}. Traffic to those ports is dropped before it reaches Postfix/Dovecot, so mail and/or mail clients can't connect even though the services are running.`,
    causes: [
      "ufw was enabled without allowing the mail ports.",
      "A hardening script reset the rules.",
      "Only web ports (80/443) were opened.",
    ],
    steps: [
      "Check the current rules: sudo ufw status",
      "Allow every mail port (commands below), then reload.",
      "Remember the VPS-provider firewall is separate — allow the same ports in your provider's panel (Hetzner, Contabo, OVH, Vultr, AWS security groups, etc.).",
      "Re-test the ports from another machine.",
    ],
    commands: [
      "sudo ufw status",
      ...FIREWALL_PORTS.map((p) => `sudo ufw allow ${p}/tcp`),
      "sudo ufw reload",
      "sudo ufw status              # confirm ALLOW on each port",
    ],
    verification: [
      "ufw status shows ALLOW for 25, 465, 587, 80, 443, 993, 995.",
      "From another machine: nc -zv <mail-host> 465 and 587 report succeeded.",
    ],
    nextStep:
      "If ports are ALLOWed here but still time out externally, the VPS provider's firewall is blocking them — open them in the provider's control panel.",
  };
}

// ------------------------------------------------------------------------------------------------
// Broken IPv6 delivery
// ------------------------------------------------------------------------------------------------
export function ipv6Guidance(
  ctx: GuidanceContext & { ipv6Timeouts?: number; ipv4Timeouts?: number },
): FixGuidance {
  const v6 = ctx.ipv6Timeouts ?? 0;
  return {
    severity: "critical",
    explanation: `Mail is timing out over IPv6 (${v6} connection${v6 === 1 ? "" : "s"}), while IPv4 to the same MXes works fine. Postfix prefers a recipient's IPv6 (AAAA) address, so it dials IPv6 first, hangs until the connection times out, and defers the message — even though the server could deliver instantly over IPv4. This is why the queue backs up with "Connection timed out" while the outbound port 25 test passes: the test uses IPv4, Postfix uses IPv6. Result: mail is delayed for hours and eventually bounces.`,
    causes: [
      "The VPS has an IPv6 address configured but no working IPv6 route (very common — the provider assigns IPv6 but it isn't actually routed).",
      "The provider blocks outbound port 25 on IPv6 only, while allowing it on IPv4.",
      "A firewall rule drops outbound IPv6.",
    ],
    steps: [
      "Confirm IPv6 is genuinely broken from the server (commands below) — if it can't reach an IPv6 host at all, that's your answer.",
      "Tell Postfix to use IPv4 only. In Mailcow, add it to the override file so it survives updates: data/conf/postfix/extra.cf",
      "Add the line: inet_protocols = ipv4",
      "Restart Postfix so the change takes effect (inet_protocols needs a restart, not a reload).",
      "Flush the queue — the deferred mail should now deliver over IPv4.",
      "Alternatively, fix IPv6 routing with your provider if you'd rather keep IPv6 delivery.",
    ],
    commands: [
      "# Is IPv6 actually usable from this server?",
      "curl -6 -s --max-time 5 https://ifconfig.co || echo 'no IPv6 egress'",
      "ping6 -c1 -W2 2001:4860:4860::8888 || echo 'no IPv6 route'",
      "",
      "# Make Postfix use IPv4 only (Mailcow-safe override):",
      "cd /opt/mailcow-dockerized",
      "echo 'inet_protocols = ipv4' >> data/conf/postfix/extra.cf",
      "docker compose restart postfix-mailcow",
      "",
      "# Retry the stuck mail:",
      "docker exec $(docker ps -qf name=postfix-mailcow) postqueue -f",
      "docker compose logs -f postfix-mailcow      # watch for status=sent",
    ],
    verification: [
      "postqueue -p drains and stays empty.",
      "The log shows status=sent instead of 'Connection timed out'.",
      "A test message to Gmail arrives.",
    ],
    nextStep:
      "Run: curl -6 -s --max-time 5 https://ifconfig.co — if it hangs or fails, IPv6 is broken on this box and Postfix should be set to inet_protocols = ipv4.",
  };
}

// ------------------------------------------------------------------------------------------------
// Postfix mail log
// ------------------------------------------------------------------------------------------------
export function mailLogGuidance(
  state: "ok" | "errors",
  ctx: GuidanceContext & { dominant?: "timeout" | "hostNotFound" | "blocked" | "bounced" | null },
): FixGuidance {
  if (state === "ok") {
    return {
      severity: "info",
      explanation:
        "No delivery errors in the recent Postfix logs — messages are being accepted and sent. No action required.",
      verification: ["docker compose logs -f postfix-mailcow shows status=sent for new mail."],
    };
  }
  const d = ctx.dominant;
  const reading =
    d === "timeout"
      ? "'Connection timed out' dominates → a firewall or routing problem reaching recipient servers (check outbound port 25)."
      : d === "hostNotFound"
        ? "'Host not found' dominates → a DNS problem resolving recipient MX records."
        : d === "blocked"
          ? "'550 5.7.x' rejections dominate → recipients are refusing your mail (reputation, blacklisting, or SPF/DKIM/DMARC failures)."
          : d === "bounced"
            ? "Messages are bouncing → read the bounce reason in the log lines below."
            : "Mixed errors — read the sample lines below to classify.";
  return {
    severity: "warning",
    explanation: `Recent Postfix logs contain delivery errors. ${reading} These log lines are the fastest way to see exactly why mail isn't leaving.`,
    causes: [
      "DNS failures resolving recipient MX (Host not found).",
      "Outbound port 25 blocked or routing issues (Connection timed out).",
      "Recipient rejection on reputation/auth (550 5.7.x).",
      "Greylisting — temporary 4xx that clears on retry.",
      "Authentication failures (SPF/DKIM/DMARC).",
    ],
    steps: [
      "Read the recent logs and identify the repeated error (commands below).",
      "Connection timed out → fix outbound port 25 / firewall.",
      "Host not found → fix DNS resolution on the server.",
      "550 5.7.x → fix IP reputation and SPF/DKIM/DMARC.",
      "After fixing, send a test mail to Gmail and watch for status=sent.",
    ],
    commands: [
      "cd /opt/mailcow-dockerized",
      "docker compose logs --tail=200 postfix-mailcow",
      "docker compose logs -f postfix-mailcow      # follow live while sending a test",
      "tail -f /var/log/mail.log                   # if postfix runs on the host",
      "postqueue -p",
    ],
    verification: [
      "A test message to Gmail logs status=sent (not deferred/bounced).",
      "The queue drains and stays empty.",
    ],
    nextStep:
      "Send a test email to a Gmail address while running: docker compose logs -f postfix-mailcow — then look for status=sent.",
  };
}

// ------------------------------------------------------------------------------------------------
// Sending DNS: MX / SPF / DKIM / DMARC
// ------------------------------------------------------------------------------------------------
// These are the DNS records a domain needs to SEND (and receive) mail that receivers will accept.
// The examples are correct, ready-to-paste records for the specific domain + mail host.

export function mxGuidance(verdict: "ok" | "wrong" | "missing", ctx: GuidanceContext): FixGuidance {
  const domain = DOMAIN(ctx);
  const host = HOST(ctx);
  if (verdict === "ok") {
    return {
      severity: "info",
      explanation: `${domain}'s MX record points to ${host}. Mail for the domain is routed to your server, and bounces/replies flow correctly. No action required.`,
      verification: [`dig MX ${domain} lists ${host}.`],
    };
  }
  const severity: FixSeverity = "high";
  return {
    severity,
    explanation:
      verdict === "missing"
        ? `${domain} has no MX record. Other servers don't know where to deliver mail for the domain, so inbound mail (and bounce/reply handling for what you send) fails.`
        : `${domain}'s MX points somewhere other than ${host}. Mail is routed to the wrong server, breaking delivery and reply handling.`,
    causes: [
      "The MX record was never created for this domain.",
      "The MX still points at a previous provider (Google, old host) after migrating to this server.",
      "A typo in the MX target.",
    ],
    steps: [
      `In your DNS provider, create/replace the MX record for ${domain}.`,
      `Point it at ${host} with priority 10.`,
      `Ensure ${host} has an A record → ${IP(ctx)} (DNS Only).`,
      "Remove any stale MX records pointing at old providers.",
    ],
    commands: [`dig MX ${domain}`, `dig +short ${host}          # should be ${IP(ctx)}`],
    dns: [
      `${domain}.        MX   10   ${host}.`,
      `${host}.        A         ${IP(ctx)}      ; DNS Only`,
    ],
    verification: [
      `dig MX ${domain} returns ${host}, and a test message to the domain is delivered.`,
    ],
  };
}

export function spfGuidance(
  verdict: "ok" | "missing" | "multiple",
  ctx: GuidanceContext,
): FixGuidance {
  const domain = DOMAIN(ctx);
  const host = HOST(ctx);
  if (verdict === "ok") {
    return {
      severity: "info",
      explanation: `${domain} publishes a single SPF record. Receivers can verify that this server is authorised to send for the domain. No action required — but confirm the record actually authorises ${host} / ${IP(ctx)}.`,
      verification: [`dig TXT ${domain} shows exactly one "v=spf1 …" record.`],
    };
  }
  if (verdict === "multiple") {
    return {
      severity: "high",
      explanation: `${domain} has more than one SPF (TXT "v=spf1 …") record. That's invalid — RFC 7208 allows only one, and receivers will treat SPF as permerror, failing authentication and hurting delivery.`,
      causes: [
        "SPF was added twice (e.g. one for a previous provider and one for this server).",
        "A tool appended a second SPF instead of merging into the existing one.",
      ],
      steps: [
        `List every TXT record on ${domain} and find all the "v=spf1" entries.`,
        "Merge them into ONE record that lists every legitimate sender.",
        "Delete the extra SPF record(s).",
      ],
      commands: [`dig +short TXT ${domain}`],
      dns: [`${domain}.        TXT   "v=spf1 mx a:${host} ~all"   ; exactly one SPF record`],
      verification: [`dig TXT ${domain} now shows a single "v=spf1 …" record.`],
    };
  }
  return {
    severity: "high",
    explanation: `${domain} has no SPF record. Receivers can't confirm this server is allowed to send for the domain, so mail is far more likely to be spam-foldered or rejected.`,
    causes: ["SPF was never published.", "The TXT record is on the wrong name."],
    steps: [
      `Publish a TXT record on ${domain} (the apex, not a subdomain).`,
      `Authorise this server: "v=spf1 mx a:${host} ~all" (mx = your MX hosts, a: = the mail host).`,
      "If you also send through another provider (e.g. Google), add its include: mechanism before ~all.",
      "Use ~all (softfail) to start; tighten to -all once you're confident every sender is listed.",
    ],
    commands: [`dig +short TXT ${domain}`],
    dns: [`${domain}.        TXT   "v=spf1 mx a:${host} ~all"`],
    verification: [
      `dig TXT ${domain} returns the SPF record.`,
      "A test message to Gmail shows spf=pass in the Authentication-Results header.",
    ],
  };
}

export function dkimGuidance(
  verdict: "ok" | "mismatch" | "missing" | "weak",
  ctx: GuidanceContext,
): FixGuidance {
  const domain = DOMAIN(ctx);
  const selector = SELECTOR(ctx);
  const recName = `${selector}._domainkey.${domain}`;
  if (verdict === "weak") {
    return {
      severity: "high",
      explanation: `The DKIM key published at ${recName} is a 1024-bit RSA key. 1024-bit keys are increasingly distrusted (Google and others now use 2048-bit), and some receivers treat them as a weak or failing signature — hurting deliverability.`,
      causes: [
        "The key was generated by an older Mailcow whose default DKIM size was 1024-bit.",
        "The domain was added before 2048-bit was enforced.",
      ],
      steps: [
        `In Mailcow → Email → Configuration → ARC/DKIM keys, delete the ${selector} key for ${domain}.`,
        `Regenerate it choosing a 2048-bit key length.`,
        `Publish the new public key as the TXT record at ${recName} (the "Sync DKIM" fix does this automatically).`,
      ],
      commands: [`dig +short TXT ${recName}`],
      dns: [`${recName}.   TXT   "v=DKIM1; k=rsa; p=<new 2048-bit public key from Mailcow>"`],
      verification: [
        `The published key is 2048-bit, and test mail to Gmail shows dkim=pass.`,
      ],
    };
  }
  if (verdict === "ok") {
    return {
      severity: "info",
      explanation: `A DKIM key is published at ${recName} and matches the server's signing key. Outgoing mail is cryptographically signed and verifiable. No action required.`,
      verification: [`dig TXT ${recName} returns the DKIM key, and test mail shows dkim=pass.`],
    };
  }
  if (verdict === "mismatch") {
    return {
      severity: "high",
      explanation: `A DKIM record exists at ${recName}, but it does NOT match the server's current signing key. Signatures won't verify (dkim=fail), which harms delivery and can fail DMARC — usually the key was rotated on the server but the DNS wasn't updated.`,
      causes: [
        "The DKIM key was regenerated in Mailcow but the new public key was never published to DNS.",
        "An old/duplicate DKIM record is being served.",
      ],
      steps: [
        "In Mailcow → Email → Configuration → ARC/DKIM keys, copy the current public key for this domain.",
        `Replace the TXT record at ${recName} with that exact key.`,
        "Remove any stale DKIM records for the same selector.",
      ],
      commands: [`dig +short TXT ${recName}`],
      dns: [`${recName}.   TXT   "v=DKIM1; k=rsa; p=<current public key from Mailcow>"`],
      verification: [`Test mail to Gmail shows dkim=pass, and the published key matches Mailcow.`],
    };
  }
  return {
    severity: "high",
    explanation: `No DKIM record is published at ${recName}. Outgoing mail is unsigned, so receivers can't verify it wasn't tampered with — this lowers reputation and (with a DMARC policy) can cause outright rejection.`,
    causes: [
      "DKIM was enabled in Mailcow but the public key was never added to DNS.",
      "The record is published under the wrong selector or name.",
    ],
    steps: [
      "In Mailcow → Email → Configuration → ARC/DKIM keys, generate a key for the domain if none exists, then copy the public key.",
      `Publish it as a TXT record at ${recName}.`,
      "Wait for propagation, then send a test message and confirm dkim=pass.",
    ],
    commands: [`dig +short TXT ${recName}`],
    dns: [`${recName}.   TXT   "v=DKIM1; k=rsa; p=<public key from Mailcow>"`],
    verification: [
      `dig TXT ${recName} returns the key.`,
      "A test message to Gmail shows dkim=pass in Authentication-Results.",
    ],
    nextStep: `If unsure of the selector, check Mailcow's DKIM page — the record name is <selector>._domainkey.${domain}.`,
  };
}

export function dmarcGuidance(verdict: "ok" | "missing", ctx: GuidanceContext): FixGuidance {
  const domain = DOMAIN(ctx);
  const recName = `_dmarc.${domain}`;
  if (verdict === "ok") {
    return {
      severity: "info",
      explanation: `${domain} publishes a DMARC policy at ${recName}. It tells receivers how to handle mail that fails SPF/DKIM and where to send reports. No action required — consider tightening p=none → quarantine → reject as confidence grows.`,
      verification: [`dig TXT ${recName} returns a "v=DMARC1 …" record.`],
    };
  }
  return {
    severity: "warning",
    explanation: `${domain} has no DMARC record. Without one, receivers have no instruction for handling mail that fails SPF/DKIM, you get no visibility via reports, and providers like Gmail/Yahoo increasingly require DMARC for bulk senders.`,
    causes: ["DMARC was never published.", "The record is on the wrong name (must be _dmarc)."],
    steps: [
      `Publish a TXT record at ${recName}.`,
      "Start in monitoring mode: p=none, with a rua address to receive aggregate reports.",
      "Review reports for a couple of weeks, then move to p=quarantine and eventually p=reject.",
      "Make sure SPF and DKIM already pass before enforcing, or legitimate mail could be blocked.",
    ],
    commands: [`dig +short TXT ${recName}`],
    dns: [`${recName}.   TXT   "v=DMARC1; p=none; rua=mailto:dmarc@${domain}; adkim=s; aspf=s"`],
    verification: [
      `dig TXT ${recName} returns the DMARC record.`,
      "Aggregate reports start arriving at the rua address.",
    ],
  };
}
