import { NodeSSH } from "node-ssh";
import { domains } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { mailcowRequest } from "./mailcow-helpers";
import { SSHManager } from "@/lib/ssh";
import type { SSHAuth } from "@/types";
import { MAILCOW_SHELL_PRELUDE } from "./health-checks";
import type { ConsoleLog } from "./console-bus";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Domain = any;

// Is the Mailcow API reachable + authorized with the domain's current key?
// Returns false on 401 (wrong key), non-200, or an HTML/string body (proxied/unreachable).
export async function mailcowApiWorks(domain: Domain): Promise<boolean> {
  if (!domain?.mailcowHostname || !domain?.mailcowApiKey) return false;
  try {
    const res = await mailcowRequest(
      domain.mailcowHostname,
      domain.mailcowApiKey,
      "get/domain/all",
      undefined,
      {
        timeoutMs: 10000,
      },
    );
    return res.status === 200 && typeof res.json !== "string";
  } catch {
    return false;
  }
}

// Re-read the authoritative API key from the server's mailcow.conf and persist it. This fixes
// the "stored key drifted from the server" case (a re-provision regenerates the key, leaving the
// DB with a stale one -> every API call 401s). Returns the fresh key on success, else null.
export async function syncApiKeyFromServer(db: Db, domain: Domain): Promise<string | null> {
  const ipAddress = domain.ipAddress || domain.server?.ipAddress;
  const sshUser = domain.sshUser || domain.server?.sshUser;
  const sshPassword = domain.sshPassword || domain.server?.sshPassword;
  if (!ipAddress || !sshUser) return null;

  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: ipAddress,
      username: sshUser,
      password: sshPassword || undefined,
      readyTimeout: 20000,
    });
    const res = await ssh.execCommand(
      'grep "^API_KEY=" /opt/mailcow-dockerized/mailcow.conf | head -1 | cut -d= -f2',
    );
    const key = res.stdout.trim();
    if (!/^[a-f0-9]{64}$/i.test(key)) return null;
    await db.update(domains).set({ mailcowApiKey: key }).where(eq(domains.id, domain.id));
    return key;
  } catch {
    return null;
  } finally {
    ssh.dispose();
  }
}

// ------------------------------------------------------------------------------------------------
// Reading Mailcow's config off an EXTERNAL server (one we didn't provision)
// ------------------------------------------------------------------------------------------------
// A Mailcow API key lives in one of two places, and an external server could use either:
//   1. mailcow.conf as `API_KEY=` — stock Mailcow supports this, and it's what our own
//      provisioning writes (see queue.ts). Gated by `API_ALLOW_FROM`.
//   2. the `api` table in Mailcow's MySQL database — where the Mailcow UI stores keys it creates.
//      Each row carries its own `allow_from` / `skip_ip_check`.
// We read (1) then fall back to (2), so an ad-hoc troubleshoot can unlock the API-only checks
// (container health, DKIM key-match) without the user hunting for the key.

// Keys can be our 64-hex format OR Mailcow's UI format (e.g. "1A2B3-4C5D6-7E8F9-0A1B2-3C4D5").
// Deliberately looser than syncApiKeyFromServer's hex-only check, which is right for OUR servers.
export function isValidMailcowApiKey(key: string): boolean {
  const k = String(key ?? "").trim();
  return /^[A-Za-z0-9-]{10,120}$/.test(k);
}

// An IP allow-list that can't include us will make every API call fail, however valid the key.
// "auto" and a 0.0.0.0/0-style entry both mean "not restricted to specific IPs".
export function isApiAllowListPermissive(allowFrom: string | null): boolean {
  if (!allowFrom) return false;
  const v = allowFrom.toLowerCase();
  return v.includes("0.0.0.0/0") || v.includes("::/0") || v.includes("auto");
}

export interface MailcowServerConfig {
  hostname: string | null;
  apiKey: string | null;
  apiKeySource: "mailcow.conf" | "database" | null;
  apiAllowFrom: string | null;
  apiKeyRestricted: boolean; // an allow-list is set that may reject our requests
}

// Pull a marked section out of the probe script's output.
function section(out: string, name: string): string {
  const m = out.split(`---${name}---`)[1];
  if (m === undefined) return "";
  return m.split("---")[0].trim();
}

// Read MAILCOW_HOSTNAME (+ optionally the API key) from an external server over one SSH session.
// Every step is best-effort: a missing file, no DB container or a bad password just yields nulls.
export async function readMailcowConfigOverSsh(
  target: { ipAddress: string; sshUser: string; sshPassword: string },
  opts: { wantApiKey?: boolean; log?: ConsoleLog } = {},
): Promise<MailcowServerConfig> {
  const log = opts.log;
  const empty: MailcowServerConfig = {
    hostname: null,
    apiKey: null,
    apiKeySource: null,
    apiAllowFrom: null,
    apiKeyRestricted: false,
  };
  const auth: SSHAuth = { type: "password", password: target.sshPassword };
  const mgr = new SSHManager(target.ipAddress, 22, target.sshUser, auth);
  try {
    log?.info(`Connecting to ${target.sshUser}@${target.ipAddress}…`);
    await mgr.connect({ timeoutMs: 15000, maxRetries: 1 });

    // Query the `api` table only when we actually need a key and mailcow.conf didn't have one.
    // NOTE: the access-level column is `api_access` on some Mailcow versions and `access` on
    // others. Hardcoding `api_access` made this SELECT fail with "Unknown column" on those builds,
    // so no DB key was ever found and we silently fell back to mailcow.conf's legacy API_KEY —
    // which modern Mailcow ignores, making every API call return HTTP 200 `{}`. Detect the column.
    const dbLookup = opts.wantApiKey
      ? `DBROOT=$(grep -m1 '^DBROOT=' mailcow.conf 2>/dev/null | cut -d= -f2-); ` +
        `DBNAME=$(grep -m1 '^DBNAME=' mailcow.conf 2>/dev/null | cut -d= -f2-); ` +
        `[ -n "$DBNAME" ] || DBNAME=mailcow; ` +
        `MYC=$(docker ps -qf name=mysql-mailcow 2>/dev/null | head -1); ` +
        `if [ -n "$MYC" ] && [ -n "$DBROOT" ]; then ` +
        `ACOL=$(docker exec -i "$MYC" mysql -u root -p"$DBROOT" "$DBNAME" -N -B -e "SHOW COLUMNS FROM api LIKE 'api_access'" 2>/dev/null | awk 'NR==1{print $1}'); ` +
        `[ -n "$ACOL" ] || ACOL=access; ` +
        `docker exec -i "$MYC" mysql -u root -p"$DBROOT" "$DBNAME" -N -B -e ` +
        `"SELECT api_key, allow_from, skip_ip_check FROM api WHERE active=1 ORDER BY (\${ACOL}='rw') DESC LIMIT 1" 2>/dev/null; ` +
        `fi; `
      : "";

    const script =
      MAILCOW_SHELL_PRELUDE +
      `echo "---HOSTNAME---"; grep -m1 '^MAILCOW_HOSTNAME=' mailcow.conf 2>/dev/null | cut -d= -f2 | tr -d '\\r'; ` +
      (opts.wantApiKey
        ? `echo "---CONFKEY---"; grep -m1 '^API_KEY=' mailcow.conf 2>/dev/null | cut -d= -f2 | tr -d '\\r'; ` +
          `echo "---ALLOWFROM---"; grep -m1 '^API_ALLOW_FROM=' mailcow.conf 2>/dev/null | cut -d= -f2 | tr -d '\\r'; ` +
          `echo "---DBKEY---"; ${dbLookup}`
        : "") +
      `echo "---END---"; true`;

    log?.cmd("Reading mailcow.conf (mail host" + (opts.wantApiKey ? " + API key)" : ")"));
    const res = await mgr
      .executeCommand(script, { timeoutMs: 40000, onData: (c) => log?.out(c) })
      .catch(() => ({ stdout: "", stderr: "", exitCode: -1 }));
    const out = res.stdout;

    const hostname = section(out, "HOSTNAME").split("\n")[0]?.trim() || null;
    const result: MailcowServerConfig = {
      ...empty,
      hostname: hostname && /\./.test(hostname) ? hostname : null,
    };
    if (!opts.wantApiKey) return result;

    const confKey = section(out, "CONFKEY").split("\n")[0]?.trim() || "";
    const allowFrom = section(out, "ALLOWFROM").split("\n")[0]?.trim() || "";

    // 1. The `api` DATABASE table FIRST: "<key>\t<allow_from>\t<skip_ip_check>".
    //    This is the only place modern Mailcow looks. mailcow.conf's legacy API_KEY is ignored by
    //    current builds, so preferring it (as we used to) handed out a key that Mailcow rejected on
    //    every call — the HTTP 200 `{}` that blocked mailbox setup.
    const dbRow = section(out, "DBKEY")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && isValidMailcowApiKey(l.split("\t")[0] ?? ""));
    if (dbRow) {
      const [key, rowAllowFrom = "", skipIpCheck = "0"] = dbRow.split("\t");
      const skips = skipIpCheck.trim() === "1";
      return {
        ...result,
        apiKey: key.trim(),
        apiKeySource: "database",
        apiAllowFrom: rowAllowFrom.trim() || null,
        apiKeyRestricted:
          !skips && !!rowAllowFrom.trim() && !isApiAllowListPermissive(rowAllowFrom),
      };
    }

    // 2. Fall back to mailcow.conf's API_KEY (older builds / legacy setups), gated by API_ALLOW_FROM.
    if (isValidMailcowApiKey(confKey)) {
      return {
        ...result,
        apiKey: confKey,
        apiKeySource: "mailcow.conf",
        apiAllowFrom: allowFrom || null,
        apiKeyRestricted: !!allowFrom && !isApiAllowListPermissive(allowFrom),
      };
    }
    return result;
  } catch {
    return empty;
  } finally {
    await mgr.dispose().catch(() => {});
  }
}

// Ensure the domain has a WORKING Mailcow key before mailbox operations. If the current key
// fails, re-read it from the server and retry. Returns a domain object with the working key
// (possibly updated), or the original if it already worked / couldn't be repaired.
export async function ensureWorkingApiKey(
  db: Db,
  domain: Domain,
): Promise<{ domain: Domain; repaired: boolean }> {
  if (await mailcowApiWorks(domain)) return { domain, repaired: false };
  const fresh = await syncApiKeyFromServer(db, domain);
  if (fresh && fresh !== domain.mailcowApiKey) {
    const updated = { ...domain, mailcowApiKey: fresh };
    if (await mailcowApiWorks(updated)) return { domain: updated, repaired: true };
    return { domain: updated, repaired: true };
  }
  return { domain, repaired: false };
}
