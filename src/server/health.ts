import tls from "node:tls";
import { mailcowRequest } from "./mailcow-helpers";

// DNS-over-HTTPS resolver. Node's dns.resolve*/reverse use c-ares (direct UDP/53 queries),
// which fail in many runtimes (no configured server / blocked), even though https/tls work
// (they use the OS resolver). DoH uses the same HTTPS transport that already works here, so
// the DNS checks reflect reality. Returns the answer `data` strings for the record type.
const DOH_TYPE: Record<string, number> = { A: 1, MX: 15, TXT: 16, PTR: 12 };
async function doh(name: string, type: "A" | "MX" | "TXT" | "PTR", timeoutMs = 6000): Promise<string[]> {
  const url = `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`;
  const res = await withTimeout(fetch(url, { headers: { accept: "application/dns-json" } }), timeoutMs);
  if (!res.ok) throw new Error(`DoH ${res.status}`);
  const json: any = await res.json();
  // Status 0 = NOERROR, 3 = NXDOMAIN. Anything without Answer means "no such record".
  if (json.Status !== 0 || !Array.isArray(json.Answer)) return [];
  return json.Answer.filter((a: any) => a.type === DOH_TYPE[type]).map((a: any) => String(a.data));
}

// TXT answers come back wrapped in quotes and possibly split into chunks; normalise.
function txtValue(data: string): string {
  return data.replace(/"\s+"/g, "").replace(/^"|"$/g, "");
}

// Deliverability health engine. Each indicator is probed independently (one failure never
// aborts the rest) and carries a concrete remediation. Network probes (DNS/RBL/TLS/Mailcow)
// are runtime-only. Pure-ish: takes plain data, returns a structured result.

export type HealthStatus = "ok" | "warn" | "fail" | "skip";
export type HealthAction = "pushDns" | "syncDkim" | "fixDns" | "recreate" | "provision";

export interface Indicator {
  id: string;
  label: string;
  status: HealthStatus;
  detail: string;
  fix?: string;
  action?: HealthAction;
}

export interface DomainHealth {
  status: "healthy" | "warning" | "critical" | "unknown";
  score: number; // 0-100 over non-skipped indicators
  checkedAt: string;
  indicators: Indicator[];
}

export interface HealthInput {
  name: string;
  ipAddress?: string | null;
  mailcowHostname?: string | null;
  mailcowApiKey?: string | null;
  subdomains: string[]; // mail subdomains (e.g. web.example.com)
  plannedInboxCount: number;
}

const DNSBLS = ["zen.spamhaus.org", "b.barracudacentral.org", "bl.spamcop.net"];

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

// Common Cloudflare proxy ranges — enough to flag a mail host that's orange-clouded.
function isCloudflareIp(ip: string): boolean {
  return /^(104\.1[6-9]|104\.2[0-7]|172\.6[4-9]|172\.7[01]|162\.158\.|141\.101\.|188\.114\.|190\.93\.|198\.41\.1)/.test(
    ip,
  );
}

function rollUp(indicators: Indicator[]): { status: DomainHealth["status"]; score: number } {
  const scored = indicators.filter((i) => i.status !== "skip");
  if (scored.length === 0) return { status: "unknown", score: 0 };
  const okCount = scored.filter((i) => i.status === "ok").length;
  const score = Math.round((okCount / scored.length) * 100);
  if (scored.some((i) => i.status === "fail")) return { status: "critical", score };
  if (scored.some((i) => i.status === "warn")) return { status: "warning", score };
  return { status: "healthy", score };
}

export async function checkDomainHealth(input: HealthInput): Promise<DomainHealth> {
  const { name, ipAddress, mailcowHostname, mailcowApiKey, subdomains, plannedInboxCount } = input;
  const mailHost = mailcowHostname || `mail.${name}`;
  const ind: Indicator[] = [];
  const add = (i: Indicator) => ind.push(i);

  // 1. Mail host A record + Cloudflare-proxy check.
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

  // 2. Reverse DNS (PTR).
  if (ipAddress) {
    try {
      const revName = ipAddress.split(".").reverse().join(".") + ".in-addr.arpa";
      const ptr = (await doh(revName, "PTR")).map((h) => h.replace(/\.$/, ""));
      if (ptr.some((h) => h.toLowerCase() === mailHost.toLowerCase())) {
        add({ id: "ptr", label: "Reverse DNS (PTR)", status: "ok", detail: `${ipAddress} → ${ptr[0]}` });
      } else {
        add({ id: "ptr", label: "Reverse DNS (PTR)", status: "fail", detail: `PTR is ${ptr.join(", ") || "unset"}, expected ${mailHost}.`, fix: `Set reverse DNS for ${ipAddress} to ${mailHost} in your VPS provider's panel.` });
      }
    } catch {
      add({ id: "ptr", label: "Reverse DNS (PTR)", status: "fail", detail: `No PTR record for ${ipAddress}.`, fix: `Set reverse DNS for ${ipAddress} to ${mailHost} in your VPS provider's panel.` });
    }
  } else {
    add({ id: "ptr", label: "Reverse DNS (PTR)", status: "skip", detail: "No server IP configured." });
  }

  // 3-6. Per-subdomain records (MX, SPF, DKIM, DMARC) — aggregated.
  const subs = subdomains.length ? subdomains : [name];
  const agg = async (
    id: string,
    label: string,
    check: (sub: string) => Promise<boolean>,
    fix: string,
    action: HealthAction,
  ) => {
    const results = await Promise.all(
      subs.map(async (s) => {
        try {
          return await check(s);
        } catch {
          return false;
        }
      }),
    );
    const okN = results.filter(Boolean).length;
    if (okN === subs.length) add({ id, label, status: "ok", detail: `Present on all ${subs.length} subdomains.` });
    else if (okN === 0) add({ id, label, status: "fail", detail: `Missing on all ${subs.length} subdomains.`, fix, action });
    else add({ id, label, status: "warn", detail: `Present on ${okN}/${subs.length} subdomains.`, fix, action });
  };

  await agg("mx", "MX records", async (s) => {
    const mx = await doh(s, "MX");
    return mx.some((m) => (m.trim().split(/\s+/).pop() || "").toLowerCase().replace(/\.$/, "") === mailHost.toLowerCase());
  }, "Push DNS to set MX → mail host.", "pushDns");

  await agg("spf", "SPF", async (s) => {
    const txt = await doh(s, "TXT");
    return txt.some((t) => txtValue(t).toLowerCase().includes("v=spf1"));
  }, "Push DNS to publish SPF.", "pushDns");

  await agg("dkim", "DKIM", async (s) => {
    const prefix = s.split(".")[0];
    const txt = await doh(`dkim._domainkey.${prefix}.${name}`, "TXT");
    return txt.some((t) => {
      const v = txtValue(t).toLowerCase();
      return v.includes("v=dkim1") && v.includes("p=");
    });
  }, "Run Sync DKIM to publish the DKIM key.", "syncDkim");

  await agg("dmarc", "DMARC", async (s) => {
    const txt = await doh(`_dmarc.${s}`, "TXT");
    return txt.some((t) => txtValue(t).toLowerCase().includes("v=dmarc1"));
  }, "Push DNS to publish DMARC.", "pushDns");

  // 7. Blacklist / IP reputation.
  if (ipAddress) {
    try {
      const rev = ipAddress.split(".").reverse().join(".");
      const listings: string[] = [];
      await Promise.all(
        DNSBLS.map(async (bl) => {
          try {
            const a = await doh(`${rev}.${bl}`, "A", 5000);
            if (a.length > 0) listings.push(bl); // answer => listed
          } catch {
            /* query failed => treat as not listed */
          }
        }),
      );
      if (listings.length === 0) add({ id: "blacklist", label: "IP reputation", status: "ok", detail: `${ipAddress} not on Spamhaus / Barracuda / SpamCop.` });
      else add({ id: "blacklist", label: "IP reputation", status: "fail", detail: `${ipAddress} listed on: ${listings.join(", ")}.`, fix: "Request delisting at the listing provider and warm up the IP (send gently)." });
    } catch {
      add({ id: "blacklist", label: "IP reputation", status: "skip", detail: "Could not query blacklists." });
    }
  } else {
    add({ id: "blacklist", label: "IP reputation", status: "skip", detail: "No server IP configured." });
  }

  // 8. TLS certificate on the mail host.
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (i: Indicator) => { if (!done) { done = true; add(i); resolve(); } };
    const socket = tls.connect({ host: mailHost, port: 443, servername: mailHost, rejectUnauthorized: false, timeout: 6000 }, () => {
      const cert = socket.getPeerCertificate();
      const issuer = (cert?.issuer?.O || "").toString();
      const validTo = cert?.valid_to ? new Date(cert.valid_to) : null;
      socket.end();
      if (issuer.toLowerCase().includes("mailcow") || issuer === "") {
        finish({ id: "tls", label: "TLS certificate", status: "warn", detail: "Self-signed cert in use (Let's Encrypt not issued yet).", fix: "Ensure DNS resolves + port 80 is open; ACME retries every 30 min." });
      } else if (validTo && validTo.getTime() < Date.now()) {
        finish({ id: "tls", label: "TLS certificate", status: "fail", detail: `Certificate expired ${validTo.toDateString()}.`, fix: "Re-provision or check ACME on the server." });
      } else {
        finish({ id: "tls", label: "TLS certificate", status: "ok", detail: `Valid cert from ${issuer}${validTo ? `, expires ${validTo.toDateString()}` : ""}.` });
      }
    });
    socket.on("error", () => finish({ id: "tls", label: "TLS certificate", status: "fail", detail: `Could not connect to ${mailHost}:443.`, fix: "Check the server is up and the mail host resolves to it." }));
    socket.on("timeout", () => { socket.destroy(); finish({ id: "tls", label: "TLS certificate", status: "fail", detail: `Timed out connecting to ${mailHost}:443.`, fix: "Check the server is reachable (and not Cloudflare-proxied)." }); });
  });

  // 9-10. Mailcow containers + mailbox count.
  if (mailcowHostname && mailcowApiKey) {
    try {
      const { json } = await mailcowRequest(mailcowHostname, mailcowApiKey, "get/status/containers", undefined, { timeoutMs: 8000 });
      if (json && typeof json === "object" && !Array.isArray(json)) {
        const containers = Object.values(json as Record<string, any>);
        const running = containers.filter((c) => c?.state === "running").length;
        if (containers.length > 0 && running === containers.length)
          add({ id: "mailcow", label: "Mailcow services", status: "ok", detail: `${running}/${containers.length} containers running.` });
        else if (containers.length > 0)
          add({ id: "mailcow", label: "Mailcow services", status: "fail", detail: `${running}/${containers.length} containers running.`, fix: "Re-provision the server.", action: "provision" });
        else
          add({ id: "mailcow", label: "Mailcow services", status: "fail", detail: "Mailcow API reachable but returned no containers.", fix: "Re-provision the server.", action: "provision" });
      } else {
        add({ id: "mailcow", label: "Mailcow services", status: "fail", detail: "Mailcow API unreachable or unauthorized.", fix: "Check the mail host (un-proxy) / re-provision.", action: "fixDns" });
      }
    } catch {
      add({ id: "mailcow", label: "Mailcow services", status: "fail", detail: "Mailcow API unreachable.", fix: "Check the mail host (un-proxy) / re-provision.", action: "fixDns" });
    }

    try {
      const { json } = await mailcowRequest(mailcowHostname, mailcowApiKey, "get/mailbox/all", undefined, { timeoutMs: 8000 });
      const count = Array.isArray(json) ? json.length : 0;
      if (plannedInboxCount > 0 && count >= plannedInboxCount)
        add({ id: "mailboxes", label: "Mailboxes", status: "ok", detail: `${count} of ${plannedInboxCount} planned mailboxes exist.` });
      else if (count > 0)
        add({ id: "mailboxes", label: "Mailboxes", status: "warn", detail: `${count} of ${plannedInboxCount || "?"} planned mailboxes exist.`, fix: "Run Set up / Recreate mailboxes.", action: "recreate" });
      else
        add({ id: "mailboxes", label: "Mailboxes", status: "fail", detail: `No mailboxes exist (planned ${plannedInboxCount || "?"}).`, fix: "Run Set up mailboxes.", action: "recreate" });
    } catch {
      add({ id: "mailboxes", label: "Mailboxes", status: "skip", detail: "Could not query mailboxes." });
    }
  } else {
    add({ id: "mailcow", label: "Mailcow services", status: "skip", detail: "Server not provisioned yet." });
    add({ id: "mailboxes", label: "Mailboxes", status: "skip", detail: "Server not provisioned yet." });
  }

  const { status, score } = rollUp(ind);
  return { status, score, checkedAt: new Date().toISOString(), indicators: ind };
}
