// Shared network primitives for the health engines: DNS-over-HTTPS lookups, blacklist list,
// Cloudflare-IP detection, and a timeout race. Kept in a leaf module so both the domain engine
// (health.ts) and the server engine (health-server.ts) reuse one implementation.
//
// DoH is used instead of Node's dns.resolve*/reverse (c-ares direct UDP/53) because those fail in
// many runtimes even when HTTPS works. DoH rides the same HTTPS transport that already works here.

const DOH_TYPE: Record<string, number> = { A: 1, NS: 2, MX: 15, TXT: 16, PTR: 12 };
export const DOH_RESOLVERS = ["https://dns.google/resolve", "https://cloudflare-dns.com/dns-query"];

// Curated, actively-maintained DNSBLs that follow the "127.0.0.x A-record = listed" convention.
// Deliberately EXCLUDES defunct / pay-to-delist / over-aggressive lists (UCEPROTECT L2/L3, cbl) and
// code-based reputation/whitelist-hybrid lists (hostkarma, mailspike z.) that false-positive — a
// wrong blacklist verdict is worse than a missing one. MAJOR listings are deliverability-killing;
// SECONDARY are worth flagging but rarely block delivery on their own.
export const DNSBL_MAJOR = ["zen.spamhaus.org", "b.barracudacentral.org", "bl.spamcop.net"];
export const DNSBL_SECONDARY = [
  "dnsbl.sorbs.net",
  "dnsbl-1.uceprotect.net",
  "psbl.surriel.com",
  "all.spamrats.com",
  "bl.mailspike.net",
  "bl.blocklist.de",
  "dnsbl.dronebl.org",
  "db.wpbl.info",
  "ix.dnsbl.manitu.net",
  "spam.dnsbl.anonmails.de",
  "truncate.gbudb.net",
  "rbl.interserver.net",
  "ips.backscatterer.org",
];
// The full set checkBlacklist queries (major first, for stable ordering in output).
export const DNSBLS = [...DNSBL_MAJOR, ...DNSBL_SECONDARY];

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

export async function dohOne(
  base: string,
  name: string,
  type: "A" | "NS" | "MX" | "TXT" | "PTR",
  timeoutMs: number,
): Promise<string[]> {
  const url = `${base}?name=${encodeURIComponent(name)}&type=${type}`;
  const res = await withTimeout(fetch(url, { headers: { accept: "application/dns-json" } }), timeoutMs);
  if (!res.ok) throw new Error(`DoH ${res.status}`);
  const json: any = await res.json();
  if (json.Status !== 0 || !Array.isArray(json.Answer)) return [];
  return json.Answer.filter((a: any) => a.type === DOH_TYPE[type]).map((a: any) => String(a.data));
}

// Query one resolver; if empty (missing OR cache lag), confirm against a second before concluding
// "missing". Stops freshly pushed records from flapping as failed while they propagate.
export async function doh(
  name: string,
  type: "A" | "NS" | "MX" | "TXT" | "PTR",
  timeoutMs = 6000,
): Promise<string[]> {
  const first = await dohOne(DOH_RESOLVERS[0], name, type, timeoutMs).catch(() => null);
  if (first && first.length > 0) return first;
  const second = await dohOne(DOH_RESOLVERS[1], name, type, timeoutMs).catch(() => null);
  if (second && second.length > 0) return second;
  if (first === null && second === null) throw new Error("DoH unavailable");
  return [];
}

// TXT answers come back wrapped in quotes and possibly split into chunks; normalise.
export function txtValue(data: string): string {
  return data.replace(/"\s+"/g, "").replace(/^"|"$/g, "");
}

// Common Cloudflare proxy ranges — enough to flag a mail host that's orange-clouded.
export function isCloudflareIp(ip: string): boolean {
  return /^(104\.1[6-9]|104\.2[0-7]|172\.6[4-9]|172\.7[01]|162\.158\.|141\.101\.|188\.114\.|190\.93\.|198\.41\.1)/.test(
    ip,
  );
}
