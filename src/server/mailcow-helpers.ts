import https from "node:https";
import crypto from "node:crypto";
import { retryTransient } from "@/lib/retry";

// Quota sizing for Mailcow domains/mailboxes. IMPORTANT: Mailcow's add/domain fields are
// `mailboxes`, `quota` (domain TOTAL, MB), `maxquota` (max a single mailbox may have, MB),
// `defquota`. Constraint Mailcow enforces: maxquota <= quota.
export const QUOTA = {
  DOMAIN_MAX_MAILBOXES: 50,
  DOMAIN_QUOTA_MB: 51200, // 50 GB total per mail domain
  MAILBOX_MAX_QUOTA_MB: 10240, // a single mailbox may be up to 10 GB (<= domain)
  MAILBOX_QUOTA_MB: 1024, // default/created mailbox size: 1 GB (sending accounts)
} as const;

// Generate a strong mailbox password that satisfies any sane complexity policy:
// guaranteed >=2 each of upper/lower/digit/special, length 20, cryptographically random.
// (Math.random().toString(36) was weak/inconsistent — it could omit a character class
// entirely, which Mailcow rejected with "password_complexity".)
export function generateMailboxPassword(): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O (ambiguous)
  const lower = "abcdefghijkmnopqrstuvwxyz"; // no l
  const digits = "23456789"; // no 0/1
  const special = "!@#$%*-_=+";
  const all = upper + lower + digits + special;
  const pick = (set: string) => set[crypto.randomInt(set.length)];
  const chars = [
    pick(upper), pick(upper),
    pick(lower), pick(lower),
    pick(digits), pick(digits),
    pick(special), pick(special),
  ];
  while (chars.length < 20) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

// Call the Mailcow API. Mailcow serves a SELF-SIGNED TLS cert until ACME/Let's Encrypt
// obtains a real one (always the case during a fresh-provision window, and whenever
// ACME is rate-limited or failing). Node's global fetch rejects self-signed certs, which
// silently broke every API call. We connect to the user's OWN server, so we skip TLS
// verification here only — Cloudflare calls elsewhere stay strict. Uses node:https to
// avoid adding an undici dependency that might behave differently when bundled.
export function mailcowRequest(
  host: string,
  apiKey: string,
  path: string,
  body?: unknown,
  opts?: { timeoutMs?: number },
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const timeoutMs = opts?.timeoutMs ?? 20000;
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    let settled = false;
    const req = https.request(
      {
        host,
        port: 443,
        path: `/api/v1/${path}`,
        method: body !== undefined ? "POST" : "GET",
        headers: {
          "X-API-Key": apiKey,
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
        rejectUnauthorized: false, // Mailcow self-signed cert — own server
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (settled) return;
          settled = true;
          clearTimeout(hardTimer);
          let json: unknown;
          try {
            json = JSON.parse(data);
          } catch {
            json = data;
          }
          const status = res.statusCode || 0;
          resolve({ ok: status >= 200 && status < 300, status, json });
        });
      },
    );
    // Hard backstop: a Cloudflare-proxied host can keep a socket alive so the inactivity
    // `timeout` never fires. This timer destroys the request no matter what.
    const hardTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy(new Error(`Mailcow request to ${host} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      reject(err);
    });
    req.on("timeout", () => req.destroy(new Error("Mailcow request timed out")));
    if (payload) req.write(payload);
    req.end();
  });
}

// An HTTP status worth retrying: a transport failure (0, surfaced as a throw), rate limiting
// (429), or a server-side error (5xx) from a warming-up / overloaded Mailcow. A 2xx or a
// deterministic 4xx is NOT retried — those reflect the request, not a transient hiccup.
export function isTransientHttp(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

// Like mailcowRequest but retries TRANSIENT failures (thrown network/timeout errors, 429, 5xx)
// with backoff. Use this for WRITES (add/edit/delete) during bulk provisioning so a single
// transient hiccup doesn't drop a domain/mailbox and force a manual re-run. A 200 response with a
// "danger" body (e.g. object_exists) is deterministic and returned as-is — never retried.
export function mailcowRequestRetry(
  host: string,
  apiKey: string,
  path: string,
  body?: unknown,
  opts?: { attempts?: number; timeoutMs?: number },
): Promise<{ ok: boolean; status: number; json: unknown }> {
  return retryTransient(
    () => mailcowRequest(host, apiKey, path, body, { timeoutMs: opts?.timeoutMs ?? 20000 }),
    (res) => isTransientHttp(res.status),
    { attempts: opts?.attempts ?? 3, base: 600 },
  );
}

// Read a Mailcow "get all" list endpoint (get/mailbox/all, get/domain/all) resiliently.
//
// During the fresh-provision window the API is briefly flaky — self-signed cert, cold
// nginx/php-fpm, ACME churn — so a single call can time out, reset the connection, or return a
// non-array (an HTML error page). These endpoints are READ-ONLY and idempotent, so we retry with
// backoff until we get a real array.
//
// Returns null when no valid array response ever came back. Callers MUST treat null as
// "verification unavailable" (leave state untouched), NEVER as "the list is empty" — the latter
// is what caused successfully-created mailboxes to be marked `failed` on a transient hiccup.
export async function mailcowListAll(
  host: string,
  apiKey: string,
  path: string,
  opts?: { attempts?: number; timeoutMs?: number },
): Promise<any[] | null> {
  const attempts = opts?.attempts ?? 4;
  const timeoutMs = opts?.timeoutMs ?? 20000;
  for (let i = 0; i < attempts; i++) {
    try {
      const { json } = await mailcowRequest(host, apiKey, path, undefined, { timeoutMs });
      if (Array.isArray(json)) return json;
    } catch {
      // transient (timeout / connection reset) — fall through to backoff and retry
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }
  return null;
}

// Mailcow's API returns HTTP 200 even when an operation fails; the real outcome is
// in the JSON body as an array of { type: "success" | "danger" | "error" | ... }.
// Treat a call as successful only when HTTP is OK, the body reports at least one
// "success", and no "danger"/"error" entries.
export function parseMailcowResult(
  resOk: boolean,
  json: unknown,
): { success: boolean; error?: string } {
  if (!resOk) return { success: false, error: "HTTP request to Mailcow failed" };
  const entries = Array.isArray(json) ? json : [json];
  let sawSuccess = false;
  const errors: string[] = [];
  for (const entry of entries) {
    const type = entry && typeof entry === "object" ? (entry as any).type : undefined;
    if (type === "success") sawSuccess = true;
    else if (type === "danger" || type === "error") {
      const msg = (entry as any).msg;
      errors.push(typeof msg === "string" ? msg : JSON.stringify(msg ?? entry));
    }
  }
  if (errors.length > 0) return { success: false, error: errors.join("; ") };
  if (!sawSuccess) return { success: false, error: "Mailcow did not confirm success" };
  return { success: true };
}

// Cloudflare requires TXT record content wrapped in quotation marks; sending it
// unquoted works but triggers a dashboard warning. Wrap TXT content in quotes
// (escaping any internal quote) unless it's already quoted. Non-TXT is untouched.
export function cfTxtContent(type: string, content: string): string {
  if (type !== "TXT") return content;
  const trimmed = (content ?? "").trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) return trimmed;
  return `"${trimmed.replace(/"/g, '\\"')}"`;
}

// A DNS record as persisted in our `dns_records` table (the fields the Cloudflare push needs).
export interface CfPushRecord {
  type: string;
  name: string;
  content: string;
  ttl?: number | null;
  priority?: number | null;
  proxied?: boolean | null;
}

// Build the Cloudflare `POST /dns_records` body for one record.
//
// A/AAAA/CNAME/MX/TXT use the flat `content` field. SRV and TLSA are STRUCTURED record types:
// Cloudflare rejects them when sent as `content` ("weight is a required data field" / "usage is
// a required data field") and instead requires a `data` object. We store their fields packed
// into `content` (+ a separate `priority` for SRV) and unpack them here.
//
//   SRV  content = "<weight> <port> <target>", priority stored separately
//   TLSA content = "<usage> <selector> <matching_type> <certificate>"
export function buildCfRecordBody(
  record: CfPushRecord,
  fullName: string,
  domainName: string,
): Record<string, unknown> {
  const ttl = record.ttl || 1;

  if (record.type === "SRV") {
    const [weight, port, target] = String(record.content).trim().split(/\s+/);
    // record.name is e.g. "_autodiscover._tcp" (apex) or "_autodiscover._tcp.enterprise".
    const labels = record.name.split(".");
    const service = labels[0];
    const proto = labels[1];
    const hostLabels = labels.slice(2);
    const srvName = hostLabels.length ? `${hostLabels.join(".")}.${domainName}` : domainName;
    return {
      type: "SRV",
      name: fullName,
      ttl,
      data: {
        service,
        proto,
        name: srvName,
        priority: record.priority ?? 0,
        weight: Number(weight) || 0,
        port: Number(port) || 0,
        target: target ?? "",
      },
    };
  }

  if (record.type === "TLSA") {
    const [usage, selector, matchingType, ...cert] = String(record.content).trim().split(/\s+/);
    return {
      type: "TLSA",
      name: fullName,
      ttl,
      data: {
        usage: Number(usage) || 0,
        selector: Number(selector) || 0,
        matching_type: Number(matchingType) || 0,
        certificate: cert.join(""),
      },
    };
  }

  const body: Record<string, unknown> = {
    type: record.type,
    name: fullName,
    content: cfTxtContent(record.type, record.content),
    ttl,
    proxied: record.proxied || false,
  };
  if (record.priority !== null && record.priority !== undefined) body.priority = record.priority;
  return body;
}

// Find an already-present Cloudflare record matching one we're about to push (for idempotency).
// Matches by type + name; when several records share a name (e.g. multiple TXT), the one whose
// content matches wins so we adopt the right record id.
export function findMatchingCfRecord(
  existing: { id: string; type: string; name: string; content: string }[],
  type: string,
  fullName: string,
  content: string,
): { id: string } | null {
  const lname = fullName.toLowerCase();
  const same = existing.filter((r) => r.type === type && r.name.toLowerCase() === lname);
  if (same.length === 0) return null;
  if (same.length === 1) return same[0];
  const norm = (s: string) => String(s ?? "").replace(/^"|"$/g, "").trim().toLowerCase();
  return same.find((r) => norm(r.content) === norm(content)) ?? same[0];
}

// A create failed only because the desired record (or an equivalent host record) already exists
// — the target state is satisfied, so we treat it as success rather than a hard failure.
export function isCfAlreadyExistsError(message: string): boolean {
  const m = (message ?? "").toLowerCase();
  return (
    m.includes("identical record already exists") ||
    m.includes("record with that host already exists")
  );
}
