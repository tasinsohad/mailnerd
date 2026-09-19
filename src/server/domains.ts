import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth";
import { z } from "zod";
import {
  domains,
  dnsRecords,
  domainBatches,
  domainPlans,
  plannedInboxes,
  cloudflareZones,
  userSecrets,
  serverHealth,
  jobTemplates,
} from "@/lib/db/schema";
import { eq, and, desc, inArray, getTableColumns } from "drizzle-orm";
import { planDomain, randInt, DomainPlan, generateDnsRecords } from "@/lib/planning";
import dns from "dns/promises";
import {
  cfTxtContent,
  buildCfRecordBody,
  findMatchingCfRecord,
  isCfAlreadyExistsError,
} from "./mailcow-helpers";
import { resolveAndSaveCfZoneId } from "./cloudflare";
import { fetchAllCfDnsRecords, createCfDnsRecordResilient } from "./cloudflare.functions";
import { unproxyDns } from "./pipeline";
import { pushDnsForDomain } from "./domains-heal";

// Re-exported for any existing importers of these modules.
export { cfTxtContent };
export { resolveAndSaveCfZoneId };

// Strip server-only secrets before a domain row is sent to the browser. mailcowApiKey is never
// used client-side; sshPassword is replaced with a boolean so edit forms can show "set" without
// leaking the value. mailcowAdminPassword is shown only on the domain page (getDomainDetails), so
// every other response leaves it out. (Responses are userId-scoped, but these are cacheable GETs and
// the app is deployable, so secrets must not leave the server.)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function publicDomain<T extends Record<string, any>>(
  d: T | null | undefined,
  { withAdminPassword = false }: { withAdminPassword?: boolean } = {},
) {
  if (!d) return d;
  const { mailcowApiKey: _k, sshPassword, mailcowAdminPassword, ...rest } = d;
  return {
    ...rest,
    hasSshPassword: Boolean(sshPassword),
    ...(withAdminPassword ? { mailcowAdminPassword } : {}),
  };
}

// For the server log, and for errors returned to the browser. Drizzle's message ends with the query's
// parameters ("params: ..."), SSH passwords among them, and logging the error object prints them
// too. Keep the SQL text, the Postgres error code and the underlying cause; drop the parameters.
function describeErrorForLog(err: unknown): string {
  const e = err as { message?: unknown; code?: unknown; cause?: { message?: unknown; code?: unknown } } | null;
  const withoutParams = (text: string) => {
    const at = text.search(/params:/i);
    return (at === -1 ? text : text.slice(0, at)).trim();
  };
  const parts = [withoutParams(typeof e?.message === "string" ? e.message : String(err))];
  const code = e?.code ?? e?.cause?.code;
  if (typeof code === "string" && code) parts.push(`code ${code}`);
  if (typeof e?.cause?.message === "string" && e.cause.message) {
    parts.push(`cause: ${withoutParams(e.cause.message)}`);
  }
  return parts.join(" | ");
}

// Validation schemas
const validateDomainsSchema = z.object({
  domains: z.array(z.string().min(1).max(255)),
});

const listDomainsSchema = z.object({
  batchId: z.string().uuid().optional(),
}).optional().default({});

const getDomainSchema = z.object({
  id: z.string().uuid(),
});

const updateDomainSchema = z.object({
  id: z.string().uuid(),
  name: z.string().max(255).optional().nullable().or(z.literal("")),
  ipAddress: z.string().max(45).optional().nullable().or(z.literal("")),
  sshUser: z.string().max(50).optional().nullable().or(z.literal("")),
  sshPassword: z.string().optional().nullable().or(z.literal("")),
  cfZoneId: z.string().uuid().optional().nullable().or(z.literal("")),
  cfAccountId: z.string().uuid().optional().nullable().or(z.literal("")),
  mailcowHostname: z.string().url().optional().nullable().or(z.literal("")),
  mailcowApiKey: z.string().max(255).optional().nullable().or(z.literal("")),
  status: z.enum(["pending", "configuring", "provisioning", "ready", "error"]).optional(),
  plannedInboxCount: z.number().int().min(0).optional().nullable(),
});

const deleteDomainSchema = z.object({
  id: z.string().uuid(),
});

export const validateDomainsAgainstZones = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => validateDomainsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { db, userId } = (context as any) as { db: any; userId: string };
    if (!db) return [];

    try {
      const zones = await db
        .select()
        .from(cloudflareZones)
        .where(eq(cloudflareZones.userId, userId));

      const zoneMap = new Map(zones.map((z: any) => [z.name.toLowerCase(), z.zoneId]));

      return data.domains.map((d) => ({
        name: d,
        valid: zoneMap.has(d.toLowerCase()),
        zoneId: zoneMap.get(d.toLowerCase()) || null,
      }));
    } catch {
      return [];
    }
  });

export const listDomains = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => listDomainsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { db, userId } = (context as any) as { db: any; userId: string };
    if (!db) return [];

    try {
      const where = data?.batchId
        ? and(eq(domains.userId, userId), eq(domains.batchId, data.batchId))
        : eq(domains.userId, userId);
      // Everything but the setup log: it runs to hundreds of KB per domain (7.8 MB for 29 domains), no list
      // shows it, and this list loads on the Domains page, once per job card, and in the add-domains wizard.
      const { terminalLogs: _terminalLogs, ...listColumns } = getTableColumns(domains);
      const rows = await db.select(listColumns).from(domains).where(where).orderBy(desc(domains.createdAt));

      // Attach the job (batch) name and the planned inbox count to each domain row.
      const batchList = await db.select().from(domainBatches).where(eq(domainBatches.userId, userId));
      const batchName = new Map<string, string>(batchList.map((b: any) => [b.id, b.name]));

      const ids = rows.map((r: any) => r.id);
      const plans =
        ids.length > 0
          ? await db.select().from(domainPlans).where(inArray(domainPlans.domainId, ids))
          : [];
      const inboxCount = new Map<string, number>(
        plans.map((p: any) => [p.domainId, p.totalInboxes ?? 0]),
      );

      // Count usable mailboxes: confirmed in Mailcow and with a saved password, the same rule the CSV export
      // uses. Used to gate CSV export so it's only offered once mailboxes exist.
      const inboxRows =
        ids.length > 0
          ? await db
              .select({
                domainId: plannedInboxes.domainId,
                status: plannedInboxes.status,
                password: plannedInboxes.password,
              })
              .from(plannedInboxes)
              .where(inArray(plannedInboxes.domainId, ids))
          : [];
      const createdCount = new Map<string, number>();
      for (const ir of inboxRows) {
        if (ir.status === "active" && ir.password) {
          createdCount.set(ir.domainId, (createdCount.get(ir.domainId) ?? 0) + 1);
        }
      }

      return rows.map((r: any) => ({
        ...publicDomain(r),
        batchName: r.batchId ? batchName.get(r.batchId) ?? null : null,
        plannedInboxCount: inboxCount.get(r.id) ?? 0,
        createdInboxCount: createdCount.get(r.id) ?? 0,
      }));
    } catch {
      return [];
    }
  });

export const getDomain = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => getDomainSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { db, userId } = (context as any) as { db: any; userId: string };
    if (!db) return null;

    try {
      const row = await db.query.domains.findFirst({
        where: and(eq(domains.id, data.id), eq(domains.userId, userId)),
      });
      return publicDomain(row);
    } catch {
      return null;
    }
  });

export const updateDomain = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => updateDomainSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { db, userId } = (context as any) as { db: any; userId: string };
    if (!db) return { ok: false, error: "Database not connected" };

    try {
      const { id, ...rest } = data;

      // Edit forms no longer pre-fill the SSH password (it's not sent to the client anymore),
      // so an empty value means "leave unchanged" — never overwrite the stored secret with "".
      if (rest.sshPassword === "" || rest.sshPassword == null) {
        delete (rest as { sshPassword?: unknown }).sshPassword;
      }

      const oldDomain = await db.query.domains.findFirst({
        where: and(eq(domains.id, id), eq(domains.userId, userId)),
      });

      if (!oldDomain) return { ok: false, error: "Domain not found" };

      await db
        .update(domains)
        .set(rest)
        .where(and(eq(domains.id, id), eq(domains.userId, userId)));

      if (
        (rest.ipAddress && rest.ipAddress !== oldDomain.ipAddress) ||
        (rest.name && rest.name !== oldDomain.name)
      ) {
        const plan = await db.query.domainPlans.findFirst({
          where: eq(domainPlans.domainId, id),
        });
        const inboxes = await db.select().from(plannedInboxes).where(eq(plannedInboxes.domainId, id));

        if (plan) {
          const newName = rest.name || oldDomain.name;
          const newIp = rest.ipAddress || oldDomain.ipAddress;
          const newRecords = generateDnsRecords(newName, newIp, { ...plan, inboxes });

          // Delete pending records and recreate them with the new IP/name
          await db.delete(dnsRecords).where(and(eq(dnsRecords.domainId, id), eq(dnsRecords.status, "pending")));

          const dnsRecordsToInsert = newRecords.map((rec) => ({
            userId,
            domainId: id,
            ...rec,
          }));
          await db.insert(dnsRecords).values(dnsRecordsToInsert);
        }
      }

      return { ok: true };
    } catch (error) {
      return { ok: false, error: describeErrorForLog(error) };
    }
  });

export const deleteDomain = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => deleteDomainSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { db, userId } = (context as any) as { db: any; userId: string };
    if (!db) return { ok: false, error: "Database not connected" };

    try {
      // The child tables are keyed by domain id alone, so check the domain is in this workspace first.
      const owned = await db.query.domains.findFirst({
        where: and(eq(domains.id, data.id), eq(domains.userId, userId)),
        columns: { id: true },
      });
      if (!owned) return { ok: false, error: "Domain not found" };
      await db.delete(dnsRecords).where(eq(dnsRecords.domainId, data.id));
      await db.delete(plannedInboxes).where(eq(plannedInboxes.domainId, data.id));
      await db.delete(domainPlans).where(eq(domainPlans.domainId, data.id));
      await db.delete(domains).where(and(eq(domains.id, data.id), eq(domains.userId, userId)));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: describeErrorForLog(error) };
    }
  });

export const listDomainPlans = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { db, userId } = (context as any) as { db: any; userId: string };
    if (!db) return [];

    try {
      return await db.select().from(domainPlans).where(eq(domainPlans.userId, userId));
    } catch {
      return [];
    }
  });

export const listDomainBatches = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { db, userId } = (context as any) as { db: any; userId: string };
    if (!db) return [];

    try {
      return await db
        .select()
        .from(domainBatches)
        .where(eq(domainBatches.userId, userId))
        .orderBy(desc(domainBatches.createdAt));
    } catch {
      return [];
    }
  });

// Why a domain couldn't be added, in words for the wizard. Drizzle's own message includes the query's
// parameters (SSH passwords among them), so only the database's message is passed on.
function describeAddDomainError(err: unknown): string {
  const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e?.code === "23505" || e?.cause?.code === "23505") return "This domain is already in the app";
  if (e?.cause?.message) return e.cause.message;
  const message = e?.message ?? String(err);
  if (/^Failed query/i.test(message)) return "The database rejected this domain";
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

const addDomainsWizardSchema = z.object({
  batchName: z.string().min(1).max(255),
  domains: z.array(
    z.object({
      domain: z.string().min(1).max(255),
      ipAddress: z.string().min(1).max(45),
      sshUser: z.string().min(1).max(50),
      sshPassword: z.string().optional().nullable(),
      plannedSubdomainCount: z.number().int().min(1).max(1000).optional(),
      // Required: the count comes from the wizard's chosen mode. (A missing count used to fall back to a
      // random 8-40.)
      plannedInboxCount: z.number().int().min(1).max(10000),
      // The previewed split per mail domain ("@" = main domain), replayed exactly.
      plannedDistribution: z
        .array(z.object({ prefix: z.string().min(1).max(63), count: z.number().int().min(0).max(10000) }))
        .optional(),
    }),
  ),
  prefixes: z.array(z.string()).optional(),
  names: z.array(z.string()).optional(),
  templateId: z.string().uuid().optional(),
  placement: z.enum(["subdomain", "main", "both"]).optional(),
});

export const addDomainsWizardAction = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => addDomainsWizardSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { db, userId } = (context as any) as { db: any; userId: string };
    if (!db) return { ok: false, error: "Database not connected" };

    try {
      const prefixes = data.prefixes ?? ["mail", "contact", "hello", "team", "support", "info"];
      const names = data.names ?? ["Alice Johnson", "John Doe", "Marco", "Sofia Rossi"];
      const placement = data.placement ?? "subdomain";

      // A template from another workspace is ignored rather than linked.
      const templateId = data.templateId
        ? ((
            await db.query.jobTemplates.findFirst({
              where: and(eq(jobTemplates.id, data.templateId), eq(jobTemplates.userId, userId)),
              columns: { id: true },
            })
          )?.id ?? null)
        : null;

      const [batch] = await db
        .insert(domainBatches)
        .values({
          userId,
          name: data.batchName,
          templateId,
        })
        .returning();

      let okCount = 0;
      // Domains that couldn't be added, with the reason, so the wizard says so instead of quietly
      // creating a smaller batch.
      const failed: { domain: string; error: string }[] = [];
      for (const row of data.domains) {
        try {
          // Without a previewed split, keep the previewed subdomain count. With "both" that count
          // includes the main domain, which isn't a subdomain.
          const subdomains = row.plannedSubdomainCount
            ? Math.max(1, row.plannedSubdomainCount - (placement === "both" ? 1 : 0))
            : undefined;
          const plan = planDomain(row.domain, {
            totalInboxes: row.plannedInboxCount,
            prefixes,
            names,
            minSubdomains: subdomains ?? 1,
            maxSubdomains: subdomains ?? 15,
            placement,
            distribution: row.plannedDistribution,
          });

          // All of a domain's rows or none: a half-added domain can't be added again (its name is taken).
          await db.transaction(async (tx: any) => {
            const [domain] = await tx
              .insert(domains)
              .values({
                userId,
                batchId: batch.id,
                name: row.domain,
                ipAddress: row.ipAddress,
                sshUser: row.sshUser,
                sshPassword: row.sshPassword,
                status: "pending",
                plannedInboxCount: plan.totalInboxes,
              })
              .returning();

            const [domainPlan] = await tx
              .insert(domainPlans)
              .values({
                userId,
                domainId: domain.id,
                totalInboxes: plan.totalInboxes,
                subdomainCount: plan.subdomainCount,
                status: "planned",
                prefixesSnapshot: prefixes,
                namesSnapshot: names,
                placement,
              })
              .returning();

            const inboxesToInsert = plan.inboxes.map((ib) => ({
              userId,
              domainId: domain.id,
              planId: domainPlan.id,
              subdomainPrefix: ib.subdomainPrefix,
              subdomainFqdn: ib.subdomainFqdn,
              localPart: ib.localPart,
              email: ib.email,
              fullName: ib.fullName,
              firstName: ib.firstName,
              lastName: ib.lastName,
              format: ib.format,
              status: "planned" as const,
            }));
            // In chunks: Postgres takes at most 65535 parameters per statement, which one insert of a
            // 10000-mailbox plan (12 columns each) would pass.
            for (let i = 0; i < inboxesToInsert.length; i += 500) {
              await tx.insert(plannedInboxes).values(inboxesToInsert.slice(i, i + 500));
            }

            const dnsRecordsToInsert = generateDnsRecords(row.domain, row.ipAddress, plan).map((rec) => ({
              userId,
              domainId: domain.id,
              ...rec,
            }));
            await tx.insert(dnsRecords).values(dnsRecordsToInsert);
          });
          okCount++;
        } catch (err) {
          console.error(`Failed to add domain ${row.domain}: ${describeErrorForLog(err)}`);
          failed.push({ domain: row.domain, error: describeAddDomainError(err) });
        }
      }

      if (okCount === 0) {
        await db.delete(domainBatches).where(eq(domainBatches.id, batch.id)).catch(() => {});
      }
      // Only when something landed: an empty batch was just deleted above, so its id is no longer valid.
      return { ok: true, okCount, failed, ...(okCount > 0 ? { batchId: batch.id } : {}) };
    } catch (error) {
      return { ok: false, error: describeErrorForLog(error) };
    }
  });


const getDomainDetailsSchema = z.object({
  id: z.string().uuid(),
});

export const getDomainDetails = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => getDomainDetailsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { db, userId } = (context as any) as { db: any; userId: string };
    if (!db) return null;

    try {
      const domain = await db.query.domains.findFirst({
        where: and(eq(domains.id, data.id), eq(domains.userId, userId)),
      });

      if (!domain) return null;

      // Automatically associate and populate the Cloudflare Zone ID if missing
      const cfZoneId = await resolveAndSaveCfZoneId(db, domain, userId);
      if (cfZoneId) {
        domain.cfZoneId = cfZoneId;
      }

      const records = await db.select().from(dnsRecords).where(eq(dnsRecords.domainId, domain.id));
      const inboxes = await db
        .select()
        .from(plannedInboxes)
        .where(eq(plannedInboxes.domainId, domain.id));
      const plan = await db.query.domainPlans.findFirst({
        where: eq(domainPlans.domainId, domain.id),
      });

      // Latest server-level health for this domain's VPS (shared across domains on the same IP).
      let serverHealthRow = null;
      if (domain.ipAddress) {
        try {
          const shRows = await db
            .select()
            .from(serverHealth)
            .where(and(eq(serverHealth.userId, userId), eq(serverHealth.ipAddress, domain.ipAddress)))
            .limit(1);
          serverHealthRow = shRows[0] ?? null;
        } catch {
          /* server_health table may not be migrated yet */
        }
      }

      return {
        // The domain page shows the current Mailcow admin password (MailcowAdminReset).
        domain: publicDomain(domain, { withAdminPassword: true }),
        records,
        inboxes,
        plan,
        serverHealth: serverHealthRow,
      };
    } catch {
      return null;
    }
  });

const pushDnsSchema = z.object({
  domainId: z.string().uuid(),
});

export const pushDnsToCloudflare = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => pushDnsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { db, userId } = (context as any) as { db: any; userId: string };
    if (!db) return { error: "Database not connected" };

    const domain = await db.query.domains.findFirst({
      where: and(eq(domains.id, data.domainId), eq(domains.userId, userId)),
    });
    if (!domain) return { error: "Domain not found" };

    try {
      const { results } = await pushDnsForDomain(db, domain, userId);
      return { results };
    } catch (err) {
      return { error: describeErrorForLog(err) };
    }
  });

// Fix Cloudflare DNS for a domain: remove the proxied/duplicate `mail` A record and
// un-proxy the rest, so the Mailcow API/mail host (mail.<domain>) is reachable. Safe to
// run any time; also runs automatically during provisioning / wipe & re-provision.
export const repairDomainDns = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => z.object({ domainId: z.string() }).parse(d))
  .handler(async ({ data, context }) => {
    const { db, userId } = (context as any) as { db: any; userId: string };
    if (!db) return { error: "Database not connected" };

    const domain = await db.query.domains.findFirst({
      where: and(eq(domains.id, data.domainId), eq(domains.userId, userId)),
    });
    if (!domain) return { error: "Domain not found" };

    try {
      const r = await unproxyDns(db, domain, userId);
      return { success: true, ...r };
    } catch (err) {
      return { error: describeErrorForLog(err) };
    }
  });

const getBatchDetailsSchema = z.object({
  id: z.string().uuid(),
});

export const getBatchDetails = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => getBatchDetailsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { db, userId } = (context as any) as { db: any; userId: string };
    if (!db) return null;

    try {
      const batch = await db.query.domainBatches.findFirst({
        where: and(eq(domainBatches.id, data.id), eq(domainBatches.userId, userId)),
      });

      if (!batch) return null;

      const domainRows = await db.select().from(domains).where(eq(domains.batchId, batch.id));
      const domainIds = domainRows.map((d: { id: string }) => d.id);

      const inboxes =
        domainIds.length > 0
          ? await db
              .select()
              .from(plannedInboxes)
              .where(inArray(plannedInboxes.domainId, domainIds))
          : [];

      const records =
        domainIds.length > 0
          ? await db.select().from(dnsRecords).where(inArray(dnsRecords.domainId, domainIds))
          : [];

      return { batch, domains: domainRows.map((d: any) => publicDomain(d)), inboxes, records };
    } catch {
      return null;
    }
  });

export const batchPushDnsToCloudflare = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => pushDnsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { db, userId } = (context as any) as { db: any; userId: string };
    if (!db) return { error: "Database not connected" };

    const domain = await db.query.domains.findFirst({
      where: and(eq(domains.id, data.domainId), eq(domains.userId, userId)),
    });
    if (!domain || !domain.cfZoneId) return { error: "Domain or Zone ID missing" };

    const secrets = await db.query.userSecrets.findFirst({
      where: eq(userSecrets.userId, userId),
    });
    if (!secrets?.cfApiToken) return { error: "Cloudflare token missing" };

    const records = await db.select().from(dnsRecords).where(eq(dnsRecords.domainId, domain.id));
    const results: { id: string; name: string; success: boolean; error?: string }[] = [];

    // Pre-fetch the zone's existing records so already-present records are adopted (not
    // re-created) — re-pushing an already-provisioned domain then succeeds instead of erroring.
    const existing = await fetchAllCfDnsRecords(secrets.cfApiToken, domain.cfZoneId);

    // Modest concurrency: enough to be fast, low enough to rarely trip Cloudflare's rate limit.
    // createCfDnsRecordResilient still retries any 429/5xx that slips through.
    const batchSize = 5;
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const promises = batch.map(async (record: any) => {
        if (record.status === "active")
          return { id: record.id, name: record.name, success: true, skipped: true };

        const name = record.name === "@" ? domain.name : `${record.name}.${domain.name}`;

        // Idempotency: adopt an already-present record instead of re-creating it.
        const match = findMatchingCfRecord(existing, record.type, name, record.content);
        if (match) {
          await db
            .update(dnsRecords)
            .set({ cfRecordId: match.id, status: "active", lastError: null })
            .where(eq(dnsRecords.id, record.id));
          return { id: record.id, name: record.name, success: true };
        }

        try {
          const json = await createCfDnsRecordResilient(
            secrets.cfApiToken,
            domain.cfZoneId,
            buildCfRecordBody(record, name, domain.name),
          );
          if (json.success) {
            await db
              .update(dnsRecords)
              .set({ cfRecordId: json.result!.id, status: "active", lastError: null })
              .where(eq(dnsRecords.id, record.id));
            return { id: record.id, name: record.name, success: true };
          } else {
            const errorMsg = json.errors?.[0]?.message || "Unknown Cloudflare error";
            // "Already exists" means the desired state is present — treat as success.
            if (isCfAlreadyExistsError(errorMsg)) {
              await db
                .update(dnsRecords)
                .set({ status: "active", lastError: null })
                .where(eq(dnsRecords.id, record.id));
              return { id: record.id, name: record.name, success: true };
            }
            await db
              .update(dnsRecords)
              .set({ lastError: errorMsg })
              .where(eq(dnsRecords.id, record.id));
            return { id: record.id, name: record.name, success: false, error: errorMsg };
          }
        } catch (err) {
          const errorMsg = String(err);
          await db
            .update(dnsRecords)
            .set({ lastError: errorMsg })
            .where(eq(dnsRecords.id, record.id));
          return { id: record.id, name: record.name, success: false, error: errorMsg };
        }
      });

      const batchResults = await Promise.allSettled(promises);
      for (const res of batchResults) {
        if (res.status === "fulfilled") {
          results.push(res.value);
        } else {
          results.push({ id: "", name: "", success: false, error: String(res.reason) });
        }
      }

      await new Promise((r) => setTimeout(r, 200));
    }

    return { results };
  });

const checkDnsSchema = z.object({
  domainName: z.string(),
});

export const checkDnsPropagation = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => checkDnsSchema.parse(d))
  .handler(async ({ data }) => {
    try {
      const aRecords = await dns.resolve4(`mail.${data.domainName}`).catch(() => []);
      const mxRecords = await dns.resolveMx(data.domainName).catch(() => []);

      const success = aRecords.length > 0;

      return { success, aRecords, mxRecords };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

const deleteBatchSchema = z.object({
  id: z.string().uuid(),
});

export const deleteDomainBatch = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => deleteBatchSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { db, userId } = (context as any) as { db: any; userId: string };
    if (!db) return { ok: false, error: "Database not connected" };

    try {
      const batch = await db.query.domainBatches.findFirst({
        where: and(eq(domainBatches.id, data.id), eq(domainBatches.userId, userId)),
      });
      if (!batch) return { ok: false, error: "Batch not found" };

      const batchDomains = await db.select().from(domains).where(eq(domains.batchId, batch.id));
      const domainIds = batchDomains.map((d: { id: string }) => d.id);

      if (domainIds.length > 0) {
        await db.delete(dnsRecords).where(inArray(dnsRecords.domainId, domainIds));
        await db.delete(plannedInboxes).where(inArray(plannedInboxes.domainId, domainIds));
        await db.delete(domainPlans).where(inArray(domainPlans.domainId, domainIds));
        await db.delete(domains).where(inArray(domains.id, domainIds));
      }

      await db.delete(domainBatches).where(eq(domainBatches.id, batch.id));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: describeErrorForLog(error) };
    }
  });
