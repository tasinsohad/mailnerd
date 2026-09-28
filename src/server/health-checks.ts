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
  ipv6: 15, // a broken-IPv6 stall blocks delivery outright — rank it just under a port-25 block
  queue: 50,
  listeners: 52, // postfix not listening explains a submission failure — surface it first
  firewall: 54,
  submission: 55,
  containers: 56,
  mailhost: 58,
  mailtls: 12, // a bad cert on 993/465 blocks EVERY mail client — rank it just under a port-25 block
  tls: 60,
  smtpbanner: 62, // mail-server identity checks sit near TLS/submission
  starttls25: 63,
  mailcow: 70,
  maillog: 75,
  mailboxes: 80,
  apex: 82, // apex-domain spoofing posture — informational, separate from the subdomains' delivery
  nameservers: 85, // DNS-hygiene, informational
  openrelay: 90,
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
// `forwardProxied` signals that the forward A lookup returned only CDN/proxy IPs (e.g. Cloudflare
// orange-cloud) — the PTR is correct but a proxy is masking the real IP, so we don't call it a
// mismatch (that would blame the reverse DNS, which is fine; the fix is un-proxying the host).
export function fcrdnsVerdict(
  ip: string,
  ptrHosts: string[],
  forwardIps: string[],
  forwardProxied = false,
): "confirmed" | "mismatch" | "missing" | "proxied" {
  if (!ptrHosts || ptrHosts.length === 0) return "missing";
  if (forwardIps.includes(ip)) return "confirmed";
  if (forwardProxied) return "proxied";
  return "mismatch";
}

/* ---------- Mailcow shell helpers ---------- */

// Locate the Mailcow directory and pick the right compose command before running anything in it.
// Handles a non-standard install path and both `docker compose` (v2) and legacy `docker-compose`.
// Pure string; lives here so SSH callers don't have to import the network-touching engine.
export const MAILCOW_SHELL_PRELUDE =
  // A non-interactive SSH shell often gets a minimal PATH, so `docker` can be missing entirely —
  // which silently yields empty container lists and looks exactly like "Mailcow is down". Pin the
  // standard sbin/bin dirs first so every SSH script below actually finds docker.
  `export PATH="$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"; ` +
  `MCDIR=$(dirname "$(find /opt -maxdepth 3 -name mailcow.conf 2>/dev/null | head -1)" 2>/dev/null); ` +
  `[ -d "$MCDIR" ] || MCDIR=/opt/mailcow-dockerized; cd "$MCDIR" 2>/dev/null; ` +
  `DC="docker compose"; $DC version >/dev/null 2>&1 || DC="docker-compose"; `;

/* ---------- Mailcow containers (docker ps) ---------- */

// The core Mailcow services. Matched as substrings because compose prefixes/suffixes the real
// container names (e.g. "mailcowdockerized-postfix-mailcow-1").
export const REQUIRED_CONTAINERS = ["postfix", "dovecot", "nginx", "rspamd", "mysql", "redis"];

export interface ContainerRow {
  name: string;
  running: boolean;
  unhealthy: boolean;
}

// Parse `docker ps -a --format '{{.Names}}\t{{.State}}\t{{.Status}}'`.
export function parseDockerPs(output: string): ContainerRow[] {
  const rows: ContainerRow[] = [];
  for (const line of String(output ?? "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const [name, state = "", status = ""] = t.split("\t");
    if (!name) continue;
    rows.push({
      name: name.trim(),
      running: state.trim().toLowerCase() === "running",
      unhealthy: /\(unhealthy\)/i.test(status),
    });
  }
  return rows;
}

// Which required services are missing entirely, stopped, or running-but-unhealthy.
export function containersVerdict(rows: ContainerRow[]): {
  status: "ok" | "warn" | "fail";
  missing: string[];
  stopped: string[];
  unhealthy: string[];
} {
  const missing: string[] = [];
  const stopped: string[] = [];
  const unhealthy: string[] = [];
  for (const svc of REQUIRED_CONTAINERS) {
    const match = rows.filter((r) => r.name.toLowerCase().includes(svc));
    if (match.length === 0) {
      missing.push(svc);
    } else if (!match.some((r) => r.running)) {
      stopped.push(svc);
    } else if (match.some((r) => r.running && r.unhealthy)) {
      unhealthy.push(svc);
    }
  }
  // Missing/stopped core services break mail outright; unhealthy is a warning.
  const status = missing.length || stopped.length ? "fail" : unhealthy.length ? "warn" : "ok";
  return { status, missing, stopped, unhealthy };
}

/* ---------- Mailcow container API response ---------- */

export type ContainerApiResult =
  | { kind: "containers"; running: number; total: number }
  | { kind: "apiError"; message: string }
  | { kind: "unexpected" };

// Interpret `get/status/containers`. Mailcow reports failures as {"type":"error","msg":"..."}
// (see mailcow-helpers), which naively Object.values()'d counts as TWO entries with zero
// "running" — reporting a perfectly healthy server as "0/2 containers running". Real container
// entries always carry a `state`, so keying off that tells a genuine reply from an error body.
export function parseContainerApi(json: unknown): ContainerApiResult {
  if (!json || typeof json !== "object") return { kind: "unexpected" };
  const entries = Array.isArray(json) ? json : [json];
  const err = entries.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (e: any) => e && typeof e === "object" && (e.type === "error" || e.type === "danger"),
  );
  if (err) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msg = (err as any).msg;
    return {
      kind: "apiError",
      message: typeof msg === "string" ? msg : JSON.stringify(msg ?? err),
    };
  }
  if (Array.isArray(json)) return { kind: "unexpected" };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vals = Object.values(json as Record<string, any>);
  const containers = vals.filter((v) => v && typeof v === "object" && "state" in v);
  if (containers.length === 0) return { kind: "unexpected" };
  return {
    kind: "containers",
    running: containers.filter((c) => c.state === "running").length,
    total: containers.length,
  };
}

/* ---------- listening ports (ss -tlnp) ---------- */

// The ports Postfix/Dovecot should be listening on locally.
export const EXPECTED_LISTEN_PORTS = [25, 465, 587];

// Parse `ss -tlnp` / `netstat -tlnp`: collect every port in a LISTEN row's local address.
export function parseListeningPorts(output: string): number[] {
  const ports = new Set<number>();
  for (const line of String(output ?? "").split("\n")) {
    if (!/^\s*(LISTEN|tcp\S*\s)/i.test(line) && !/\bLISTEN\b/.test(line)) continue;
    // Local address is the field before the peer address; match "<addr>:<port>" tokens.
    const tokens = line.trim().split(/\s+/);
    for (const tok of tokens) {
      const m = tok.match(/:(\d{1,5})$/);
      if (!m) continue;
      const p = Number(m[1]);
      if (p > 0 && p <= 65535) ports.add(p);
      break; // only the first addr:port token (the local address)
    }
  }
  return [...ports].sort((a, b) => a - b);
}

// Which of the expected SMTP ports aren't listening on the host.
export function listenersVerdict(
  listening: number[],
  expected: number[] = EXPECTED_LISTEN_PORTS,
): { status: "ok" | "fail"; missing: number[] } {
  const set = new Set(listening);
  const missing = expected.filter((p) => !set.has(p));
  return { status: missing.length ? "fail" : "ok", missing };
}

/* ---------- host firewall (ufw status) ---------- */

// Every port a Mailcow host should accept.
export const FIREWALL_PORTS = [25, 465, 587, 80, 443, 993, 995];

// Parse `ufw status`: whether it's active, and which ports are explicitly ALLOWed.
export function parseUfwStatus(output: string): { active: boolean; allowed: number[] } {
  const text = String(output ?? "");
  const active = /Status:\s*active/i.test(text);
  const allowed = new Set<number>();
  for (const line of text.split("\n")) {
    // e.g. "25/tcp   ALLOW   Anywhere" or "587   ALLOW   Anywhere"
    const m = line.match(/^\s*(\d{1,5})(?:\/tcp)?\s+ALLOW\b/i);
    if (m) allowed.add(Number(m[1]));
  }
  return { active, allowed: [...allowed].sort((a, b) => a - b) };
}

// An inactive ufw isn't blocking anything — that's fine. When active, every mail port must be open.
export function firewallVerdict(
  parsed: { active: boolean; allowed: number[] },
  required: number[] = FIREWALL_PORTS,
): { status: "ok" | "fail"; blocked: number[] } {
  if (!parsed.active) return { status: "ok", blocked: [] };
  const set = new Set(parsed.allowed);
  const blocked = required.filter((p) => !set.has(p));
  return { status: blocked.length ? "fail" : "ok", blocked };
}

/* ---------- Postfix log errors ---------- */

// Classify notable delivery errors in recent postfix logs (step 9 of the runbook).
export function summarizeMailLog(output: string): {
  deferred: number;
  bounced: number;
  timeouts: number;
  hostNotFound: number;
  blocked: number;
  ipv6Timeouts: number;
  ipv4Timeouts: number;
  samples: string[];
} {
  const text = String(output ?? "");
  const lines = text.split("\n").filter((l) => l.trim());
  const count = (re: RegExp) => lines.filter((l) => re.test(l)).length;
  const samples = lines
    .filter((l) =>
      /status=(deferred|bounced)|Connection timed out|Host not found|550 5\.7|Name service error/i.test(
        l,
      ),
    )
    .slice(-5)
    .map((l) => l.trim().slice(0, 240));

  // Postfix logs the address it actually dialled in brackets:
  //   connect to mx.example.com[2a00:1450:400c::1a]:25: Connection timed out   <- IPv6
  //   connect to mx.example.com[142.250.1.26]:25: Connection timed out         <- IPv4
  // Splitting these apart matters: timeouts ONLY on IPv6 while IPv4 works is the classic
  // broken-IPv6-egress case, which has a completely different fix from a real port-25 block.
  const failedConnect = lines.filter((l) =>
    /(Connection timed out|Network is unreachable|No route to host)/i.test(l),
  );
  const bracketed = (l: string) => l.match(/\[([^\]]+)\]:\d+:/)?.[1] ?? "";
  const isIpv6 = (a: string) => a.includes(":");
  return {
    deferred: count(/status=deferred/i),
    bounced: count(/status=bounced/i),
    timeouts: count(/Connection timed out/i),
    hostNotFound: count(/Host not found|Name service error/i),
    blocked: count(/550 5\.7/i),
    ipv6Timeouts: failedConnect.filter((l) => isIpv6(bracketed(l))).length,
    ipv4Timeouts: failedConnect.filter((l) => {
      const a = bracketed(l);
      return !!a && !isIpv6(a);
    }).length,
    samples,
  };
}

// Is broken IPv6 egress the reason mail is deferring? True when connections are timing out on
// IPv6 and IPv4 is demonstrably fine — Postfix prefers AAAA, hangs, and defers, even though the
// server can reach the internet perfectly well over IPv4. The fix is to stop Postfix using IPv6,
// which is completely different from "the provider blocks port 25".
export function ipv6DeliveryVerdict(
  log: { ipv6Timeouts: number; ipv4Timeouts: number },
  outboundPort25Open: boolean,
): "broken-ipv6" | "ok" {
  if (log.ipv6Timeouts <= 0) return "ok";
  // If IPv4 is also timing out, this isn't an IPv6-specific fault — don't misdiagnose it.
  if (!outboundPort25Open) return "ok";
  if (log.ipv4Timeouts >= log.ipv6Timeouts) return "ok";
  return "broken-ipv6";
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

/* ---------- DKIM key strength ---------- */

// The minimum RSA DKIM key size we require. 1024-bit keys are increasingly distrusted (Google now
// rotates its own to 2048), so anything weaker is a deliverability risk.
export const DKIM_MIN_BITS = 2048;

// Decode standard base64 to bytes without depending on Buffer (keeps this module portable/pure).
function base64ToBytes(b64: string): Uint8Array | null {
  const clean = String(b64 ?? "").replace(/[^A-Za-z0-9+/=]/g, "");
  if (!clean) return null;
  try {
    const bin =
      typeof atob === "function"
        ? atob(clean)
        : // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (globalThis as any).Buffer?.from(clean, "base64").toString("binary");
    if (typeof bin !== "string") return null;
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

// Minimal DER reader: the RSA modulus bit length of a public key encoded either as an X.509
// SubjectPublicKeyInfo (what Mailcow publishes) or a bare PKCS#1 RSAPublicKey. null when it can't be
// parsed — callers treat that as "size unknown", never as weak.
function rsaModulusBits(der: Uint8Array): number | null {
  let pos = 0;
  const readLen = (): number | null => {
    if (pos >= der.length) return null;
    let len = der[pos++];
    if (len & 0x80) {
      const n = len & 0x7f;
      if (n === 0 || n > 4 || pos + n > der.length) return null;
      len = 0;
      for (let i = 0; i < n; i++) len = (len << 8) | der[pos++];
    }
    return len;
  };
  const expect = (tag: number): number | null => {
    if (pos >= der.length || der[pos] !== tag) return null;
    pos++;
    return readLen();
  };
  if (expect(0x30) === null) return null; // outer SEQUENCE
  // SPKI => next element is a SEQUENCE (AlgorithmIdentifier); bare PKCS#1 => next is the INTEGER modulus.
  if (der[pos] === 0x30) {
    const algLen = expect(0x30);
    if (algLen === null) return null;
    pos += algLen; // skip AlgorithmIdentifier
    const bitLen = expect(0x03); // BIT STRING wrapping the RSAPublicKey
    if (bitLen === null || pos >= der.length) return null;
    pos++; // unused-bits byte (expected 0)
    if (expect(0x30) === null) return null; // RSAPublicKey SEQUENCE
  }
  const modLen = expect(0x02); // INTEGER modulus
  if (modLen === null || modLen <= 0 || pos + modLen > der.length) return null;
  let start = pos;
  let len = modLen;
  while (len > 0 && der[start] === 0x00) {
    start++; // strip leading zero padding (keeps the integer positive)
    len--;
  }
  if (len <= 0) return null;
  let bits = (len - 1) * 8;
  for (let top = der[start]; top > 0; top >>= 1) bits++;
  return bits;
}

// The RSA key size (bits) of a published DKIM record, or null when it can't be determined. Reads the
// p= base64 out of the TXT value(s) and measures the modulus.
export function dkimPublicKeyBits(dnsTxtValues: string[]): number | null {
  for (const txt of dnsTxtValues ?? []) {
    const key = extractDkimKey(txt);
    if (!key) continue;
    const der = base64ToBytes(key);
    if (!der) continue;
    const bits = rsaModulusBits(der);
    if (bits) return bits;
  }
  return null;
}

// Strength verdict for a published DKIM key. "unknown" (unparseable/no key) never fails the check —
// a false "weak" is worse than a miss.
export function dkimStrengthVerdict(bits: number | null): "ok" | "weak" | "unknown" {
  if (bits === null) return "unknown";
  return bits >= DKIM_MIN_BITS ? "ok" : "weak";
}

/* ---------- Postfix queue ---------- */

export interface QueueStats {
  count: number;
  oldestAgeMinutes: number | null;
  deferrals: { timeout: number; rejected: number; other: number };
}

const MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
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
    if (ts > nowMs + 24 * 3600 * 1000)
      ts = Date.UTC(year - 1, mon, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
    if (oldestMs === null || ts < oldestMs) oldestMs = ts;
  }

  // Deferral reason lines are parenthesised, e.g. "(connect to mx[..]:25: Connection timed out)"
  // or "(host mx[..] said: 550 5.7.1 blocked ...)".
  const deferrals = { timeout: 0, rejected: 0, other: 0 };
  const reasonRe = /^\s*\(([^)]+)\)\s*$/gm;
  let r: RegExpExecArray | null;
  while ((r = reasonRe.exec(text)) !== null) {
    const reason = r[1].toLowerCase();
    if (
      /timed out|timeout|connection refused|no route to host|network is unreachable|connect to/.test(
        reason,
      )
    ) {
      deferrals.timeout++;
    } else if (
      /said:\s*[45]\d\d|blocked|blacklist|spam|reputation|rejected|access denied|not authorized/.test(
        reason,
      )
    ) {
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
  opts: {
    maxCount?: number;
    maxAgeMinutes?: number;
    deferAgeMinutes?: number;
    failAgeMinutes?: number;
  } = {},
): "ok" | "warn" | "fail" {
  const maxCount = opts.maxCount ?? 50;
  const maxAge = opts.maxAgeMinutes ?? 360; // 6h
  const deferAge = opts.deferAgeMinutes ?? 60; // 1h
  const failAge = opts.failAgeMinutes ?? 1440; // 24h
  if (stats.count === 0) return "ok";
  const age = stats.oldestAgeMinutes;
  // Mail that has been stuck for a day is failing, not "worth a look" — Postfix gives up and
  // bounces around 5 days, so this is a countdown to lost mail regardless of queue depth.
  if (age !== null && age >= failAge) return "fail";
  const overCount = stats.count > maxCount;
  // >= so a queue sitting exactly at the limit isn't reported as healthy.
  const overAge = age !== null && age >= maxAge;
  if (overCount && overAge) return "fail";
  if (overCount || overAge) return "warn";
  // Mail that keeps failing to deliver is a problem well before the hard thresholds: a queue
  // aging past deferAge with real deferral reasons means delivery is repeatedly failing, even
  // if it's only a handful of messages.
  const deferring = stats.deferrals.timeout + stats.deferrals.rejected > 0;
  if (deferring && stats.oldestAgeMinutes !== null && stats.oldestAgeMinutes >= deferAge)
    return "warn";
  return "ok";
}

/* ---------- Mail-port TLS (what IMAP/SMTP clients actually see) ---------- */

// One TLS probe result. `authorized` is Node's own chain+hostname verification — i.e. exactly the
// verdict a mail client reaches, which is what matters here.
export interface MailTlsProbe {
  port: number;
  reachable: boolean;
  authorized: boolean;
  authError?: string; // DEPTH_ZERO_SELF_SIGNED_CERT / CERT_HAS_EXPIRED / ALTNAME_INVALID / …
  issuerO?: string;
  validToMs?: number | null;
}

// Verdict for the certificate mail CLIENTS see on IMAPS/SMTPS. This is deliberately separate from
// the port-443 check: Dovecot and Postfix load their certificate at container start, so after ACME
// issues the real one they can keep serving Mailcow's self-signed snakeoil. The web UI then looks
// perfectly healthy on 443 while every mail client reports "connection failed" — a real outage that
// the 443-only check cannot see. `needsReload` marks the case a service restart actually fixes.
export function mailTlsVerdict(
  probes: MailTlsProbe[],
  nowMs: number,
): { status: "ok" | "warn" | "fail" | "skip"; reason: string; needsReload: boolean } {
  const reached = probes.filter((p) => p.reachable);
  if (reached.length === 0)
    return { status: "skip", reason: "No mail port answered TLS.", needsReload: false };

  const bad = reached.filter((p) => !p.authorized);
  if (bad.length > 0) {
    const ports = bad.map((p) => p.port).join(", ");
    const err = bad.map((p) => p.authError ?? "").join(" ");
    const selfSigned = /SELF_SIGNED/i.test(err) || bad.some((p) => /mailcow/i.test(p.issuerO ?? ""));
    const expired = /CERT_HAS_EXPIRED/i.test(err);
    const nameBad = /ALTNAME|HOSTNAME/i.test(err);
    const reason = selfSigned
      ? `Self-signed certificate on port ${ports} — IMAP/SMTP clients will refuse to connect (the web UI on 443 can still look fine).`
      : expired
        ? `Expired certificate on port ${ports}.`
        : nameBad
          ? `Certificate name doesn't match the mail host on port ${ports}.`
          : `Untrusted certificate on port ${ports} (${bad[0].authError ?? "chain not valid"}).`;
    // A self-signed or mismatched cert on a mail port is almost always a STALE one still held in
    // memory — reloading dovecot/postfix picks up the cert ACME already wrote to disk.
    return { status: "fail", reason, needsReload: selfSigned || nameBad };
  }

  const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000;
  const soon = reached.filter((p) => p.validToMs && p.validToMs - nowMs < FOURTEEN_DAYS);
  if (soon.length > 0)
    return {
      status: "warn",
      reason: `Certificate expires in under 14 days on port ${soon.map((p) => p.port).join(", ")}.`,
      needsReload: false,
    };
  return {
    status: "ok",
    reason: `Valid, trusted certificate on port ${reached.map((p) => p.port).join(", ")}.`,
    needsReload: false,
  };
}

// Blacklist verdict from the lists an IP was found on. Any MAJOR listing (Spamhaus/Barracuda/
// SpamCop) is deliverability-killing → fail; a SECONDARY-only listing is worth flagging → warn;
// none → ok. A lookup ERROR must be treated by the caller as "not listed", never a hit — a false
// blacklist positive is worse than a miss.
export function blacklistVerdict(
  hits: readonly string[],
  major: readonly string[],
): "ok" | "warn" | "fail" {
  if (hits.length === 0) return "ok";
  return hits.some((h) => major.includes(h)) ? "fail" : "warn";
}

// --- DNS record quality (mxtoolbox-style) ---

// Count the DNS-lookup-incurring terms in an SPF record (RFC 7208 caps these at 10 before a
// permerror): include, a, mx, ptr, exists, and the redirect modifier. `all`, `ip4`, `ip6` don't
// count.
export function spfLookupCount(record: string): number {
  let n = 0;
  for (const raw of record.trim().split(/\s+/)) {
    const t = raw.replace(/^[+\-~?]/, "").toLowerCase();
    if (/^(include:|exists:)/.test(t) || /^redirect=/.test(t)) n++;
    else if (/^(a|mx|ptr)(:|$)/.test(t)) n++;
  }
  return n;
}

// Verdict for a domain's SPF TXT records (the ones already filtered to v=spf1). 0 → fail (missing),
// >1 → fail (invalid), else warn on >10 lookups / permissive `all` / deprecated ptr, otherwise ok.
export function spfVerdict(spfRecords: string[]): { status: "ok" | "warn" | "fail"; reason: string } {
  if (spfRecords.length === 0) return { status: "fail", reason: "no SPF record" };
  if (spfRecords.length > 1)
    return { status: "fail", reason: `${spfRecords.length} SPF records — only one is valid` };
  const rec = spfRecords[0];
  const lookups = spfLookupCount(rec);
  if (lookups > 10)
    return { status: "warn", reason: `${lookups} DNS lookups (>10 causes an SPF permerror)` };
  const allQual = rec.match(/(?:^|\s)([+\-~?]?)all(?:\s|$)/i)?.[1] || "+";
  if (allQual === "+" || allQual === "?")
    return { status: "warn", reason: `ends in "${allQual}all" (too permissive — use ~all or -all)` };
  if (/(?:^|\s)[+\-~?]?ptr(?::|\s|$)/i.test(rec))
    return { status: "warn", reason: "uses the deprecated ptr mechanism" };
  return { status: "ok", reason: `${lookups} DNS lookups, ends in "${allQual}all"` };
}

// Verdict for a DMARC record. p=none is monitor-only (warn — not actually enforcing); quarantine/
// reject enforce (ok). Missing policy or record → fail.
export function dmarcPolicyVerdict(record: string): { status: "ok" | "warn" | "fail"; reason: string } {
  if (!/v=dmarc1/i.test(record)) return { status: "fail", reason: "no DMARC record" };
  const p = (record.match(/\bp\s*=\s*(none|quarantine|reject)/i)?.[1] ?? "").toLowerCase();
  if (!p) return { status: "fail", reason: "DMARC record has no policy (p=)" };
  const noRua = /\brua\s*=/i.test(record) ? "" : " (no rua= aggregate reports)";
  if (p === "none")
    return { status: "warn", reason: `p=none — monitoring only, not enforcing${noRua}` };
  return { status: "ok", reason: `p=${p}${noRua}` };
}

// Verdict for an MX target host. Must be a hostname (not an IP literal) that resolves to an address.
export function mxTargetVerdict(mxHost: string, hasAddress: boolean): { status: "ok" | "warn"; reason: string } {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(mxHost) || mxHost.includes(":"))
    return { status: "warn", reason: `MX points to an IP literal (${mxHost}) — should be a hostname` };
  if (!hasAddress) return { status: "warn", reason: `MX host ${mxHost} has no A/AAAA record` };
  return { status: "ok", reason: "" };
}

// --- SMTP dialogue (banner + EHLO capabilities) ---

// Parse the raw text of a `220 banner … EHLO … 250-CAP` SMTP exchange into the banner's advertised
// hostname and the uppercased EHLO capability list. Tolerant of \r\n and multiline 250- responses.
export function parseSmtpDialogue(raw: string): { bannerHost: string; caps: string[] } {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const banner = lines.find((l) => l.startsWith("220")) ?? "";
  // "220 mail.example.com ESMTP Postfix" → mail.example.com
  const bannerHost = banner.replace(/^220[ -]+/, "").split(/\s+/)[0] ?? "";
  const caps: string[] = [];
  for (const l of lines) {
    const m = l.match(/^250[ -]+(.+)$/);
    if (m) caps.push(m[1].trim().toUpperCase().split(/\s+/)[0]);
  }
  return { bannerHost, caps };
}

// Verdict for the SMTP banner + STARTTLS support read from localhost:25. `bannerHost` should be a
// FQDN (not localhost / a bare IP); STARTTLS should be offered.
export function smtpBannerVerdict(bannerHost: string): { status: "ok" | "warn"; reason: string } {
  if (!bannerHost) return { status: "warn", reason: "no SMTP banner" };
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bannerHost) || /^localhost$/i.test(bannerHost) || !bannerHost.includes("."))
    return { status: "warn", reason: `banner is "${bannerHost}" — should advertise a FQDN` };
  return { status: "ok", reason: `banner advertises ${bannerHost}` };
}

// The dominant deferral reason, for the remediation hint.
export function dominantDeferral(stats: QueueStats): "timeout" | "rejected" | "other" | null {
  const { timeout, rejected, other } = stats.deferrals;
  if (timeout === 0 && rejected === 0 && other === 0) return null;
  if (timeout >= rejected && timeout >= other) return "timeout";
  if (rejected >= other) return "rejected";
  return "other";
}
