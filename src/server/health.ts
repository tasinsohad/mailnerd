import { mailcowRequest } from "./mailcow-helpers";
import { doh, txtValue } from "./health-net";
import { dkimKeyMatch } from "./health-checks";
import type { DomainHealth, Indicator, HealthAction } from "./health-types";
import { rollUp } from "./health-types";

// Re-export the shared health types so existing importers of "@/server/health" keep working.
export type { HealthStatus, HealthAction, Indicator, DomainHealth } from "./health-types";

// Domain-level deliverability checks: the DNS-authentication records for each sending
// subdomain (MX, SPF, DKIM key-match, DMARC) plus the mailbox count. The VPS/IP-level checks
// (port 25, submission ports, queue, PTR, blacklist, TLS, containers) live in health-server.ts.

export interface HealthInput {
  name: string;
  mailcowHostname?: string | null;
  mailcowApiKey?: string | null;
  subdomains: string[]; // mail subdomains (e.g. web.example.com); falls back to the apex
  plannedInboxCount: number;
}

export async function checkDomainHealth(input: HealthInput): Promise<DomainHealth> {
  const { name, mailcowHostname, mailcowApiKey, subdomains, plannedInboxCount } = input;
  const mailHost = mailcowHostname || `mail.${name}`;
  const ind: Indicator[] = [];
  const add = (i: Indicator) => ind.push(i);
  const subs = subdomains.length ? subdomains : [name];

  // Aggregate a boolean DNS check across every sending subdomain.
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

  await agg(
    "mx",
    "MX records",
    async (s) => {
      const mx = await doh(s, "MX");
      return mx.some((m) => (m.trim().split(/\s+/).pop() || "").toLowerCase().replace(/\.$/, "") === mailHost.toLowerCase());
    },
    "Push DNS to set MX → mail host.",
    "pushDns",
  );

  await agg(
    "spf",
    "SPF",
    async (s) => {
      const txt = await doh(s, "TXT");
      return txt.some((t) => txtValue(t).toLowerCase().includes("v=spf1"));
    },
    "Push DNS to publish SPF.",
    "pushDns",
  );

  // DKIM key-match: the published DNS key must equal Mailcow's current signing key (not just exist).
  await checkDkimMatch(subs, name, mailHost, mailcowHostname, mailcowApiKey, add);

  await agg(
    "dmarc",
    "DMARC",
    async (s) => {
      const txt = await doh(`_dmarc.${s}`, "TXT");
      return txt.some((t) => txtValue(t).toLowerCase().includes("v=dmarc1"));
    },
    "Push DNS to publish DMARC.",
    "pushDns",
  );

  // Mailbox count (this domain's planned inboxes vs what Mailcow reports).
  if (mailcowHostname && mailcowApiKey) {
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
    add({ id: "mailboxes", label: "Mailboxes", status: "skip", detail: "Server not provisioned yet." });
  }

  const { status, score } = rollUp(ind);
  return { status, score, checkedAt: new Date().toISOString(), indicators: ind };
}

async function checkDkimMatch(
  subs: string[],
  name: string,
  _mailHost: string,
  mailcowHostname: string | null | undefined,
  mailcowApiKey: string | null | undefined,
  add: (i: Indicator) => void,
): Promise<void> {
  if (!mailcowHostname || !mailcowApiKey) {
    add({ id: "dkim", label: "DKIM", status: "skip", detail: "Server not provisioned yet." });
    return;
  }

  const states = await Promise.all(
    subs.map(async (s): Promise<"match" | "mismatch" | "missing"> => {
      const recName = s === name ? `dkim._domainkey.${name}` : `dkim._domainkey.${s.split(".")[0]}.${name}`;
      let dnsTxt: string[] = [];
      try {
        dnsTxt = await doh(recName, "TXT");
      } catch {
        /* treat as missing */
      }
      let pubkey = "";
      try {
        const { json } = await mailcowRequest(mailcowHostname, mailcowApiKey, `get/dkim/${s}`, undefined, { timeoutMs: 8000 });
        pubkey = String((json as any)?.pubkey ?? "");
      } catch {
        /* no key from mailcow */
      }
      const { published, matches } = dkimKeyMatch(dnsTxt, pubkey);
      if (published && matches) return "match";
      if (published && !matches) return "mismatch";
      return "missing";
    }),
  );

  const matchN = states.filter((x) => x === "match").length;
  const mismatchN = states.filter((x) => x === "mismatch").length;
  const missingN = states.filter((x) => x === "missing").length;

  if (matchN === subs.length) {
    add({ id: "dkim", label: "DKIM", status: "ok", detail: `Key published and matches Mailcow on all ${subs.length} subdomains.` });
  } else if (missingN === subs.length) {
    add({ id: "dkim", label: "DKIM", status: "fail", detail: `DKIM key missing on all ${subs.length} subdomains.`, fix: "Run Sync DKIM to publish the DKIM key.", action: "syncDkim" });
  } else {
    const bits = [];
    if (mismatchN) bits.push(`${mismatchN} published but NOT matching Mailcow's current key (rotated?)`);
    if (missingN) bits.push(`${missingN} missing`);
    add({ id: "dkim", label: "DKIM", status: "warn", detail: `${matchN}/${subs.length} matching — ${bits.join(", ")}.`, fix: "Run Sync DKIM to publish Mailcow's current key.", action: "syncDkim" });
  }
}
