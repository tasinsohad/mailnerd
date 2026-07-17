import net from "node:net";
import tls from "node:tls";
import { mailcowRequest } from "./mailcow-helpers";
import { SSHManager } from "@/lib/ssh";
import type { SSHAuth } from "@/types";
import type { DomainHealth, Indicator } from "./health-types";
import { rollUp } from "./health-types";
import type { ConsoleLog } from "./console-bus";
import { doh, dohOne, txtValue, isCloudflareIp, DNSBLS, DOH_RESOLVERS } from "./health-net";
import {
  classifyPort25,
  fcrdnsVerdict,
  dkimKeyMatch,
  parsePostfixQueue,
  queueVerdict,
  dominantDeferral,
  parseDockerPs,
  containersVerdict,
  REQUIRED_CONTAINERS,
  parseListeningPorts,
  listenersVerdict,
  EXPECTED_LISTEN_PORTS,
  parseUfwStatus,
  firewallVerdict,
  summarizeMailLog,
  ipv6DeliveryVerdict,
  parseContainerApi,
  MAILCOW_SHELL_PRELUDE,
  type PortVerdict,
} from "./health-checks";
import {
  fcrdnsGuidance,
  mailhostGuidance,
  submissionGuidance,
  port25Guidance,
  queueGuidance,
  mailcowGuidance,
  tlsGuidance,
  blacklistGuidance,
  mxGuidance,
  spfGuidance,
  dkimGuidance,
  dmarcGuidance,
  containersGuidance,
  listenersGuidance,
  firewallGuidance,
  mailLogGuidance,
  ipv6Guidance,
  type GuidanceContext,
} from "./health-guidance";

// Known public MXes we test outbound port 25 against (a provider-agnostic pair).
const PORT25_TARGETS = ["gmail-smtp-in.l.google.com", "aspmx.l.google.com"];

export interface ServerHealthInput {
  ipAddress?: string | null;
  mailcowHostname?: string | null;
  mailcowApiKey?: string | null;
  sshUser?: string | null;
  sshPassword?: string | null;
  // Also check the sending-authentication DNS records (MX/SPF/DKIM/DMARC) for the sending domain.
  // Off by default so owned-server checks (keyed by IP) don't duplicate the domain engine.
  includeSendingDns?: boolean;
  sendingDomain?: string | null; // explicit sending domain; else derived from the mail host
  log?: ConsoleLog; // live console for the ad-hoc troubleshoot flow
}

// The sending domain from an explicit value or the mail host (mail.a.com -> a.com; a.com -> a.com).
export function deriveSendingDomain(mailHost: string): string {
  const labels = mailHost.split(".").filter(Boolean);
  return labels.length > 2 ? labels.slice(1).join(".") : mailHost;
}

// Deliverability checks that belong to a VPS/IP (run once per unique server per job): mail-host
// DNS, outbound port 25 (SSH), submission ports 587/465, Postfix queue (SSH), FCrDNS, IP
// blacklist, TLS cert, and Mailcow container health.
export async function checkServerHealth(input: ServerHealthInput): Promise<DomainHealth> {
  const { ipAddress, mailcowHostname, mailcowApiKey, sshUser, sshPassword } = input;
  const mailHost = mailcowHostname || "";
  const ind: Indicator[] = [];
  const add = (i: Indicator) => ind.push(i);
  const ctx: GuidanceContext = { ipAddress: ipAddress ?? null, mailHost: mailHost || null };

  // 1. Mail host DNS + Cloudflare-proxy check.
  if (mailHost) {
    try {
      const ips = await doh(mailHost, "A");
      if (ips.length === 0) throw new Error("no A record");
      if (ips.some((ip) => isCloudflareIp(ip))) {
        add({
          id: "mailhost",
          label: "Mail host DNS",
          status: "fail",
          detail: `${mailHost} is Cloudflare-proxied (${ips[0]}) — the Mailcow API and mail can't be reached.`,
          fix: "Un-proxy the mail host (set it DNS-only).",
          action: "fixDns",
          guidance: mailhostGuidance("proxied", ctx),
        });
      } else if (ipAddress && !ips.includes(ipAddress)) {
        add({
          id: "mailhost",
          label: "Mail host DNS",
          status: "fail",
          detail: `${mailHost} → ${ips.join(", ")}, but the server is ${ipAddress}.`,
          fix: "Push DNS so the mail host points to the server.",
          action: "pushDns",
          guidance: mailhostGuidance("wrongip", ctx),
        });
      } else {
        add({
          id: "mailhost",
          label: "Mail host DNS",
          status: "ok",
          detail: `${mailHost} → ${ips.join(", ")}`,
          guidance: mailhostGuidance("ok", ctx),
        });
      }
    } catch {
      add({
        id: "mailhost",
        label: "Mail host DNS",
        status: "fail",
        detail: `${mailHost} does not resolve.`,
        fix: "Push DNS to create the mail host A record.",
        action: "pushDns",
        guidance: mailhostGuidance("missing", ctx),
      });
    }
  }

  // 2. FCrDNS: PTR exists AND the PTR host forward-resolves back to the IP.
  if (ipAddress) {
    try {
      const revName = ipAddress.split(".").reverse().join(".") + ".in-addr.arpa";
      const ptr = (await doh(revName, "PTR")).map((h) => h.replace(/\.$/, ""));
      const forwardIps: string[] = [];
      for (const host of ptr) {
        try {
          const a = await doh(host, "A");
          forwardIps.push(...a);
        } catch {
          /* ignore per-host */
        }
      }
      const forwardProxied = forwardIps.length > 0 && forwardIps.every((x) => isCloudflareIp(x));
      const verdict = fcrdnsVerdict(ipAddress, ptr, forwardIps, forwardProxied);
      const fctx: GuidanceContext = { ...ctx, ptrHost: ptr[0] || null, forwardIps };
      if (verdict === "confirmed") {
        add({
          id: "fcrdns",
          label: "Reverse DNS (FCrDNS)",
          status: "ok",
          detail: `${ipAddress} → ${ptr[0]} → ${ipAddress} (forward-confirmed).`,
          guidance: fcrdnsGuidance("confirmed", fctx),
        });
      } else if (verdict === "proxied") {
        // PTR is correct; the host is Cloudflare-proxied so it can't forward-confirm to the IP.
        add({
          id: "fcrdns",
          label: "Reverse DNS (FCrDNS)",
          status: "warn",
          detail: `PTR for ${ipAddress} is correctly set to ${ptr[0]}, but ${ptr[0]} is Cloudflare-proxied (resolves to ${forwardIps.join(", ")}), so it can't forward-confirm to the server. The reverse DNS itself is fine — un-proxying will complete FCrDNS.`,
          fix: `Un-proxy the mail host (${ptr[0]}) so it resolves to ${ipAddress}. The PTR is already correct.`,
          action: "fixDns",
          guidance: fcrdnsGuidance("proxied", fctx),
        });
      } else if (verdict === "mismatch") {
        add({
          id: "fcrdns",
          label: "Reverse DNS (FCrDNS)",
          status: "fail",
          detail: `PTR ${ptr.join(", ")} does not forward-resolve back to ${ipAddress} (got ${forwardIps.join(", ") || "nothing"}).`,
          fix: `Ensure ${ptr[0] || mailHost} A-records to ${ipAddress}, and the PTR matches.`,
          guidance: fcrdnsGuidance("mismatch", fctx),
        });
      } else {
        add({
          id: "fcrdns",
          label: "Reverse DNS (FCrDNS)",
          status: "fail",
          detail: `No PTR record for ${ipAddress}.`,
          fix: `Set reverse DNS for ${ipAddress} to ${mailHost || "your mail host"} in your VPS provider's panel.`,
          guidance: fcrdnsGuidance("missing", fctx),
        });
      }
    } catch {
      add({
        id: "fcrdns",
        label: "Reverse DNS (FCrDNS)",
        status: "skip",
        detail: "Could not query reverse DNS.",
        guidance: fcrdnsGuidance("skip", ctx),
      });
    }
  } else {
    add({
      id: "fcrdns",
      label: "Reverse DNS (FCrDNS)",
      status: "skip",
      detail: "No server IP configured.",
    });
  }

  // 3. Submission ports 587 (STARTTLS reachable) + 465 (implicit TLS).
  if (mailHost) add(await checkSubmission(mailHost, ctx));

  // 4 + 7. SSH-based checks in one session: outbound port 25, the Postfix queue, and the
  // server-side runbook checks (containers, local listeners, host firewall, mail log).
  if (ipAddress && sshUser && sshPassword) {
    const { port25, queue, server } = await checkOverSsh(
      ipAddress,
      sshUser,
      sshPassword,
      ctx,
      input.log,
    );
    add(port25);
    add(queue);
    for (const i of server) add(i);
  } else {
    add({
      id: "port25",
      label: "Outbound port 25",
      status: "skip",
      detail: "No SSH credentials for this server.",
    });
    add({
      id: "queue",
      label: "Mail queue",
      status: "skip",
      detail: "No SSH credentials for this server.",
    });
  }

  // 5. IP blacklist / reputation.
  if (ipAddress) add(await checkBlacklist(ipAddress, ctx));
  else
    add({
      id: "blacklist",
      label: "IP reputation",
      status: "skip",
      detail: "No server IP configured.",
    });

  // 6. TLS certificate on the mail host (443).
  if (mailHost) add(await checkTls(mailHost, ctx));

  // 8. Mailcow container health.
  if (mailcowHostname && mailcowApiKey)
    add(await checkContainers(mailcowHostname, mailcowApiKey, ctx));
  else
    add({
      id: "mailcow",
      label: "Mailcow services",
      status: "skip",
      // Don't claim "not provisioned" — an external server may be running Mailcow perfectly well
      // and simply have no API key for us to use.
      detail: "No Mailcow API key — API health not checked.",
      guidance: mailcowGuidance("notprovisioned", ctx),
    });

  // 9. Sending-authentication DNS (MX / SPF / DKIM / DMARC) for the sending domain.
  if (input.includeSendingDns && mailHost) {
    const domain = input.sendingDomain?.trim() || deriveSendingDomain(mailHost);
    const dnsInds = await checkSendingDns(domain, mailHost, ctx, mailcowHostname, mailcowApiKey);
    for (const i of dnsInds) add(i);
  }

  const { status, score } = rollUp(ind);
  return { status, score, checkedAt: new Date().toISOString(), indicators: ind };
}

// --- sending-authentication DNS (MX / SPF / DKIM / DMARC) ---
// The records a domain needs so receivers accept its mail. Uses DoH only; DKIM is additionally
// key-matched against Mailcow when an API key is available, otherwise just checked for presence.
export async function checkSendingDns(
  domain: string,
  mailHost: string,
  baseCtx: GuidanceContext,
  mailcowHostname?: string | null,
  mailcowApiKey?: string | null,
): Promise<Indicator[]> {
  const out: Indicator[] = [];
  const ctx: GuidanceContext = { ...baseCtx, domain, mailHost, dkimSelector: "dkim" };

  // MX → should route to the mail host.
  try {
    const mx = await doh(domain, "MX");
    const hosts = mx.map((m) =>
      (m.trim().split(/\s+/).pop() || "").toLowerCase().replace(/\.$/, ""),
    );
    if (hosts.length === 0) {
      out.push({
        id: "mx",
        label: "MX record",
        status: "fail",
        detail: `${domain} has no MX record.`,
        guidance: mxGuidance("missing", ctx),
      });
    } else if (hosts.includes(mailHost.toLowerCase())) {
      out.push({
        id: "mx",
        label: "MX record",
        status: "ok",
        detail: `${domain} MX → ${mailHost}.`,
        guidance: mxGuidance("ok", ctx),
      });
    } else {
      out.push({
        id: "mx",
        label: "MX record",
        status: "warn",
        detail: `${domain} MX → ${hosts.join(", ")} (expected ${mailHost}).`,
        guidance: mxGuidance("wrong", ctx),
      });
    }
  } catch {
    out.push({
      id: "mx",
      label: "MX record",
      status: "skip",
      detail: `Could not query MX for ${domain}.`,
    });
  }

  // SPF → exactly one "v=spf1 …" TXT on the apex.
  try {
    const txt = await doh(domain, "TXT");
    const spfs = txt.map(txtValue).filter((t) => /v=spf1/i.test(t));
    if (spfs.length === 0) {
      out.push({
        id: "spf",
        label: "SPF",
        status: "fail",
        detail: `${domain} has no SPF record.`,
        guidance: spfGuidance("missing", ctx),
      });
    } else if (spfs.length > 1) {
      out.push({
        id: "spf",
        label: "SPF",
        status: "fail",
        detail: `${domain} has ${spfs.length} SPF records — only one is valid.`,
        guidance: spfGuidance("multiple", ctx),
      });
    } else {
      out.push({
        id: "spf",
        label: "SPF",
        status: "ok",
        detail: `SPF: ${spfs[0]}`,
        guidance: spfGuidance("ok", ctx),
      });
    }
  } catch {
    out.push({
      id: "spf",
      label: "SPF",
      status: "skip",
      detail: `Could not query TXT for ${domain}.`,
    });
  }

  // DKIM → published at dkim._domainkey.<domain>, and matching Mailcow's key when we can check.
  const recName = `dkim._domainkey.${domain}`;
  let dnsTxt: string[] = [];
  try {
    dnsTxt = await doh(recName, "TXT");
  } catch {
    /* treat as missing */
  }
  let pubkey = "";
  if (mailcowHostname && mailcowApiKey) {
    try {
      const { json } = await mailcowRequest(
        mailcowHostname,
        mailcowApiKey,
        `get/dkim/${domain}`,
        undefined,
        { timeoutMs: 8000 },
      );
      pubkey = String((json as any)?.pubkey ?? "");
    } catch {
      /* no key from mailcow */
    }
  }
  const { published, matches } = dkimKeyMatch(dnsTxt, pubkey);
  if (published && (matches || !pubkey)) {
    out.push({
      id: "dkim",
      label: "DKIM",
      status: "ok",
      detail: pubkey
        ? "DKIM published and matches Mailcow."
        : `DKIM record published at ${recName}.`,
      guidance: dkimGuidance("ok", ctx),
    });
  } else if (published && !matches) {
    out.push({
      id: "dkim",
      label: "DKIM",
      status: "warn",
      detail: "DKIM published but does not match Mailcow's current key (rotated?).",
      guidance: dkimGuidance("mismatch", ctx),
    });
  } else {
    out.push({
      id: "dkim",
      label: "DKIM",
      status: "fail",
      detail: `No DKIM record at ${recName}.`,
      guidance: dkimGuidance("missing", ctx),
    });
  }

  // DMARC → "v=DMARC1 …" TXT at _dmarc.<domain>.
  try {
    const txt = await doh(`_dmarc.${domain}`, "TXT");
    const dmarc = txt.map(txtValue).find((t) => /v=DMARC1/i.test(t));
    if (dmarc) {
      out.push({
        id: "dmarc",
        label: "DMARC",
        status: "ok",
        detail: `DMARC: ${dmarc}`,
        guidance: dmarcGuidance("ok", ctx),
      });
    } else {
      out.push({
        id: "dmarc",
        label: "DMARC",
        status: "warn",
        detail: `${domain} has no DMARC record.`,
        guidance: dmarcGuidance("missing", ctx),
      });
    }
  } catch {
    out.push({
      id: "dmarc",
      label: "DMARC",
      status: "skip",
      detail: `Could not query _dmarc.${domain}.`,
    });
  }

  return out;
}

// --- submission ports ---
async function checkSubmission(mailHost: string, ctx: GuidanceContext): Promise<Indicator> {
  const p465 = await probeTls(mailHost, 465, true);
  const p587 = await probeStartTls(mailHost, 587);
  const parts = [`465: ${p465.detail}`, `587: ${p587.detail}`];
  if (p465.ok && p587.ok) {
    return {
      id: "submission",
      label: "Submission ports",
      status: "ok",
      detail: parts.join("  •  "),
      guidance: submissionGuidance("ok", ctx),
    };
  }
  const bothDown = !p465.ok && !p587.ok;
  return {
    id: "submission",
    label: "Submission ports",
    status: bothDown ? "fail" : "warn",
    detail: parts.join("  •  "),
    fix: "Open/verify ports 587 and 465 on the VPS firewall and confirm the Mailcow TLS cert is valid.",
    guidance: submissionGuidance(bothDown ? "down" : "partial", ctx),
  };
}

function probeTls(
  host: string,
  port: number,
  checkCert: boolean,
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean, detail: string) => {
      if (!done) {
        done = true;
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
        resolve({ ok, detail });
      }
    };
    const socket = tls.connect(
      { host, port, servername: host, rejectUnauthorized: false, timeout: 6000 },
      () => {
        if (!checkCert) return finish(true, "reachable");
        const cert = socket.getPeerCertificate();
        const validTo = cert?.valid_to ? new Date(cert.valid_to) : null;
        if (validTo && validTo.getTime() < Date.now())
          finish(false, `cert expired ${validTo.toDateString()}`);
        else finish(true, "TLS ok");
      },
    );
    socket.on("error", () => finish(false, "unreachable"));
    socket.on("timeout", () => finish(false, "timeout"));
  });
}

// Confirm 587 is listening and advertises STARTTLS (SMTP banner + EHLO), without completing the
// upgrade — enough to verify the submission service is reachable.
function probeStartTls(host: string, port: number): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let done = false;
    let buf = "";
    const finish = (ok: boolean, detail: string) => {
      if (!done) {
        done = true;
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
        resolve({ ok, detail });
      }
    };
    const socket = net.connect({ host, port, timeout: 6000 }, () => {});
    socket.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("220") && !buf.toUpperCase().includes("EHLO-SENT")) {
        socket.write("EHLO deliverability-check\r\n");
        buf += "EHLO-SENT";
      }
      if (buf.toUpperCase().includes("STARTTLS")) finish(true, "STARTTLS ready");
      else if (/250 /.test(buf)) finish(true, "reachable (no STARTTLS advertised)");
    });
    socket.on("error", () => finish(false, "unreachable"));
    socket.on("timeout", () =>
      finish(buf.includes("220"), buf.includes("220") ? "reachable" : "timeout"),
    );
  });
}

// --- SSH: outbound port 25 + Postfix queue ---
async function checkOverSsh(
  ip: string,
  user: string,
  password: string,
  ctx: GuidanceContext,
  log?: ConsoleLog,
): Promise<{ port25: Indicator; queue: Indicator; server: Indicator[] }> {
  const auth: SSHAuth = { type: "password", password };
  const mgr = new SSHManager(ip, 22, user, auth);
  try {
    log?.info(`Connecting to ${user}@${ip} for server checks…`);
    await mgr.connect({ timeoutMs: 15000, maxRetries: 1 });

    // Port 25: test TCP to each target MX from the VPS. Always exits 0, echoes a verdict per host.
    const p25cmd =
      `for h in ${PORT25_TARGETS.join(" ")}; do ` +
      `timeout 8 bash -c "exec 3<>/dev/tcp/$h/25" 2>/dev/null && echo "$h OPEN" || echo "$h BLOCKED"; done; true`;
    const p25 = await mgr
      .executeCommand(p25cmd, { timeoutMs: 40000 })
      .catch((e) => ({ stdout: "", stderr: String(e), exitCode: -1 }));
    const verdicts: PortVerdict[] = PORT25_TARGETS.map((h) =>
      new RegExp(`${h.replace(/\./g, "\\.")} OPEN`).test(p25.stdout) ? "open" : "blocked",
    );
    const p25Verdict = classifyPort25(verdicts);
    const port25: Indicator =
      p25Verdict === "open"
        ? {
            id: "port25",
            label: "Outbound port 25",
            status: "ok",
            detail: `Reachable: ${PORT25_TARGETS.join(", ")}.`,
            guidance: port25Guidance("open", ctx),
          }
        : {
            id: "port25",
            label: "Outbound port 25",
            status: "fail",
            detail:
              p25Verdict === "partial"
                ? `Partially blocked: ${p25.stdout.trim().replace(/\n/g, "; ")}`
                : `Blocked to ${PORT25_TARGETS.join(" & ")} — the provider is blocking outbound SMTP.`,
            fix: "Port 25 blocked by the provider — open a support ticket to unblock, or configure a relayhost/smarthost in Mailcow → Configuration → Routing.",
            guidance: port25Guidance(p25Verdict === "partial" ? "partial" : "blocked", ctx),
          };

    // Postfix queue: prefer the container; parse `postqueue -p`.
    const qcmd =
      `docker exec $(docker ps -qf name=postfix-mailcow 2>/dev/null) postqueue -p 2>/dev/null ` +
      `|| postqueue -p 2>/dev/null || echo QUEUE_UNAVAILABLE`;
    const q = await mgr
      .executeCommand(qcmd, { timeoutMs: 20000 })
      .catch((e) => ({ stdout: "", stderr: String(e), exitCode: -1 }));
    let queue: Indicator;
    if (!q.stdout || q.stdout.includes("QUEUE_UNAVAILABLE")) {
      queue = {
        id: "queue",
        label: "Mail queue",
        status: "skip",
        detail: "Could not read the Postfix queue.",
      };
    } else {
      const stats = parsePostfixQueue(q.stdout, Date.now());
      const verdict = queueVerdict(stats);
      const reason = dominantDeferral(stats);
      const reasonText =
        reason === "timeout"
          ? " Most deferrals are connection timeouts (check port 25 / relayhost)."
          : reason === "rejected"
            ? " Most deferrals are remote rejections (reputation/content)."
            : "";
      const ageText =
        stats.oldestAgeMinutes !== null
          ? `, oldest ${Math.round(stats.oldestAgeMinutes / 60)}h`
          : "";
      queue = {
        id: "queue",
        label: "Mail queue",
        status: verdict,
        detail: `${stats.count} message${stats.count === 1 ? "" : "s"} queued${ageText}.${reasonText}`,
        ...(verdict !== "ok"
          ? {
              fix:
                reason === "timeout"
                  ? "Queue backing up on timeouts — verify outbound port 25 and DNS; consider a relayhost."
                  : "Queue backing up — investigate the deferral reasons above and recipient reputation.",
            }
          : {}),
        guidance: queueGuidance(verdict, ctx, reason),
      };
    }

    // Server-side runbook checks: containers, local listeners, host firewall, recent mail log.
    // The port-25 verdict is passed through so a broken-IPv6 stall isn't misread as a real block.
    const server = await checkServerInternals(mgr, ctx, p25Verdict === "open", log);
    return { port25, queue, server };
  } catch (e) {
    const detail = `SSH to ${ip} failed: ${e instanceof Error ? e.message : String(e)}`;
    return {
      port25: {
        id: "port25",
        label: "Outbound port 25",
        status: "fail",
        detail,
        fix: "Verify SSH access to the server, then re-check.",
      },
      queue: { id: "queue", label: "Mail queue", status: "skip", detail: "SSH unavailable." },
      server: [],
    };
  } finally {
    await mgr.dispose().catch(() => {});
  }
}

// Steps 3/4/5/9 of the runbook, gathered over the already-open SSH session.
async function checkServerInternals(
  mgr: SSHManager,
  ctx: GuidanceContext,
  outboundPort25Open: boolean,
  log?: ConsoleLog,
): Promise<Indicator[]> {
  const out: Indicator[] = [];

  // ONE round trip for the whole runbook sweep. These were four separate execs, which cost four
  // SSH round trips AND four independent timeout budgets (~105s worst case) on every server —
  // enough to turn a bulk "Re-check all" over a few dozen domains into a multi-minute wall.
  // They're independent read-only commands, so a single script with markers is equivalent.
  const script = [
    'echo "---PS---"',
    `docker ps -a --format '{{.Names}}\t{{.State}}\t{{.Status}}' 2>/dev/null`,
    'echo "---LISTEN---"',
    "ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null",
    'echo "---UFW---"',
    "ufw status 2>/dev/null || sudo -n ufw status 2>/dev/null",
    // The prelude cd's into the Mailcow dir, so it goes last — nothing after it needs the old cwd.
    'echo "---LOGS---"',
    MAILCOW_SHELL_PRELUDE +
      "$DC logs --tail=200 postfix-mailcow 2>/dev/null || tail -n 200 /var/log/mail.log 2>/dev/null",
    'echo "---END---"',
    "true",
  ].join("\n");

  log?.cmd("docker ps · ss -tlnp · ufw status · postfix logs");
  const res = await mgr
    .executeCommand(script, { timeoutMs: 45000, onData: (chunk) => log?.out(chunk) })
    .catch(() => ({ stdout: "", stderr: "", exitCode: -1 }));

  // Pull one marked section out of the combined output. Bounded by the NEXT KNOWN marker, not by
  // the next "---": log lines legitimately contain dashes, and splitting on those would silently
  // truncate the log (losing the very timeout counts the IPv6/queue checks read).
  const MARKERS = ["PS", "LISTEN", "UFW", "LOGS", "END"];
  const sect = (name: string): string => {
    const tag = `---${name}---`;
    const i = res.stdout.indexOf(tag);
    if (i === -1) return "";
    const from = i + tag.length;
    let end = res.stdout.length;
    for (const m of MARKERS) {
      const j = res.stdout.indexOf(`---${m}---`, from);
      if (j !== -1 && j < end) end = j;
    }
    return res.stdout.slice(from, end);
  };

  // --- Step 3: Mailcow containers (docker ps) ---
  const rows = parseDockerPs(sect("PS"));
  if (rows.length === 0) {
    out.push({
      id: "containers",
      label: "Mailcow containers",
      status: "fail",
      detail: "No Docker containers found (is Docker running?).",
      guidance: containersGuidance("down", { ...ctx, missing: REQUIRED_CONTAINERS }),
      action: "restartMailcow",
    });
  } else {
    const v = containersVerdict(rows);
    if (v.status === "ok") {
      out.push({
        id: "containers",
        label: "Mailcow containers",
        status: "ok",
        detail: `All ${REQUIRED_CONTAINERS.length} core containers running (${rows.filter((r) => r.running).length} up total).`,
        guidance: containersGuidance("ok", ctx),
      });
    } else {
      const bits: string[] = [];
      if (v.missing.length) bits.push(`missing: ${v.missing.join(", ")}`);
      if (v.stopped.length) bits.push(`stopped: ${v.stopped.join(", ")}`);
      if (v.unhealthy.length) bits.push(`unhealthy: ${v.unhealthy.join(", ")}`);
      out.push({
        id: "containers",
        label: "Mailcow containers",
        status: v.status,
        detail: bits.join(" • "),
        fix:
          v.status === "fail"
            ? "Bring the stopped containers up (docker compose up -d)."
            : "Restart the unhealthy containers (docker compose restart).",
        action: "restartMailcow",
        guidance: containersGuidance(v.status === "warn" ? "unhealthy" : "down", {
          ...ctx,
          missing: v.missing,
          stopped: v.stopped,
          unhealthy: v.unhealthy,
        }),
      });
    }
  }

  // --- Step 4: local SMTP listeners (ss -tlnp) ---
  const ports = parseListeningPorts(sect("LISTEN"));
  if (ports.length === 0) {
    out.push({
      id: "listeners",
      label: "SMTP listeners",
      status: "skip",
      detail: "Could not read listening sockets (ss/netstat unavailable).",
    });
  } else {
    const v = listenersVerdict(ports);
    if (v.status === "ok") {
      out.push({
        id: "listeners",
        label: "SMTP listeners",
        status: "ok",
        detail: `Listening on ${EXPECTED_LISTEN_PORTS.join(", ")}.`,
        guidance: listenersGuidance("ok", ctx),
      });
    } else {
      out.push({
        id: "listeners",
        label: "SMTP listeners",
        status: "fail",
        detail: `Postfix is not listening on ${v.missing.join(", ")}.`,
        fix: "Restart Postfix (docker compose restart postfix-mailcow).",
        action: "restartMailcow",
        guidance: listenersGuidance("missing", { ...ctx, missing: v.missing }),
      });
    }
  }

  // --- Step 5: host firewall (ufw) ---
  const ufw = sect("UFW");
  if (!/Status:/i.test(ufw)) {
    out.push({
      id: "firewall",
      label: "Server firewall",
      status: "skip",
      detail: "ufw not installed or not readable — check your firewall manually.",
    });
  } else {
    const parsed = parseUfwStatus(ufw);
    const v = firewallVerdict(parsed);
    if (v.status === "ok") {
      out.push({
        id: "firewall",
        label: "Server firewall",
        status: "ok",
        detail: parsed.active
          ? `ufw active; all mail ports allowed.`
          : "ufw inactive — the host isn't blocking any ports.",
        guidance: firewallGuidance("ok", ctx),
      });
    } else {
      out.push({
        id: "firewall",
        label: "Server firewall",
        status: "fail",
        detail: `ufw active but ${v.blocked.join(", ")} not allowed.`,
        fix: `Open the mail ports (ufw allow ${v.blocked.join(", ")}).`,
        action: "openFirewall",
        guidance: firewallGuidance("blocked", { ...ctx, blocked: v.blocked }),
      });
    }
  }

  // --- Step 9: recent Postfix log errors ---
  const logs = sect("LOGS");
  if (!logs.trim()) {
    out.push({
      id: "maillog",
      label: "Mail log",
      status: "skip",
      detail: "Could not read the Postfix log.",
    });
  } else {
    const s = summarizeMailLog(logs);
    const total = s.deferred + s.bounced + s.timeouts + s.hostNotFound + s.blocked;
    if (total === 0) {
      out.push({
        id: "maillog",
        label: "Mail log",
        status: "ok",
        detail: "No delivery errors in the last 200 log lines.",
        guidance: mailLogGuidance("ok", ctx),
      });
    } else {
      const dominant =
        s.timeouts >= s.hostNotFound && s.timeouts >= s.blocked && s.timeouts > 0
          ? ("timeout" as const)
          : s.hostNotFound >= s.blocked && s.hostNotFound > 0
            ? ("hostNotFound" as const)
            : s.blocked > 0
              ? ("blocked" as const)
              : s.bounced > 0
                ? ("bounced" as const)
                : null;
      const bits: string[] = [];
      if (s.deferred) bits.push(`${s.deferred} deferred`);
      if (s.bounced) bits.push(`${s.bounced} bounced`);
      if (s.timeouts) bits.push(`${s.timeouts} timeouts`);
      if (s.hostNotFound) bits.push(`${s.hostNotFound} host-not-found`);
      if (s.blocked) bits.push(`${s.blocked} 5.7.x rejections`);
      out.push({
        id: "maillog",
        label: "Mail log",
        status: "warn",
        detail: `Recent errors — ${bits.join(", ")}.`,
        guidance: {
          ...mailLogGuidance("errors", { ...ctx, dominant }),
          // Surface the actual log lines so the user doesn't have to SSH in to read them.
          ...(s.samples.length ? { logs: s.samples } : {}),
        },
      });
    }

    // Timeouts on IPv6 while IPv4 works = Postfix stalling on AAAA. This is the actual root
    // cause behind "port 25 is reachable but the queue is full of connection timeouts".
    if (ipv6DeliveryVerdict(s, outboundPort25Open) === "broken-ipv6") {
      out.push({
        id: "ipv6",
        label: "IPv6 delivery",
        status: "fail",
        detail: `${s.ipv6Timeouts} connection${s.ipv6Timeouts === 1 ? "" : "s"} timed out over IPv6 while IPv4 works — Postfix tries IPv6 first and stalls, deferring the mail.`,
        fix: "Set Postfix to inet_protocols = ipv4 and restart it.",
        action: "restartMailcow",
        guidance: {
          ...ipv6Guidance({ ...ctx, ipv6Timeouts: s.ipv6Timeouts, ipv4Timeouts: s.ipv4Timeouts }),
          ...(s.samples.length ? { logs: s.samples } : {}),
        },
      });
    }
  }

  return out;
}

// --- IP blacklist ---
async function checkBlacklist(ip: string, ctx: GuidanceContext): Promise<Indicator> {
  try {
    const rev = ip.split(".").reverse().join(".");
    const listings: string[] = [];
    await Promise.all(
      DNSBLS.map(async (bl) => {
        try {
          const a = await dohOne(DOH_RESOLVERS[0], `${rev}.${bl}`, "A", 5000);
          if (a.some((x) => /^127\.0\.0\.\d{1,3}$/.test(x))) listings.push(bl);
        } catch {
          /* not listed */
        }
      }),
    );
    if (listings.length === 0)
      return {
        id: "blacklist",
        label: "IP reputation",
        status: "ok",
        detail: `${ip} not on Spamhaus / Barracuda / SpamCop.`,
        guidance: blacklistGuidance(false, ctx),
      };
    return {
      id: "blacklist",
      label: "IP reputation",
      status: "fail",
      detail: `${ip} listed on: ${listings.join(", ")}.`,
      fix: "Request delisting at the listing provider and warm up the IP (send gently).",
      guidance: blacklistGuidance(true, { ...ctx, blacklists: listings }),
    };
  } catch {
    return {
      id: "blacklist",
      label: "IP reputation",
      status: "skip",
      detail: "Could not query blacklists.",
    };
  }
}

// --- TLS cert on the mail host ---
function checkTls(mailHost: string, ctx: GuidanceContext): Promise<Indicator> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (i: Indicator) => {
      if (!done) {
        done = true;
        resolve(i);
      }
    };
    const socket = tls.connect(
      { host: mailHost, port: 443, servername: mailHost, rejectUnauthorized: false, timeout: 6000 },
      () => {
        const cert = socket.getPeerCertificate();
        const issuer = (cert?.issuer?.O || "").toString();
        const validTo = cert?.valid_to ? new Date(cert.valid_to) : null;
        socket.end();
        if (issuer.toLowerCase().includes("mailcow") || issuer === "")
          finish({
            id: "tls",
            label: "TLS certificate",
            status: "warn",
            detail: "Self-signed cert in use (Let's Encrypt not issued yet).",
            fix: "Ensure DNS resolves + port 80 is open; ACME retries every 30 min.",
            guidance: tlsGuidance("selfsigned", ctx),
          });
        else if (validTo && validTo.getTime() < Date.now())
          finish({
            id: "tls",
            label: "TLS certificate",
            status: "fail",
            detail: `Certificate expired ${validTo.toDateString()}.`,
            fix: "Re-provision or check ACME on the server.",
            guidance: tlsGuidance("expired", ctx),
          });
        else
          finish({
            id: "tls",
            label: "TLS certificate",
            status: "ok",
            detail: `Valid cert from ${issuer}${validTo ? `, expires ${validTo.toDateString()}` : ""}.`,
            guidance: tlsGuidance("ok", ctx),
          });
      },
    );
    socket.on("error", () =>
      finish({
        id: "tls",
        label: "TLS certificate",
        status: "fail",
        detail: `Could not connect to ${mailHost}:443.`,
        fix: "Check the server is up and the mail host resolves to it.",
        guidance: tlsGuidance("unreachable", ctx),
      }),
    );
    socket.on("timeout", () => {
      socket.destroy();
      finish({
        id: "tls",
        label: "TLS certificate",
        status: "fail",
        detail: `Timed out connecting to ${mailHost}:443.`,
        fix: "Check the server is reachable (and not Cloudflare-proxied).",
        guidance: tlsGuidance("unreachable", ctx),
      });
    });
  });
}

// --- Mailcow containers ---
async function checkContainers(
  mailcowHostname: string,
  mailcowApiKey: string,
  ctx: GuidanceContext,
): Promise<Indicator> {
  try {
    const { json } = await mailcowRequest(
      mailcowHostname,
      mailcowApiKey,
      "get/status/containers",
      undefined,
      { timeoutMs: 8000 },
    );
    const parsed = parseContainerApi(json);
    // The API rejected us. That says nothing about whether mail is running — the SSH container
    // check is authoritative for that — so report it as an API-access problem, not "containers down".
    if (parsed.kind === "apiError") {
      return {
        id: "mailcow",
        label: "Mailcow services",
        status: "warn",
        detail: `Mailcow API rejected the key: ${parsed.message}`,
        fix: "Check the API key and that API_ALLOW_FROM includes this app's IP.",
        guidance: mailcowGuidance("apiRejected", { ...ctx, apiError: parsed.message }),
      };
    }
    if (parsed.kind === "unexpected") {
      return {
        id: "mailcow",
        label: "Mailcow services",
        status: "warn",
        detail: "Mailcow API returned an unexpected response (not a container list).",
        fix: "Verify the mail host is DNS-only and the Mailcow API is enabled.",
        guidance: mailcowGuidance("apiRejected", ctx),
      };
    }
    if (parsed.running === parsed.total)
      return {
        id: "mailcow",
        label: "Mailcow services",
        status: "ok",
        detail: `${parsed.running}/${parsed.total} containers running.`,
        guidance: mailcowGuidance("ok", ctx),
      };
    return {
      id: "mailcow",
      label: "Mailcow services",
      status: "fail",
      detail: `${parsed.running}/${parsed.total} containers running.`,
      fix: "Bring the stopped containers up (docker compose up -d).",
      action: "restartMailcow",
      guidance: mailcowGuidance("down", ctx),
    };
  } catch {
    return {
      id: "mailcow",
      label: "Mailcow services",
      status: "fail",
      detail: "Mailcow API unreachable.",
      fix: "Check the mail host (un-proxy) / re-provision.",
      action: "fixDns",
      guidance: mailcowGuidance("down", ctx),
    };
  }
}
