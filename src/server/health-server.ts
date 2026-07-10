import net from "node:net";
import tls from "node:tls";
import { mailcowRequest } from "./mailcow-helpers";
import { SSHManager } from "@/lib/ssh";
import type { SSHAuth } from "@/types";
import type { DomainHealth, Indicator } from "./health-types";
import { rollUp } from "./health-types";
import { doh, dohOne, isCloudflareIp, DNSBLS, DOH_RESOLVERS } from "./health-net";
import {
  classifyPort25,
  fcrdnsVerdict,
  parsePostfixQueue,
  queueVerdict,
  dominantDeferral,
  type PortVerdict,
} from "./health-checks";

// Known public MXes we test outbound port 25 against (a provider-agnostic pair).
const PORT25_TARGETS = ["gmail-smtp-in.l.google.com", "aspmx.l.google.com"];

export interface ServerHealthInput {
  ipAddress?: string | null;
  mailcowHostname?: string | null;
  mailcowApiKey?: string | null;
  sshUser?: string | null;
  sshPassword?: string | null;
}

// Deliverability checks that belong to a VPS/IP (run once per unique server per job): mail-host
// DNS, outbound port 25 (SSH), submission ports 587/465, Postfix queue (SSH), FCrDNS, IP
// blacklist, TLS cert, and Mailcow container health.
export async function checkServerHealth(input: ServerHealthInput): Promise<DomainHealth> {
  const { ipAddress, mailcowHostname, mailcowApiKey, sshUser, sshPassword } = input;
  const mailHost = mailcowHostname || "";
  const ind: Indicator[] = [];
  const add = (i: Indicator) => ind.push(i);

  // 1. Mail host DNS + Cloudflare-proxy check.
  if (mailHost) {
    try {
      const ips = await doh(mailHost, "A");
      if (ips.length === 0) throw new Error("no A record");
      if (ips.some((ip) => isCloudflareIp(ip))) {
        add({ id: "mailhost", label: "Mail host DNS", status: "fail", detail: `${mailHost} is Cloudflare-proxied (${ips[0]}) — the Mailcow API and mail can't be reached.`, fix: "Un-proxy the mail host (set it DNS-only).", action: "fixDns" });
      } else if (ipAddress && !ips.includes(ipAddress)) {
        add({ id: "mailhost", label: "Mail host DNS", status: "fail", detail: `${mailHost} → ${ips.join(", ")}, but the server is ${ipAddress}.`, fix: "Push DNS so the mail host points to the server.", action: "pushDns" });
      } else {
        add({ id: "mailhost", label: "Mail host DNS", status: "ok", detail: `${mailHost} → ${ips.join(", ")}` });
      }
    } catch {
      add({ id: "mailhost", label: "Mail host DNS", status: "fail", detail: `${mailHost} does not resolve.`, fix: "Push DNS to create the mail host A record.", action: "pushDns" });
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
        } catch { /* ignore per-host */ }
      }
      const verdict = fcrdnsVerdict(ipAddress, ptr, forwardIps);
      if (verdict === "confirmed") {
        add({ id: "fcrdns", label: "Reverse DNS (FCrDNS)", status: "ok", detail: `${ipAddress} → ${ptr[0]} → ${ipAddress} (forward-confirmed).` });
      } else if (verdict === "mismatch") {
        add({ id: "fcrdns", label: "Reverse DNS (FCrDNS)", status: "fail", detail: `PTR ${ptr.join(", ")} does not forward-resolve back to ${ipAddress} (got ${forwardIps.join(", ") || "nothing"}).`, fix: `Ensure ${ptr[0] || mailHost} A-records to ${ipAddress}, and the PTR matches.` });
      } else {
        add({ id: "fcrdns", label: "Reverse DNS (FCrDNS)", status: "fail", detail: `No PTR record for ${ipAddress}.`, fix: `Set reverse DNS for ${ipAddress} to ${mailHost || "your mail host"} in your VPS provider's panel.` });
      }
    } catch {
      add({ id: "fcrdns", label: "Reverse DNS (FCrDNS)", status: "skip", detail: "Could not query reverse DNS." });
    }
  } else {
    add({ id: "fcrdns", label: "Reverse DNS (FCrDNS)", status: "skip", detail: "No server IP configured." });
  }

  // 3. Submission ports 587 (STARTTLS reachable) + 465 (implicit TLS).
  if (mailHost) add(await checkSubmission(mailHost));

  // 4 + 7. SSH-based checks: outbound port 25 and the Postfix queue (one session).
  if (ipAddress && sshUser && sshPassword) {
    const { port25, queue } = await checkOverSsh(ipAddress, sshUser, sshPassword);
    add(port25);
    add(queue);
  } else {
    add({ id: "port25", label: "Outbound port 25", status: "skip", detail: "No SSH credentials for this server." });
    add({ id: "queue", label: "Mail queue", status: "skip", detail: "No SSH credentials for this server." });
  }

  // 5. IP blacklist / reputation.
  if (ipAddress) add(await checkBlacklist(ipAddress));
  else add({ id: "blacklist", label: "IP reputation", status: "skip", detail: "No server IP configured." });

  // 6. TLS certificate on the mail host (443).
  if (mailHost) add(await checkTls(mailHost));

  // 8. Mailcow container health.
  if (mailcowHostname && mailcowApiKey) add(await checkContainers(mailcowHostname, mailcowApiKey));
  else add({ id: "mailcow", label: "Mailcow services", status: "skip", detail: "Server not provisioned yet." });

  const { status, score } = rollUp(ind);
  return { status, score, checkedAt: new Date().toISOString(), indicators: ind };
}

// --- submission ports ---
async function checkSubmission(mailHost: string): Promise<Indicator> {
  const p465 = await probeTls(mailHost, 465, true);
  const p587 = await probeStartTls(mailHost, 587);
  const parts = [`465: ${p465.detail}`, `587: ${p587.detail}`];
  if (p465.ok && p587.ok) {
    return { id: "submission", label: "Submission ports", status: "ok", detail: parts.join("  •  ") };
  }
  const bothDown = !p465.ok && !p587.ok;
  return {
    id: "submission",
    label: "Submission ports",
    status: bothDown ? "fail" : "warn",
    detail: parts.join("  •  "),
    fix: "Open/verify ports 587 and 465 on the VPS firewall and confirm the Mailcow TLS cert is valid.",
  };
}

function probeTls(host: string, port: number, checkCert: boolean): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean, detail: string) => { if (!done) { done = true; try { socket.destroy(); } catch { /* ignore */ } resolve({ ok, detail }); } };
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: 6000 }, () => {
      if (!checkCert) return finish(true, "reachable");
      const cert = socket.getPeerCertificate();
      const validTo = cert?.valid_to ? new Date(cert.valid_to) : null;
      if (validTo && validTo.getTime() < Date.now()) finish(false, `cert expired ${validTo.toDateString()}`);
      else finish(true, "TLS ok");
    });
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
    const finish = (ok: boolean, detail: string) => { if (!done) { done = true; try { socket.destroy(); } catch { /* ignore */ } resolve({ ok, detail }); } };
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
    socket.on("timeout", () => finish(buf.includes("220"), buf.includes("220") ? "reachable" : "timeout"));
  });
}

// --- SSH: outbound port 25 + Postfix queue ---
async function checkOverSsh(
  ip: string,
  user: string,
  password: string,
): Promise<{ port25: Indicator; queue: Indicator }> {
  const auth: SSHAuth = { type: "password", password };
  const mgr = new SSHManager(ip, 22, user, auth);
  try {
    await mgr.connect({ timeoutMs: 15000, maxRetries: 1 });

    // Port 25: test TCP to each target MX from the VPS. Always exits 0, echoes a verdict per host.
    const p25cmd =
      `for h in ${PORT25_TARGETS.join(" ")}; do ` +
      `timeout 8 bash -c "exec 3<>/dev/tcp/$h/25" 2>/dev/null && echo "$h OPEN" || echo "$h BLOCKED"; done; true`;
    const p25 = await mgr.executeCommand(p25cmd, { timeoutMs: 40000 }).catch((e) => ({ stdout: "", stderr: String(e), exitCode: -1 }));
    const verdicts: PortVerdict[] = PORT25_TARGETS.map((h) =>
      new RegExp(`${h.replace(/\./g, "\\.")} OPEN`).test(p25.stdout) ? "open" : "blocked",
    );
    const p25Verdict = classifyPort25(verdicts);
    const port25: Indicator =
      p25Verdict === "open"
        ? { id: "port25", label: "Outbound port 25", status: "ok", detail: `Reachable: ${PORT25_TARGETS.join(", ")}.` }
        : {
            id: "port25",
            label: "Outbound port 25",
            status: "fail",
            detail: p25Verdict === "partial" ? `Partially blocked: ${p25.stdout.trim().replace(/\n/g, "; ")}` : `Blocked to ${PORT25_TARGETS.join(" & ")} — the provider is blocking outbound SMTP.`,
            fix: "Port 25 blocked by the provider — open a support ticket to unblock, or configure a relayhost/smarthost in Mailcow → Configuration → Routing.",
          };

    // Postfix queue: prefer the container; parse `postqueue -p`.
    const qcmd =
      `docker exec $(docker ps -qf name=postfix-mailcow 2>/dev/null) postqueue -p 2>/dev/null ` +
      `|| postqueue -p 2>/dev/null || echo QUEUE_UNAVAILABLE`;
    const q = await mgr.executeCommand(qcmd, { timeoutMs: 20000 }).catch((e) => ({ stdout: "", stderr: String(e), exitCode: -1 }));
    let queue: Indicator;
    if (!q.stdout || q.stdout.includes("QUEUE_UNAVAILABLE")) {
      queue = { id: "queue", label: "Mail queue", status: "skip", detail: "Could not read the Postfix queue." };
    } else {
      const stats = parsePostfixQueue(q.stdout, Date.now());
      const verdict = queueVerdict(stats);
      const reason = dominantDeferral(stats);
      const reasonText = reason === "timeout" ? " Most deferrals are connection timeouts (check port 25 / relayhost)." : reason === "rejected" ? " Most deferrals are remote rejections (reputation/content)." : "";
      const ageText = stats.oldestAgeMinutes !== null ? `, oldest ${Math.round(stats.oldestAgeMinutes / 60)}h` : "";
      queue = {
        id: "queue",
        label: "Mail queue",
        status: verdict,
        detail: `${stats.count} message${stats.count === 1 ? "" : "s"} queued${ageText}.${reasonText}`,
        ...(verdict !== "ok" ? { fix: reason === "timeout" ? "Queue backing up on timeouts — verify outbound port 25 and DNS; consider a relayhost." : "Queue backing up — investigate the deferral reasons above and recipient reputation." } : {}),
      };
    }
    return { port25, queue };
  } catch (e) {
    const detail = `SSH to ${ip} failed: ${e instanceof Error ? e.message : String(e)}`;
    return {
      port25: { id: "port25", label: "Outbound port 25", status: "fail", detail, fix: "Verify SSH access to the server, then re-check." },
      queue: { id: "queue", label: "Mail queue", status: "skip", detail: "SSH unavailable." },
    };
  } finally {
    await mgr.dispose().catch(() => {});
  }
}

// --- IP blacklist ---
async function checkBlacklist(ip: string): Promise<Indicator> {
  try {
    const rev = ip.split(".").reverse().join(".");
    const listings: string[] = [];
    await Promise.all(
      DNSBLS.map(async (bl) => {
        try {
          const a = await dohOne(DOH_RESOLVERS[0], `${rev}.${bl}`, "A", 5000);
          if (a.some((x) => /^127\.0\.0\.\d{1,3}$/.test(x))) listings.push(bl);
        } catch { /* not listed */ }
      }),
    );
    if (listings.length === 0)
      return { id: "blacklist", label: "IP reputation", status: "ok", detail: `${ip} not on Spamhaus / Barracuda / SpamCop.` };
    return { id: "blacklist", label: "IP reputation", status: "fail", detail: `${ip} listed on: ${listings.join(", ")}.`, fix: "Request delisting at the listing provider and warm up the IP (send gently)." };
  } catch {
    return { id: "blacklist", label: "IP reputation", status: "skip", detail: "Could not query blacklists." };
  }
}

// --- TLS cert on the mail host ---
function checkTls(mailHost: string): Promise<Indicator> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (i: Indicator) => { if (!done) { done = true; resolve(i); } };
    const socket = tls.connect({ host: mailHost, port: 443, servername: mailHost, rejectUnauthorized: false, timeout: 6000 }, () => {
      const cert = socket.getPeerCertificate();
      const issuer = (cert?.issuer?.O || "").toString();
      const validTo = cert?.valid_to ? new Date(cert.valid_to) : null;
      socket.end();
      if (issuer.toLowerCase().includes("mailcow") || issuer === "")
        finish({ id: "tls", label: "TLS certificate", status: "warn", detail: "Self-signed cert in use (Let's Encrypt not issued yet).", fix: "Ensure DNS resolves + port 80 is open; ACME retries every 30 min." });
      else if (validTo && validTo.getTime() < Date.now())
        finish({ id: "tls", label: "TLS certificate", status: "fail", detail: `Certificate expired ${validTo.toDateString()}.`, fix: "Re-provision or check ACME on the server." });
      else
        finish({ id: "tls", label: "TLS certificate", status: "ok", detail: `Valid cert from ${issuer}${validTo ? `, expires ${validTo.toDateString()}` : ""}.` });
    });
    socket.on("error", () => finish({ id: "tls", label: "TLS certificate", status: "fail", detail: `Could not connect to ${mailHost}:443.`, fix: "Check the server is up and the mail host resolves to it." }));
    socket.on("timeout", () => { socket.destroy(); finish({ id: "tls", label: "TLS certificate", status: "fail", detail: `Timed out connecting to ${mailHost}:443.`, fix: "Check the server is reachable (and not Cloudflare-proxied)." }); });
  });
}

// --- Mailcow containers ---
async function checkContainers(mailcowHostname: string, mailcowApiKey: string): Promise<Indicator> {
  try {
    const { json } = await mailcowRequest(mailcowHostname, mailcowApiKey, "get/status/containers", undefined, { timeoutMs: 8000 });
    if (json && typeof json === "object" && !Array.isArray(json)) {
      const containers = Object.values(json as Record<string, any>);
      const running = containers.filter((c) => c?.state === "running").length;
      if (containers.length > 0 && running === containers.length)
        return { id: "mailcow", label: "Mailcow services", status: "ok", detail: `${running}/${containers.length} containers running.` };
      if (containers.length > 0)
        return { id: "mailcow", label: "Mailcow services", status: "fail", detail: `${running}/${containers.length} containers running.`, fix: "Re-provision the server.", action: "provision" };
      return { id: "mailcow", label: "Mailcow services", status: "fail", detail: "Mailcow API reachable but returned no containers.", fix: "Re-provision the server.", action: "provision" };
    }
    return { id: "mailcow", label: "Mailcow services", status: "fail", detail: "Mailcow API unreachable or unauthorized.", fix: "Check the mail host (un-proxy) / re-provision.", action: "fixDns" };
  } catch {
    return { id: "mailcow", label: "Mailcow services", status: "fail", detail: "Mailcow API unreachable.", fix: "Check the mail host (un-proxy) / re-provision.", action: "fixDns" };
  }
}
