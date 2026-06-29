import https from "node:https";
import crypto from "node:crypto";

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
