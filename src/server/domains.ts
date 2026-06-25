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
} from "@/lib/db/schema";
import { eq, and, desc, inArray } from "drizzle-orm";
import { planDomain, randInt, DomainPlan, generateDnsRecords } from "@/lib/planning";
import dns from "dns/promises";



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
      let query = db.select().from(domains).where(eq(domains.userId, userId));
      if (data?.batchId) {
        query = db
          .select()
          .from(domains)
          .where(and(eq(domains.userId, userId), eq(domains.batchId, data.batchId)));
      }
      return await query.orderBy(desc(domains.createdAt));
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
      return await db.query.domains.findFirst({
        where: and(eq(domains.id, data.id), eq(domains.userId, userId)),
      });
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
      return { ok: false, error: String(error) };
    }
  });

export const deleteDomain = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => deleteDomainSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { db, userId } = (context as any) as { db: any; userId: string };
    if (!db) return { ok: false, error: "Database not connected" };

    try {
      await db.delete(dnsRecords).where(eq(dnsRecords.domainId, data.id));
      await db.delete(plannedInboxes).where(eq(plannedInboxes.domainId, data.id));
      await db.delete(domainPlans).where(eq(domainPlans.domainId, data.id));
      await db.delete(domains).where(and(eq(domains.id, data.id), eq(domains.userId, userId)));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error) };
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

const addDomainsWizardSchema = z.object({
  batchName: z.string().min(1).max(255),
  domains: z.array(
    z.object({
      domain: z.string().min(1).max(255),
      ipAddress: z.string().min(1).max(45),
      sshUser: z.string().min(1).max(50),
      sshPassword: z.string().optional().nullable(),
      plannedSubdomainCount: z.number().int().min(1).max(20).optional(),
      plannedInboxCount: z.number().int().min(1).max(100).optional(),
      plannedDistribution: z.array(z.number().int()).optional(),
    }),
  ),
  prefixes: z.array(z.string()).optional(),
  names: z.array(z.string()).optional(),
  templateId: z.string().uuid().optional(),
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

      const [batch] = await db
        .insert(domainBatches)
        .values({
          userId,
          name: data.batchName,
          templateId: data.templateId ?? null,
        })
        .returning();

      let okCount = 0;
      for (const row of data.domains) {
        try {
          const inboxCount = row.plannedInboxCount ?? randInt(8, 40);
          const plan = planDomain(row.domain, {
            totalInboxes: inboxCount,
            prefixes,
            names,
            minSubdomains: 1,
            maxSubdomains: row.plannedSubdomainCount ?? 15,
          });

          const [domain] = await db
            .insert(domains)
            .values({
              userId,
              batchId: batch.id,
              name: row.domain,
              ipAddress: row.ipAddress,
              sshUser: row.sshUser,
              sshPassword: row.sshPassword,
              status: "pending",
            })
            .returning();

          const [domainPlan] = await db
            .insert(domainPlans)
            .values({
              userId,
              domainId: domain.id,
              totalInboxes: plan.totalInboxes,
              subdomainCount: plan.subdomainCount,
              status: "planned",
              prefixesSnapshot: prefixes,
              namesSnapshot: names,
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

          await db.insert(plannedInboxes).values(inboxesToInsert);

          const dnsRecordsToInsert = generateDnsRecords(row.domain, row.ipAddress, plan).map((rec) => ({
            userId,
            domainId: domain.id,
            ...rec,
          }));
          await db.insert(dnsRecords).values(dnsRecordsToInsert);
          okCount++;
        } catch (err) {
          console.error(`Failed to process domain ${row.domain}:`, err);
        }
      }

      return { ok: true, okCount };
    } catch (error) {
      return { ok: false, error: String(error) };
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

      const records = await db.select().from(dnsRecords).where(eq(dnsRecords.domainId, domain.id));
      const inboxes = await db
        .select()
        .from(plannedInboxes)
        .where(eq(plannedInboxes.domainId, domain.id));
      const plan = await db.query.domainPlans.findFirst({
        where: eq(domainPlans.domainId, domain.id),
      });

      return { domain, records, inboxes, plan };
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
    if (!domain || !domain.cfZoneId) return { error: "Domain or Zone ID missing" };

    const secrets = await db.query.userSecrets.findFirst({
      where: eq(userSecrets.userId, userId),
    });
    if (!secrets?.cfApiToken) return { error: "Cloudflare token missing" };

    const records = await db.select().from(dnsRecords).where(eq(dnsRecords.domainId, domain.id));
    const results: { id: string; name: string; success: boolean; error?: string }[] = [];

    for (const record of records) {
      if (record.status === "active") continue;

      const name = record.name === "@" ? domain.name : `${record.name}.${domain.name}`;

      try {
        const res = await fetch(
          `https://api.cloudflare.com/client/v4/zones/${domain.cfZoneId}/dns_records`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${secrets.cfApiToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              type: record.type,
              name,
              content: record.content,
              ttl: record.ttl || 1,
              priority: record.priority,
              proxied: record.proxied || false,
            }),
          },
        );
        const json = (await res.json()) as {
          success: boolean;
          result?: { id: string };
          errors?: { message: string }[];
        };
        if (json.success) {
          await db
            .update(dnsRecords)
            .set({ cfRecordId: json.result!.id, status: "active", lastError: null })
            .where(eq(dnsRecords.id, record.id));
          results.push({ id: record.id, name: record.name, success: true });
        } else {
          const errorMsg = json.errors?.[0]?.message || "Unknown Cloudflare error";
          await db
            .update(dnsRecords)
            .set({ lastError: errorMsg })
            .where(eq(dnsRecords.id, record.id));
          results.push({ id: record.id, name: record.name, success: false, error: errorMsg });
        }
      } catch (err) {
        const errorMsg = String(err);
        await db
          .update(dnsRecords)
          .set({ lastError: errorMsg })
          .where(eq(dnsRecords.id, record.id));
        results.push({ id: record.id, name: record.name, success: false, error: errorMsg });
      }

      await new Promise((r) => setTimeout(r, 200));
    }

    return { results };
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

      return { batch, domains: domainRows, inboxes, records };
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

    const batchSize = 10;
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const promises = batch.map(async (record: any) => {
        if (record.status === "active")
          return { id: record.id, name: record.name, success: true, skipped: true };

        const name = record.name === "@" ? domain.name : `${record.name}.${domain.name}`;

        try {
          const res = await fetch(
            `https://api.cloudflare.com/client/v4/zones/${domain.cfZoneId}/dns_records`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${secrets.cfApiToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                type: record.type,
                name,
                content: record.content,
                ttl: record.ttl || 1,
                priority: record.priority,
                proxied: record.proxied || false,
              }),
            },
          );
          const json = (await res.json()) as {
            success: boolean;
            result?: { id: string };
            errors?: { message: string }[];
          };
          if (json.success) {
            await db
              .update(dnsRecords)
              .set({ cfRecordId: json.result!.id, status: "active", lastError: null })
              .where(eq(dnsRecords.id, record.id));
            return { id: record.id, name: record.name, success: true };
          } else {
            const errorMsg = json.errors?.[0]?.message || "Unknown Cloudflare error";
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
      return { ok: false, error: String(error) };
    }
  });
