import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth";
import { z } from "zod";
import { domainPlans, plannedInboxes, domains } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { planDomain } from "@/lib/planning";

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

export const regeneratePlan = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        domainId: z.string(),
        totalInboxes: z.number(),
        prefixes: z.array(z.string()),
        names: z.array(z.string()),
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

    const built = planDomain(domain.name, {
      totalInboxes: data.totalInboxes,
      prefixes: data.prefixes,
      names: data.names,
    });

    await db.delete(plannedInboxes).where(eq(plannedInboxes.domainId, data.domainId));

    const existingPlan = await db.query.domainPlans.findFirst({
      where: eq(domainPlans.domainId, data.domainId),
    });

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
