import { NodeSSH } from "node-ssh";
import { domains } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { mailcowRequest } from "./mailcow-helpers";

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
