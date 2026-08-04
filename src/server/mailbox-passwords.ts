import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { domains, plannedInboxes } from "@/lib/db/schema";
import { ConsoleLog } from "./console-bus";
import { readMailcowConfigOverSsh } from "./mailcow-key";
import {
  mailcowListAll,
  mailcowRequestRetry,
  parseMailcowResult,
  generateMailboxPassword,
  type MailcowSshTarget,
} from "./mailcow-helpers";

// Bulk mailbox password reset for INTERNAL (system-created) and EXTERNAL (user's own) Mailcow
// servers. One shared password per run: a blank input auto-generates one and applies it to every
// mailbox, a filled input is used verbatim. All API calls go through the same direct->SSH-tunnel
// transport as provisioning, so a locked-down API or a wrong app IP can't break it.
//
// SERVER-ONLY, exports only createServerFns (+ types), so it's stubbed out of the client bundle even
// though it imports the SSH-touching mailcow-key. Never add a plain runtime export here.

export type ResetRow = { email: string; ok: boolean; error?: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sshTargetFor(d: any): MailcowSshTarget | undefined {
  const ipAddress = d.ipAddress || d.server?.ipAddress;
  const sshPassword = d.sshPassword || d.server?.sshPassword;
  const sshUser = d.sshUser || d.server?.sshUser || "root";
  return ipAddress && sshPassword ? { ipAddress, sshUser, sshPassword } : undefined;
}

// Resolve the working transport + the mailbox list. Tries the app's direct connection first, then
// falls back to running the API over SSH (source 127.0.0.1, always allow-listed).
async function resolveMailboxes(
  host: string,
  key: string,
  sshTarget: MailcowSshTarget | undefined,
): Promise<{ ssh?: MailcowSshTarget; usernames: string[] } | { error: string }> {
  let list = await mailcowListAll(host, key, "get/mailbox/all", { attempts: 2, timeoutMs: 12000 });
  let ssh: MailcowSshTarget | undefined;
  if (list === null && sshTarget) {
    list = await mailcowListAll(host, key, "get/mailbox/all", {
      attempts: 2,
      timeoutMs: 20000,
      ssh: sshTarget,
    });
    if (list !== null) ssh = sshTarget;
  }
  if (list === null)
    return { error: "Could not reach the Mailcow API to list mailboxes (check the server / API key)." };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const usernames = list.map((m: any) => String(m?.username ?? "")).filter(Boolean);
  return { ssh, usernames };
}

// Reset each mailbox to `password` via edit/mailbox, streaming to the console. Sequential so one
// failure is isolated and Mailcow isn't hammered.
async function resetEach(
  host: string,
  key: string,
  ssh: MailcowSshTarget | undefined,
  emails: string[],
  password: string,
  log: ConsoleLog,
): Promise<ResetRow[]> {
  const rows: ResetRow[] = [];
  for (const email of emails) {
    log.cmd(`Reset ${email}`);
    const r = await mailcowRequestRetry(
      host,
      key,
      "edit/mailbox",
      { items: [email], attr: { password, password2: password } },
      { ssh },
    ).catch((e) => ({ ok: false, status: 0, json: e instanceof Error ? e.message : String(e) }));
    const outcome = parseMailcowResult(r.ok, r.json);
    rows.push({ email, ok: outcome.success, error: outcome.success ? undefined : outcome.error ?? "failed" });
    log.out(`${email}: ${outcome.success ? "password reset" : outcome.error ?? "failed"}`);
  }
  return rows;
}

// Mailboxes on `list` that belong to this registrable domain (any of its subdomains).
function mailboxesForDomain(usernames: string[], domainName: string): string[] {
  const n = domainName.toLowerCase();
  return usernames.filter((u) => {
    const d = u.split("@")[1]?.toLowerCase();
    return d === n || (d ? d.endsWith(`.${n}`) : false);
  });
}

const domainInput = (d: unknown) =>
  z.object({ domainId: z.string(), password: z.string().optional(), runId: z.string().trim().optional() }).parse(d);

export const resetDomainMailboxPasswords = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator(domainInput)
  .handler(async ({ data, context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { db, userId } = context as any;
    if (!db) return { error: "Database not connected" };
    const log = new ConsoleLog(data.runId);
    const domain = await db.query.domains.findFirst({
      where: and(eq(domains.id, data.domainId), eq(domains.userId, userId)),
      with: { server: true },
    });
    if (!domain?.mailcowHostname || !domain?.mailcowApiKey)
      return { error: "Mailcow isn't set up for this domain yet.", transcript: log.transcript() };

    const resolved = await resolveMailboxes(
      domain.mailcowHostname,
      domain.mailcowApiKey,
      sshTargetFor(domain),
    );
    if ("error" in resolved) return { error: resolved.error, transcript: log.transcript() };

    const emails = mailboxesForDomain(resolved.usernames, domain.name);
    if (emails.length === 0)
      return { error: `No mailboxes found for ${domain.name}.`, transcript: log.transcript() };

    const password = data.password?.trim() || generateMailboxPassword();
    log.info(`Resetting ${emails.length} mailbox password(s) for ${domain.name}.`);
    const results = await resetEach(
      domain.mailcowHostname,
      domain.mailcowApiKey,
      resolved.ssh,
      emails,
      password,
      log,
    );

    // Persist the new password on the planned inboxes we successfully reset, so exports match.
    const okEmails = results.filter((r) => r.ok).map((r) => r.email.toLowerCase());
    for (const email of okEmails) {
      await db
        .update(plannedInboxes)
        .set({ password })
        .where(and(eq(plannedInboxes.domainId, domain.id), eq(plannedInboxes.email, email)));
    }
    return { password, results, transcript: log.transcript() };
  });

const batchInput = (d: unknown) =>
  z.object({ batchId: z.string(), password: z.string().optional(), runId: z.string().trim().optional() }).parse(d);

export const resetJobMailboxPasswords = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator(batchInput)
  .handler(async ({ data, context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { db, userId } = context as any;
    if (!db) return { error: "Database not connected" };
    const log = new ConsoleLog(data.runId);
    const rows = await db.query.domains.findMany({
      where: and(eq(domains.batchId, data.batchId), eq(domains.userId, userId)),
      with: { server: true },
    });
    if (!rows.length) return { error: "No domains in this job.", transcript: log.transcript() };

    // ONE shared password across the whole batch.
    const password = data.password?.trim() || generateMailboxPassword();
    const results: ResetRow[] = [];
    for (const domain of rows) {
      if (!domain.mailcowHostname || !domain.mailcowApiKey) continue;
      const resolved = await resolveMailboxes(
        domain.mailcowHostname,
        domain.mailcowApiKey,
        sshTargetFor(domain),
      );
      if ("error" in resolved) {
        log.error(`${domain.name}: ${resolved.error}`);
        continue;
      }
      const emails = mailboxesForDomain(resolved.usernames, domain.name);
      if (!emails.length) continue;
      log.info(`Resetting ${emails.length} mailbox(es) for ${domain.name}.`);
      const r = await resetEach(
        domain.mailcowHostname,
        domain.mailcowApiKey,
        resolved.ssh,
        emails,
        password,
        log,
      );
      results.push(...r);
      const okEmails = r.filter((x) => x.ok).map((x) => x.email.toLowerCase());
      for (const email of okEmails) {
        await db
          .update(plannedInboxes)
          .set({ password })
          .where(and(eq(plannedInboxes.domainId, domain.id), eq(plannedInboxes.email, email)));
      }
    }
    return { password, results, transcript: log.transcript() };
  });

const externalInput = (d: unknown) =>
  z
    .object({
      ipAddress: z.string().trim().min(1),
      sshUser: z.string().trim().min(1).default("root"),
      sshPassword: z.string().min(1),
      mailcowHostname: z.string().trim().optional(),
      mailcowApiKey: z.string().trim().optional(),
      fetchApiKey: z.boolean().default(true),
      password: z.string().optional(),
      runId: z.string().trim().optional(),
    })
    .parse(d);

export const resetExternalMailboxPasswords = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator(externalInput)
  .handler(async ({ data }) => {
    const log = new ConsoleLog(data.runId);
    const target: MailcowSshTarget = {
      ipAddress: data.ipAddress,
      sshUser: data.sshUser,
      sshPassword: data.sshPassword,
    };

    // Auto-read the mail host + API key over SSH when not supplied (same as the diagnostics flow).
    const needHost = !data.mailcowHostname;
    const wantApiKey = !data.mailcowApiKey && data.fetchApiKey;
    let host = data.mailcowHostname || null;
    let key = data.mailcowApiKey || null;
    if (needHost || wantApiKey) {
      log.info(`Connecting to ${data.ipAddress} for the mail host + API key…`);
      const cfg = await readMailcowConfigOverSsh(target, { wantApiKey, log }).catch(() => null);
      host = host || cfg?.hostname || null;
      key = key || cfg?.apiKey || null;
    }
    if (!host || !key)
      return {
        error: "Couldn't get the Mailcow host + API key from the server. Enter them under Advanced and retry.",
        transcript: log.transcript(),
      };

    const resolved = await resolveMailboxes(host, key, target);
    if ("error" in resolved) return { error: resolved.error, transcript: log.transcript() };
    if (resolved.usernames.length === 0)
      return { error: "No mailboxes found on this server.", transcript: log.transcript() };

    const password = data.password?.trim() || generateMailboxPassword();
    log.info(`Resetting ${resolved.usernames.length} mailbox password(s) on ${host}.`);
    const results = await resetEach(host, key, resolved.ssh, resolved.usernames, password, log);
    return { password, host, results, transcript: log.transcript() };
  });
