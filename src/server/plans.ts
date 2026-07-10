import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth";
import { z } from "zod";
import { domainPlans, plannedInboxes, domains } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { planDomain } from "@/lib/planning";
import { subdomainExportRows } from "@/lib/subdomains";

export const getDomainPlan = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => z.object({ domainId: z.string() }).parse(d))
  .handler(async ({ data, context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { db, userId } = context as any;
    return await db.query.domainPlans.findFirst({
      where: and(eq(domainPlans.domainId, data.domainId), eq(domainPlans.userId, userId)),
    });
  });

export const listPlannedInboxes = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => z.object({ domainId: z.string() }).parse(d))
  .handler(async ({ data, context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { db, userId } = context as any;
    return await db
      .select()
      .from(plannedInboxes)
      .where(and(eq(plannedInboxes.domainId, data.domainId), eq(plannedInboxes.userId, userId)))
      .orderBy(plannedInboxes.subdomainFqdn, plannedInboxes.localPart);
  });

// Export rows (created mailboxes with passwords) for one domain or, when domainId is omitted,
// every domain the user owns. Used by the per-domain CSV export and the bulk "download all".
export const getInboxExport = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => z.object({ domainId: z.string().optional() }).parse(d))
  .handler(async ({ data, context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { db, userId } = context as any;
    if (!db) return { rows: [], domainCount: 0 };

    const doms = data.domainId
      ? await db.select().from(domains).where(and(eq(domains.id, data.domainId), eq(domains.userId, userId)))
      : await db.select().from(domains).where(eq(domains.userId, userId));

    const rows: {
      domain: string;
      name: string;
      firstName: string;
      lastName: string;
      email: string;
      password: string;
      mailServer: string;
    }[] = [];
    for (const dom of doms) {
      const mailServer = dom.mailcowHostname || `mail.${dom.name}`;
      const inbs = await db.select().from(plannedInboxes).where(eq(plannedInboxes.domainId, dom.id));
      for (const ib of inbs) {
        if (!ib.password) continue; // only created/usable accounts
        rows.push({
          domain: dom.name,
          name: ib.fullName || [ib.firstName, ib.lastName].filter(Boolean).join(" ") || ib.localPart || "",
          firstName: ib.firstName || "",
          lastName: ib.lastName || "",
          email: ib.email,
          password: ib.password,
          mailServer,
        });
      }
    }
    return { rows, domainCount: doms.length };
  });

// Unique mail subdomains (apex excluded) for one domain or a whole job/batch. Available as soon
// as inboxes are planned — mailboxes don't need to be created. Used by the subdomain export.
export const getSubdomainExport = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) =>
    z.object({ domainId: z.string().optional(), batchId: z.string().optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { db, userId } = context as any;
    if (!db) return { rows: [] };

    let doms;
    if (data.domainId) {
      doms = await db
        .select()
        .from(domains)
        .where(and(eq(domains.id, data.domainId), eq(domains.userId, userId)));
    } else if (data.batchId) {
      doms = await db
        .select()
        .from(domains)
        .where(and(eq(domains.batchId, data.batchId), eq(domains.userId, userId)));
    } else {
      doms = await db.select().from(domains).where(eq(domains.userId, userId));
    }

    const domainIds = doms.map((d: { id: string }) => d.id);
    if (domainIds.length === 0) return { rows: [] };

    const nameById = new Map<string, string>(doms.map((d: any) => [d.id, d.name]));
    const inbs = await db
      .select()
      .from(plannedInboxes)
      .where(inArray(plannedInboxes.domainId, domainIds));

    const rows = subdomainExportRows(
      inbs.map((ib: any) => ({
        domainName: nameById.get(ib.domainId) ?? "",
        subdomainPrefix: ib.subdomainPrefix,
        subdomainFqdn: ib.subdomainFqdn,
      })),
    );
    return { rows };
  });

export const regeneratePlan = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        domainId: z.string(),
        totalInboxes: z.number(),
        prefixes: z.array(z.string()),
        names: z.array(z.string()),
        placement: z.enum(["subdomain", "main", "both"]).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { db, userId } = context as any;

    const domain = await db.query.domains.findFirst({
      where: and(eq(domains.id, data.domainId), eq(domains.userId, userId)),
    });
    if (!domain) throw new Error("Domain not found");

    const existingPlan = await db.query.domainPlans.findFirst({
      where: eq(domainPlans.domainId, data.domainId),
    });

    // Preserve the placement (main / subdomain / both) chosen at creation, unless overridden.
    const placement = data.placement ?? existingPlan?.placement ?? "subdomain";

    const built = planDomain(domain.name, {
      totalInboxes: data.totalInboxes,
      prefixes: data.prefixes,
      names: data.names,
      placement,
    });

    await db.delete(plannedInboxes).where(eq(plannedInboxes.domainId, data.domainId));

    let planId: string;
    if (existingPlan) {
      await db
        .update(domainPlans)
        .set({
          totalInboxes: built.totalInboxes,
          subdomainCount: built.subdomainCount,
          status: "planned",
          prefixesSnapshot: data.prefixes,
          namesSnapshot: data.names,
          placement,
        })
        .where(eq(domainPlans.id, existingPlan.id));
      planId = existingPlan.id;
    } else {
      const [p] = await db
        .insert(domainPlans)
        .values({
          userId,
          domainId: data.domainId,
          totalInboxes: built.totalInboxes,
          subdomainCount: built.subdomainCount,
          status: "planned",
          prefixesSnapshot: data.prefixes,
          namesSnapshot: data.names,
          placement,
        })
        .returning();
      planId = p.id;
    }

    await db
      .update(domains)
      .set({ plannedInboxCount: built.totalInboxes })
      .where(eq(domains.id, data.domainId));

    const rows = built.inboxes.map((ib) => ({
      userId,
      domainId: data.domainId,
      planId,
      subdomainPrefix: ib.subdomainPrefix,
      subdomainFqdn: ib.subdomainFqdn,
      localPart: ib.localPart,
      email: ib.email,
      fullName: ib.fullName,
      firstName: ib.firstName,
      lastName: ib.lastName,
      format: ib.format,
      status: "planned",
    }));

    if (rows.length) {
      await db.insert(plannedInboxes).values(rows);
    }

    return { ok: true };
  });
