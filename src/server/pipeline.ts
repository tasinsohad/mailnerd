// Shared, idempotent provisioning pipeline. Each step checks live state first and skips
// work already done, so a retry resumes cleanly instead of redoing slow steps (e.g. the
// 20-minute Mailcow image pull). Both the BullMQ worker and the manual per-step buttons
// call these same functions, so there is exactly one code path.

import { eq } from "drizzle-orm";
import { plannedInboxes } from "@/lib/db/schema";
import {
  mailcowRequest,
  parseMailcowResult,
  generateMailboxPassword,
  QUOTA,
} from "./mailcow-helpers";

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
