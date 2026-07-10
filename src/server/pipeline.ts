// Shared, idempotent provisioning pipeline. Each step checks live state first and skips
// work already done, so a retry resumes cleanly instead of redoing slow steps (e.g. the
// 20-minute Mailcow image pull). Both the BullMQ worker and the manual per-step buttons
// call these same functions, so there is exactly one code path.

import { eq, and } from "drizzle-orm";
import { plannedInboxes, dnsRecords, userSecrets } from "@/lib/db/schema";
import {
  mailcowRequest,
  mailcowRequestRetry,
  mailcowListAll,
  parseMailcowResult,
  generateMailboxPassword,
  cfTxtContent,
  buildCfRecordBody,
  findMatchingCfRecord,
  isCfAlreadyExistsError,
  QUOTA,
} from "./mailcow-helpers";
import { resolveAndSaveCfZoneId } from "./cloudflare";
import { fetchAllCfDnsRecords, createCfDnsRecordResilient } from "./cloudflare.functions";

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

// Subdomain prefixes that can't hold mailboxes (collide with the mail host / autodiscovery).
const RESERVED_SUBDOMAIN_PREFIXES = new Set(["mail", "autodiscover", "autoconfig", "www", "dkim", "_dmarc"]);

// --- Repair: some inboxes were planned on the mail host (mail.<domain>) or other reserved
// subdomains before the reserved-name fix. Those can never be created (the host isn't a mail
// domain). Reassign each to a valid existing subdomain, regenerating the email and avoiding
// collisions, so the user still gets the mailbox. Idempotent (no-op when nothing is bad). ---
export async function reassignReservedSubdomainInboxes(
  db: Db,
  domain: Domain,
): Promise<{ reassigned: number }> {
  const mailHost = (domain.mailcowHostname || `mail.${domain.name}`).toLowerCase();
  const inboxes = await db.select().from(plannedInboxes).where(eq(plannedInboxes.domainId, domain.id));
  const isBad = (fqdn: unknown) => {
    const f = String(fqdn).toLowerCase();
    return f === mailHost || RESERVED_SUBDOMAIN_PREFIXES.has(f.split(".")[0]);
  };
  const bad = inboxes.filter((ib: any) => isBad(ib.subdomainFqdn));
  if (!bad.length) return { reassigned: 0 };
  const goodSubs = Array.from(
    new Set(inboxes.filter((ib: any) => !isBad(ib.subdomainFqdn)).map((ib: any) => String(ib.subdomainFqdn))),
  );
  if (!goodSubs.length) return { reassigned: 0 }; // nothing valid to move them to
  const emails = new Set(inboxes.map((ib: any) => String(ib.email).toLowerCase()));

  let reassigned = 0;
  let ti = 0;
  for (const ib of bad) {
    const target = goodSubs[ti % goodSubs.length];
    ti++;
    const targetPrefix = String(target).split(".")[0];
    emails.delete(String(ib.email).toLowerCase());
    let lp = ib.localPart;
    let email = `${lp}@${target}`;
    let n = 1;
    while (emails.has(email.toLowerCase())) {
      lp = `${ib.localPart}${n++}`;
      email = `${lp}@${target}`;
    }
    emails.add(email.toLowerCase());
    await db
      .update(plannedInboxes)
      .set({ subdomainPrefix: targetPrefix, subdomainFqdn: target, localPart: lp, email, status: "planned", password: null })
      .where(eq(plannedInboxes.id, ib.id));
    reassigned++;
  }
  return { reassigned };
}

// --- Step: ensure each planned subdomain exists in Mailcow as a mail domain with adequate
// quota. Idempotent: add/domain creates if missing; if it already exists, edit/domain
// repairs its limits. Truth comes from get/domain/all, never the POST result. ---
export async function ensureMailDomains(
  db: Db,
  domain: Domain,
): Promise<{ existingDomains: Set<string>; results: MailcowResultRow[] }> {
  // Writes go through the retrying client so a transient hiccup during bulk provisioning
  // (429 / 5xx / timeout) doesn't silently drop a domain or mailbox.
  const mc = (path: string, body?: unknown) =>
    mailcowRequestRetry(domain.mailcowHostname, domain.mailcowApiKey, path, body);

  // Fail fast if the Mailcow API isn't reachable. A Cloudflare-PROXIED mail host (orange
  // cloud) intercepts the API and returns HTML / hangs, which would otherwise make us hang
  // on dozens of add/* calls. The mail host MUST be DNS-only. A valid empty Mailcow returns
  // {} (object) or [] with HTTP 200; HTML (string) or non-200/timeout means unreachable.
  const probe = await mailcowListAll(domain.mailcowHostname, domain.mailcowApiKey, "get/domain/all", {
    attempts: 5,
    timeoutMs: 12000,
  });
  if (probe === null) {
    throw new Error(
      `Mailcow API not reachable at ${domain.mailcowHostname} after retries. ` +
        `Is the mail host Cloudflare-proxied? mail.<domain> must be DNS-only (grey cloud).`,
    );
  }
  // Reassign any inboxes stuck on the mail host / reserved subdomains (planned before the
  // reserved-name fix) to a valid subdomain so they can actually be created.
  await reassignReservedSubdomainInboxes(db, domain);

  const inboxes = await db.select().from(plannedInboxes).where(eq(plannedInboxes.domainId, domain.id));
  const mailHost = (domain.mailcowHostname || `mail.${domain.name}`).toLowerCase();
  // Never try to add the mail server host itself as a mail domain (Mailcow rejects it).
  const uniqueSubdomains = Array.from(new Set(inboxes.map((i: any) => String(i.subdomainFqdn)))).filter(
    (s) => String(s).toLowerCase() !== mailHost,
  );
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
  const domList = await mailcowListAll(domain.mailcowHostname, domain.mailcowApiKey, "get/domain/all");
  if (domList) {
    for (const d of domList) if (d?.domain_name) existingDomains.add(String(d.domain_name).toLowerCase());
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
  // Writes go through the retrying client so a transient hiccup during bulk provisioning
  // (429 / 5xx / timeout) doesn't silently drop a domain or mailbox.
  const mc = (path: string, body?: unknown) =>
    mailcowRequestRetry(domain.mailcowHostname, domain.mailcowApiKey, path, body);
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
        // Display name. The planned-inbox column is `fullName` — `personName` never existed, so
        // this was silently sending `undefined` and creating blank-named mailboxes.
        name: ib.fullName || [ib.firstName, ib.lastName].filter(Boolean).join(" ") || ib.localPart,
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
  // CRITICAL: use the resilient list read. If verification is unavailable (transient API flakiness
  // during the fresh-provision window), we must NOT fall through to "empty" — that would mark every
  // just-created mailbox `failed`. Throw instead so statuses are left untouched and a retry can
  // reconcile them once the API settles.
  const mbList = await mailcowListAll(domain.mailcowHostname, domain.mailcowApiKey, "get/mailbox/all");
  if (mbList === null) {
    throw new Error(
      "Could not verify mailboxes: Mailcow get/mailbox/all did not return a list after retries. " +
        "Mailbox statuses left unchanged — re-run once the API is stable.",
    );
  }
  const existingMailboxes = new Set<string>();
  for (const m of mbList) if (m?.username) existingMailboxes.add(String(m.username).toLowerCase());

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
  // Resilient read: null means "couldn't verify" — do NOT mark everything failed on a transient
  // hiccup. Leave statuses untouched and surface a clear error for a later retry.
  const mbList = await mailcowListAll(domain.mailcowHostname, domain.mailcowApiKey, "get/mailbox/all");
  if (mbList === null) {
    throw new Error(
      "Could not verify mailboxes: Mailcow get/mailbox/all did not return a list after retries.",
    );
  }
  const existing = new Set<string>();
  for (const m of mbList) if (m?.username) existing.add(String(m.username).toLowerCase());
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

  // Pre-fetch the zone's existing records so we can adopt (not re-create) ones already present —
  // this makes re-pushing an already-provisioned domain succeed instead of erroring on duplicates.
  const existing = await fetchAllCfDnsRecords(secrets.cfApiToken, cfZoneId);

  for (const record of records) {
    if (record.status === "active") continue;
    const name = record.name === "@" ? domain.name : `${record.name}.${domain.name}`;

    // Idempotency: if this record already exists in the zone, adopt it and move on.
    const match = findMatchingCfRecord(existing, record.type, name, record.content);
    if (match) {
      await db
        .update(dnsRecords)
        .set({ cfRecordId: match.id, status: "active", lastError: null })
        .where(eq(dnsRecords.id, record.id));
      results.push({ id: record.id, name: record.name, success: true });
      pushed++;
      continue;
    }

    try {
      const json = await createCfDnsRecordResilient(
        secrets.cfApiToken,
        cfZoneId,
        buildCfRecordBody(record, name, domain.name),
      );
      if (json.success) {
        await db
          .update(dnsRecords)
          .set({ cfRecordId: json.result!.id, status: "active", lastError: null })
          .where(eq(dnsRecords.id, record.id));
        results.push({ id: record.id, name: record.name, success: true });
        pushed++;
      } else {
        const errorMsg = json.errors?.[0]?.message || "Unknown Cloudflare error";
        // "Already exists" means the desired state is present — treat as success, not failure.
        if (isCfAlreadyExistsError(errorMsg)) {
          await db
            .update(dnsRecords)
            .set({ status: "active", lastError: null })
            .where(eq(dnsRecords.id, record.id));
          results.push({ id: record.id, name: record.name, success: true });
          pushed++;
        } else {
          await db.update(dnsRecords).set({ lastError: errorMsg }).where(eq(dnsRecords.id, record.id));
          results.push({ id: record.id, name: record.name, success: false, error: errorMsg });
          failed++;
        }
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
      // Mailcow returns { pubkey, dkim_txt, dkim_selector, length } — NOT `dkim_public`.
      // Prefer the ready-made dkim_txt; otherwise build the record from the raw pubkey.
      const dkimTxt = (json as any)?.dkim_txt;
      const pubkey = (json as any)?.pubkey;
      if (!dkimTxt && !pubkey) {
        results.push({ name: sub, success: false, error: "DKIM key not found in Mailcow" });
        continue;
      }
      const recName = sub === domain.name ? "dkim._domainkey" : `dkim._domainkey.${sub.split(".")[0]}`;
      const fullRecName = recName === "@" ? domain.name : `${recName}.${domain.name}`;
      const recordContent =
        dkimTxt && String(dkimTxt).toLowerCase().includes("v=dkim1")
          ? String(dkimTxt).replace(/(\r\n|\n|\r)/gm, "")
          : `v=DKIM1;k=rsa;t=s;s=email;p=${String(pubkey).replace(/(\r\n|\n|\r)/gm, "")}`;

      const dnsRec = await db.query.dnsRecords.findFirst({
        where: and(
          eq(dnsRecords.domainId, domain.id),
          eq(dnsRecords.type, "TXT"),
          eq(dnsRecords.name, recName),
        ),
      });

      let isNew = false;
      const body = JSON.stringify({ type: "TXT", name: fullRecName, content: cfTxtContent("TXT", recordContent), ttl: 1 });
      const headers = { Authorization: `Bearer ${secrets.cfApiToken}`, "Content-Type": "application/json" };
      const createUrl = `https://api.cloudflare.com/client/v4/zones/${cfZoneId}/dns_records`;
      let cfRes: Response;
      let cfJson: any;
      if (dnsRec?.cfRecordId) {
        cfRes = await fetch(`${createUrl}/${dnsRec.cfRecordId}`, { method: "PUT", headers, body });
        cfJson = await cfRes.json();
        // Stale record id (record was removed in Cloudflare) — recreate it instead of failing.
        if (!cfJson.success) {
          isNew = true;
          cfRes = await fetch(createUrl, { method: "POST", headers, body });
          cfJson = await cfRes.json();
        }
      } else {
        isNew = true;
        cfRes = await fetch(createUrl, { method: "POST", headers, body });
        cfJson = await cfRes.json();
      }
      if (cfJson.success && isNew) {
        if (dnsRec) {
          await db.update(dnsRecords).set({ content: recordContent, cfRecordId: cfJson.result.id, status: "active" }).where(eq(dnsRecords.id, dnsRec.id));
        } else {
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
        }
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

// --- Repair: ensure Cloudflare DNS won't break the Mailcow API/mail. Removes any
// duplicate/placeholder/proxied `mail.<domain>` A record (the collision that intermittently
// broke the API), ensures a single DNS-only mail A -> server IP, and un-proxies the other
// A/CNAME records (mail subdomains never need Cloudflare proxying). Idempotent. ---
export async function unproxyDns(
  db: Db,
  domain: Domain,
  userId: string,
): Promise<{ unproxied: number; removed: number; ensuredMailHost: boolean }> {
  const cfZoneId = await resolveAndSaveCfZoneId(db, domain, userId);
  if (!cfZoneId) throw new Error("Cloudflare zone id could not be resolved");
  const secrets = await db.query.userSecrets.findFirst({ where: eq(userSecrets.userId, userId) });
  if (!secrets?.cfApiToken) throw new Error("Cloudflare token missing");
  const headers = { Authorization: `Bearer ${secrets.cfApiToken}`, "Content-Type": "application/json" };
  const base = `https://api.cloudflare.com/client/v4/zones/${cfZoneId}/dns_records`;
  const serverIp: string | undefined = domain.ipAddress || undefined;
  const mailHost: string = domain.mailcowHostname || `mail.${domain.name}`;

  const listJson = (await (await fetch(`${base}?per_page=500`, { headers })).json()) as any;
  if (!listJson.success) throw new Error("Failed to list Cloudflare records: " + JSON.stringify(listJson.errors));

  let unproxied = 0;
  let removed = 0;
  let ensuredMailHost = false;

  // 1. Fix the mail host: delete any A record for it that's proxied or not the real server IP.
  const mailARecords = listJson.result.filter((r: any) => r.type === "A" && r.name === mailHost);
  for (const r of mailARecords) {
    if (r.proxied || (serverIp && r.content !== serverIp)) {
      await fetch(`${base}/${r.id}`, { method: "DELETE", headers });
      removed++;
    }
  }
  // 2. Ensure exactly one DNS-only mail A -> server IP.
  if (serverIp && !mailARecords.some((r: any) => !r.proxied && r.content === serverIp)) {
    await fetch(base, {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "A", name: mailHost, content: serverIp, ttl: 1, proxied: false }),
    });
    ensuredMailHost = true;
  }
  // 3. Un-proxy every other proxied A/CNAME record.
  for (const r of listJson.result) {
    if ((r.type === "A" || r.type === "CNAME") && r.proxied && r.name !== mailHost) {
      await fetch(`${base}/${r.id}`, { method: "PATCH", headers, body: JSON.stringify({ proxied: false }) });
      unproxied++;
      await new Promise((res) => setTimeout(res, 100));
    }
  }
  return { unproxied, removed, ensuredMailHost };
}
