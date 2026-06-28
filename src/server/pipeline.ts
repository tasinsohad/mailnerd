// Shared, idempotent provisioning pipeline. Each step checks live state first and skips
// work already done, so a retry resumes cleanly instead of redoing slow steps (e.g. the
// 20-minute Mailcow image pull). Both the BullMQ worker and the manual per-step buttons
// call these same functions, so there is exactly one code path.

import { eq, and } from "drizzle-orm";
import { plannedInboxes, dnsRecords, userSecrets } from "@/lib/db/schema";
import {
  mailcowRequest,
  parseMailcowResult,
  generateMailboxPassword,
  cfTxtContent,
  QUOTA,
} from "./mailcow-helpers";
import { resolveAndSaveCfZoneId } from "./cloudflare";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Domain = any;
export type MailcowResultRow = { type: string; name: string; success: boolean; error?: string | null };

export type StepName =
  | "pushDns"
  | "provision"
  | "ensureMailDomains"
  | "createMailboxes"
  | "syncDkim"
  | "verify";

export type StepState = "pending" | "running" | "ok" | "failed";

export interface PipelineProgress {
  currentStep: StepName | null;
  steps: Partial<Record<StepName, StepState>>;
  error: string | null;
  updatedAt: string;
}

export const ALL_STEPS: StepName[] = [
  "pushDns",
  "provision",
  "ensureMailDomains",
  "createMailboxes",
  "syncDkim",
  "verify",
];

// Merge a progress patch onto the previous progress without dropping already-set steps.
// `error` is only changed when the patch explicitly includes an `error` key.
export function mergeProgress(
  prev: PipelineProgress | null,
  patch: Partial<PipelineProgress>,
): PipelineProgress {
  return {
    currentStep: patch.currentStep ?? prev?.currentStep ?? null,
    steps: { ...(prev?.steps ?? {}), ...(patch.steps ?? {}) },
    error: "error" in patch ? (patch.error ?? null) : (prev?.error ?? null),
    updatedAt: new Date().toISOString(),
  };
}

// --- Step: ensure each planned subdomain exists in Mailcow as a mail domain with adequate
// quota. Idempotent: add/domain creates if missing; if it already exists, edit/domain
// repairs its limits. Truth comes from get/domain/all, never the POST result. ---
export async function ensureMailDomains(
  db: Db,
  domain: Domain,
): Promise<{ existingDomains: Set<string>; results: MailcowResultRow[] }> {
  const mc = (path: string, body?: unknown) =>
    mailcowRequest(domain.mailcowHostname, domain.mailcowApiKey, path, body);

  // Fail fast if the Mailcow API isn't reachable. A Cloudflare-PROXIED mail host (orange
  // cloud) intercepts the API and returns HTML / hangs, which would otherwise make us hang
  // on dozens of add/* calls. The mail host MUST be DNS-only. A valid empty Mailcow returns
  // {} (object) or [] with HTTP 200; HTML (string) or non-200/timeout means unreachable.
  const probe = await mailcowRequest(
    domain.mailcowHostname,
    domain.mailcowApiKey,
    "get/domain/all",
    undefined,
    { timeoutMs: 12000 },
  ).catch((e) => ({ ok: false, status: 0, json: String(e) }));
  if (probe.status !== 200 || typeof probe.json === "string") {
    throw new Error(
      `Mailcow API not reachable at ${domain.mailcowHostname} (status ${probe.status}). ` +
        `Is the mail host Cloudflare-proxied? mail.<domain> must be DNS-only (grey cloud).`,
    );
  }
  const inboxes = await db.select().from(plannedInboxes).where(eq(plannedInboxes.domainId, domain.id));
  const uniqueSubdomains = Array.from(new Set(inboxes.map((i: any) => String(i.subdomainFqdn))));
  const { DOMAIN_MAX_MAILBOXES, DOMAIN_QUOTA_MB, MAILBOX_MAX_QUOTA_MB, MAILBOX_QUOTA_MB } = QUOTA;

  const addDomainErrors: Record<string, string> = {};
  for (const sub of uniqueSubdomains) {
    try {
      const addRes = await mc("add/domain", {
        domain: sub,
        active: 1,
        mailboxes: DOMAIN_MAX_MAILBOXES,
        defquota: MAILBOX_QUOTA_MB,
        maxquota: MAILBOX_MAX_QUOTA_MB,
        quota: DOMAIN_QUOTA_MB,
      });
      const addOutcome = parseMailcowResult(addRes.ok, addRes.json);
      if (!addOutcome.success) {
        if (addOutcome.error) addDomainErrors[String(sub)] = addOutcome.error;
        await mc("edit/domain", {
          items: [sub],
          attr: { mailboxes: DOMAIN_MAX_MAILBOXES, maxquota: MAILBOX_MAX_QUOTA_MB, quota: DOMAIN_QUOTA_MB },
        });
      }
    } catch {
      // Verified against get/domain/all below - POST result is not trusted.
    }
  }

  const existingDomains = new Set<string>();
  try {
    const { json } = await mc("get/domain/all");
    if (Array.isArray(json)) {
      for (const d of json) if (d?.domain_name) existingDomains.add(String(d.domain_name).toLowerCase());
    }
  } catch {
    // leave empty -> domains reported as missing below
  }

  const results: MailcowResultRow[] = uniqueSubdomains.map((sub) => {
    const ok = existingDomains.has(String(sub).toLowerCase());
    return {
      type: "domain",
      name: String(sub),
      success: ok,
      error: ok
        ? null
        : `add/domain rejected${addDomainErrors[String(sub)] ? `: ${addDomainErrors[String(sub)]}` : ""}`,
    };
  });
  return { existingDomains, results };
}

// --- Step: create the planned mailboxes. Idempotent + verified: only stores a password
// for mailboxes created this run; final status comes from get/mailbox/all. `recreate`
// deletes existing mailboxes first (keeping the domain + DKIM) for a clean slate. ---
export async function createMailboxes(
  db: Db,
  domain: Domain,
  existingDomains: Set<string>,
  opts?: { recreate?: boolean },
): Promise<{ results: MailcowResultRow[]; summary: { total: number; created: number; failed: number } }> {
  const mc = (path: string, body?: unknown) =>
    mailcowRequest(domain.mailcowHostname, domain.mailcowApiKey, path, body);
  const inboxes = await db.select().from(plannedInboxes).where(eq(plannedInboxes.domainId, domain.id));
  const { MAILBOX_QUOTA_MB } = QUOTA;
  const results: MailcowResultRow[] = [];

  if (opts?.recreate && inboxes.length) {
    try {
      await mc("delete/mailbox", inboxes.map((ib: any) => ib.email));
    } catch {
      // best effort; verification below reflects real state
    }
    await db
      .update(plannedInboxes)
      .set({ status: "planned", password: null })
      .where(eq(plannedInboxes.domainId, domain.id));
  }

  const passwordByEmail: Record<string, string> = {};
  const createdThisRun = new Set<string>();
  for (const ib of inboxes) {
    const key = String(ib.email).toLowerCase();
    if (!existingDomains.has(String(ib.subdomainFqdn).toLowerCase())) {
      results.push({
        type: "mailbox",
        name: ib.email,
        success: false,
        error: `Parent mail domain ${ib.subdomainFqdn} is missing in Mailcow`,
      });
      continue;
    }
    try {
      const pw = generateMailboxPassword();
      passwordByEmail[key] = pw;
      const r = await mc("add/mailbox", {
        local_part: ib.localPart,
        domain: ib.subdomainFqdn,
        name: ib.personName,
        password: pw,
        password2: pw, // Mailcow requires the confirmation field; empty -> "password_complexity"
        quota: MAILBOX_QUOTA_MB,
        active: 1,
      });
      const outcome = parseMailcowResult(r.ok, r.json);
      if (outcome.success) createdThisRun.add(key);
      results.push({ type: "mailbox", name: ib.email, success: outcome.success, error: outcome.error ?? null });
    } catch (err) {
      results.push({ type: "mailbox", name: ib.email, success: false, error: String(err) });
    }
  }

  // Verify against the source of truth and persist passwords only for ones created now.
  const existingMailboxes = new Set<string>();
  try {
    const { json } = await mc("get/mailbox/all");
    if (Array.isArray(json)) {
      for (const m of json) if (m?.username) existingMailboxes.add(String(m.username).toLowerCase());
    }
  } catch {
    // leave empty -> everything reported as failed below
  }

  let created = 0;
  let failed = 0;
  for (const ib of inboxes) {
    const key = String(ib.email).toLowerCase();
    if (existingMailboxes.has(key)) {
      created++;
      await db
        .update(plannedInboxes)
        .set({ status: "active", ...(createdThisRun.has(key) ? { password: passwordByEmail[key] } : {}) })
        .where(eq(plannedInboxes.id, ib.id));
    } else {
      failed++;
      await db.update(plannedInboxes).set({ status: "failed" }).where(eq(plannedInboxes.id, ib.id));
    }
  }

  const verified = results.map((r) =>
    r.type !== "mailbox"
      ? r
      : {
          ...r,
          success: existingMailboxes.has(String(r.name).toLowerCase()),
          error: existingMailboxes.has(String(r.name).toLowerCase())
            ? null
            : r.error || "Mailbox not present in Mailcow after creation",
        },
  );
  return { results: verified, summary: { total: inboxes.length, created, failed } };
}

// --- Step: re-verify mailbox existence against Mailcow and reconcile DB status (no
// password changes). Idempotent; used as the final pipeline step. ---
export async function verifyMailboxes(db: Db, domain: Domain): Promise<{ total: number; active: number }> {
  const inboxes = await db.select().from(plannedInboxes).where(eq(plannedInboxes.domainId, domain.id));
  const existing = new Set<string>();
  try {
    const { json } = await mailcowRequest(domain.mailcowHostname, domain.mailcowApiKey, "get/mailbox/all");
    if (Array.isArray(json)) {
      for (const m of json) if (m?.username) existing.add(String(m.username).toLowerCase());
    }
  } catch {
    // leave empty -> all marked failed
  }
  let active = 0;
  for (const ib of inboxes) {
    const ok = existing.has(String(ib.email).toLowerCase());
    if (ok) active++;
    await db.update(plannedInboxes).set({ status: ok ? "active" : "failed" }).where(eq(plannedInboxes.id, ib.id));
  }
  return { total: inboxes.length, active };
}

// --- Step: push the domain's planned DNS records to Cloudflare. Idempotent: records
// already marked active are skipped. TXT content is quoted to avoid Cloudflare warnings. ---
export async function pushDns(
  db: Db,
  domain: Domain,
  userId: string,
): Promise<{ pushed: number; failed: number; results: { id: string; name: string; success: boolean; error?: string }[] }> {
  const cfZoneId = await resolveAndSaveCfZoneId(db, domain, userId);
  if (!cfZoneId) throw new Error("Cloudflare zone id could not be resolved");
  const secrets = await db.query.userSecrets.findFirst({ where: eq(userSecrets.userId, userId) });
  if (!secrets?.cfApiToken) throw new Error("Cloudflare token missing");

  const records = await db.select().from(dnsRecords).where(eq(dnsRecords.domainId, domain.id));
  const results: { id: string; name: string; success: boolean; error?: string }[] = [];
  let pushed = 0;
  let failed = 0;

  for (const record of records) {
    if (record.status === "active") continue;
    const name = record.name === "@" ? domain.name : `${record.name}.${domain.name}`;
    try {
      const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${cfZoneId}/dns_records`, {
        method: "POST",
        headers: { Authorization: `Bearer ${secrets.cfApiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          type: record.type,
          name,
          content: cfTxtContent(record.type, record.content),
          ttl: record.ttl || 1,
          priority: record.priority,
          proxied: record.proxied || false,
        }),
      });
      const json = (await res.json()) as { success: boolean; result?: { id: string }; errors?: { message: string }[] };
      if (json.success) {
        await db
          .update(dnsRecords)
          .set({ cfRecordId: json.result!.id, status: "active", lastError: null })
          .where(eq(dnsRecords.id, record.id));
        results.push({ id: record.id, name: record.name, success: true });
        pushed++;
      } else {
        const errorMsg = json.errors?.[0]?.message || "Unknown Cloudflare error";
        await db.update(dnsRecords).set({ lastError: errorMsg }).where(eq(dnsRecords.id, record.id));
        results.push({ id: record.id, name: record.name, success: false, error: errorMsg });
        failed++;
      }
    } catch (err) {
      const errorMsg = String(err);
      await db.update(dnsRecords).set({ lastError: errorMsg }).where(eq(dnsRecords.id, record.id));
      results.push({ id: record.id, name: record.name, success: false, error: errorMsg });
      failed++;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { pushed, failed, results };
}

// --- Step: fetch each domain/subdomain's DKIM key from Mailcow and upsert the TXT record
// to Cloudflare. Idempotent: updates the existing record by cfRecordId, else creates it. ---
export async function syncDkim(
  db: Db,
  domain: Domain,
  userId: string,
): Promise<{ results: { name: string; success: boolean; error?: string }[] }> {
  const cfZoneId = await resolveAndSaveCfZoneId(db, domain, userId);
  if (!cfZoneId) throw new Error("Cloudflare zone id could not be resolved");
  const secrets = await db.query.userSecrets.findFirst({ where: eq(userSecrets.userId, userId) });
  if (!secrets?.cfApiToken) throw new Error("Cloudflare token missing");

  const inboxes = await db.select().from(plannedInboxes).where(eq(plannedInboxes.domainId, domain.id));
  const uniqueSubdomains = [domain.name, ...Array.from(new Set(inboxes.map((i: any) => i.subdomainFqdn)))];
  const results: { name: string; success: boolean; error?: string }[] = [];

  for (const sub of uniqueSubdomains) {
    try {
      const { json } = await mailcowRequest(domain.mailcowHostname, domain.mailcowApiKey, `get/dkim/${sub}`);
      const dkimPublic = (json as any)?.dkim_public;
      if (!dkimPublic) {
        results.push({ name: sub, success: false, error: "DKIM not found in Mailcow" });
        continue;
      }
      const dkimKey = String(dkimPublic).replace(/(\r\n|\n|\r)/gm, "");
      const recName = sub === domain.name ? "dkim._domainkey" : `dkim._domainkey.${sub.split(".")[0]}`;
      const fullRecName = recName === "@" ? domain.name : `${recName}.${domain.name}`;
      const recordContent = `v=DKIM1;k=rsa;t=s;s=email;p=${dkimKey}`;

      const dnsRec = await db.query.dnsRecords.findFirst({
        where: and(
          eq(dnsRecords.domainId, domain.id),
          eq(dnsRecords.type, "TXT"),
          eq(dnsRecords.name, recName),
        ),
      });

      let cfRes;
      let isNew = false;
      const body = JSON.stringify({ type: "TXT", name: fullRecName, content: cfTxtContent("TXT", recordContent), ttl: 1 });
      const headers = { Authorization: `Bearer ${secrets.cfApiToken}`, "Content-Type": "application/json" };
      if (dnsRec?.cfRecordId) {
        cfRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${cfZoneId}/dns_records/${dnsRec.cfRecordId}`, { method: "PUT", headers, body });
      } else {
        isNew = true;
        cfRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${cfZoneId}/dns_records`, { method: "POST", headers, body });
      }
      const cfJson = (await cfRes.json()) as any;
      if (cfJson.success && isNew) {
        await db.insert(dnsRecords).values({
          userId,
          domainId: domain.id,
          type: "TXT",
          name: recName,
          content: recordContent,
          ttl: 1,
          cfRecordId: cfJson.result.id,
          status: "active",
        });
      } else if (cfJson.success && dnsRec) {
        await db.update(dnsRecords).set({ content: recordContent }).where(eq(dnsRecords.id, dnsRec.id));
      }
      results.push({ name: sub, success: cfJson.success, error: cfJson.errors?.[0]?.message });
    } catch (err) {
      results.push({ name: sub, success: false, error: String(err) });
    }
  }
  return { results };
}
