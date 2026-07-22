import https from "node:https";
import crypto from "node:crypto";
import { retryTransient } from "@/lib/retry";
import { MAILCOW_SHELL_PRELUDE } from "./health-checks";

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
// SSH creds for running an API call FROM the server (see mailcowRequestViaSsh).
export interface MailcowSshTarget {
  ipAddress: string;
  sshUser: string;
  sshPassword: string;
}

export function mailcowRequest(
  host: string,
  apiKey: string,
  path: string,
  body?: unknown,
  opts?: { timeoutMs?: number; ssh?: MailcowSshTarget },
): Promise<{ ok: boolean; status: number; json: unknown }> {
  // When an SSH target is supplied, run the call FROM the server (curl to localhost) instead of
  // directly: the request's source is then 127.0.0.1, which is always in Mailcow's API_ALLOW_FROM,
  // so a serverless app whose HTTPS egress IP rotates / isn't allow-listed still reaches the API.
  if (opts?.ssh)
    return mailcowRequestViaSsh(opts.ssh, host, apiKey, path, body, { timeoutMs: opts.timeoutMs });
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

// Run a Mailcow API call FROM the server over SSH (curl to localhost). Source = 127.0.0.1, which is
// always in API_ALLOW_FROM, so this works no matter what the app's own egress IP is — the fix for a
// serverless host whose HTTPS IP rotates and isn't allow-listed. Same {ok,status,json} shape as the
// direct client. Dynamic-imports @/lib/ssh so the native ssh2 binding never enters the client bundle
// (this module is pulled into client graphs via pipeline → health-fixes; see sshRun in server-fixes).
export async function mailcowRequestViaSsh(
  ssh: MailcowSshTarget,
  host: string,
  apiKey: string,
  path: string,
  body?: unknown,
  opts?: { timeoutMs?: number },
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const timeoutMs = opts?.timeoutMs ?? 20000;
  const { SSHManager } = await import("@/lib/ssh");
  const mgr = new SSHManager(ssh.ipAddress, 22, ssh.sshUser, {
    type: "password",
    password: ssh.sshPassword,
  });
  try {
    await mgr.connect({ timeoutMs: 15000, maxRetries: 1 });
    const method = body !== undefined ? "POST" : "GET";
    const curlSecs = Math.max(5, Math.round(timeoutMs / 1000));
    // --resolve pins the mail host to 127.0.0.1: keeps the real Host header for nginx while making
    // the source localhost. -w appends the status on its own line so we can split body/status.
    const dataFlag = body !== undefined ? "--data-binary @- " : "";
    // --resolve pins the host to loopback (source = the box itself). We also set X-Forwarded-For to
    // 127.0.0.1: on a Dockerised Mailcow the request reaches nginx from the docker bridge gateway,
    // so if API_ALLOW_FROM was narrowed to just 127.0.0.1 the raw source could be rejected — forcing
    // XFF to loopback (which is always allow-listed) makes the tunnel reliable. We're on the trusted
    // server, so asserting loopback here is legitimate.
    const curl =
      `curl -sk --max-time ${curlSecs} --resolve ${host}:443:127.0.0.1 ` +
      `-X ${method} -H "X-API-Key: ${apiKey}" -H "X-Forwarded-For: 127.0.0.1" ` +
      `-H "Content-Type: application/json" ${dataFlag}` +
      `-w '\\n__MCHTTP__%{http_code}' "https://${host}/api/v1/${path}"`;
    // Feed the JSON body via a single-quoted heredoc so the shell doesn't touch it.
    const cmd =
      body !== undefined
        ? `cat <<'__MCJSON__' | ${curl}\n${JSON.stringify(body)}\n__MCJSON__`
        : curl;
    const res = await mgr.executeCommand(cmd, { timeoutMs: timeoutMs + 8000 });
    const out = String(res.stdout ?? "");
    const m = out.match(/__MCHTTP__(\d{3})\s*$/);
    const status = m ? Number(m[1]) : 0;
    const bodyText = (m ? out.slice(0, m.index) : out).trim();
    let json: unknown = bodyText;
    try {
      json = JSON.parse(bodyText);
    } catch {
      /* non-JSON (HTML/empty) stays a string */
    }
    return { ok: status >= 200 && status < 300, status, json };
  } finally {
    await mgr.dispose().catch(() => {});
  }
}

// Ensure Mailcow's API_ALLOW_FROM permits calls FROM the server itself. A tunnelled API call (curl
// to localhost) reaches Mailcow's nginx from the docker bridge gateway, so if fixCreateApiKey
// narrowed API_ALLOW_FROM to just 127.0.0.1,<ssh-ip> the call is rejected (HTTP 200 {}). We add
// loopback + the PRIVATE/Docker ranges only — never the public internet — then reload Mailcow if it
// changed. Idempotent. Returns what it found/did.
export async function mailcowEnsureApiAllowList(
  ssh: MailcowSshTarget,
): Promise<{ ok: boolean; allow: string; reloaded: boolean; detail: string }> {
  const { SSHManager } = await import("@/lib/ssh");
  const script =
    MAILCOW_SHELL_PRELUDE +
    "\n" +
    [
      '[ -f mailcow.conf ] || { echo "NO_CONF"; exit 0; }',
      'CUR=$(grep -m1 "^API_ALLOW_FROM=" mailcow.conf 2>/dev/null | cut -d= -f2 | tr -d "\\r")',
      'NEW="$CUR"; CHANGED=0',
      "for e in 127.0.0.1 ::1 172.16.0.0/12 10.0.0.0/8 192.168.0.0/16; do",
      '  case ",$NEW," in *",$e,"*) ;; *) NEW="${NEW:+$NEW,}$e"; CHANGED=1 ;; esac',
      "done",
      'if [ -z "$CUR" ]; then echo "API_ALLOW_FROM=${NEW}" >> mailcow.conf; CHANGED=1;',
      'elif [ "$CHANGED" = "1" ]; then sed -i "s|^API_ALLOW_FROM=.*|API_ALLOW_FROM=${NEW}|" mailcow.conf; fi',
      'echo "ALLOW=${NEW}"',
      'if [ "$CHANGED" = "1" ]; then $DC up -d 2>&1 | tail -2; echo "RELOADED=yes"; else echo "RELOADED=no"; fi',
    ].join("\n");
  const mgr = new SSHManager(ssh.ipAddress, 22, ssh.sshUser, {
    type: "password",
    password: ssh.sshPassword,
  });
  try {
    await mgr.connect({ timeoutMs: 15000, maxRetries: 1 });
    const res = await mgr.executeCommand(script, { timeoutMs: 240000 });
    const out = `${res.stdout}\n${res.stderr}`;
    if (out.includes("NO_CONF"))
      return { ok: false, allow: "", reloaded: false, detail: "No mailcow.conf found on the server." };
    const allow = (out.match(/ALLOW=(.*)/)?.[1] ?? "").trim();
    const reloaded = /RELOADED=yes/.test(out);
    return {
      ok: true,
      allow,
      reloaded,
      detail: reloaded
        ? `Broadened API_ALLOW_FROM to include private ranges (${allow}) and reloaded Mailcow.`
        : `API_ALLOW_FROM already permits internal calls (${allow}).`,
    };
  } finally {
    await mgr.dispose().catch(() => {});
  }
}

// Read the ACTIVE API key straight out of Mailcow's `api` database table — the key Mailcow actually
// honours. mailcow.conf's legacy `API_KEY=` can shadow it (fixCreateApiKey writes a synthetic one),
// and modern Mailcow ignores that conf key, answering every call with HTTP 200 `{}`. When the API
// rejects us, this gets the real key so we can recover instead of failing the whole provision.
export async function mailcowFetchDbApiKey(ssh: MailcowSshTarget): Promise<string | null> {
  const { SSHManager } = await import("@/lib/ssh");
  const script =
    MAILCOW_SHELL_PRELUDE +
    "\n" +
    [
      '[ -f mailcow.conf ] || { echo "NO_CONF"; exit 0; }',
      "DBROOT=$(grep -m1 '^DBROOT=' mailcow.conf 2>/dev/null | cut -d= -f2 | tr -d '\\r')",
      "DBNAME=$(grep -m1 '^DBNAME=' mailcow.conf 2>/dev/null | cut -d= -f2 | tr -d '\\r')",
      '[ -n "$DBNAME" ] || DBNAME=mailcow',
      "MYC=$(docker ps -qf name=mysql-mailcow 2>/dev/null | head -1)",
      'if [ -n "$MYC" ] && [ -n "$DBROOT" ]; then',
      '  echo "---KEY---"',
      '  docker exec -i "$MYC" mysql -u root -p"$DBROOT" "$DBNAME" -N -B -e ' +
        '"SELECT api_key FROM api WHERE active=1 ORDER BY (api_access=\'rw\') DESC LIMIT 1" 2>/dev/null',
      "fi",
    ].join("\n");
  const mgr = new SSHManager(ssh.ipAddress, 22, ssh.sshUser, {
    type: "password",
    password: ssh.sshPassword,
  });
  try {
    await mgr.connect({ timeoutMs: 15000, maxRetries: 1 });
    const res = await mgr.executeCommand(script, { timeoutMs: 60000 });
    const out = String(res.stdout ?? "");
    const after = out.split("---KEY---")[1] ?? "";
    const key = after
      .split("\n")
      .map((l) => l.trim())
      .find((l) => /^[a-fA-F0-9-]{20,}$/.test(l));
    return key ?? null;
  } finally {
    await mgr.dispose().catch(() => {});
  }
}

// Create a REAL Mailcow API key in its `api` database table (the only place modern Mailcow looks)
// when the server has none. Read-write, active, and skip_ip_check=1 so it works from any source —
// which also removes the whole allow-list class of failure. Verifies by reading the row back.
// Returns the new key, or null if we couldn't create one (no mysql container / no DB root).
export async function mailcowCreateDbApiKey(
  ssh: MailcowSshTarget,
): Promise<{ key: string | null; diag: string }> {
  // Mailcow-style key: 6 groups of 5 uppercase alphanumerics. Matches isValidMailcowApiKey.
  const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const group = () =>
    Array.from({ length: 5 }, () => ALPHA[crypto.randomInt(ALPHA.length)]).join("");
  const key = Array.from({ length: 6 }, group).join("-");

  const { SSHManager } = await import("@/lib/ssh");
  // stderr is NOT suppressed: a silent mysql failure (bad DBROOT, missing table) is precisely what
  // left us guessing. Report it so the cause names itself.
  const sql = (q: string) =>
    `docker exec -i "$MYC" mysql -u root -p"$DBROOT" "$DBNAME" -N -B -e "${q}" 2>&1 | head -25`;
  const script =
    MAILCOW_SHELL_PRELUDE +
    "\n" +
    [
      '[ -f mailcow.conf ] || { echo "NO_CONF"; exit 0; }',
      // -f2- (not -f2) so a value containing '=' isn't truncated.
      "DBROOT=$(grep -m1 '^DBROOT=' mailcow.conf 2>/dev/null | cut -d= -f2- | tr -d '\\r')",
      "DBNAME=$(grep -m1 '^DBNAME=' mailcow.conf 2>/dev/null | cut -d= -f2- | tr -d '\\r')",
      '[ -n "$DBNAME" ] || DBNAME=mailcow',
      "MYC=$(docker ps -qf name=mysql-mailcow 2>/dev/null | head -1)",
      // Report inputs (password LENGTH only, never the value) so a bad read is visible.
      'echo "DBROOT_LEN=${#DBROOT}"; echo "DBNAME=${DBNAME}"; echo "MYC=${MYC:-none}"',
      '[ -n "$MYC" ] && [ -n "$DBROOT" ] || { echo "NO_DB"; exit 0; }',
      // The real `api` table schema, so a column mismatch is visible instead of inferred.
      'echo "---COLS---"',
      sql("SHOW COLUMNS FROM api"),
      'echo "---SQL---"',
      // Plain INSERT (never IGNORE — that hides the very error we need).
      sql(
        `INSERT INTO api (api_key, allow_from, skip_ip_check, api_access, active) VALUES ('${key}','0.0.0.0/0',1,'rw',1)`,
      ),
      'echo "---VERIFY---"',
      sql(`SELECT api_key FROM api WHERE api_key='${key}'`),
    ].join("\n");

  const mgr = new SSHManager(ssh.ipAddress, 22, ssh.sshUser, {
    type: "password",
    password: ssh.sshPassword,
  });
  try {
    await mgr.connect({ timeoutMs: 15000, maxRetries: 1 });
    const res = await mgr.executeCommand(script, { timeoutMs: 60000 });
    const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
    const verified = (out.split("---VERIFY---")[1] ?? "").includes(key);
    // Compact, secret-free diagnostic: input presence + whatever mysql actually said.
    const dbrootLen = out.match(/DBROOT_LEN=(\d+)/)?.[1] ?? "?";
    const myc = out.match(/MYC=(.*)/)?.[1]?.trim() ?? "?";
    const cols = (out.split("---COLS---")[1] ?? "").split("---SQL---")[0] ?? "";
    const sqlOut = (out.split("---SQL---")[1] ?? "").split("---VERIFY---")[0] ?? "";
    const clean = (s: string) => s.replace(/-{5,}/g, " ").replace(/\s+/g, " ").trim();
    const diag = out.includes("NO_DB")
      ? `couldn't reach the DB (DBROOT length ${dbrootLen}, mysql container ${myc})`
      : `DBROOT len ${dbrootLen}, mysql ${myc}. api table columns: [${clean(cols).slice(0, 300) || "none — table missing?"}]. INSERT said: ${clean(sqlOut).slice(0, 300) || "(no output)"}`;
    return { key: verified ? key : null, diag };
  } finally {
    await mgr.dispose().catch(() => {});
  }
}

// Bring the Mailcow stack up, and report what's actually running.
//
// THIS is the failure that masquerades as everything else: Mailcow validates every API key against
// its MySQL container. If mysql-mailcow is down, the API answers HTTP 200 `{}` for EVERY key — which
// is indistinguishable from "bad key" or "IP not allow-listed". nginx can still be up and serving
// 443, so the host looks healthy from outside. Starting the stack is the real fix.
export async function mailcowBringUpStack(
  ssh: MailcowSshTarget,
): Promise<{ ok: boolean; running: number; mysqlUp: boolean; detail: string }> {
  const { SSHManager } = await import("@/lib/ssh");
  const script =
    MAILCOW_SHELL_PRELUDE +
    "\n" +
    [
      'echo "MCDIR=$(pwd)"',
      'echo "DOCKER=$(command -v docker || echo MISSING)"',
      '[ -f mailcow.conf ] || { echo "NO_CONF"; exit 0; }',
      'command -v docker >/dev/null 2>&1 || { echo "NO_DOCKER"; exit 0; }',
      'BEFORE=$(docker ps -q --filter name=mailcow 2>/dev/null | wc -l | tr -d " ")',
      '$DC up -d 2>&1 | tail -5',
      "sleep 12",
      'AFTER=$(docker ps -q --filter name=mailcow 2>/dev/null | wc -l | tr -d " ")',
      'MYC=$(docker ps -qf name=mysql-mailcow 2>/dev/null | head -1)',
      'echo "BEFORE=${BEFORE}"; echo "AFTER=${AFTER}"; echo "MYSQL=${MYC:-none}"',
      // Names of what IS running, so a naming mismatch is visible rather than read as "down".
      'echo "NAMES=$(docker ps --format \'{{.Names}}\' 2>/dev/null | head -12 | tr \'\\n\' \' \')"',
    ].join("\n");
  const mgr = new SSHManager(ssh.ipAddress, 22, ssh.sshUser, {
    type: "password",
    password: ssh.sshPassword,
  });
  try {
    await mgr.connect({ timeoutMs: 15000, maxRetries: 1 });
    const res = await mgr.executeCommand(script, { timeoutMs: 300000 });
    const out = `${res.stdout}\n${res.stderr}`;
    const where = out.match(/MCDIR=(.*)/)?.[1]?.trim() ?? "?";
    const dockerPath = out.match(/DOCKER=(.*)/)?.[1]?.trim() ?? "?";
    if (out.includes("NO_CONF"))
      return { ok: false, running: 0, mysqlUp: false, detail: `No mailcow.conf found (looked in ${where}).` };
    if (out.includes("NO_DOCKER"))
      return {
        ok: false,
        running: 0,
        mysqlUp: false,
        detail: `docker is NOT on PATH for the SSH session (${dockerPath}) — can't inspect or start Mailcow.`,
      };
    const before = Number(out.match(/BEFORE=(\d+)/)?.[1] ?? 0);
    const running = Number(out.match(/AFTER=(\d+)/)?.[1] ?? 0);
    const mysqlUp = !/MYSQL=none/.test(out) && /MYSQL=\w/.test(out);
    const names = out.match(/NAMES=(.*)/)?.[1]?.trim() ?? "";
    return {
      ok: true,
      running,
      mysqlUp,
      detail:
        `Mailcow at ${where}: ${before} containers before, ${running} after 'compose up -d'; mysql ${mysqlUp ? "UP" : "still DOWN"}.` +
        (names ? ` Running: ${names.slice(0, 200)}` : " No containers running."),
    };
  } finally {
    await mgr.dispose().catch(() => {});
  }
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
  opts?: { attempts?: number; timeoutMs?: number; ssh?: MailcowSshTarget },
): Promise<{ ok: boolean; status: number; json: unknown }> {
  return retryTransient(
    () => mailcowRequest(host, apiKey, path, body, { timeoutMs: opts?.timeoutMs ?? 20000, ssh: opts?.ssh }),
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
  opts?: { attempts?: number; timeoutMs?: number; ssh?: MailcowSshTarget },
): Promise<any[] | null> {
  const attempts = opts?.attempts ?? 4;
  const timeoutMs = opts?.timeoutMs ?? 20000;
  for (let i = 0; i < attempts; i++) {
    try {
      const { json } = await mailcowRequest(host, apiKey, path, undefined, { timeoutMs, ssh: opts?.ssh });
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
