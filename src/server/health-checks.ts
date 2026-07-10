// Pure, dependency-free logic for the deliverability check engine. Everything here is
// deterministic (no network / SSH / DB) so it can be unit-tested; the server/domain engines are
// thin orchestration over these cores.

import type { Indicator } from "./health-types";

/* ---------- alert priority ---------- */

// Lower = more urgent. Matches the spec's alert priority order:
// port 25 block > new blacklist > PTR/DNS auth > queue backup > (submission/tls/services).
const PRIORITY: Record<string, number> = {
  port25: 10,
  blacklist: 20,
  ptr: 30,
  fcrdns: 30,
  mx: 40,
  spf: 40,
  dkim: 40,
  dmarc: 40,
  queue: 50,
  submission: 55,
  mailhost: 58,
  tls: 60,
  mailcow: 70,
  mailboxes: 80,
};

export function indicatorPriority(id: string): number {
  return PRIORITY[id] ?? 100;
}

// Sort indicators by urgency (priority asc), stable within the same priority.
export function sortByPriority(indicators: Indicator[]): Indicator[] {
  return indicators
    .map((ind, i) => ({ ind, i }))
    .sort((a, b) => indicatorPriority(a.ind.id) - indicatorPriority(b.ind.id) || a.i - b.i)
    .map((x) => x.ind);
}

/* ---------- outbound port 25 ---------- */

export type PortVerdict = "open" | "blocked";

// Given the per-MX verdicts, classify the server's outbound-25 status.
export function classifyPort25(verdicts: PortVerdict[]): "open" | "blocked" | "partial" {
  if (verdicts.length === 0) return "blocked";
  const open = verdicts.filter((v) => v === "open").length;
  if (open === verdicts.length) return "open";
  if (open === 0) return "blocked";
  return "partial";
}

/* ---------- FCrDNS ---------- */

// Forward-confirmed reverse DNS: PTR exists AND the PTR hostname forward-resolves back to the IP.
export function fcrdnsVerdict(
  ip: string,
  ptrHosts: string[],
  forwardIps: string[],
): "confirmed" | "mismatch" | "missing" {
  if (!ptrHosts || ptrHosts.length === 0) return "missing";
  return forwardIps.includes(ip) ? "confirmed" : "mismatch";
}

/* ---------- DKIM key match ---------- */

// Pull the base64 public key out of a DKIM TXT value (v=DKIM1; k=rsa; p=<base64>), or a bare key.
function extractDkimKey(txt: string): string {
  const joined = String(txt ?? "")
    .replace(/"\s*"/g, "") // stitch chunked TXT
    .replace(/^"|"$/g, "");
  const m = joined.match(/(?:^|;)\s*p\s*=\s*([A-Za-z0-9+/=]*)/i);
  const key = m ? m[1] : joined; // no p= tag → assume the whole thing is the key
  return key.replace(/\s+/g, "");
}

// Compare the DKIM key published in DNS to Mailcow's current signing key.
// - published: a non-empty key is present in DNS
// - matches:   that key equals Mailcow's pubkey (rotated-but-not-republished => published && !matches)
export function dkimKeyMatch(
  dnsTxtValues: string[],
  mailcowPubkey: string | null | undefined,
): { published: boolean; matches: boolean } {
  const dnsKeys = (dnsTxtValues ?? []).map(extractDkimKey).filter((k) => k.length > 0);
  const published = dnsKeys.length > 0;
  const mcKey = String(mailcowPubkey ?? "").replace(/\s+/g, "");
  const matches = published && mcKey.length > 0 && dnsKeys.some((k) => k === mcKey);
  return { published, matches };
}

/* ---------- Postfix queue ---------- */

export interface QueueStats {
  count: number;
  oldestAgeMinutes: number | null;
  deferrals: { timeout: number; rejected: number; other: number };
}

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

// Parse `postqueue -p` output: queue depth, age of the oldest message, and a classification of the
// deferral reasons (connection timeout vs remote rejection vs other). nowMs supplies the reference
// time (arrival lines carry no year), passed in for testability.
export function parsePostfixQueue(output: string, nowMs: number): QueueStats {
  const text = String(output ?? "");
  if (/Mail queue is empty/i.test(text)) {
    return { count: 0, oldestAgeMinutes: null, deferrals: { timeout: 0, rejected: 0, other: 0 } };
  }

  // A queue entry starts with an ID, then size, then an arrival timestamp like "Wed Jul 10 14:23:01".
  const entryRe =
    /^([0-9A-Za-z]{6,})[*!]?\s+\d+\s+\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\b/gm;

  let count = 0;
  let oldestMs: number | null = null;
  const now = new Date(nowMs);
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(text)) !== null) {
    count++;
    const mon = MONTHS[m[2]];
    if (mon === undefined) continue;
    let year = now.getUTCFullYear();
    let ts = Date.UTC(year, mon, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
    // Arrival can't be in the future — if it is, it belongs to last year (Dec seen in Jan).
    if (ts > nowMs + 24 * 3600 * 1000) ts = Date.UTC(year - 1, mon, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
    if (oldestMs === null || ts < oldestMs) oldestMs = ts;
  }

  // Deferral reason lines are parenthesised, e.g. "(connect to mx[..]:25: Connection timed out)"
  // or "(host mx[..] said: 550 5.7.1 blocked ...)".
  const deferrals = { timeout: 0, rejected: 0, other: 0 };
  const reasonRe = /^\s*\(([^)]+)\)\s*$/gm;
  let r: RegExpExecArray | null;
  while ((r = reasonRe.exec(text)) !== null) {
    const reason = r[1].toLowerCase();
    if (/timed out|timeout|connection refused|no route to host|network is unreachable|connect to/.test(reason)) {
      deferrals.timeout++;
    } else if (/said:\s*[45]\d\d|blocked|blacklist|spam|reputation|rejected|access denied|not authorized/.test(reason)) {
      deferrals.rejected++;
    } else {
      deferrals.other++;
    }
  }

  const oldestAgeMinutes =
    oldestMs === null ? null : Math.max(0, Math.floor((nowMs - oldestMs) / 60000));
  return { count, oldestAgeMinutes, deferrals };
}

// Turn queue stats into a health verdict given thresholds.
export function queueVerdict(
  stats: QueueStats,
  opts: { maxCount?: number; maxAgeMinutes?: number } = {},
): "ok" | "warn" | "fail" {
  const maxCount = opts.maxCount ?? 50;
  const maxAge = opts.maxAgeMinutes ?? 360; // 6h
  if (stats.count === 0) return "ok";
  const overCount = stats.count > maxCount;
  const overAge = stats.oldestAgeMinutes !== null && stats.oldestAgeMinutes > maxAge;
  if (overCount && overAge) return "fail";
  if (overCount || overAge) return "warn";
  return "ok";
}

// The dominant deferral reason, for the remediation hint.
export function dominantDeferral(stats: QueueStats): "timeout" | "rejected" | "other" | null {
  const { timeout, rejected, other } = stats.deferrals;
  if (timeout === 0 && rejected === 0 && other === 0) return null;
  if (timeout >= rejected && timeout >= other) return "timeout";
  if (rejected >= other) return "rejected";
  return "other";
}
